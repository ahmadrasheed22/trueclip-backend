FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV YTDLP_JS_RUNTIMES=node

RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    ffmpeg \
    fonts-liberation \
    fontconfig \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get update \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir --break-system-packages --upgrade yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 8000
CMD ["node", "server.js"]
