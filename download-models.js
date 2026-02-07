#!/usr/bin/env node
/**
 * LinguaSpark Model Downloader
 * Downloads the latest Bergamot translation models from Mozilla's server
 *
 * Usage:
 *   node download-models.js                    # Download en-zh and en-ja
 *   node download-models.js --model en-zh    # Download specific model
 *   node download-models.js --list           # List available models
 *   node download-models.js --dir ./models   # Specify output directory
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import https from 'https';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mozilla's translation data CDN
const BASE_URL = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data';

// Model configurations - uses known file patterns from Mozilla
const MODEL_CONFIGS = {
    'en-zh': {
        name: 'English → Chinese',
        prefix: 'enzh',
        files: [
            { name: 'model.enzh.intgemm8.bin', key: 'model' },
            { name: 'lex.50.50.enzh.s2t.bin', key: 'lex' },
            { name: 'srcvocab.enzh.spm', key: 'srcVocab' },
            { name: 'trgvocab.enzh.spm', key: 'trgVocab' }
        ]
    },
    'en-ja': {
        name: 'English → Japanese',
        prefix: 'enja',
        files: [
            { name: 'model.enja.intgemm8.bin', key: 'model' },
            { name: 'lex.50.50.enja.s2t.bin', key: 'lex' },
            { name: 'srcvocab.enja.spm', key: 'srcVocab' },
            { name: 'trgvocab.enja.spm', key: 'trgVocab' }
        ]
    },
    'zh-en': {
        name: 'Chinese → English',
        prefix: 'zhen',
        files: [
            { name: 'model.zhen.intgemm8.bin', key: 'model' },
            { name: 'lex.50.50.zhen.s2t.bin', key: 'lex' },
            { name: 'srcvocab.zhen.spm', key: 'srcVocab' },
            { name: 'trgvocab.zhen.spm', key: 'trgVocab' }
        ]
    },
    'en-ko': {
        name: 'English → Korean',
        prefix: 'enko',
        files: [
            { name: 'model.enko.intgemm8.bin', key: 'model' },
            { name: 'lex.50.50.enko.s2t.bin', key: 'lex' },
            { name: 'srcvocab.enko.spm', key: 'srcVocab' },
            { name: 'trgvocab.enko.spm', key: 'trgVocab' }
        ]
    }
};

// CLI args
const args = process.argv.slice(2);
const modelArg = args.find(a => a.startsWith('--model='))?.split('=')[1];
const dirArg = args.find(a => a.startsWith('--dir='))?.split('=')[1];
const listMode = args.includes('--list');
const helpMode = args.includes('--help') || args.includes('-h');

const targetDir = dirArg || './models';
const targetModel = modelArg;

// Download helper using curl (more reliable on Windows)
async function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const proc = spawn('curl', ['-fsSL', '-C', '-', '-o', destPath, url], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);

        proc.on('close', (code) => {
            if (code === 0) {
                console.log(`  Downloaded: ${path.basename(destPath)}`);
                resolve();
            } else {
                reject(new Error(`curl failed (${code}): ${stderr}`));
            }
        });

        proc.on('error', reject);
    });
}

// Decompress gzip
async function decompressFile(filePath) {
    if (filePath.endsWith('.gz')) {
        const zlib = await import('zlib');
        const gunzip = zlib.createGunzip();
        const input = fs.createReadStream(filePath);
        const output = fs.createWriteStream(filePath.replace(/\.gz$/, ''));
        await pipeline(input, gunzip, output);
        await fs.unlink(filePath);
        console.log(`  Decompressed: ${path.basename(filePath).replace(/\.gz$/, '')}`);
    }
}

// List available models
function listModels() {
    console.log('\nAvailable models:\n');
    for (const [key, config] of Object.entries(MODEL_CONFIGS)) {
        console.log(`  ${key} - ${config.name}`);
    }
    console.log('');
}

// Download a single model
async function downloadModel(modelKey) {
    const config = MODEL_CONFIGS[modelKey];
    if (!config) {
        throw new Error(`Unknown model: ${modelKey}`);
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Downloading: ${config.name} (${modelKey})`);
    console.log(`${'='.repeat(60)}\n`);

    const modelDir = path.join(targetDir, modelKey);
    await fs.mkdir(modelDir, { recursive: true });

    for (const file of config.files) {
        const url = `${BASE_URL}/${modelKey}/${file.name}.gz`;
        const destPath = path.join(modelDir, file.name);

        console.log(`  Fetching: ${file.name}...`);
        try {
            await downloadFile(url, destPath);
            await decompressFile(destPath);
        } catch (err) {
            // Try without .gz extension
            const url2 = `${BASE_URL}/${modelKey}/${file.name}`;
            console.log(`  Trying: ${file.name} (no gzip)...`);
            try {
                await downloadFile(url2, destPath);
            } catch (err2) {
                console.log(`  Skipping: ${file.name} (not found)`);
            }
        }
    }

    console.log(`\nModel ${modelKey} -> ${modelDir}`);
}

// Main
async function main() {
    if (helpMode) {
        console.log(`
LinguaSpark Model Downloader

Usage:
  node download-models.js [options]

Options:
  --list          List available models
  --model=<name>  Download specific model (e.g., en-zh, en-ja, zh-en)
  --dir=<path>    Output directory (default: ./models)
  --help, -h      Show this help

Examples:
  node download-models.js                    # Download en-zh and en-ja
  node download-models.js --model=en-zh     # Download only en-zh
  node download-models.js --list            # Show available models
  node download-models.js --dir=./my-models # Custom output dir

Environment:
  MODEL_DIR         Override default output directory
`);
        process.exit(0);
    }

    if (listMode) {
        listModels();
        process.exit(0);
    }

    const modelsToDownload = targetModel
        ? [targetModel]
        : ['en-zh', 'en-ja'];

    console.log(`Output directory: ${path.resolve(targetDir)}`);
    console.log(`Models: ${modelsToDownload.join(', ')}\n`);

    for (const model of modelsToDownload) {
        try {
            await downloadModel(model);
        } catch (err) {
            console.error(`Failed: ${err.message}`);
            process.exit(1);
        }
    }

    console.log('\nDone!');
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});