#!/usr/bin/env node
/**
 * Bergamot WASM Translation Worker
 * Runs as a sidecar process to the Rust server
 * Uses Node.js built-in WASI and embind support
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load bergamot-translator.js and execute in a sandbox to get loadBergamot
const wasmDir = path.join(__dirname, 'wasm');
const bergamotJsPath = path.join(wasmDir, 'bergamot-translator.js');
const bergamotJsContent = await fs.readFile(bergamotJsPath, 'utf-8');

// Create a sandbox with required globals
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
    // Add more built-ins as needed by the glue code
    Error: Error,
    TypeError: TypeError,
    Map: Map,
    Set: Set,
    Promise: Promise,
};

// Create context and run the code
vm.createContext(sandbox);
vm.runInContext(bergamotJsContent, sandbox);

// Get the loadBergamot function from the sandbox (defined by bergamot-translator.js)
const loadBergamotFromSandbox = sandbox.loadBergamot;

// Configuration
const PORT = process.env.WORKER_PORT || 3001;
const MODEL_DIR = process.env.MODEL_DIR || './models';

const app = express();
app.use(cors());
app.use(express.json());

// Bergamot module and state
let bergamotModule = null;
const loadedModels = new Map(); // key: "from-to", value: model object

/**
 * Load Bergamot WASM module
 */
async function initBergamot() {
    const wasmPath = process.env.WASM_PATH || path.join(__dirname, 'wasm', 'bergamot-translator.wasm');

    console.log(`[Worker] Loading WASM from: ${wasmPath}`);

    const wasmBinary = await fs.readFile(wasmPath);

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('WASM initialization timeout'));
        }, 60000);

        loadBergamotFromSandbox({
            wasmBinary: wasmBinary.buffer,
            print: (msg) => console.log(`[Bergamot]: ${msg}`),
            printErr: (msg) => console.error(`[Bergamot Error]: ${msg}`),
            onAbort: (msg) => {
                console.error(`[Bergamot Abort]: ${msg}`);
                reject(new Error(`WASM aborted: ${msg}`));
            },
            onRuntimeInitialized: function() {
                console.log('[Worker] Bergamot runtime initialized');
                clearTimeout(timeout);
                resolve(this);
            }
        });
    });
}

/**
 * Load model files from directory
 */
async function loadModelFiles(modelPath) {
    const files = {};

    // Read all files in the directory and match them
    const entries = await fs.readdir(modelPath, { withFileTypes: true });

    for (const entry of entries) {
        const name = entry.name.toLowerCase();
        if (name.endsWith('.spm')) {
            if (name.startsWith('srcvocab')) {
                files.srcvocab = await fs.readFile(path.join(modelPath, entry.name));
                console.log(`[Worker] Loaded srcvocab: ${entry.name} (${files.srcvocab.byteLength} bytes)`);
            } else if (name.startsWith('trgvocab')) {
                files.trgvocab = await fs.readFile(path.join(modelPath, entry.name));
                console.log(`[Worker] Loaded trgvocab: ${entry.name} (${files.trgvocab.byteLength} bytes)`);
            }
        } else if (name.endsWith('.bin')) {
            if (name.includes('s2t') || name.includes('lex')) {
                files.lex = await fs.readFile(path.join(modelPath, entry.name));
                console.log(`[Worker] Loaded lex: ${entry.name} (${files.lex.byteLength} bytes)`);
            } else if (name.includes('model') || name.includes('intgemm')) {
                files.model = await fs.readFile(path.join(modelPath, entry.name));
                console.log(`[Worker] Loaded model: ${entry.name} (${files.model.byteLength} bytes)`);
            }
        }
    }

    // Check for required files
    if (!files.model) throw new Error('Model file not found');
    if (!files.lex) throw new Error('Lexicon file not found');
    if (!files.srcvocab) throw new Error('Source vocabulary not found');
    if (!files.trgvocab) throw new Error('Target vocabulary not found');

    return files;
}

/**
 * Create aligned memory from buffer
 */
function createAlignedMemory(module, buffer, alignment = 64) {
    const aligned = new module.AlignedMemory(buffer.length || buffer.byteLength, alignment);
    const view = aligned.getByteArrayView();
    view.set(new Uint8Array(buffer));
    return aligned;
}

