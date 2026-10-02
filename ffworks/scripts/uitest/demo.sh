#!/usr/bin/env bash
# GUI test for the filter-graph node editor: builds in -> negate -> hue(s=0) -> out with real drags, exports,
# then checks the exported pixels and the saved project file independently.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-demo.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "color=c=red:s=160x240:r=25:d=10" -f lavfi -i "color=c=blue:s=160x240:r=25:d=10" -f lavfi -i "sine=f=440:r=44100:d=10" \
  -filter_complex "[0:v][1:v]hstack[v]" -map "[v]" -map 2:a -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/halves.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__SRC__|$W/halves.mp4|g" -e "s|__OUT__|$W/out.mp4|g" -e "s|__PROJ__|$W/p.ffworks|g" scripts/uitest/demo.js > "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 240); do [ -f "$W/r.json" ] && break; sleep 1; done
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $P 2>/dev/null || true
CACHE=$(find "$W/cache" -name "*.mp4" 2>/dev/null | head -50)
N=$(echo "$CACHE" | grep -c mp4 || true)
OK=0; for f in $CACHE; do d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null || echo 0); python3 -c "import sys; sys.exit(0 if abs(float('${d:-0}' or 0)-4.5)<0.4 else 1)" && OK=$((OK+1)); done
python3 - "$W/r.json" "$N" "$OK" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); bad=0
n,ok=int(sys.argv[2]),int(sys.argv[3])
extra=[("several different demo previews were really rendered (>=4 files)",n>=4),("every demo preview is 3 x 1.5 s = 4.5 s long",n>0 and ok==n)]
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
for n_,c in extra:
    print(("PASS" if c else "FAIL"),n_); bad+=not c
tot=len(r["steps"])+len(extra); print(f"{tot-bad}/{tot} demo mode checks passed"); sys.exit(1 if bad else 0)
PY
