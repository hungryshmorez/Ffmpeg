#!/usr/bin/env bash
# GUI test for the corruption lab (needs only FFmpeg): damage a clip's compressed video, get a new clip on a new track.
set -euo pipefail
cd "$(dirname "$0")/../.."
export CARGO_INCREMENTAL=0
W=$(mktemp -d "/tmp/ffworks-corrupt.XXXXXX"); mkdir -p "$W/cache" "$W/data"
ffmpeg -v error -y -f lavfi -i "testsrc2=s=320x240:r=25:d=6" -c:v libx264 -pix_fmt yuv420p -g 50 "$W/src.mp4"
ffmpeg -v error -y -f lavfi -i "testsrc2=s=1280x720:r=25:d=40" -c:v ffv1 "$W/long.mkv"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__SRC__|$W/src.mp4|g" -e "s|__LONG__|$W/long.mkv|g" scripts/uitest/corrupt.js > "$W/t.js"
node --check "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" XDG_DATA_HOME="$W/data" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 240); do [ -f "$W/r.json" ] && break; sleep 1; done
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $P 2>/dev/null || true
LEFT=$(find /tmp -maxdepth 1 -name 'ffworks-corrupt-*' -type d 2>/dev/null | wc -l)
python3 - "$W/r.json" "$LEFT" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); bad=0
r["steps"].append({"name":"no working folders are left in the temp folder","pass":sys.argv[2]=="0","detail":sys.argv[2]+" left"})
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
print(f'{len(r["steps"])-bad}/{len(r["steps"])} corruption steps passed'); sys.exit(1 if bad else 0)
PY
