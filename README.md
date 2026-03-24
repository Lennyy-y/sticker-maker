# Sticker Maker

A WhatsApp bot that turns images and videos into stickers, with optional GPU-accelerated background removal powered by Meta's SAM 2.1.

Send `/sticker` with any image or video in WhatsApp and get a sticker back instantly.

Two build modes:
- **Lite** — just the bot, no GPU needed. Runs on any machine.
- **Full** — adds the SAM 2.1 GPU matting service for background removal (`-borderless` flag).

## Features

- **Images → Stickers** — any image becomes a 512x512 WhatsApp sticker
- **Videos/GIFs → Animated Stickers** — converts video to animated WebP with automatic compression to fit WhatsApp's 500 KB limit
- **Background Removal** *(full build only)* — GPU-powered subject isolation using SAM 2.1 for both images and video (frame-by-frame temporal propagation)
- **Text Overlays** — meme-style top/bottom text rendered via Puppeteer with full emoji and Unicode support
- **Speed Control** — adjust video playback speed from 0.5x to 2x
- **Reply Support** — reply to any existing image/video with `/sticker` to convert it

## Usage

Send a message in any WhatsApp chat where the bot is active:

```
/sticker                     — basic sticker from attached media
/sticker -borderless         — remove background (transparent sticker)
/sticker -square             — force square crop
/sticker -speed 1.5          — speed up video by 1.5x
/sticker -tt "top text"      — add top text overlay
/sticker -bt "bottom text"   — add bottom text overlay
```

Flags can be combined:

```
/sticker -borderless -tt "wow" -bt "such sticker" -speed 2
```

You can also reply to an existing image or video with `/sticker` to convert it.

## Architecture

The project runs as two Docker containers:

| Service | Description |
|---|---|
| **sticker-bot** | Node.js/TypeScript WhatsApp client using `whatsapp-web.js` + Puppeteer. Handles message parsing, media download, text overlay rendering, video encoding (FFmpeg/img2webp), and sticker delivery. |
| **video-matting** | Python FastAPI service running SAM 2.1 (hiera_large) on GPU. Provides `/process-image` and `/process` endpoints for background removal on static images and video frame sequences. |

```
WhatsApp ←→ sticker-bot (Node.js)
                 │
                 ├── FFmpeg / img2webp (video → animated WebP)
                 ├── Sharp (image resizing)
                 ├── Puppeteer (text overlay rendering)
                 │
                 └──→ video-matting (Python/CUDA)
                        ├── SAM 2.1 automatic mask generator
                        └── SAM 2.1 video predictor (temporal propagation)
```

## Prerequisites

- Docker
- A WhatsApp account to link via QR code
- *(Full build only)* NVIDIA GPU + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)

## Getting Started

1. **Clone the repo:**

   ```bash
   git clone https://github.com/Lennyy-y/sticker-maker.git
   cd sticker-maker
   ```

2. **Start the bot:**

   **Lite** (no GPU required):
   ```bash
   docker compose up --build
   ```

   **Full** (with GPU background removal):
   ```bash
   docker compose --profile gpu up --build
   ```

   The full build will take a while on first run — it downloads the CUDA base image, PyTorch, and the SAM 2.1 checkpoint (~900 MB).

3. **Scan the QR code** that appears in the terminal with your WhatsApp mobile app (Linked Devices).

4. **Send `/sticker`** with an image or video in any chat.

## Development

The `sticker-bot` service bind-mounts `./src` into the container for live reloading during development. Edit `src/index.ts` and restart the container to pick up changes.

```bash
docker compose restart sticker-bot
```
