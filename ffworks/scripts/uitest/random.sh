#!/usr/bin/env bash
# GUI test for the filter-graph node editor: builds in -> negate -> hue(s=0) -> out with real drags, exports,
# then checks the exported pixels and the saved project file independently.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-random.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "color=c=red:s=160x240:r=25:d=9" -f lavfi -i "color=c=blue:s=160x240:r=25:d=9" -f lavfi -i "sine=f=440:r=44100:d=9" \
  -filter_complex "[0:v][1:v]hstack[v]" -map "[v]" -map 2:a -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/halves.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__SRC__|$W/halves.mp4|g" -e "s|__OUT__|$W/out.mp4|g" -e "s|__PROJ__|$W/p.ffworks|g" scripts/uitest/random.js > "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 240); do [ -f "$W/r.json" ] && break; sleep 1; done
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $P 2>/dev/null || true
px() { ffmpeg -v error -ss 1 -i "$W/out.mp4" -frames:v 1 -vf "crop=2:2:$1:$2,scale=1:1" -f rawvideo -pix_fmt rgb24 - | od -An -tu1 | tr -s ' '; }
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$W/out.mp4" 2>/dev/null || echo 0)
python3 - "$W/r.json" "$DUR" "$W/p.ffworks" <<'PY'
import json,sys,os
r=json.load(open(sys.argv[1])); bad=0
dur=float(sys.argv[2] or 0)
extra=[("exported file is about 6 s long (three 2 s clips)",abs(dur-6)<0.3)]
if os.path.exists(sys.argv[3]):
    t=json.load(open(sys.argv[3]))["sequences"][0]["tracks"][0]
    extra.append(("saved project holds 2 transitions and 2 effects on the first clip",len(t["transitions"])==2 and len(t["clips"][0]["effects"])==2))
else: extra.append(("project file was saved",False))
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
for n,c in extra:
    print(("PASS" if c else "FAIL"),n); bad+=not c
tot=len(r["steps"])+len(extra); print(f"{tot-bad}/{tot} random/favourites checks passed"); sys.exit(1 if bad else 0)
PY
