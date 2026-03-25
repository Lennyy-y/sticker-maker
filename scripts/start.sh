#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$REPO_ROOT/scripts/.pids"
VENV_DIR="$REPO_ROOT/matting-service/.venv"
LOG_DIR="$REPO_ROOT/scripts/.logs"

LITE=false
if [[ "${1:-}" == "--lite" ]]; then
    LITE=true
fi

if [ -f "$PID_FILE" ]; then
    echo "Services appear to be running already. Run ./scripts/stop.sh first."
    exit 1
fi

if [ ! -d "$REPO_ROOT/node_modules" ]; then
    echo "Error: node_modules not found. Run ./scripts/setup-mac.sh first."
    exit 1
fi

mkdir -p "$LOG_DIR"
> "$PID_FILE"

echo "=== Starting Sticker Maker (native) ==="

# ---- Matting service ----
if [ "$LITE" = false ]; then
    if [ ! -d "$VENV_DIR" ]; then
        echo "Error: Python venv not found. Run ./scripts/setup-mac.sh first."
        exit 1
    fi
    CKPT="$REPO_ROOT/matting-service/checkpoints/sam2.1_hiera_large.pt"
    if [ ! -f "$CKPT" ]; then
        echo "Error: SAM2 checkpoint not found at $CKPT"
        echo "Run ./scripts/setup-mac.sh to download it."
        exit 1
    fi
    echo "[1/3] Starting matting service..."
    (
        source "$VENV_DIR/bin/activate"
        cd "$REPO_ROOT/matting-service"
        exec uvicorn main:app --host 0.0.0.0 --port 8000
    ) > "$LOG_DIR/matting.log" 2>&1 &
    echo "$!" >> "$PID_FILE"
    echo "  PID $! — matting service on port 8000"
else
    echo "[1/3] Skipping matting service (--lite mode)"
fi

# ---- Sticker bot ----
echo "[2/3] Starting sticker bot..."
(
    cd "$REPO_ROOT"
    MATTING_API_URL="http://localhost:8000" \
    DATA_DIR="$REPO_ROOT/data" \
    exec ./node_modules/.bin/ts-node src/index.ts
) > "$LOG_DIR/bot.log" 2>&1 &
echo "$!" >> "$PID_FILE"
echo "  PID $! — sticker bot on port 3001"

# ---- Web GUI ----
echo "[3/3] Starting web dashboard..."
(
    cd "$REPO_ROOT/web-gui"
    BOT_WS_URL="http://localhost:3001" \
    MATTING_URL="http://localhost:8000" \
    NATIVE_MODE=1 \
    exec node server.js
) > "$LOG_DIR/gui.log" 2>&1 &
echo "$!" >> "$PID_FILE"
echo "  PID $! — dashboard on port 3000"

echo ""
echo "=== All services started ==="
echo "Dashboard: http://localhost:3000"
echo ""
echo "Tailing logs (Ctrl+C to detach — services keep running)..."
echo ""
tail -f "$LOG_DIR"/*.log
