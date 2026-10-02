#!/usr/bin/env bash
# GUI test for proxies; then verifies the proxy file on disk with ffprobe.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-proxy.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "testsrc2=s=1280x720:r=25:d=3" -f lavfi -i "sine=f=440:r=44100:d=3" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/src.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__SRC__|$W/src.mp4|g" scripts/uitest/proxy.js > "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 300); do [ -f "$W/r.json" ] && break; sleep 1; done
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $P 2>/dev/null || true
PX=$(find "$W/cache" -name '*_540p.mp4' | head -1)
python3 - "$W/r.json" "$PX" <<'PY'
import json,subprocess,sys,os
r=json.load(open(sys.argv[1])); bad=0; extra=[]
px=sys.argv[2]
if px and os.path.exists(px):
    o=subprocess.run(["ffprobe","-v","error","-show_entries","stream=codec_name,width,height,channels,pix_fmt","-of","compact",px],capture_output=True,text=True).stdout
    extra=[("proxy file on disk is 960x540 H.264 yuv420p",("width=960" in o and "height=540" in o and "h264" in o and "yuv420p" in o)),("proxy file has stereo AAC",("aac" in o and "channels=2" in o))]
else: extra=[("a proxy file exists in the cache",False)]
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
for n,c in extra:
    print(("PASS" if c else "FAIL"),n); bad+=not c
tot=len(r["steps"])+len(extra); print(f"{tot-bad}/{tot} proxy checks passed"); sys.exit(1 if bad else 0)
PY
