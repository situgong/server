# LinguaSpark Translation Service - Docker Image
# Uses Node.js with Bergamot WASM translator

FROM node:25.6.0-bookworm-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application files
COPY server.js ./
COPY wasm/ ./wasm/
COPY public/ ./public/

# Create models directory
RUN mkdir -p /app/models

# Environment variables
ENV NODE_ENV=production
ENV IP=0.0.0.0
ENV PORT=3000
ENV MODELS_DIR=/app/models
ENV WASM_PATH=wasm/bergamot-translator.wasm
ENV JS_PATH=wasm/bergamot-translator.js

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Run as non-root user
USER node

ENTRYPOINT ["node", "server.js"]
