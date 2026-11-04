# DeepGuard Node.js API gateway (Express + Socket.IO + Mongoose + Puppeteer for PDF reports)
# Build context = repository root.
FROM node:22-bookworm-slim

# System Chromium for Puppeteer PDF reports (don't let npm download its own copy).
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY backend-node/package.json backend-node/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY backend-node/src ./src

# The app runs behind Caddy. Without "trust proxy", every visitor shares Caddy's IP in the rate limiter and the audit log.
# (Cleaner: add  app.set("trust proxy", 1);  after `const app = express();` in server.js and delete this RUN.)
RUN sed -i 's|^const app = express();|const app = express();\napp.set("trust proxy", 1);|' src/server.js \
 && grep -q 'trust proxy' src/server.js

# runtime folders (bind-mounted from the host by docker-compose)
RUN mkdir -p uploads reports backups && chown -R node:node /app
USER node

EXPOSE 4000
# package.json hard-codes --max-old-space-size=4096, far too big for a 1-2 GB VM -> start node directly.
CMD ["sh", "-c", "exec node --max-old-space-size=${NODE_HEAP_MB:-384} src/server.js"]
