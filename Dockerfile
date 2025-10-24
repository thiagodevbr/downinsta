# Dockerfile
FROM node:20-bookworm

# yt-dlp (última) + ffmpeg
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg \
 && python3 -m venv /venv \
 && /venv/bin/pip install --upgrade pip yt-dlp \
 && ln -s /venv/bin/yt-dlp /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.mjs"]
