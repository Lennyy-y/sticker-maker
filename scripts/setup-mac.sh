#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECKPOINT_DIR="$REPO_ROOT/matting-service/checkpoints"
CHECKPOINT_FILE="$CHECKPOINT_DIR/sam2.1_hiera_large.pt"
CHECKPOINT_URL="https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt"
VENV_DIR="$REPO_ROOT/matting-service/.venv"

echo "=== Sticker Maker — macOS Setup ==="
echo ""

# ---- Homebrew ----
if ! command -v brew &>/dev/null; then
    echo "[1/6] Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
    echo "[1/6] Homebrew found"
fi

# ---- System dependencies ----
echo "[2/6] Installing system dependencies (python, node, ffmpeg)..."
brew install python node ffmpeg 2>/dev/null || true

# ---- Python venv + pip deps ----
echo "[3/6] Setting up Python virtual environment..."
if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

echo "  Installing PyTorch (with MPS support)..."
pip install --quiet torch torchvision

echo "  Installing SAM2..."
pip install --quiet "git+https://github.com/facebookresearch/sam2.git"

echo "  Installing Python dependencies..."
pip install --quiet -r "$REPO_ROOT/matting-service/requirements.txt"

deactivate

# ---- Node.js dependencies ----
echo "[4/6] Installing Node.js dependencies (bot)..."
cd "$REPO_ROOT"
npm install --silent

echo "[5/6] Installing Node.js dependencies (web-gui)..."
cd "$REPO_ROOT/web-gui"
npm install --silent

# ---- SAM2 checkpoint ----
echo "[6/6] Checking SAM 2.1 checkpoint (~900 MB)..."
mkdir -p "$CHECKPOINT_DIR"
if [ -f "$CHECKPOINT_FILE" ]; then
    echo "  Checkpoint already downloaded"
else
    echo "  Downloading sam2.1_hiera_large.pt..."
    curl -L -o "$CHECKPOINT_FILE" "$CHECKPOINT_URL"
fi

echo ""
echo "=== Setup complete! ==="
echo ""
echo "To start all services:  ./scripts/start.sh"
echo "To start without GPU:   ./scripts/start.sh --lite"
echo "To stop all services:   ./scripts/stop.sh"
