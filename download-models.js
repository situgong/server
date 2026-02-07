#!/usr/bin/env node
/**
 * LinguaSpark Model Downloader
 * Downloads the latest Bergamot translation models from Mozilla's server
 *
 * Usage:
 *   node download-models.js                    # Download all configured models
 *   node download-models.js --model en-zh      # Download specific model
 *   node download-models.js --list             # List available models
 *   node download-models.js --dir ./models     # Specify output directory
 *   node download-models.js --check            # Check for updates
 *   node download-models.js --all              # Download all available models
 */

import fs from 'fs/promises';
import fss from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import zlib from 'zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const MODELS_JSON_URL = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json';
const OUTPUT_DIR = process.env.MODEL_DIR || './models';

// CLI args
const args = process.argv.slice(2);
const modelArg = args.find(a => a.startsWith('--model='))?.split('=')[1];
const dirArg = args.find(a => a.startsWith('--dir='))?.split('=')[1];
const listMode = args.includes('--list');
const checkMode = args.includes('--check');
const allMode = args.includes('--all');
const helpMode = args.includes('--help') || args.includes('-h');

const targetDir = dirArg || OUTPUT_DIR;
const targetModel = modelArg;

// Supported language pairs
const DEFAULT_MODELS = ['en-zh', 'en-ja', 'zh-en', 'en-ko', 'ja-en', 'ko-en', 'en-de', 'de-en', 'en-fr', 'fr-en', 'en-es', 'es-en', 'en-ru', 'ru-en', 'en-pt', 'pt-en'];

// Download with retry and progress
async function downloadFile(url, destPath, retries = 3) {
    await fs.mkdir(path.dirname(destPath), { recursive: true });

    const fileName = path.basename(destPath);
    let attempt = 0;

    while (attempt < retries) {
        try {
            // Get file size for progress
            let downloadedSize = 0;
            let fileSize = 0;

            return new Promise((resolve, reject) => {
                const proc = spawn('curl', ['-fsSL', '-C', '-', '-o', destPath, url], {
                    stdio: 'ignore'
                });

                proc.stdout?.on('data', (data) => {
                    process.stdout.write(`\r  ${fileName}: ${data.toString().trim()}`);
                });

                proc.on('close', (code) => {
                    if (code === 0) {
                        console.log(`\r  ${fileName}: Done`);
                        resolve();
                    } else {
                        reject(new Error(`curl failed (exit ${code})`));
                    }
                });
                proc.on('error', reject);
            });
        } catch (err) {
            attempt++;
            if (attempt < retries) {
                console.log(`  Retry ${attempt}/${retries} for ${fileName}...`);
                await new Promise(r => setTimeout(r, 1000 * attempt));
            } else {
                throw err;
            }
        }
    }
}

// Decompress gzip
async function decompressFile(filePath) {
    if (filePath.endsWith('.gz')) {
        const gunzip = zlib.createGunzip();
        const input = fss.createReadStream(filePath);
        const output = fss.createWriteStream(filePath.replace(/\.gz$/, ''));
        await pipeline(input, gunzip, output);
        await fs.unlink(filePath);
        console.log(`  Decompressed: ${path.basename(filePath).replace(/\.gz$/, '')}`);
    }
}

// Fetch and parse models.json
async function getModelUrls(saveToFile = true) {
    console.log('Fetching models metadata...');
    const tempFile = path.join(__dirname, 'temp-models.json');
    await downloadFile(MODELS_JSON_URL, tempFile);
    const content = await fs.readFile(tempFile, 'utf-8');
    await fs.unlink(tempFile);

    const data = JSON.parse(content);

    // Save models.json to target directory
    if (saveToFile) {
        const modelsJsonPath = path.join(targetDir, 'models.json');
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(modelsJsonPath, JSON.stringify(data, null, 2));
        console.log(`  Saved models.json to ${modelsJsonPath}`);
    }

    return data;
}

