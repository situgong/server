# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LinguaSpark Server is a Node.js HTTP translation service using the Bergamot Translator engine (same as Firefox Translations). Single-process architecture with no Rust dependencies.

## Quick Start

```bash
# Install dependencies
npm install

# Start server
npm start

# Server runs on http://127.0.0.1:3000
```

## Development

```bash
# Run with hot reload
npm run dev
```

## Architecture

```
server.js          - Main Express server with all endpoints
wasm/              - Bergamot WASM files
  bergamot-translator.wasm  - WASM binary
  bergamot-translator.js   - Emscripten glue code
models/            - Translation model files
```

## Model Files

Model directories use 4-letter codes: `enzh/` (English→Chinese), `zhen/` (Chinese→English)

Expected files:
- `model.intgemm8.bin` or `model.bin`
- `model.s2t.bin` (lexicon)
- `srcvocab.spm` (source vocabulary)
- `trgvocab.spm` (target vocabulary)

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /translate` | Native translation API |
| `POST /kiss` | Kiss Translator compatibility |
| `POST /imme` | Immersive Translate (batch) |
| `POST /hcfy` | HCFY compatibility |
| `POST /deeplx` | DeepLX compatibility |
| `POST /detect` | Language detection |
| `GET /health` | Health check |
| `GET /models` | List loaded models |
| `POST /models/load` | Load a model |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `IP` | `127.0.0.1` | Bind address |
| `MODELS_DIR` | `./models` | Models directory |
| `API_KEY` | `""` | API key (empty = no auth) |
| `WASM_PATH` | `wasm/bergamot-translator.wasm` | WASM path |
| `JS_PATH` | `wasm/bergamot-translator.js` | JS glue path |

## API Key

Set `API_KEY` environment variable. Use header `Authorization: Bearer <key>` or query `?token=<key>`.

## Why Bergamot WASM?

The Bergamot WASM uses Emscripten's embind system requiring complex C++ runtime support. Node.js provides:
- Native WASI support
- Full embind compatibility
- Simple integration

This is the same approach used by MTranServer.