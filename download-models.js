#!/usr/bin/env node
/**
 * LinguaSpark Model Downloader
 * Downloads the latest Bergamot translation models from Mozilla's server
 *
 * Usage:
 *   node download-models.js                    # Download all configured models
 *   node download-models.js --model en-zh      # Download specific model
 *   node download-models.js --list            # List available models
 *   node download-models.js --dir ./models    # Specify output directory
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const MODELS_JSON_URL = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json';
const OUTPUT_DIR = process.env.MODEL_DIR || './models';

// CLI args
const args = process.argv.slice(2);
const modelArg = args.find(a => a.startsWith('--model='))?.split('=')[1];
const dirArg = args.find(a => a.startsWith('--dir='))?.split('=')[1];
const listMode = args.includes('--list');
const helpMode = args.includes('--help') || args.includes('-h');

const targetDir = dirArg || OUTPUT_DIR;
const targetModel = modelArg;

// Download using curl with retry
async function downloadFile(url, destPath, retries = 3) {
    // Ensure parent directory exists
    await fs.mkdir(path.dirname(destPath), { recursive: true });

    for (let i = 0; i < retries; i++) {
        try {
            return await new Promise((resolve, reject) => {
                const proc = spawn('curl', ['-fsSL', '-C', '-', '-o', destPath, url], {
                    stdio: 'ignore'
                });

                proc.on('close', (code) => {
                    if (code === 0) {
                        console.log(`  Downloaded: ${path.basename(destPath)}`);
                        resolve();
                    } else {
                        reject(new Error(`curl failed (exit ${code})`));
                    }
                });
                proc.on('error', reject);
            });
        } catch (err) {
            if (i < retries - 1) {
                console.log(`  Retry ${i + 2}/${retries}...`);
                await new Promise(r => setTimeout(r, 2000));
            } else {
                throw err;
            }
        }
    }
}

// Decompress gzip
async function decompressFile(filePath) {
    if (filePath.endsWith('.gz')) {
        const zlib = await import('zlib');
        const gunzip = zlib.createGunzip();
        const input = fs.createReadStream(filePath);
        const output = fs.createWriteStream(filePath.replace(/\.gz$/, ''));
        await new Promise((resolve, reject) => {
            pipeline(input, gunzip, output, err => err ? reject(err) : resolve());
        });
        await fs.unlink(filePath);
        console.log(`  Decompressed: ${path.basename(filePath).replace(/\.gz$/, '')}`);
    }
}

// Fetch and parse models.json
async function getModelUrls() {
    console.log('Fetching models metadata...');
    const tempFile = path.join(__dirname, 'temp-models.json');
    await downloadFile(MODELS_JSON_URL, tempFile);
    const content = await fs.readFile(tempFile, 'utf-8');
    await fs.unlink(tempFile);
    return JSON.parse(content);
}

// List available models
async function listModels() {
    const data = await getModelUrls();
    const baseUrl = data.baseUrl;

    console.log('\nAvailable models:\n');
    console.log(`Generated: ${data.generated}`);
    console.log(`Base URL: ${baseUrl}\n`);

    const available = Object.keys(data.models).filter(k =>
        ['en-zh', 'en-ja', 'zh-en', 'en-ko', 'ja-en', 'ko-en', 'en-de', 'de-en', 'en-fr', 'fr-en'].includes(k)
    );

    for (const key of available) {
        const model = data.models[key][0];
        const arch = model.architecture;
        console.log(`  ${key} - ${model.sourceLanguage} → ${model.targetLanguage} (${arch})`);
    }
    console.log('');
}

// Download a single model
async function downloadModel(modelKey, baseUrl, modelData) {
    if (!modelData[modelKey] || modelData[modelKey].length === 0) {
        throw new Error(`Model ${modelKey} not found in registry`);
    }

    const model = modelData[modelKey][0];
    const files = model.files;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Downloading: ${model.sourceLanguage} → ${model.targetLanguage} (${model.architecture})`);
    console.log(`${'='.repeat(60)}\n`);

    const modelDir = path.join(targetDir, modelKey);
    await fs.mkdir(modelDir, { recursive: true });

    // Map file keys to download
    const fileMapping = {
        'lexicalShortlist': `${modelKey}/lex.bin`,
        'model': `${modelKey}/model.bin`,
        'srcVocab': `${modelKey}/srcvocab.spm`,
        'trgVocab': `${modelKey}/trgvocab.spm`,
        'vocab': `${modelKey}/vocab.spm`  // Some models use 'vocab' instead of srcVocab/trgVocab
    };

    for (const [key, filename] of Object.entries(fileMapping)) {
        if (!files[key]) {
            console.log(`  Skipping: ${key} (not available)`);
            continue;
        }

        const filePath = files[key].path;
        const destPath = path.join(modelDir, filename);

        console.log(`  Fetching: ${filename}...`);
        const url = `${baseUrl}/${filePath}`;

        try {
            await downloadFile(url, destPath);
            await decompressFile(destPath);
        } catch (err) {
            console.log(`  Failed: ${err.message}`);
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
  node download-models.js                    # Download all models
  node download-models.js --model=en-zh       # Download only en-zh
  node download-models.js --list              # Show available models
  node download-models.js --dir=./my-models  # Custom output dir

Environment:
  MODEL_DIR         Override default output directory
`);
        process.exit(0);
    }

    if (listMode) {
        await listModels();
        process.exit(0);
    }

    // Fetch models metadata
    const data = await getModelUrls();
    const baseUrl = data.baseUrl;

    // Determine models to download
    const modelsToDownload = targetModel
        ? [targetModel]
        : ['en-zh', 'en-ja'];  // Default models

    console.log(`\nOutput directory: ${path.resolve(targetDir)}`);
    console.log(`Models: ${modelsToDownload.join(', ')}\n`);

    for (const model of modelsToDownload) {
        try {
            await downloadModel(model, baseUrl, data.models);
        } catch (err) {
            console.error(`Failed to download ${model}: ${err.message}`);
            process.exit(1);
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log('All models downloaded successfully!');
    console.log(`\nTo use: Set MODELS_DIR=${path.resolve(targetDir)} or restart server`);
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});