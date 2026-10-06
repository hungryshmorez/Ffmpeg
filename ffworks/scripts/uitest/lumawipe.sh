#!/usr/bin/env bash
# GUI test for picture (luma) wipes: pick a mask picture in the Transitions panel, export, check the frames; invert/undo/none.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-luma.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "color=c=red:s=320x180:r=30:d=4" -c:v libx264 -pix_fmt yuv420p "$W/red.mp4"
ffmpeg -v error -y -f lavfi -i "color=c=blue:s=320x180:r=30:d=4" -c:v libx264 -pix_fmt yuv420p "$W/blue.mp4"
ffmpeg -v error -y -f lavfi -i "color=c=black:s=320x240,format=gray,geq=lum='X/W*255'" -frames:v 1 "$W/mask.png"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__A__|$W/red.mp4|g" -e "s|__B__|$W/blue.mp4|g" -e "s|__MASK__|$W/mask.png|g" -e "s|__OUT__|$W/out.mp4|g" scripts/uitest/lumawipe.js > "$W/t.js"
node --check "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" XDG_DATA_HOME="$W/data" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 240); do [ -f "$W/r.json" ] && break; sleep 1; done
kill $P 2>/dev/null || true
# (the sources are 16:9 so they fill the frame) the wipe is centred on the cut at 2 s (1 s long): at 2.0 the dark left is blue and the bright right still red
px() { ffmpeg -v error -ss "$1" -i "$W/out.mp4" -frames:v 1 -vf "crop=iw/40:ih/40:iw*$2:ih*0.5,scale=1:1" -f rawvideo -pix_fmt rgb24 - | od -An -tu1 | tr -s ' '; }
echo "pixels: t=1.3 left [$(px 1.3 0.1)] t=2 left [$(px 2 0.1)] right [$(px 2 0.9)] t=2.7 right [$(px 2.7 0.9)]"
python3 - "$W/r.json" "$(px 1.3 0.1)" "$(px 2 0.1)" "$(px 2 0.9)" "$(px 2.7 0.9)" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); bad=0
p=lambda s:[int(x) for x in s.split()]
before,left,right,after=p(sys.argv[2]),p(sys.argv[3]),p(sys.argv[4]),p(sys.argv[5])
red=lambda c:c[0]>170 and c[2]<80
blue=lambda c:c[2]>170 and c[0]<80
extra=[("before the wipe the picture is A (red)",red(before)),("mid-wipe the dark left has switched to B",blue(left)),("mid-wipe the bright right is still A",red(right)),("after the wipe the right is B",blue(after))]
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
for n,c in extra:
    print(("PASS" if c else "FAIL"),n); bad+=not c
tot=len(r["steps"])+len(extra); print(f"{tot-bad}/{tot} luma wipe checks passed"); sys.exit(1 if bad else 0)
PY