/**
 * Translate text
 */
function translate(model, text) {
    const msgs = new bergamotModule.VectorString();
    const opts = new bergamotModule.VectorResponseOptions();

    try {
        msgs.push_back(text);
        opts.push_back({
            qualityScores: false,
            alignment: false,
            html: false
        });

        const responses = model.service.translate(model.instance, msgs, opts);
        const result = responses.get(0).getTranslatedText();

        responses.delete();
        msgs.delete();
        opts.delete();

        return result;
    } catch (err) {
        console.error('[Worker] Translation error:', err);
        msgs.delete();
        opts.delete();
        throw err;
    }
}

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        bergamotLoaded: bergamotModule !== null,
        loadedModels: Array.from(loadedModels.keys())
    });
});

// Load model endpoint
app.post('/load-model', async (req, res) => {
    const { from, to, modelDir } = req.body;

    if (!from || !to) {
        return res.status(400).json({ error: 'Missing from or to language' });
    }

    const key = `${from}-${to}`;
    // Normalize path to handle Windows backslashes and escape sequences
    const normalizedModelDir = modelDir ? path.normalize(modelDir) : null;
    const dir = normalizedModelDir || path.join(MODEL_DIR, `${from}${to}`);

    console.log(`[Worker] Loading model: ${key} from ${dir}`);

    try {
        if (!bergamotModule) {
            bergamotModule = await loadBergamot();
        }

        const buffers = await loadModelFiles(dir);

        const MODEL_FILE_ALIGNMENTS = {
            model: 256,
            lex: 64,
            srcvocab: 64,
            trgvocab: 64
        };

        const alignedMemories = {};
        for (const [key, buffer] of Object.entries(buffers)) {
            alignedMemories[key] = createAlignedMemory(bergamotModule, buffer, MODEL_FILE_ALIGNMENTS[key]);
        }

        const vocabList = new bergamotModule.AlignedMemoryList();
        vocabList.push_back(alignedMemories.srcvocab);
        vocabList.push_back(alignedMemories.trgvocab);

        const config = [
            'beam-size: 1',
            'normalize: 1.0',
            'word-penalty: 0',
            'max-length-break: 512',
            'mini-batch-words: 1024',
            'workspace: 128',
            'max-length-factor: 2.0',
            'skip-cost: true',
            'cpu-threads: 0',
            'quiet: true',
            'quiet-translation: true',
            'gemm-precision: int8shiftAlphaAll',
            'alignment: soft'
        ].join('\n');

        const model = new bergamotModule.TranslationModel(
            from,
            to,
            config,
            alignedMemories.model,
            alignedMemories.lex,
            vocabList,
            null
        );

        const service = new bergamotModule.BlockingService({ cacheSize: 0 });

        loadedModels.set(key, {
            instance: model,
            service,
            from,
            to
        });

        console.log(`[Worker] Model loaded: ${key}`);

        res.json({
            success: true,
            key,
            from,
            to
        });
    } catch (err) {
        console.error(`[Worker] Failed to load model ${key}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Translate endpoint
app.post('/translate', async (req, res) => {
    const { text, from, to } = req.body;

    if (!text || !from || !to) {
        return res.status(400).json({ error: 'Missing text, from, or to' });
    }

    const key = `${from}-${to}`;
    const model = loadedModels.get(key);

    if (!model) {
        return res.status(400).json({ error: `Model not loaded: ${key}` });
    }

    try {
        const result = translate(model, text);
        res.json({
            text: result,
            from,
            to
        });
    } catch (err) {
        console.error(`[Worker] Translation failed for ${key}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Start server
async function start() {
    try {
        // Load Bergamot module at startup
        bergamotModule = await initBergamot();

        app.listen(PORT, '127.0.0.1', () => {
            console.log(`[Worker] Translation worker listening on http://127.0.0.1:${PORT}`);
        });
    } catch (err) {
        console.error('[Worker] Failed to start:', err);
        process.exit(1);
    }
}

// Handle shutdown
process.on('SIGTERM', () => {
    console.log('[Worker] Shutting down...');
    // Clean up models
    for (const [key, model] of loadedModels) {
        try {
            model.instance.delete();
            model.service.delete();
        } catch {}
    }
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('[Worker] Interrupted');
    process.exit(0);
});

start();