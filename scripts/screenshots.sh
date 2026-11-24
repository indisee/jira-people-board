#!/usr/bin/env bash
# README screenshots from the demo page (fake data), with headless Google Chrome, at 2x.
#   npm run screenshots      → docs/screenshots/*.png
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[[ -x "$CHROME" ]] || { echo "error: Google Chrome not found (set CHROME=/path/to/chrome)" >&2; exit 1; }
PORT=4318
OUT=docs/screenshots
mkdir -p "$OUT"

python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
PROFILE="$(mktemp -d)"
trap 'kill $SERVER 2>/dev/null; rm -rf "$PROFILE"' EXIT
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/demo/" >/dev/null && break; sleep 0.1; done

# name  width  height  query
shoot() {
  echo "$OUT/$1.png"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --force-color-profile=srgb --user-data-dir="$PROFILE" --window-size="$2,$3" \
    --virtual-time-budget=6000 --screenshot="$OUT/$1.png" \
    "http://127.0.0.1:$PORT/demo/$4" >/dev/null 2>&1
}

shoot board    1280 880  ""
shoot brief    1280 640  "?shot=brief"
shoot changes  1280 520  "?shot=changes"
shoot daily    1280 760  "?shot=daily"
shoot settings 600  780  "?view=settings"
