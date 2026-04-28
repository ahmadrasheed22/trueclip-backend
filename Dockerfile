FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    wget \
    && apt-get clean

# Install latest yt-dlp
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Install bgutil PO token provider plugin for yt-dlp
RUN pip install -U bgutil-ytdlp-pot-provider --break-system-packages

# Setup bgutil script provider
RUN yt-dlp --version && \
    mkdir -p /root/bgutil-ytdlp-pot-provider && \
    cd /root/bgutil-ytdlp-pot-provider && \
    pip show bgutil-ytdlp-pot-provider --break-system-packages | grep Location | awk '{print $2}' | xargs -I{} cp -r {}/bgutil_ytdlp_pot_provider/server . 2>/dev/null || true

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

EXPOSE 8000
CMD ["node", "server.js"]
