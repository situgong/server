# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LinguaSpark Server is a Rust-based HTTP translation service using the Bergamot Translator engine (same as Firefox Translations). It uses a hybrid architecture with Rust for the HTTP server and Node.js for WASM translation.

## Architecture

```
Rust Server (Port 3000) <--HTTP--> Node.js Worker (Port 3001) <--WASM--> Bergamot
```

### Source Structure

- `src/main.rs` - Axum web server, spawns Node.js worker
- `src/endpoint.rs` - HTTP API handlers for all translation formats
- `src/translation.rs` - Translation client (talks to Node.js worker)
- `wasm-worker.js` - Node.js sidecar that loads and runs Bergamot WASM
- `wasm/bergamot-translator.js` - Official Emscripten glue code
- `wasm/bergamot-translator.wasm` - Compiled Bergamot translator

## Development Commands

```bash
# Install Node dependencies for the worker
npm install

# Build Rust server
cargo build --release

# Run both Rust server and Node.js worker (from project root)
cargo run --release

# Run Node.js worker separately
node wasm-worker.js
```

### Rust Commands

```bash
# Check compilation
cargo check

# Format code
cargo fmt

# Lint
cargo clippy

# Inspect WASM module
cargo run --bin inspect
```

## Translation Flow

1. Rust server starts and spawns `wasm-worker.js` as a child process
2. Worker loads `bergamot-translator.wasm` + `bergamot-translator.js` via Node.js
3. On `/translate` request, Rust forwards to `localhost:3001/translate`
4. Node.js worker performs translation using Bergamot WASM
5. Response returned to client

## Model Files

Model directories use 4-letter codes: `enzh/` (English→Chinese), `zhen/` (Chinese→English)

Expected files:
- `model.intgemm8.bin` or `model.enzh.intgemm.alphas.bin`
- `model.s2t.bin` or `lex.50.50.enzh.s2t.bin`
- `srcvocab.spm`
- `trgvocab.spm`

## API Endpoints

All endpoints on port 3000:

- `POST /translate` - Native API
- `POST /kiss` - Kiss Translator compatibility
- `POST /imme` - Immersive Translate compatibility (batch)
- `POST /hcfy` - HCFY compatibility (converts Chinese language names)
- `POST /deeplx` - DeepLX compatibility
- `POST /detect` - Language detection via Whichlang
- `GET /health` - Health check

Optional API key via `Authorization: Bearer <key>` or `?token=<key>`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MODELS_DIR` | `./models` | Path to translation models |
| `PORT` | `3000` | Rust server port |
| `WORKER_PORT` | `3001` | Node.js worker port |
| `IP` | `127.0.0.1` | Bind address |
| `API_KEY` | `""` | API key (empty = no auth) |
| `RUST_LOG` | `info` | Log level |

## Why Node.js Sidecar?

The Bergamot WASM uses Emscripten's embind system which requires complex C++ runtime support (50+ imports like `_embind_register_*`, `__cxa_*`, WASI). Using Node.js as the WASM runtime provides:
- Native WASI support
- Full embind compatibility
- Simpler integration than reimplementing in Rust
- Proven approach (used by MTranServer)

## Language Detection

- Uses Whichlang for automatic detection when `from` is omitted or `"auto"`
- If only one model loaded, uses that model's source language
- Returns original text if source == target
- HCFY endpoint maps Chinese names to ISO codes