#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="${STICKER_RUNTIME_DIR:-${HOME}/.sticker-maker/run}"
PID_FILE="$RUNTIME_DIR/pids"

if [ ! -f "$PID_FILE" ]; then
    # Legacy location (before run state moved out of the repo)
    LEGACY_PID="$REPO_ROOT/scripts/.pids"
    if [ -f "$LEGACY_PID" ]; then
        PID_FILE="$LEGACY_PID"
    else
        echo "No running services found (no PID file)."
        exit 0
    fi
fi

echo "=== Stopping Sticker Maker ==="

while IFS= read -r pid; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "  Stopping PID $pid..."
        kill "$pid" 2>/dev/null || true
    fi
done < "$PID_FILE"

rm -f "$PID_FILE"
echo "All services stopped."
