#!/usr/bin/env bash
# GUI test for transform/keyframes/blend/timing: drives the real Inspector, then verifies the exported file's pixels independently.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-clipfx.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "color=c=red:s=160x240:r=25:d=4" -f lavfi -i "color=c=blue:s=160x240:r=25:d=4" -f lavfi -i "sine=f=440:r=44100:d=4" \
  -filter_complex "[0:v][1:v]hstack[v]" -map "[v]" -map 2:a -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/halves.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__SRC__|$W/halves.mp4|g" -e "s|__OUT__|$W/out.mp4|g" scripts/uitest/clipfx.js > "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 240); do [ -f "$W/r.json" ] && break; sleep 1; done
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $P 2>/dev/null || true
# Independent pixel check on the exported file. The GUI project is 1920x1080 and the 320x240 source is fitted to 1440x1080
# (x 240..1680; red 240..960, blue 960..1680). With x=+80 and scale 1 -> 0.5 between 1 s and 2 s:
#   t=3   : picture is 720x540 centred at (1040,540): x 680..1400, red 680..1040, blue 1040..1400
#   t=0.5 : scale 1, shifted +80: x 320..1760, so x=200 is empty and x=400 is red
px() { ffmpeg -v error -ss "$1" -i "$W/out.mp4" -frames:v 1 -vf "crop=2:2:$2:$3,scale=1:1" -f rawvideo -pix_fmt rgb24 - | od -An -tu1 | tr -s ' '; }
echo "t=3 (400,540) [$(px 3 400 540)]  (800,540) [$(px 3 800 540)]  (1250,540) [$(px 3 1250 540)]   t=0.5 (200,540) [$(px 0.5 200 540)] (400,540) [$(px 0.5 400 540)]"
python3 - "$W/r.json" "$(px 3 400 540)" "$(px 3 800 540)" "$(px 3 1250 540)" "$(px 0.5 200 540)" "$(px 0.5 400 540)" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); bad=0
p=lambda s:[int(x) for x in s.split()]
empty,red,blue,early_empty,early_red=[p(a) for a in sys.argv[2:7]]
extra=[("exported t=3: outside the shrunken picture is black",max(empty)<50),("exported t=3: red half where the animated scale + x put it",red[0]>170 and red[2]<80),("exported t=3: blue half where the animated scale + x put it",blue[2]>170 and blue[0]<80),("exported t=0.5: x=+80 leaves the left edge empty",max(early_empty)<50),("exported t=0.5: and the picture is red at x=400",early_red[0]>170 and early_red[2]<80)]
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
for n,c in extra:
    print(("PASS" if c else "FAIL"),n); bad+=not c
tot=len(r["steps"])+len(extra); print(f"{tot-bad}/{tot} clip-property checks passed"); sys.exit(1 if bad else 0)
PY