// Load local models.json if exists
async function getLocalModelsJson() {
    const localPath = path.join(targetDir, 'models.json');
    try {
        const content = await fs.readFile(localPath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return null;
    }
}

// List available models
async function listModels() {
    const data = await getModelUrls(false);
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

// Check for model updates
async function checkUpdates() {
    console.log('\n=== CHECKING FOR UPDATES ===\n');

    const localData = await getLocalModelsJson();
    const remoteData = await getModelUrls(false);

    if (!localData) {
        console.log('No local models.json found. Run download to create one.');
        return;
    }

    console.log(`Local:  ${localData.generated}`);
    console.log(`Remote: ${remoteData.generated}\n`);

    const baseUrl = remoteData.baseUrl;
    const updates = [];

    for (const [key, models] of Object.entries(remoteData.models)) {
        if (!['en-zh', 'en-ja', 'zh-en', 'en-ko'].includes(key)) continue;

        const localModel = localData.models[key]?.[0];
        const remoteModel = models[0];

        if (!localModel) {
            updates.push({ key, action: 'new', model: remoteModel });
        } else {
            // Check version or timestamp
            const localGen = localData.generated;
            const remoteGen = remoteData.generated;
            if (remoteGen > localGen) {
                updates.push({ key, action: 'update', model: remoteModel });
            }
        }
    }

    if (updates.length === 0) {
        console.log('All models are up to date.');
    } else {
        console.log('Updates available:');
        for (const u of updates) {
            console.log(`  ${u.key}: ${u.action}`);
        }
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

    // Use hyphenated name for folder (en-zh, en-ja, etc.)
    const folderName = modelKey;  // Already uses hyphens
    const modelDir = path.join(targetDir, folderName);
    await fs.mkdir(modelDir, { recursive: true });

    // Download lexical shortlist with original filename
    if (files.lexicalShortlist) {
        const filePath = files.lexicalShortlist.path;
        const origName = path.basename(filePath).replace(/\.gz$/, '');
        const destPath = path.join(modelDir, origName);
        const tempPath = destPath + '.gz';
        await downloadFile(`${baseUrl}/${filePath}`, tempPath);
        await decompressFile(tempPath);
    }

    // Download model with original filename
    if (files.model) {
        const filePath = files.model.path;
        const origName = path.basename(filePath).replace(/\.gz$/, '');
        const destPath = path.join(modelDir, origName);
        const tempPath = destPath + '.gz';
        await downloadFile(`${baseUrl}/${filePath}`, tempPath);
        await decompressFile(tempPath);
    }

    // Download vocabularies with original filenames
    if (files.srcVocab && files.trgVocab) {
        const srcPath = files.srcVocab.path;
        const trgPath = files.trgVocab.path;
        const srcDest = path.join(modelDir, path.basename(srcPath).replace(/\.gz$/, ''));
        const trgDest = path.join(modelDir, path.basename(trgPath).replace(/\.gz$/, ''));

        await downloadFile(`${baseUrl}/${srcPath}`, srcDest + '.gz');
        await decompressFile(srcDest + '.gz');

        await downloadFile(`${baseUrl}/${trgPath}`, trgDest + '.gz');
        await decompressFile(trgDest + '.gz');
    } else if (files.vocab) {
        const filePath = files.vocab.path;
        const origName = path.basename(filePath).replace(/\.gz$/, '');
        const destPath = path.join(modelDir, origName);
        const tempPath = destPath + '.gz';
        await downloadFile(`${baseUrl}/${filePath}`, tempPath);
        await decompressFile(tempPath);

        // Copy vocab as both src and trg
        await fs.copyFile(destPath, path.join(modelDir, 'srcvocab.spm'));
        await fs.copyFile(destPath, path.join(modelDir, 'trgvocab.spm'));
        console.log(`  Copied vocab as srcvocab.spm and trgvocab.spm`);
    }

    console.log(`\nModel ${modelKey} -> ${modelDir}`);
}

// Rename old folders to new naming convention
async function renameFolders() {
    console.log('\n=== RENAMING FOLDERS ===\n');

    const renames = [
        ['enja', 'en-ja'],
        ['enzh', 'en-zh'],
        ['zhen', 'zh-en'],
        ['enko', 'en-ko'],
        ['jaen', 'ja-en'],
        ['koen', 'ko-en'],
    ];

    for (const [oldName, newName] of renames) {
        const oldPath = path.join(targetDir, oldName);
        const newPath = path.join(targetDir, newName);

        try {
            const stats = await fs.stat(oldPath);
            if (stats.isDirectory()) {
                await fs.rename(oldPath, newPath);
                console.log(`  Renamed: ${oldName} -> ${newName}`);
            }
        } catch {
            // Folder doesn't exist, skip
        }
    }
    console.log('');
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
  --check         Check for model updates
  --model=<name>  Download specific model (e.g., en-zh, en-ja, zh-en)
  --all           Download all supported models
  --dir=<path>    Output directory (default: ./models)
  --rename        Rename old folders (enja -> en-ja, enzh -> en-zh)
  --help, -h      Show this help

Examples:
  node download-models.js                    # Download default models
  node download-models.js --all             # Download all models
  node download-models.js --model=en-zh       # Download only en-zh
  node download-models.js --list              # Show available models
  node download-models.js --check             # Check for updates
  node download-models.js --rename            # Rename folders
  node download-models.js --dir=./my-models   # Custom output dir

Environment:
  MODEL_DIR         Override default output directory
`);
        process.exit(0);
    }

    // Rename folders if requested
    if (args.includes('--rename')) {
        await renameFolders();
    }

    if (listMode) {
        await listModels();
        process.exit(0);
    }

    if (checkMode) {
        await checkUpdates();
        process.exit(0);
    }

    // Fetch models metadata (this saves models.json)
    const data = await getModelUrls(true);
    const baseUrl = data.baseUrl;

    // Determine models to download
    let modelsToDownload;
    if (targetModel) {
        modelsToDownload = [targetModel];
    } else if (allMode) {
        // Download all models from DEFAULT_MODELS that exist in registry
        modelsToDownload = DEFAULT_MODELS.filter(m => data.models[m]);
    } else {
        // Default: download en-zh, en-ja
        modelsToDownload = ['en-zh', 'en-ja'];
    }

    console.log(`\nOutput directory: ${path.resolve(targetDir)}`);
    console.log(`Models: ${modelsToDownload.join(', ')}\n`);

    let successCount = 0;
    for (const model of modelsToDownload) {
        try {
            await downloadModel(model, baseUrl, data.models);
            successCount++;
        } catch (err) {
            console.error(`Failed to download ${model}: ${err.message}`);
        }
    }

    console.log('\n' + '='.repeat(60));
    if (successCount > 0) {
        console.log(`Downloaded ${successCount}/${modelsToDownload.length} models successfully!`);
    } else {
        console.log('No models were downloaded.');
        process.exit(1);
    }
    console.log(`\nTo use: Set MODELS_DIR=${path.resolve(targetDir)} or restart server`);
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});