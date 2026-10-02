#!/usr/bin/env bash
# GUI test for audio auto-sync of two recordings of the same sound through the Inspector.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-sync.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "anoisesrc=d=8:c=pink:r=44100:seed=5:a=0.5" -ac 1 "$W/n.wav"
ffmpeg -v error -y -f lavfi -i "testsrc2=s=160x120:r=25:d=8" -i "$W/n.wav" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/a.mp4"
ffmpeg -v error -y -i "$W/n.wav" -f lavfi -i "anoisesrc=d=10:c=white:r=44100:seed=9:a=0.05" -filter_complex "[0:a]volume=0.5,adelay=1370[d];[d][1:a]amix=inputs=2:duration=longest:normalize=0[o]" -map "[o]" -ac 1 "$W/b.wav"
ffmpeg -v error -y -f lavfi -i "testsrc2=s=160x120:r=25:d=8" -i "$W/b.wav" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/b.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__A__|$W/a.mp4|g" -e "s|__B__|$W/b.mp4|g" scripts/uitest/sync.js > "$W/t.js"
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
print(f'{len(r["steps"])-bad}/{len(r["steps"])} sync steps passed');sys.exit(1 if bad else 0)
PY
