FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    unzip \
    && pip3 install -U yt-dlp --break-system-packages \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && /usr/local/bin/deno --version \
    && yt-dlp --version \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 8000

CMD ["node", "server.js"]
