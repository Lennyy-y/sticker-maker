# Use a slim Debian-based Node image
FROM node:18-bullseye-slim

# Install system dependencies for Chromium, FFmpeg, and WebP support
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && apt-get install -y fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 fonts-noto-color-emoji \
      --no-install-recommends \
    && apt-get install -y chromium ffmpeg libwebp-dev webp \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the installed system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of your application code
COPY . .

# Compile TypeScript to JavaScript
RUN npm run build

# Start the compiled bot
CMD ["node", "dist/index.js"]