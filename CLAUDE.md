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
models/            - Translation model directories (e.g., en-zh/, zh-en/)
public/            - Web UI and Swagger documentation
  index.html       - Translation web UI
  openapi.json     - OpenAPI 3.0 specification
```

### Key Implementation Details

**WASM Loading**: The Bergamot WASM module is loaded into a VM sandbox at server startup (`server.js:36-89`). Emscripten's embind requires browser APIs, so a VM sandbox is used.

**Model Management**:
- Models stored in `models/{from}-{to}/` directories (e.g., `enzh/`, `en-zh/`, `zh-en/`)
- Supports both `enzh` and `en-zh` directory naming conventions
- Auto-discovered on startup from directories in `MODELS_DIR`
- On-demand loading via `POST /models/load`
- Loading locks prevent duplicate concurrent loads (`loadingLocks` Map)
- Buffer preloading for faster first translation
- Models cached in memory (`availableModels` Map)
- Only one active model at a time (WASM memory constraint)

**Pivot Translation**: Supports translation via English when direct model is unavailable (`server.js:188-224`)

**Language Detection**: Uses `franc` library with CJK character fallback heuristics (`server.js:454-479`)

**Language Name Mapping**: Supports ISO 639-1 codes and human-readable names:
- `中文(简体)` → `zh`, `中文(繁体)` → `zh_Hant`
- English names like `chinese`, `japanese`, etc.

## API Endpoints

| Endpoint | Request | Response |
|----------|---------|----------|
| `GET /` | - | Web UI (Translation interface) |
| `GET /docs/` | - | Swagger API Documentation |
| `GET /openapi.json` | - | OpenAPI 3.0 spec |
| `POST /translate` | `{text, from?, to}` | `{text, from, to}` |
| `POST /kiss` | `{text, from?, to}` | `{text, from, to}` |
| `POST /imme` | `{source_lang?, target_lang, text_list[]}` | `{translations[]}` |
| `POST /hcfy` | `{text, source?, destination[]}` | `{text, from, to, result[]}` |
| `POST /deeplx` | `{text, source_lang, target_lang}` | `{code: 200, data, ...}` |
| `POST /detect` | `{text}` | `{language}` |
| `GET /health` | - | `{status, bergamotLoaded, availableModels}` |
| `GET /models` | - | `{models[]}` |
| `POST /models/load` | `{from, to, modelDir?}` | `{success, key, from, to}` |
| `POST /translate_mtranserver` | `{from, to, text, html?}` | `{result}` |
| `POST /translate_mtranserver/batch` | `{from, to, texts[], html?}` | `{results[]}` |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `IP` | `127.0.0.1` | Bind address |
| `MODELS_DIR` | `./models` | Models directory |
| `API_KEY` | `""` | API key authentication (empty = disabled) |
| `WASM_PATH` | `wasm/bergamot-translator.wasm` | WASM binary path |
| `JS_PATH` | `wasm/bergamot-translator.js` | JS glue code path |

## Docker Deployment

```bash
# Create models directory
mkdir -p models
# Download your models here

# Run with Docker
docker run -d --name translation-service \
  -p 3000:3000 \
  -v "$(pwd)/models:/app/models" \
  ghcr.io/linguaspark/server:main
```

## Docker Compose

```yaml
services:
  translation-service:
    image: ghcr.io/linguaspark/server:main
    ports:
      - "3000:3000"
    volumes:
      - ./models:/app/models
    environment:
      API_KEY: "your_api_key"  # Optional, leave empty to disable
    restart: unless-stopped
```

## Authentication

When `API_KEY` is set, use header `Authorization: Bearer <key>` or query `?token=<key>`.

## Model Files

Model directory naming: `{from}-{to}` (e.g., `en-zh`, `zh-en`, `en-ja`) or `{fromLang}{toLang}` (e.g., `enzh`, `zhen`)

Expected files:
- `model.intgemm8.bin`, `model.intgemm.alphas.bin`, or `model.bin` - Translation model
- `model.s2t.bin`, `lex.50.50.s2t.bin`, or `lex.bin` - Shortlist lexicon
- `srcvocab.xxen.spm` or `vocab.xxen.spm` - Source vocabulary
- `trgvocab.xxen.spm` or `vocab.xxen.spm` - Target vocabulary

Single `vocab.spm` file can be used for both source and target vocabulary.