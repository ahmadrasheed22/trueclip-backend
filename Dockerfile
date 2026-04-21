FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && pip3 install yt-dlp --break-system-packages \
    && apt-get clean

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 8000

CMD ["node", "server.js"]
