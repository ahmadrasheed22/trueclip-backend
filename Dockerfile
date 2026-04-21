FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    unzip \
    git \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && ([ -x /usr/local/bin/deno ] || mv /root/.deno/bin/deno /usr/local/bin/deno) \
    && pip3 install --upgrade --force-reinstall yt-dlp --break-system-packages \
    && deno --version \
    && yt-dlp --version \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV DENO_PATH=/usr/local/bin/deno
ENV YTDLP_EJS_BACKEND=/usr/local/bin/deno

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 8000

CMD ["node", "server.js"]
