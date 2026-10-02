#!/usr/bin/env bash
# GUI test for beat detection (ported from the browser app): click-track clip -> Detect beats -> ticks -> snap to beats.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-beats.XXXXXX"); mkdir -p "$W/cache"
# 120 BPM click track (20 ms 1 kHz bursts every 0.5 s) with a picture, 6 s
ffmpeg -v error -y -f lavfi -i "color=c=green:s=320x240:r=30:d=6" -f lavfi -i "aevalsrc=if(lt(mod(t\,0.5)\,0.02)\,0.9*sin(2*PI*1000*t)\,0):s=44100:d=6" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/clicks.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
sed "s|__CLICKS__|$W/clicks.mp4|" scripts/uitest/beats.js > "$W/t.js"
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 90); do [ -f "$W/r.json" ] && break; sleep 1; done
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $P 2>/dev/null || true
python3 - "$W/r.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]));bad=0
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]);bad+=not s["pass"]
print(f'{len(r["steps"])-bad}/{len(r["steps"])} beat steps passed');sys.exit(1 if bad else 0)
PY
