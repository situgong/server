#!/usr/bin/env node
/**
 * LinguaSpark Server - Node.js Translation Service
 * Uses Bergamot WASM for translation (same as Firefox Translations)
 *
 * Features:
 * - Native API: POST /translate
 * - Compatible APIs: /kiss, /imme, /hcfy, /deeplx
 * - Language detection: POST /detect
 * - Health check: GET /health
 * - API key authentication support
 * - CORS enabled
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { franc } from 'franc';
import swaggerUi from 'swagger-ui-express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const CONFIG = {
    PORT: parseInt(process.env.PORT || '3000', 10),
    IP: process.env.IP || '127.0.0.1',
    MODELS_DIR: process.env.MODELS_DIR || './models',
    API_KEY: process.env.API_KEY || '',
    RUST_LOG: process.env.RUST_LOG || 'info',
    WASM_PATH: process.env.WASM_PATH || path.join(__dirname, 'wasm', 'bergamot-translator.wasm'),
    JS_PATH: process.env.JS_PATH || path.join(__dirname, 'wasm', 'bergamot-translator.js'),
};

// Load bergamot-translator.js and WASM binary (will create instances per model)
const bergamotJsContent = await fs.readFile(CONFIG.JS_PATH, 'utf-8');
let wasmBinary = null;

// Create a new Bergamot WASM instance
async function createBergamotInstance() {
    const sandbox = {
        console: console,
        undefined: undefined,
        Math: Math,
        Object: Object,
        String: String,
        Array: Array,
        Uint8Array: Uint8Array,
        ArrayBuffer: ArrayBuffer,
        TextDecoder: TextDecoder,
        WebAssembly: WebAssembly,
        Error: Error,
        TypeError: TypeError,
        Map: Map,
        Set: Set,
        Promise: Promise,
        JSON: JSON,
        Date: Date,
        RegExp: RegExp,
    };
    vm.createContext(sandbox);
    vm.runInContext(bergamotJsContent, sandbox);

    // Load WASM binary if not cached
    if (!wasmBinary) {
        const data = await fs.readFile(CONFIG.WASM_PATH);
        wasmBinary = data.buffer;
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WASM init timeout')), 30000);

        sandbox.loadBergamot({
            wasmBinary: wasmBinary,
            print: (msg) => console.log(`[Bergamot]: ${msg}`),
            printErr: (msg) => console.error(`[Bergamot Error]: ${msg}`),
            onAbort: (msg) => {
                console.error(`[Bergamot Abort]: ${msg}`);
                reject(new Error(`WASM aborted: ${msg}`));
            },
            onRuntimeInitialized: function() {
                clearTimeout(timeout);
                resolve(this);
            }
        });
    });
}

// Express app
const app = express();
app.use(cors());
app.use(express.json());

// Load OpenAPI spec for Swagger UI
let openapiSpec;
try {
    openapiSpec = JSON.parse(await fs.readFile(path.join(__dirname, 'public', 'openapi.json'), 'utf-8'));
} catch (err) {
    console.warn('[Server] Could not load OpenAPI spec:', err.message);
    openapiSpec = {
        openapi: '3.0.0',
        info: { title: 'LinguaSpark API', version: '0.1.0' },
        paths: {}
    };
}

// Serve static files for Web UI
app.use(express.static(path.join(__dirname, 'public')));

// Swagger UI at /docs/
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'LinguaSpark API Docs',
}));

// API endpoint to get OpenAPI spec
app.get('/openapi.json', (req, res) => {
    res.json(openapiSpec);
});

// State
let activeModel = null; // Currently loaded model (only one at a time due to WASM limitation)
const availableModels = new Map(); // key: "from-to", value: { dir, from, to, buffers: null }
const loadingLocks = new Map(); // key: "from-to", value: Promise (prevents duplicate loads)
const langCodeMap = {
    // Chinese names
    '中文(简体)': 'zh',
    '中文(繁体)': 'zh_Hant',
    '简体中文': 'zh',
    '繁体中文': 'zh_Hant',
    // English names
    'english': 'en',
    'chinese': 'zh',
    'japanese': 'jp',
    'korean': 'ko',
    'french': 'fr',
    'german': 'de',
    'spanish': 'es',
    'russian': 'ru',
    'portuguese': 'pt',
    // Other common mappings
    '英语': 'en',
    '日语': 'jp',
    '韩语': 'ko',
    '法语': 'fr',
    '德语': 'de',
    '西班牙语': 'es',
    '俄语': 'ru',
    '葡萄牙语': 'pt',
};

// ============== Translation Log (20-minute sliding window) ==============

const LOG_RETENTION_MS = 20 * 60 * 1000; // 20 minutes
const translationLog = {
    entries: [], // Circular buffer: { timestamp, from, to, source, translated }
    maxSize: 1000, // Maximum entries to keep

    add(entry) {
        const now = Date.now();
        // Clean old entries
        this.clean(now);
        // Add new entry
        this.entries.push({
            timestamp: now,
            from: entry.from,
            to: entry.to,
            source: entry.source?.substring(0, 500) || '', // Truncate long texts
            translated: entry.translated?.substring(0, 500) || '',
        });
        // Keep size limited
        if (this.entries.length > this.maxSize) {
            this.entries = this.entries.slice(-this.maxSize);
        }
    },

    clean(now) {
        const cutoff = now - LOG_RETENTION_MS;
        // Remove entries older than 20 minutes
        while (this.entries.length > 0 && this.entries[0].timestamp < cutoff) {
            this.entries.shift();
        }
    },

    getRecent(limit = 100) {
        this.clean(Date.now());
        const start = Math.max(0, this.entries.length - limit);
        return this.entries.slice(start);
    },

    getStats() {
        this.clean(Date.now());
        const now = Date.now();
        const recent = this.entries.filter(e => now - e.timestamp < 60000); // Last minute
        return {
            totalEntries: this.entries.length,
            lastMinute: recent.length,
            oldestEntry: this.entries[0]?.timestamp || null,
            newestEntry: this.entries[this.entries.length - 1]?.timestamp || null,
        };
    }
};

// Helper function to log translations
function logTranslation(from, to, source, translated) {
    translationLog.add({ from, to, source, translated });
}

// ============== Helpers ==============

function normalizePath(p) {
    return path.normalize(p);
}

// MTranServer compatible language code normalization
const languageAliases = {
    'zh': 'zh',
    'zh-cn': 'zh',
    'zh-sg': 'zh',
    'zh-hans': 'zh',
    'cmn': 'zh',
    'chinese': 'zh',
    'zh-tw': 'zh-Hant',
    'zh-hk': 'zh-Hant',
    'zh-mo': 'zh-Hant',
    'zh-hant': 'zh-Hant',
    'cht': 'zh-Hant',
    'en-us': 'en',
    'en-gb': 'en',
    'en-au': 'en',
    'en-ca': 'en',
    'en-nz': 'en',
    'en-ie': 'en',
    'en-za': 'en',
    'en-jm': 'en',
    'en-bz': 'en',
    'en-tt': 'en',
    'ja-jp': 'ja',
    'jp': 'ja',
    'ko-kr': 'ko',
    'kr': 'ko',
};

function normalizeLanguageCode(code) {
    if (!code) return '';

    const normalized = code.toLowerCase().replace(/_/g, '-');

    if (languageAliases[normalized]) {
        return languageAliases[normalized];
    }

    const mainCode = normalized.split('-')[0];
    if (languageAliases[mainCode]) {
        return languageAliases[mainCode];
    }

    return mainCode;
}

// Map normalized language code to model directory key
function langCodeToModelKey(code) {
    // Map zh-Hans/zh-Hant variations to simple 'zh'
    if (code === 'zh-Hans' || code === 'zh-Hant') {
        return 'zh';
    }
    return code;
}

// Check if a language pair needs pivot translation via English
function needsPivotTranslation(fromLang, toLang) {
    // Use model directory keys (zh instead of zh-Hans)
    const fromKey = langCodeToModelKey(fromLang);
    const toKey = langCodeToModelKey(toLang);

    if (fromKey === 'en' || toKey === 'en') {
        return false;
    }
    const key = `${fromKey}-${toKey}`;
    return !availableModels.has(key);
}

// Translate with pivot (via English if needed)
async function translateWithPivot(fromLang, toLang, text, isHTML = false) {
    // Same language - no translation needed
    if (fromLang === toLang) {
        return text;
    }

    // Use model directory keys
    const fromKey = langCodeToModelKey(fromLang);
    const toKey = langCodeToModelKey(toLang);

    // Direct translation available
    if (!needsPivotTranslation(fromLang, toLang)) {
        const model = await getModel(fromKey, toKey);
        return doTranslate(model, text);
    }

    // Pivot via English
    const intermediateModel = await getModel(fromKey, 'en');
    const intermediate = doTranslate(intermediateModel, text);

    const finalModel = await getModel('en', toKey);
    return doTranslate(finalModel, intermediate);
}

// ============== Model Loading ==============

// Supported file naming patterns for model files
const FILE_PATTERNS = {
    model: [
        { pattern: /model\.intgemm8\.bin$/i, key: 'model' },
        { pattern: /model\.intgemm\.alphas\.bin$/i, key: 'model' },
        { pattern: /^model\..*\.bin$/i, key: 'model' },
        { pattern: /^model\.bin$/i, key: 'model' },
    ],
    lex: [
        { pattern: /\.s2t\.bin$/i, key: 'lex' },
        { pattern: /^lex\.50\.50\..*\.s2t\.bin$/i, key: 'lex' },
        { pattern: /^lex\.bin$/i, key: 'lex' },
        { pattern: /^lex\..*\.s2t\.bin$/i, key: 'lex' },
    ],
    srcvocab: [
        { pattern: /^srcvocab\..*\.spm$/i, key: 'srcvocab' },
        { pattern: /^vocab\..*\.spm$/i, key: 'srcvocab' },
        { pattern: /^srcvocab\.spm$/i, key: 'srcvocab' },
    ],
    trgvocab: [
        { pattern: /^trgvocab\..*\.spm$/i, key: 'trgvocab' },
        { pattern: /^vocab\..*\.spm$/i, key: 'trgvocab' },
        { pattern: /^trgvocab\.spm$/i, key: 'trgvocab' },
    ],
};

function matchFile(name, patterns) {
    for (const { pattern, key } of patterns) {
        if (pattern.test(name)) return key;
    }
    return null;
}

async function loadModelFiles(modelPath) {
    const files = {};
    const missing = { model: 'model.intgemm8.bin', lex: 'lex.s2t.bin', srcvocab: 'srcvocab.xxen.spm', trgvocab: 'trgvocab.xxen.spm' };

    try {
        const entries = await fs.readdir(modelPath, { withFileTypes: true });
        for (const entry of entries) {
            const name = entry.name;
            const ext = path.extname(name).toLowerCase();

            if (ext === '.spm') {
                // Check vocab patterns
                let key = matchFile(name, [...FILE_PATTERNS.srcvocab, ...FILE_PATTERNS.trgvocab]);
                if (key) {
                    if (!files[key]) files[key] = [];
                    files[key].push({ name: entry.name, path: path.join(modelPath, entry.name) });
                }
            } else if (ext === '.bin') {
                let key = matchFile(name, [...FILE_PATTERNS.model, ...FILE_PATTERNS.lex]);
                if (key) {
                    if (!files[key]) files[key] = [];
                    files[key].push({ name: entry.name, path: path.join(modelPath, entry.name) });
                }
            }
        }
    } catch (err) {
        throw new Error(`Cannot read model directory: ${err.message}`);
    }

    // Validate required files exist
    const required = ['model', 'lex', 'srcvocab', 'trgvocab'];
    const found = Object.keys(files);

    // Check for vocab.spm fallback
    if (files['vocab.spm']) {
        files.srcvocab = files.vocab.spm;
        files.trgvocab = files.vocab.spm;
        delete files['vocab.spm'];
    }

    // Check for single vocab file (use for both src and trg)
    if ((files.srcvocab && !files.trgvocab) || (!files.srcvocab && files.trgvocab)) {
        const vocabFile = files.srcvocab || files.trgvocab;
        if (vocabFile && vocabFile.length > 0) {
            files.srcvocab = vocabFile;
            files.trgvocab = vocabFile;
        }
    }

    const missingFiles = required.filter(k => !files[k] || files[k].length === 0);

    if (missingFiles.length > 0) {
        throw new Error(`Missing required files: ${missingFiles.map(f => missing[f]).join(', ')}`);
    }

    // Read the first matching file for each type
    const result = {};
    for (const [key, arr] of Object.entries(files)) {
        if (arr && arr.length > 0) {
            result[key] = await fs.readFile(arr[0].path);
        }
    }

    return result;
}

function createAlignedMemory(buffer, alignment = 64) {
    // Use the active model's bergamot module, or create a temporary one
    const bergamot = activeModel ? activeModel.bergamot : null;
    if (!bergamot) {
        throw new Error('No active model available');
    }
    const aligned = new bergamot.AlignedMemory(buffer.length || buffer.byteLength, alignment);
    const view = aligned.getByteArrayView();
    view.set(new Uint8Array(buffer));
    return aligned;
}

// Load model into WASM (unloads previous model if any)
async function loadModel(key) {
    const modelInfo = availableModels.get(key);
    if (!modelInfo) {
        throw new Error(`Model not available: ${key}`);
    }

    // If already active, return it
    if (activeModel && activeModel.key === key) {
        return activeModel;
    }

    // Check if another thread is already loading this model
    if (loadingLocks.has(key)) {
        console.log(`[Server] Waiting for model ${key} to finish loading...`);
        return await loadingLocks.get(key);
    }

    // Create loading promise
    const loadPromise = doLoadModel(key, modelInfo);
    loadingLocks.set(key, loadPromise);

    try {
        const result = await loadPromise;
        return result;
    } finally {
        loadingLocks.delete(key);
    }
}

async function doLoadModel(key, modelInfo) {
    // Unload previous model to free WASM memory
    if (activeModel) {
        console.log(`[Server] Unloading previous model: ${activeModel.key}`);
        try {
            activeModel.instance.delete();
            activeModel.service.delete();
            // Delete the WASM module to free memory
            if (activeModel.bergamot) {
                // bergamot cleanup is handled by deleting model/service
            }
        } catch (e) {
            // Ignore cleanup errors
        }
        activeModel = null;
    }

    // Load model files if not cached
    if (!modelInfo.buffers) {
        console.log(`[Server] Loading model files: ${key}`);
        modelInfo.buffers = await loadModelFiles(modelInfo.dir);
    }

    const { from, to, buffers } = modelInfo;
    console.log(`[Server] Creating WASM instance for model: ${key}`);

    // Create a new WASM instance per model (like MTranServer)
    const bergamot = await createBergamotInstance();

    const aligned = {};
    const alignments = { model: 256, lex: 64, srcvocab: 64, trgvocab: 64 };
    for (const [k, buf] of Object.entries(buffers)) {
        aligned[k] = createAlignedMemoryFromModule(bergamot, buf, alignments[k]);
    }

    const vocabList = new bergamot.AlignedMemoryList();
    vocabList.push_back(aligned.srcvocab);
    vocabList.push_back(aligned.trgvocab);

    const config = [
        'beam-size: 1', 'normalize: 1.0', 'word-penalty: 0',
        'max-length-break: 512', 'mini-batch-words: 1024', 'workspace: 128',
        'max-length-factor: 2.0', 'skip-cost: true', 'cpu-threads: 0',
        'quiet: true', 'quiet-translation: true',
        'gemm-precision: int8shiftAlphaAll', 'alignment: soft'
    ].join('\n');

    const instance = new bergamot.TranslationModel(from, to, config, aligned.model, aligned.lex, vocabList, null);
    const service = new bergamot.BlockingService({ cacheSize: 0 });

    activeModel = { key, instance, service, from, to, aligned, vocabList, bergamot };
    console.log(`[Server] Model activated: ${key}`);
    return activeModel;
}

function createAlignedMemoryFromModule(bergamot, buffer, alignment = 64) {
    const aligned = new bergamot.AlignedMemory(buffer.length || buffer.byteLength, alignment);
    const view = aligned.getByteArrayView();
    view.set(new Uint8Array(buffer));
    return aligned;
}

function doTranslate(model, text) {
    // Clean text - remove control characters and replacement chars
    let cleanedText = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    cleanedText = cleanedText.replace(/\uFFFD/g, '');

    const msgs = new model.bergamot.VectorString();
    const opts = new model.bergamot.VectorResponseOptions();
    try {
        msgs.push_back(cleanedText);
        opts.push_back({ qualityScores: false, alignment: false, html: false });
        const responses = model.service.translate(model.instance, msgs, opts);
        const result = responses.get(0).getTranslatedText();
        responses.delete();
        msgs.delete();
        opts.delete();
        return result;
    } catch (err) {
        msgs.delete();
        opts.delete();
        throw err;
    }
}

function detectLanguage(text) {
    if (!text || text.trim().length < 3) return 'en';

    // Use franc for detection
    const result = franc(text, { minLength: 3, whitelisted: ['eng', 'zho', 'jpn', 'kor', 'fra', 'deu', 'spa', 'rus', 'por'] });
    if (result !== 'und') {
        // Map 3-letter codes to 2-letter ISO 639-1
        const codeMap = {
            'eng': 'en', 'zho': 'zh', 'jpn': 'jp', 'kor': 'ko',
            'fra': 'fr', 'deu': 'de', 'spa': 'es', 'rus': 'ru',
            'por': 'pt', 'ita': 'it', 'nld': 'nl', 'pol': 'pl',
            'ara': 'ar', 'hin': 'hi', 'tha': 'th', 'vie': 'vi',
        };
        return codeMap[result] || result.slice(0, 2);
    }

    // Simple heuristic fallback for CJK
    const cjkRegex = /[\u4e00-\u9fff\uac00-\ud7af\u3040-\u309f\u30a0-\u30ff]/;
    if (cjkRegex.test(text)) {
        if (text.match(/[\u3040-\u309f\u30a0-\u30ff]/)) return 'jp';
        if (text.match(/[\uac00-\ud7af]/)) return 'ko';
        return 'zh';
    }

    return 'en';
}

// Simple language code to name mapping for HCFY
function getLangName(code) {
    const map = {
        'zh': '中文(简体)',
        'zh_Hant': '中文(繁体)',
        'en': '英语',
        'jp': '日语',
        'ko': '韩语',
        'fr': '法语',
        'de': '德语',
        'es': '西班牙语',
        'ru': '俄语',
        'pt': '葡萄牙语',
    };
    return map[code] || code;
}

function convertLangName(name) {
    return langCodeMap[name] || name;
}

// Get or load model for translation
async function getModel(from, to) {
    const key = `${from}-${to}`;
    return await loadModel(key);
}

// ============== Auth Middleware ==============

function checkAuth(req, res, next) {
    if (!CONFIG.API_KEY) return next();

    const headerKey = req.headers.authorization?.replace('Bearer ', '');
    const queryKey = req.query.token;

    if (headerKey !== CONFIG.API_KEY && queryKey !== CONFIG.API_KEY) {
        return res.status(401).json({ error: 'Invalid or missing API key' });
    }
    next();
}

// ============== Endpoints ==============

// Health check - returns available models with language info for UI
app.get('/health', (req, res) => {
    const models = Array.from(availableModels.entries()).map(([k, v]) => ({
        key: k,
        from: v.from,
        to: v.to,
    }));
    res.json({
        status: 'ok',
        bergamotLoaded: activeModel !== null,
        availableModels: models,
    });
});

// ============== Monitor API ==============

// Get recent translation logs
app.get('/monitor/logs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const logs = translationLog.getRecent(limit);
    res.json({
        logs: logs.map(l => ({
            timestamp: l.timestamp,
            from: l.from,
            to: l.to,
            source: l.source,
            translated: l.translated,
        })),
        count: logs.length,
    });
});

// Get log statistics
app.get('/monitor/stats', (req, res) => {
    const stats = translationLog.getStats();
    res.json({
        ...stats,
        retentionMinutes: 20,
        serverUptime: process.uptime(),
    });
});

// Clear logs (admin)
app.post('/monitor/clear', (req, res) => {
    translationLog.entries = [];
    res.json({ success: true });
});

// Language detection
app.post('/detect', checkAuth, (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text' });
    res.json({ language: detectLanguage(text) });
});

// Native translate API
app.post('/translate', checkAuth, async (req, res) => {
    const { text, from, to } = req.body;
    if (!text || !to) return res.status(400).json({ error: 'Missing text or to' });

    const fromLang = from && from !== 'auto' ? from : detectLanguage(text);

    try {
        const model = await getModel(fromLang, to);
        const result = doTranslate(model, text);
        logTranslation(fromLang, to, text, result);
        res.json({ text: result, from: fromLang, to });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Kiss Translator API
app.post('/kiss', checkAuth, async (req, res) => {
    const { text, from, to } = req.body;
    if (!text || !to) return res.status(400).json({ error: 'Missing text or to' });

    const fromLang = from && from !== 'auto' ? from : detectLanguage(text);

    try {
        const model = await getModel(fromLang, to);
        const result = doTranslate(model, text);
        logTranslation(fromLang, to, text, result);
        res.json({ text: result, from: fromLang, to });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Immersive Translate API (batch)
app.post('/imme', checkAuth, async (req, res) => {
    const { source_lang, target_lang, text_list } = req.body;
    if (!target_lang || !text_list) return res.status(400).json({ error: 'Missing target_lang or text_list' });

    const fromLang = source_lang && source_lang !== 'auto' ? source_lang : detectLanguage(text_list[0] || '');

    try {
        const model = await getModel(fromLang, target_lang);
        const translations = [];
        for (const text of text_list) {
            const result = doTranslate(model, text);
            logTranslation(fromLang, target_lang, text, result);
            translations.push({
                detected_source_lang: fromLang,
                text: result,
            });
        }

        res.json({ translations });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// HCFY API
app.post('/hcfy', checkAuth, async (req, res) => {
    const { text, source, destination } = req.body;
    if (!text || !destination) return res.status(400).json({ error: 'Missing text or destination' });

    const srcName = source || 'english';
    const srcLang = convertLangName(srcName);
    let tgtLang = convertLangName(destination[0] || 'chinese');

    // Convert to ISO 639-1 codes for model lookup
    const fullLangMap = {
        'chinese': 'zh',
        'japanese': 'jp',
        'korean': 'ko',
        'french': 'fr',
        'german': 'de',
        'spanish': 'es',
        'russian': 'ru',
        'portuguese': 'pt',
        'zh_Hant': 'zh',
    };

    const srcIso = fullLangMap[srcLang] || (srcLang.length === 2 ? srcLang : 'en');
    const tgtIso = fullLangMap[tgtLang] || (tgtLang.length === 2 ? tgtLang : 'zh');

    // Handle same language case
    if (srcIso === tgtIso) {
        return res.json({ text, from: srcName, to: destination[0], result: [text] });
    }

    try {
        const model = await getModel(srcIso, tgtIso);
        const result = doTranslate(model, text);
        logTranslation(srcIso, tgtIso, text, result);
        res.json({ text, from: srcName, to: destination[0], result: [result] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DeepLX API
app.post('/deeplx', checkAuth, async (req, res) => {
    const { text, source_lang, target_lang } = req.body;
    if (!text || !source_lang || !target_lang) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const fromLang = source_lang.toLowerCase();
    const toLang = target_lang.toLowerCase();

    try {
        const model = await getModel(fromLang, toLang);
        const result = doTranslate(model, text);
        logTranslation(fromLang, toLang, text, result);
        res.json({
            code: 200,
            id: Date.now(),
            data: result,
            alternatives: [],
            source_lang: source_lang.toUpperCase(),
            target_lang: target_lang.toUpperCase(),
            method: 'Free',
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// MTranServer compatible API - Single translation
// POST /translate_mtranserver
// Input: { from: string, to: string, text: string, html?: boolean }
// Output: { result: string }
app.post('/translate_mtranserver', async (req, res) => {
    const { from, to, text, html } = req.body;
    if (!from || !to || !text) {
        return res.status(400).json({ error: 'Missing required fields: from, to, text' });
    }

    try {
        const normalizedFrom = normalizeLanguageCode(from);
        const normalizedTo = normalizeLanguageCode(to);

        const result = await translateWithPivot(normalizedFrom, normalizedTo, text, html || false);
        logTranslation(normalizedFrom, normalizedTo, text, result);
        res.json({ result });
    } catch (err) {
        console.error('[Server] MTranServer translate error:', err);
        res.status(500).json({ error: err.message });
    }
});

// MTranServer compatible API - Batch translation
// POST /translate_mtranserver/batch
// Input: { from: string, to: string, texts: string[], html?: boolean }
// Output: { results: string[] }
app.post('/translate_mtranserver/batch', async (req, res) => {
    const { from, to, texts, html } = req.body;
    if (!from || !to || !texts || !Array.isArray(texts)) {
        return res.status(400).json({ error: 'Missing required fields: from, to, texts[]' });
    }

    try {
        const normalizedFrom = normalizeLanguageCode(from);
        const normalizedTo = normalizeLanguageCode(to);

        const results = [];
        for (const text of texts) {
            const result = await translateWithPivot(normalizedFrom, normalizedTo, text, html || false);
            logTranslation(normalizedFrom, normalizedTo, text, result);
            results.push(result);
        }
        res.json({ results });
    } catch (err) {
        console.error('[Server] MTranServer batch translate error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============== Model Management ==============

// Get list of available models (public - no auth required for UI)
app.get('/models', (req, res) => {
    const models = Array.from(availableModels.entries()).map(([k, v]) => ({
        key: k,
        from: v.from,
        to: v.to,
    }));
    res.json({ models });
});

// Register a model for on-demand loading
app.post('/models/load', checkAuth, async (req, res) => {
    const { from, to, modelDir } = req.body;
    if (!from || !to) return res.status(400).json({ error: 'Missing from or to' });

    const key = `${from}-${to}`;
    if (availableModels.has(key)) {
        return res.json({ success: true, key, from, to, alreadyRegistered: true });
    }

    const dir = normalizePath(modelDir || path.join(CONFIG.MODELS_DIR, key));

    console.log(`[Server] Registering model: ${key} from ${dir}`);

    try {
        // Validate model files exist
        const buffers = await loadModelFiles(dir);

        // Register for on-demand loading
        availableModels.set(key, { dir, from, to, buffers });
        console.log(`[Server] Model registered: ${key}`);

        res.json({ success: true, key, from, to, message: 'Model registered for on-demand loading' });
    } catch (err) {
        console.error(`[Server] Failed to register model ${key}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// ============== Initialization ==============

async function scanModelDirectories() {
    try {
        const entries = await fs.readdir(CONFIG.MODELS_DIR, { withFileTypes: true });
        let discovered = 0;

        for (const entry of entries) {
            if (entry.isDirectory()) {
                // Parse directory name (supports "enzh", "en-zh", "enja", "en-ja")
                let from, to;
                const name = entry.name;

                if (name.includes('-')) {
                    [from, to] = name.split('-');
                } else if (name.length >= 4) {
                    from = name.slice(0, 2);
                    to = name.slice(2, 4);
                } else {
                    continue; // Skip invalid directory names
                }

                const dir = path.join(CONFIG.MODELS_DIR, entry.name);
                const key = `${from}-${to}`;

                // Just register the model directory, don't load yet
                if (!availableModels.has(key)) {
                    availableModels.set(key, { dir, from, to, buffers: null });
                    discovered++;
                }
            }
        }

        console.log(`[Server] Discovered ${discovered} models: ${Array.from(availableModels.keys()).join(', ')}`);
    } catch (err) {
        console.log(`[Server] No models directory found or error scanning: ${err.message}`);
    }
}

// Preload model buffers (without WASM instantiation) for faster first translation
async function preloadModelBuffers() {
    for (const [key, modelInfo] of availableModels) {
        try {
            if (!modelInfo.buffers) {
                modelInfo.buffers = await loadModelFiles(modelInfo.dir);
                console.log(`[Server] Preloaded buffers for ${key}`);
            }
        } catch (err) {
            console.error(`[Server] Failed to preload ${key}: ${err.message}`);
        }
    }
}

// ============== Start Server ==============

async function start() {
    try {
        // Scan for available models (don't load yet)
        await scanModelDirectories();

        // Preload model buffers for faster first translation
        await preloadModelBuffers();

        // Start Express server
        app.listen(CONFIG.PORT, CONFIG.IP, () => {
            console.log(`[Server] LinguaSpark listening on http://${CONFIG.IP}:${CONFIG.PORT}`);
            console.log(`[Server] Models directory: ${CONFIG.MODELS_DIR}`);
            if (CONFIG.API_KEY) console.log(`[Server] API key protection enabled`);
        });

    } catch (err) {
        console.error('[Server] Failed to start:', err);
        process.exit(1);
    }
}

// Shutdown
process.on('SIGTERM', () => {
    console.log('[Server] Shutting down...');
    for (const [key, model] of availableModels) {
        try {
            model.instance.delete();
            model.service.delete();
        } catch {}
    }
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('[Server] Interrupted');
    process.exit(0);
});

start();