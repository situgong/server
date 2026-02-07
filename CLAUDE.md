# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LinguaSpark Server is a Node.js HTTP translation service using the Bergamot Translator WASM engine (same as Firefox Translations). Single-process architecture running on Node.js >= 18.

## Quick Start

```bash
npm install
npm start  # Server runs on http://127.0.0.1:3000
npm run dev  # Hot reload
```

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start server |
| `npm run dev` | Run with hot reload |

## Architecture

```
server.js          - Main Express server (all endpoints, WASM loading, model management)
wasm/              - Bergamot WASM files
  bergamot-translator.wasm  - WASM binary (compiled C++)
  bergamot-translator.js    - Emscripten glue code with embind bindings
models/            - Translation model directories
```

### Key Implementation Details

**WASM Loading**: The Bergamot WASM module is loaded into a VM sandbox at server startup (`server.js:36-60`). This is required because Emscripten's embind generates browser-specific code.

**Model Management**:
- Models are stored in `models/{langPair}/` directories (e.g., `enzh/`, `zhen/`)
- Auto-loaded on startup from directories in `MODELS_DIR`
- Can also be loaded dynamically via `POST /models/load`
- Models are cached in memory (`loadedModels` Map)

**Language Detection**: Uses `franc` library with CJK character fallback heuristics (`server.js:158-183`)

**Language Name Mapping**: Supports both ISO 639-1 codes and human-readable names:
- `中文(简体)` → `zh`, `中文(繁体)` → `zh_Hant`
- English names like `chinese`, `japanese`, etc.

## API Endpoints

| Endpoint | Request | Response |
|----------|---------|----------|
| `POST /translate` | `{text, from?, to}` | `{text, from, to}` |
| `POST /kiss` | `{text, from?, to}` | `{text, from, to}` |
| `POST /imme` | `{source_lang?, target_lang, text_list[]}` | `{translations[]}` |
| `POST /hcfy` | `{text, source?, destination[]}` | `{text, from, to, result[]}` |
| `POST /deeplx` | `{text, source_lang, target_lang}` | `{code: 200, data, ...}` |
| `POST /detect` | `{text}` | `{language}` |
| `GET /health` | - | `{status, bergamotLoaded, loadedModels}` |
| `GET /models` | - | `{models[]}` |
| `POST /models/load` | `{from, to, modelDir?}` | `{success, key, from, to}` |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `IP` | `127.0.0.1` | Bind address |
| `MODELS_DIR` | `./models` | Models directory |
| `API_KEY` | `""` | API key authentication (empty = disabled) |
| `WASM_PATH` | `wasm/bergamot-translator.wasm` | WASM binary path |
| `JS_PATH` | `wasm/bergamot-translator.js` | JS glue code path |

## Authentication

When `API_KEY` is set, use header `Authorization: Bearer <key>` or query `?token=<key>`.

## Model Files

Model directory naming: `{fromLang}{toLang}` (e.g., `enzh`, `zhen`, `enja`)

Expected files:
- `model.intgemm8.bin` or `model.bin` - Translation model
- `model.s2t.bin` or `model.lex.bin` - Shortlist lexicon
- `srcvocab.spm` or `vocab.spm` - Source vocabulary
- `trgvocab.spm` or `vocab.spm` - Target vocabulary