#!/usr/bin/env bash
# GUI test for transitions: add/edit through the Inspector, refusal cases, preview and export; then verifies pixels and audio of the file.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-trans.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "color=c=red:s=320x240:r=30:d=4" -f lavfi -i "sine=f=440:r=44100:d=4" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/red.mp4"
ffmpeg -v error -y -f lavfi -i "color=c=blue:s=320x240:r=30:d=4" -f lavfi -i "sine=f=880:r=44100:d=4" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/blue.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__A__|$W/red.mp4|g" -e "s|__B__|$W/blue.mp4|g" -e "s|__OUT__|$W/out.mp4|g" scripts/uitest/transitions.js > "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 240); do [ -f "$W/r.json" ] && break; sleep 1; done
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $P 2>/dev/null || true
px() { ffmpeg -v error -ss "$1" -i "$W/out.mp4" -frames:v 1 -vf scale=1:1 -f rawvideo -pix_fmt rgb24 - | od -An -tu1 | tr -s ' '; }
echo "pixels: t=1 [$(px 1)]  t=2 [$(px 2)]  t=3 [$(px 3)]"
vol() { ffmpeg -nostdin -hide_banner -ss "$1" -t "$2" -i "$W/out.mp4" -vn -af volumedetect -f null - 2>&1 | grep -o 'mean_volume: [-0-9.]*'; }
echo "audio around the cut: $(vol 1.6 0.8)"
python3 - "$W/r.json" "$(px 1)" "$(px 2)" "$(px 3)" "$(vol 1.6 0.8)" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); bad=0
p=lambda s:[int(x) for x in s.split()]
red,mid,blue=p(sys.argv[2]),p(sys.argv[3]),p(sys.argv[4])
vol=float(sys.argv[5].split()[-1])
extra=[("exported t=1 is red",red[0]>170 and red[2]<60),("exported t=3 is blue",blue[2]>170 and blue[0]<60),("exported cut shows both colours (dissolve)",50<mid[0]<200 and 50<mid[2]<200),("audio is present through the crossfade",vol>-35)]
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
for n,c in extra:
    print(("PASS" if c else "FAIL"),n); bad+=not c
tot=len(r["steps"])+len(extra); print(f"{tot-bad}/{tot} transition checks passed"); sys.exit(1 if bad else 0)
PY
