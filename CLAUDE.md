# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LinguaSpark Server is a Rust-based HTTP translation service using the Bergamot Translator engine (same as Firefox Translations). It provides a high-performance, low-memory translation API compatible with multiple frontend formats (Immersive Translate, Kiss Translator, HCFY, DeepLX).

## Development Commands

**Important:** Docker is the only supported deployment method. Local development is not recommended due to complex C++ dependencies (Bergamot).

```bash
# Build Docker image
docker build -t linguaspark-server .

# Build with English-Chinese model
docker build -f Dockerfile.enzh -t linguaspark-server:enzh .

# Run with Docker Compose
docker compose up -d

# Run manually with models
docker run -d -p 3000:3000 -v "$(pwd)/models:/app/models" ghcr.io/linguaspark/server:main
```

### Rust Commands (Limited Use)

```bash
# Check compilation (requires linguaspark library dependencies)
cargo check

# Format code
cargo fmt

# Lint
cargo clippy
```

**Note:** `cargo build` and `cargo run` will fail without the Bergamot C++ libraries properly configured. Use Docker for all testing and deployment.

## Architecture

### Source Structure

- `src/main.rs` - Axum web server setup, model loading, graceful shutdown
- `src/endpoint.rs` - HTTP API handlers for all translation formats
- `src/translation.rs` - Language detection and translation logic

### Core Components

**Translation Flow:**
1. Models are loaded at startup from `MODELS_DIR` (default: `/app/models`)
2. Model directories use 4-letter codes: `enzh/` (English→Chinese), `zhen/` (Chinese→English)
3. Each model directory contains: `model.intgemm8.bin`, `model.s2t.bin`, `srcvocab.spm`, `trgvocab.spm`
4. The `linguaspark::Translator` (external crate) handles the actual translation via Bergamot

**API Endpoints:**
- `POST /translate` - Native API
- `POST /kiss` - Kiss Translator compatibility
- `POST /imme` - Immersive Translate compatibility (batch translation)
- `POST /hcfy` - HCFY compatibility (converts Chinese language names)
- `POST /deeplx` - DeepLX compatibility
- `POST /detect` - Language detection via Whichlang
- `GET /health` - Health check

All endpoints support optional API key authentication via `Authorization: Bearer` header or `?token=` query parameter (configured via `API_KEY` env var).

### Key Dependencies

- `axum` - Web framework
- `linguaspark` - Translation library (external GitHub dependency: `LinguaSpark/core`)
- `whichlang` - Language detection
- `isolang` - ISO 639-1/639-3 language code handling

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MODELS_DIR` | `/app/models` | Path to translation models |
| `NUM_WORKERS` | `1` | Translation worker threads (~300MB+ memory per worker) |
| `IP` | `127.0.0.1` | Bind address |
| `PORT` | `3000` | Server port |
| `API_KEY` | `""` | API key (empty = no auth) |
| `RUST_LOG` | `info` | Log level |

### CNB Configuration

The `.cnb.yml` file defines a Cloud Native Build pipeline that:
1. Fetches English-Chinese model URLs from Mozilla's models.json API
2. Downloads model files automatically
3. Builds and pushes the specialized English-Chinese image

### Language Detection Behavior

- Uses Whichlang for automatic language detection when `from` is omitted or set to `"auto"`
- If only one model is loaded, that model's source language is used for auto-detection instead of Whichlang
- Returns original text unchanged if source and target languages are the same
- HCFY endpoint maps Chinese language names ("中文(简体)", "英语") to ISO codes internally
