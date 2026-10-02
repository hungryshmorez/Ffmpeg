#!/usr/bin/env bash
# Headless GUI test: builds the UI with the test hook, builds the Tauri app with --features uitest,
# runs it under Xvfb (real WebKitGTK webview), drives the UI, then verifies the exported file with FFprobe/FFmpeg.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-uitest.XXXXXX")
mkdir -p "$W/m ü"
ffmpeg -v error -y -f lavfi -i "color=c=red:s=320x240:r=25:d=4" -f lavfi -i "sine=f=440:r=44100:d=4" -c:v libx264 -pix_fmt yuv420p -g 12 -c:a aac -shortest "$W/m ü/a red.mp4"
ffmpeg -v error -y -f lavfi -i "color=c=blue:s=640x480:r=24000/1001:d=4" -f lavfi -i "sine=f=880:r=44100:d=4" -c:v libx264 -pix_fmt yuv420p -g 12 -c:a aac -shortest "$W/m ü/b_blue.mp4"
sed -e "s|__A__|$W/m ü/a red.mp4|" -e "s|__B__|$W/m ü/b_blue.mp4|" -e "s|__PROJECT__|$W/test.ffworks|" -e "s|__OUT__|$W/out.mp4|" scripts/uitest/uitest.js > "$W/uitest.js"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null)
touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -2
export DISPLAY=:99
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/uitest.js" FFWORKS_UITEST_OUT="$W/report.json" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 target/debug/ffworks-app >"$W/app.log" 2>&1 &
APP=$!
for i in $(seq 1 240); do [ -f "$W/report.json" ] && break; sleep 1; done
sleep 1
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $APP 2>/dev/null || true
cat "$W/report.json" 2>/dev/null || { echo "NO REPORT"; tail -20 "$W/app.log"; exit 1; }
echo
echo "== independent verification of exported file =="
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,duration -of compact "$W/out.mp4"
px() { ffmpeg -v error -ss "$1" -i "$W/out.mp4" -frames:v 1 -vf scale=1:1 -f rawvideo -pix_fmt rgb24 - | od -An -tu1 | tr -s ' '; }
for t in 1 3.5 5 6.5 8 11; do echo "t=$t rgb:$(px $t)"; done
echo "workdir: $W"
python3 - "$W/report.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); bad=[s for s in r["steps"] if not s["pass"]]
print(f'{len(r["steps"])-len(bad)}/{len(r["steps"])} UI steps passed'); sys.exit(1 if bad else 0)
PY
