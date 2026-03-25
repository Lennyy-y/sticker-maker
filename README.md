# Sticker Maker

A WhatsApp bot that turns images and videos into stickers, with optional GPU-accelerated background removal powered by Meta's SAM 2.1. Includes a browser-based dashboard for easy management.

Send `/sticker` with any image or video in WhatsApp and get a sticker back instantly.

Three deployment options:
- **Lite (Docker)** — just the bot, no GPU needed. Runs on any machine.
- **Full (Docker + NVIDIA)** — adds the SAM 2.1 GPU matting service for background removal (`-borderless` flag).
- **Native (macOS / Apple Silicon)** — runs everything natively with Metal/MPS acceleration. No Docker required.

## Features

- **Images → Stickers** — any image becomes a WhatsApp sticker with preserved aspect ratio
- **Videos/GIFs → Animated Stickers** — converts video to animated WebP with automatic compression to fit WhatsApp's 500 KB limit
- **Background Removal** *(full build only)* — GPU-powered subject isolation using SAM 2.1 for both images and video (frame-by-frame temporal propagation)
- **Text Overlays** — meme-style top/bottom text rendered via Puppeteer with full emoji and Unicode support
- **Speed Control** — adjust video playback speed from 0.5x to 2x
- **Reply Support** — reply to any existing image/video with `/sticker` to convert it
- **Concurrency Queue** — up to 3 sticker requests process in parallel; GPU matting serialized to 1 at a time to prevent OOM; additional requests wait in queue (never dropped)
- **Whitelist** — restrict the bot to specific contacts or groups via the dashboard (O(1) lookup, persisted to disk)
- **Web Dashboard** — browser-based control panel for QR code scanning, connection status, GPU mode toggling, whitelist management, and live request history

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
| **sticker-bot** | Node.js/TypeScript WhatsApp client using `whatsapp-web.js` + Puppeteer. Handles message parsing, media download, text overlay rendering, video encoding, sticker delivery, whitelist filtering, and concurrency-limited request queuing. Exposes an internal API + Socket.IO server on port 3001 for the dashboard. |
| **web-gui** | Node.js Express dashboard served on port 3000. Bridges bot events (QR code, connection status, request history) to the browser via Socket.IO, controls Docker services (GPU toggle) via the mounted Docker socket, and provides a UI for whitelist management and live request monitoring. |
| **video-matting** | Python FastAPI service running SAM 2.1 (hiera_large) on GPU. Provides `/process-image` and `/process` endpoints for background removal on static images and video frame sequences. Auto-detects CUDA, Metal/MPS, or CPU. Only runs when GPU profile is active (Docker) or launched via start script (native). |

```
Browser ←→ web-gui (:3000)
                │
                ├── Socket.IO → sticker-bot (:3001 internal)
                ├── REST API → sticker-bot (whitelist CRUD, contacts/groups)
                └── Docker socket → service control

WhatsApp ←→ sticker-bot (Node.js)
                 │
                 ├── Concurrency queue (3 stickers, 1 GPU matting)
                 ├── Whitelist filter (O(1) Set lookup)
                 ├── Sharp (image/video frame encoding + WebP assembly)
                 ├── FFmpeg (video frame extraction + filtering)
                 ├── Puppeteer (text overlay rendering)
                 │
                 └──→ video-matting (Python/CUDA or Metal/MPS)
                        ├── SAM 2.1 automatic mask generator
                        └── SAM 2.1 video predictor (temporal propagation)
```

## Prerequisites

**Docker (Linux/Windows):**
- Docker
- A WhatsApp account to link via QR code
- *(Full build only)* NVIDIA GPU + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)

**Native (macOS / Apple Silicon):**
- macOS with Apple Silicon (M1/M2/M3/M4)
- A WhatsApp account to link via QR code
- The setup script handles all other dependencies (Homebrew, Python, Node.js, FFmpeg, PyTorch, SAM2)

## Getting Started

### Docker (Linux / Windows)

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

### macOS / Apple Silicon

Docker on macOS cannot pass Metal GPU access to containers, so the native path runs everything directly on the host with Metal/MPS acceleration.

1. **Clone and set up:**

   ```bash
   git clone https://github.com/Lennyy-y/sticker-maker.git
   cd sticker-maker
   chmod +x scripts/*.sh
   ./scripts/setup-mac.sh
   ```

   The setup script installs all dependencies via Homebrew and pip, and downloads the SAM 2.1 checkpoint (~900 MB). Only needs to run once.

2. **Start all services:**

   ```bash
   ./scripts/start.sh           # full (with Metal GPU matting)
   ./scripts/start.sh --lite    # lite (no background removal)
   ```

3. **Open the dashboard** at [http://localhost:3000](http://localhost:3000) and scan the QR code. The matting service status is shown on the dashboard (toggle is disabled — lifecycle managed by the scripts).

4. **Stop all services:**

   ```bash
   ./scripts/stop.sh
   ```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `MATTING_API_URL` | `http://localhost:8000` | URL of the matting service. Set to `http://video-matting:8000` in Docker. |
| `DATA_DIR` | `./data` (relative to project root) | Directory for persistent settings (whitelist). Set to `/usr/src/app/data` in Docker. |
| `SAM2_CHECKPOINT` | `./checkpoints/sam2.1_hiera_large.pt` | Path to SAM 2.1 checkpoint. Set to `/app/checkpoints/...` in Docker. |
| `NATIVE_MODE` | `0` | Set to `1` by start scripts on macOS. Disables Docker-based GPU toggle in the dashboard. |

Whitelist settings are persisted to `DATA_DIR/whitelist.json` and survive container restarts (backed by the `bot-data` Docker volume).

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

### Running without Docker

The bot can run directly on a host machine with Node.js 18+, FFmpeg, and Chromium installed. Settings are stored in `./data/` by default (gitignored). The matting service is optional — without it, the `-borderless` flag is unavailable.

```bash
npm install
npx ts-node src/index.ts
```
