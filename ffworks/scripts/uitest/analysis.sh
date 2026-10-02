#!/usr/bin/env bash
# GUI test for scene detection (scenesdetect crate) and loudness (ebur128 crate) through the Inspector.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-analysis.XXXXXX"); mkdir -p "$W/cache"
for s in "a 0" "b 120" "c 240"; do set -- $s; ffmpeg -v error -y -f lavfi -i "testsrc2=s=320x240:r=30:d=3,hue=h=$2" -f lavfi -i "sine=f=1000:r=44100:d=3" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/$1.mp4"; done
printf "file '%s'\nfile '%s'\nfile '%s'\n" "$W/a.mp4" "$W/b.mp4" "$W/c.mp4" > "$W/l.txt"
ffmpeg -v error -y -f concat -safe 0 -i "$W/l.txt" -c copy "$W/all.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed "s|__VIDEO__|$W/all.mp4|g" scripts/uitest/analysis.js > "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 120); do [ -f "$W/r.json" ] && break; sleep 1; done
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $P 2>/dev/null || true
python3 - "$W/r.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]));bad=0
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]);bad+=not s["pass"]
print(f'{len(r["steps"])-bad}/{len(r["steps"])} analysis steps passed');sys.exit(1 if bad else 0)
PY
