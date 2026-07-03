# Always-on Telegram webhook server (interactive commands in production).
# Build context = this directory (ai-infra-digest/).
# Deploy on Render / Railway / Fly.io / any container host.
FROM node:22-slim

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Patch node-telegram-bot-api: strip its broken "exports" field so require() resolves
# to "main" (the package is ESM-only; require(esm) works on Node 22.12+).
RUN node -e "const fs=require('fs'),p='node_modules/node-telegram-bot-api/package.json',pkg=JSON.parse(fs.readFileSync(p,'utf8'));if(pkg.exports){delete pkg.exports;fs.writeFileSync(p,JSON.stringify(pkg,null,2));console.log('patched: removed exports field')}else{console.log('no exports field present')}"

# Build TypeScript -> dist/
COPY . .
RUN npm run build

ENV NODE_ENV=production
# Hosts inject PORT; the webhook server reads process.env.PORT (default 3000).
EXPOSE 3000

# Run as the unprivileged user that ships with the node base image —
# a webhook server has no reason to hold root inside the container.
USER node

CMD ["node", "dist/webhook.js"]
