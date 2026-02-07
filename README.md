# LinguaSpark - Translation Service

[![GitHub Repo](https://img.shields.io/badge/GitHub-Repository-blue.svg)](https://github.com/LinguaSpark/server)
[![Docker Image](https://img.shields.io/badge/Docker-Image-blue.svg)](https://github.com/LinguaSpark/server/pkgs/container/translation-service)

A lightweight multilingual translation service based on Node.js and Bergamot WASM translation engine, compatible with multiple translation frontend APIs.

[简体中文](README_ZH.md)

## Project Background

This project originated when I discovered the [MTranServer](https://github.com/xxnuo/MTranServer/) repository, which uses [Firefox Translations Models](https://github.com/mozilla/firefox-translations-models/) for machine translation and is compatible with APIs like Immersive Translate and Kiss Translator, but found that it wasn't open-sourced yet.

While searching for similar projects, I found Mozilla's [translation-service](https://github.com/mozilla/translation-service/), which works but hasn't been updated for a year and isn't compatible with Immersive Translate or Kiss Translator APIs. I built this project using Node.js with the Bergamot WASM runtime.

## Features

- 🚀 Built on Node.js >= 18 for simplicity and broad compatibility
- 🔄 Based on [Bergamot Translator](https://github.com/browsermt/bergamot-translator) WASM engine used in Firefox
- 🧠 Compatible with [Firefox Translations Models](https://github.com/mozilla/firefox-translations-models/)
- 🌐 Browser-based translation UI (no API tools needed)
- 📚 Interactive API documentation via Swagger UI
- 🔍 Built-in language detection with automatic source language identification
- 💾 On-demand model loading with memory optimization (only one model active at a time)
- 🔀 Pivot translation via English when direct model unavailable
- 🔌 Multiple translation API compatibility:
  - Native API
  - [Immersive Translate](https://immersivetranslate.com/) API
  - [Kiss Translator](https://www.kis-translator.com/) API
  - [HCFY](https://hcfy.app/) API
  - [DeepLX](https://github.com/OwO-Network/DeepLX) API
  - MTranServer API (single and batch)
- 🔑 API key protection support

## Tech Stack

- **Web Framework**: [Express](https://expressjs.com/)
- **Translation Engine**: [Bergamot Translator WASM](https://github.com/browsermt/bergamot-translator)
- **Translation Models**: [Firefox Translations Models](https://github.com/mozilla/firefox-translations-models/)
- **Language Detection**: [franc](https://github.com/wooorm/franc)

## Quick Start

```bash
# Install dependencies
npm install

# Start server
npm start

# Server runs on http://127.0.0.1:3000

# Development with hot reload
npm run dev
```

## Web Interface

After starting the server, access:

- **Translation UI**: http://127.0.0.1:13000/ - Browser-based translation interface
- **API Documentation**: http://127.0.0.1:13000/docs/ - Swagger UI for all API endpoints
- **Monitor**: http://127.0.0.1:13000/monitor.html - Real-time translation log and system resources monitoring

## Deployment

### Local Deployment

1. Create models directory:
```bash
mkdir -p models
```

2. Download translation models (see [Models](#translation-models) section)

3. Start the service:
```bash
npm start
```

### Docker Deployment

```bash
# Create models directory
mkdir -p models
# Download your models here

# Pull and start container
docker run -d --name translation-service \
  -p 13000:3000 \
  -v "$(pwd)/models:/app/models" \
  ghcr.io/linguaspark/server:main
```

### Docker Compose

Create `compose.yaml`:

```yaml
services:
  translation-service:
    image: ghcr.io/linguaspark/server:main
    ports:
      - "13000:3000"
    volumes:
      - ./models:/app/models
    environment:
      API_KEY: "your_api_key"  # Optional, leave empty to disable
    restart: unless-stopped
```

Start the service:
```bash
docker compose up -d
```

## Translation Models

### Getting Models

1. Download pre-trained models from [Firefox Translations Models](https://github.com/mozilla/firefox-translations-models/)
2. Place them in the models directory:

```
models/
├── en-zh/  # English to Chinese
│   ├── model.intgemm8.bin  # Translation model
│   ├── model.s2t.bin       # Shortlist file
│   ├── srcvocab.xxen.spm    # Source vocabulary
│   └── trgvocab.xxen.spm    # Target vocabulary
└── zh-en/  # Chinese to English
    └── ...
```

### Directory Naming Convention

Model directories use `[source]-[target]` or `[source][target]` format with [ISO 639-1](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes):
- `en-zh` or `enzh` - English to Chinese
- `zh-en` or `zhen` - Chinese to English
- `en-ja` - English to Japanese
- `ja-en` - Japanese to English

The service auto-discovers all model directories on startup.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `IP` | Bind address | `127.0.0.1` |
| `MODELS_DIR` | Models directory | `./models` |
| `API_KEY` | API key (empty to disable) | `""` |
| `WASM_PATH` | WASM binary path | `wasm/bergamot-translator.wasm` |
| `JS_PATH` | JS glue code path | `wasm/bergamot-translator.js` |

## API Endpoints

### Native API

**Translate**
```
POST /translate
```

Request:
```json
{
  "text": "Hello world",
  "from": "en",  // Optional, omit to auto-detect
  "to": "zh"
}
```

Response:
```json
{
  "text": "你好世界",
  "from": "en",
  "to": "zh"
}
```

**Language Detection**
```
POST /detect
```

Request:
```json
{
  "text": "Hello world"
}
```

Response:
```json
{
  "language": "en"
}
```

### Compatible APIs

**Immersive Translate API**
```
POST /imme
```
```json
{
  "source_lang": "auto",
  "target_lang": "zh",
  "text_list": ["Hello world"]
}
```

**Kiss Translator API**
```
POST /kiss
```
```json
{
  "text": "Hello world",
  "from": "en",
  "to": "zh"
}
```

**HCFY API**
```
POST /hcfy
```
```json
{
  "text": "Hello world",
  "source": "英语",
  "destination": ["中文(简体)"]
}
```

**DeepLX API**
```
POST /deeplx
```
```json
{
  "text": "Hello world",
  "source_lang": "EN",
  "target_lang": "ZH"
}
```

**MTranServer API (Single)**
```
POST /translate_mtranserver
```
```json
{
  "from": "en",
  "to": "zh",
  "text": "Hello world",
  "html": false
}
```

Response:
```json
{
  "result": "你好世界"
}
```

**MTranServer API (Batch)**
```
POST /translate_mtranserver/batch
```
```json
{
  "from": "en",
  "to": "zh",
  "texts": ["Hello world", "How are you?"],
  "html": false
}
```

Response:
```json
{
  "results": ["你好世界", "你好吗?"]
}
```

**Health Check**
```
GET /health
```

**System Stats (Monitor)**
```
GET /monitor/system
```
Returns memory usage (heap, RSS, external) and CPU usage in microseconds.

## Authentication

When `API_KEY` is set, authenticate using:

1. Header: `Authorization: Bearer <key>`
2. Query: `?token=<key>`

## License

AGPL-3.0

## Acknowledgements

- [Bergamot Translator](https://github.com/browsermt/bergamot-translator) - Translation engine
- [Firefox Translations Models](https://github.com/mozilla/firefox-translations-models/) - Translation models
- [MTranServer](https://github.com/xxnuo/MTranServer/) - Inspiration
- [Mozilla Translation Service](https://github.com/mozilla/translation-service/) - Reference implementation