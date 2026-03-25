#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$REPO_ROOT/scripts/.pids"

if [ ! -f "$PID_FILE" ]; then
    echo "No running services found (no PID file)."
    exit 0
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
