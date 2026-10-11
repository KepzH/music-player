FROM node:18-slim

# Install yt-dlp, python3, dan alias python
RUN apt-get update && apt-get install -y python3 python3-pip python-is-python3 ffmpeg curl && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080
CMD ["node", "index.js"]