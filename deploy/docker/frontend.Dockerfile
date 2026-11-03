# DeepGuard React frontend -> static files served by Caddy (which also reverse-proxies /api and /socket.io)
# Build context = repository root.

# ---------- stage 1: build ----------
FROM node:20-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/index.html frontend/vite.config.js frontend/tailwind.config.js frontend/postcss.config.js ./
COPY frontend/src ./src

# Vite bakes these in at BUILD time (they are public values: the Supabase *anon* key is meant for browsers).
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_API_URL=/api
ARG VITE_SOCKET_URL
ARG VITE_IDLE_TIMEOUT_MIN=30
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_API_URL=$VITE_API_URL \
    VITE_SOCKET_URL=$VITE_SOCKET_URL \
    VITE_IDLE_TIMEOUT_MIN=$VITE_IDLE_TIMEOUT_MIN \
    NODE_OPTIONS=--max-old-space-size=768
RUN npm run build

# ---------- stage 2: serve ----------
FROM caddy:2-alpine
COPY deploy/docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
EXPOSE 80 443
