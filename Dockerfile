# Dockerfile
FROM node:20-bookworm

# Instala yt-dlp e ffmpeg pelos pacotes Debian
RUN apt-get update \
 && apt-get install -y --no-install-recommends yt-dlp ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.mjs"]
