#!/usr/bin/env bash
# GUI test for markers: keys, ruler flags, Inspector list, undo; then checks the saved project file independently.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-mk.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "color=c=gray:s=320x240:r=25:d=10" -f lavfi -i "sine=f=440:r=44100:d=10" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/src.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__SRC__|$W/src.mp4|g" -e "s|__PROJ__|$W/p.ffworks|g" scripts/uitest/markers.js > "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 240); do [ -f "$W/r.json" ] && break; sleep 1; done
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $P 2>/dev/null || true
python3 - "$W/r.json" "$W/p.ffworks" <<'PY'
import json,sys,os
r=json.load(open(sys.argv[1])); bad=0; extra=[]
if os.path.exists(sys.argv[2]):
    ms=json.load(open(sys.argv[2]))["sequences"][0]["markers"]
    extra=[("saved file has two markers in time order",[m["name"] for m in ms]==["Intro ends","Marker 2"]),("saved file keeps colour and note",ms[0]["color"]=="#3aa0ff" and ms[0]["note"]=="cut the logo here"),("saved times are exact rationals",ms[0]["time"] in ("2","2/1") and ms[1]["time"] in ("5","5/1"))]
else: extra=[("project file was saved",False)]
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
for n,c in extra:
    print(("PASS" if c else "FAIL"),n); bad+=not c
tot=len(r["steps"])+len(extra); print(f"{tot-bad}/{tot} marker checks passed"); sys.exit(1 if bad else 0)
PY
