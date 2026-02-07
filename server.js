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

// Load bergamot-translator.js into VM sandbox
const bergamotJsContent = await fs.readFile(CONFIG.JS_PATH, 'utf-8');
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
const loadBergamot = sandbox.loadBergamot;

// Express app
const app = express();
app.use(cors());
app.use(express.json());

// State
let bergamotModule = null;
const loadedModels = new Map(); // key: "from-to", value: { instance, service, from, to }
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

// ============== Helpers ==============

function normalizePath(p) {
    return path.normalize(p);
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
    const aligned = new bergamotModule.AlignedMemory(buffer.length || buffer.byteLength, alignment);
    const view = aligned.getByteArrayView();
    view.set(new Uint8Array(buffer));
    return aligned;
}

function translate(model, text) {
    const msgs = new bergamotModule.VectorString();
    const opts = new bergamotModule.VectorResponseOptions();
    try {
        msgs.push_back(text);
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

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        bergamotLoaded: !!bergamotModule,
        loadedModels: Array.from(loadedModels.keys()),
    });
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
    const key = `${fromLang}-${to}`;
    const model = loadedModels.get(key);

    if (!model) return res.status(400).json({ error: `Model not loaded: ${key}` });

    try {
        const result = translate(model, text);
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
    const key = `${fromLang}-${to}`;
    const model = loadedModels.get(key);

    if (!model) return res.status(400).json({ error: `Model not loaded: ${key}` });

    try {
        const result = translate(model, text);
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
    const key = `${fromLang}-${target_lang}`;
    const model = loadedModels.get(key);

    if (!model) return res.status(400).json({ error: `Model not loaded: ${key}` });

    const translations = text_list.map(text => ({
        detected_source_lang: fromLang,
        text: translate(model, text),
    }));

    res.json({ translations });
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

    const key = `${srcIso}-${tgtIso}`;

    // Handle same language case
    if (srcIso === tgtIso) {
        return res.json({ text, from: srcName, to: destination[0], result: [text] });
    }

    const model = loadedModels.get(key);

    if (!model) return res.status(400).json({ error: `Model not loaded: ${key}` });

    try {
        const result = translate(model, text);
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
    const key = `${fromLang}-${toLang}`;
    const model = loadedModels.get(key);

    if (!model) return res.status(400).json({ error: `Model not loaded: ${key}` });

    try {
        const result = translate(model, text);
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

// ============== Model Management ==============

// Get list of available models
app.get('/models', checkAuth, (req, res) => {
    const models = Array.from(loadedModels.entries()).map(([k, v]) => ({
        key: k,
        from: v.from,
        to: v.to,
    }));
    res.json({ models });
});

// Load a model
app.post('/models/load', checkAuth, async (req, res) => {
    const { from, to, modelDir } = req.body;
    if (!from || !to) return res.status(400).json({ error: 'Missing from or to' });

    const key = `${from}-${to}`;
    if (loadedModels.has(key)) {
        return res.json({ success: true, key, from, to, alreadyLoaded: true });
    }

    const dir = normalizePath(modelDir || path.join(CONFIG.MODELS_DIR, key));

    console.log(`[Server] Loading model: ${key} from ${dir}`);

    try {
        if (!bergamotModule) {
            bergamotModule = await initBergamot();
        }

        const buffers = await loadModelFiles(dir);
        const aligned = {};
        const alignments = { model: 256, lex: 64, srcvocab: 64, trgvocab: 64 };
        for (const [k, buf] of Object.entries(buffers)) {
            aligned[k] = createAlignedMemory(buf, alignments[k]);
        }

        const vocabList = new bergamotModule.AlignedMemoryList();
        vocabList.push_back(aligned.srcvocab);
        vocabList.push_back(aligned.trgvocab);

        const config = [
            'beam-size: 1', 'normalize: 1.0', 'word-penalty: 0',
            'max-length-break: 512', 'mini-batch-words: 1024', 'workspace: 128',
            'max-length-factor: 2.0', 'skip-cost: true', 'cpu-threads: 0',
            'quiet: true', 'quiet-translation: true',
            'gemm-precision: int8shiftAlphaAll', 'alignment: soft'
        ].join('\n');

        const model = new bergamotModule.TranslationModel(from, to, config, aligned.model, aligned.lex, vocabList, null);
        const service = new bergamotModule.BlockingService({ cacheSize: 0 });

        loadedModels.set(key, { instance: model, service, from, to });
        console.log(`[Server] Model loaded: ${key}`);

        res.json({ success: true, key, from, to });
    } catch (err) {
        console.error(`[Server] Failed to load model ${key}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// ============== Initialization ==============

async function initBergamot() {
    console.log(`[Server] Loading WASM from: ${CONFIG.WASM_PATH}`);
    const wasmBinary = await fs.readFile(CONFIG.WASM_PATH);

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WASM init timeout')), 60000);

        loadBergamot({
            wasmBinary: wasmBinary.buffer,
            print: (msg) => console.log(`[Bergamot]: ${msg}`),
            printErr: (msg) => console.error(`[Bergamot Error]: ${msg}`),
            onAbort: (msg) => {
                console.error(`[Bergamot Abort]: ${msg}`);
                reject(new Error(`WASM aborted: ${msg}`));
            },
            onRuntimeInitialized: function() {
                console.log('[Server] Bergamot runtime initialized');
                clearTimeout(timeout);
                resolve(this);
            }
        });
    });
}

async function loadInitialModels() {
    try {
        const entries = await fs.readdir(CONFIG.MODELS_DIR, { withFileTypes: true });
        let loaded = 0;
        let failed = 0;

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

                try {
                    const dir = path.join(CONFIG.MODELS_DIR, entry.name);
                    const key = `${from}-${to}`;

                    if (loadedModels.has(key)) {
                        console.log(`[Server] Model ${key} already loaded`);
                        continue;
                    }

                    // Load model files (also validates they exist)
                    const buffers = await loadModelFiles(dir);
                    const aligned = {};
                    const alignments = { model: 256, lex: 64, srcvocab: 64, trgvocab: 64 };
                    for (const [k, buf] of Object.entries(buffers)) {
                        aligned[k] = createAlignedMemory(buf, alignments[k]);
                    }

                    const vocabList = new bergamotModule.AlignedMemoryList();
                    vocabList.push_back(aligned.srcvocab);
                    vocabList.push_back(aligned.trgvocab);

                    const config = [
                        'beam-size: 1', 'normalize: 1.0', 'word-penalty: 0',
                        'max-length-break: 512', 'mini-batch-words: 1024', 'workspace: 128',
                        'max-length-factor: 2.0', 'skip-cost: true', 'cpu-threads: 0',
                        'quiet: true', 'quiet-translation: true',
                        'gemm-precision: int8shiftAlphaAll', 'alignment: soft'
                    ].join('\n');

                    const model = new bergamotModule.TranslationModel(from, to, config, aligned.model, aligned.lex, vocabList, null);
                    const service = new bergamotModule.BlockingService({ cacheSize: 0 });

                    loadedModels.set(key, { instance: model, service, from, to });
                    console.log(`[Server] Loaded model: ${key}`);
                    loaded++;

                } catch (err) {
                    console.log(`[Server] Skipping ${entry.name}: ${err.message}`);
                    failed++;
                }
            }
        }

        console.log(`[Server] Initial models: ${loaded} loaded, ${failed} skipped`);
    } catch (err) {
        console.log(`[Server] No initial models to load: ${err.message}`);
    }
}

// ============== Start Server ==============

async function start() {
    try {
        // Initialize Bergamot
        bergamotModule = await initBergamot();

        // Start Express server
        app.listen(CONFIG.PORT, CONFIG.IP, () => {
            console.log(`[Server] LinguaSpark listening on http://${CONFIG.IP}:${CONFIG.PORT}`);
            console.log(`[Server] Models directory: ${CONFIG.MODELS_DIR}`);
            if (CONFIG.API_KEY) console.log(`[Server] API key protection enabled`);
        });

        // Load initial models
        loadInitialModels();

    } catch (err) {
        console.error('[Server] Failed to start:', err);
        process.exit(1);
    }
}

// Shutdown
process.on('SIGTERM', () => {
    console.log('[Server] Shutting down...');
    for (const [key, model] of loadedModels) {
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