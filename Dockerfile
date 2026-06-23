# Always-on Telegram webhook server (interactive commands in production).
# Build context = this directory (ai-infra-digest/).
# Deploy on Render / Railway / Fly.io / any container host.
FROM node:22-slim

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Build TypeScript -> dist/
COPY . .
RUN npm run build

ENV NODE_ENV=production
# Hosts inject PORT; the webhook server reads process.env.PORT (default 3000).
EXPOSE 3000

CMD ["node", "dist/webhook.js"]
