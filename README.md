# Sticker Maker

A WhatsApp bot that turns images and videos into stickers, with optional GPU-accelerated background removal powered by Meta's SAM 2.1. Includes a browser-based dashboard for easy management.

Send `/sticker` with any image or video in WhatsApp and get a sticker back instantly.

Two build modes:
- **Lite** — just the bot, no GPU needed. Runs on any machine.
- **Full** — adds the SAM 2.1 GPU matting service for background removal (`-borderless` flag).

## Features

- **Images → Stickers** — any image becomes a WhatsApp sticker with preserved aspect ratio
- **Videos/GIFs → Animated Stickers** — converts video to animated WebP with automatic compression to fit WhatsApp's 500 KB limit
- **Background Removal** *(full build only)* — GPU-powered subject isolation using SAM 2.1 for both images and video (frame-by-frame temporal propagation)
- **Text Overlays** — meme-style top/bottom text rendered via Puppeteer with full emoji and Unicode support
- **Speed Control** — adjust video playback speed from 0.5x to 2x
- **Reply Support** — reply to any existing image/video with `/sticker` to convert it
- **Web Dashboard** — browser-based control panel for QR code scanning, connection status, and GPU mode toggling

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

The project runs as three Docker containers:

| Service | Description |
|---|---|
| **sticker-bot** | Node.js/TypeScript WhatsApp client using `whatsapp-web.js` + Puppeteer. Handles message parsing, media download, text overlay rendering, video encoding, and sticker delivery. Exposes an internal event server on port 3001 for the dashboard. |
| **web-gui** | Node.js Express dashboard served on port 3000. Bridges bot events (QR code, connection status) to the browser via Socket.IO, and controls Docker services (GPU toggle) via the mounted Docker socket. |
| **video-matting** | Python FastAPI service running SAM 2.1 (hiera_large) on GPU. Provides `/process-image` and `/process` endpoints for background removal on static images and video frame sequences. Only runs when GPU profile is active. |

```
Browser ←→ web-gui (:3000)
                │
                ├── Socket.IO → sticker-bot (:3001 internal)
                └── Docker socket → service control

WhatsApp ←→ sticker-bot (Node.js)
                 │
                 ├── Sharp (image/video frame encoding + WebP assembly)
                 ├── FFmpeg (video frame extraction + filtering)
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

3. **Open the dashboard** at [http://localhost:3000](http://localhost:3000) and scan the QR code with your WhatsApp mobile app (Linked Devices). You can also toggle GPU mode on/off from the dashboard without restarting containers.

4. **Send `/sticker`** with an image or video in any chat.

## Remote Deployment

The entire stack can run on a remote server (e.g., an EC2 instance). Just open port 3000 in your firewall/security group and access the dashboard from any browser at `http://<server-ip>:3000`. All inter-service communication stays within the Docker network.

## Development

The `sticker-bot` service bind-mounts `./src` into the container for live reloading during development. Edit `src/index.ts` and restart the container to pick up changes.

```bash
docker compose restart sticker-bot
```

The `web-gui` service can be rebuilt independently:

```bash
docker compose up -d --build web-gui
```
