#!/usr/bin/env bash
# GUI test for the browser app's video workflows: apply "Sepia Tone" from the Effects panel, refuse an unsafe chain, export, check the colour.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-vwf.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "color=c=red:s=320x180:r=25:d=3" -c:v libx264 -pix_fmt yuv420p "$W/red.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__SRC__|$W/red.mp4|g" -e "s|__OUT__|$W/out.mp4|g" scripts/uitest/videowf.js > "$W/t.js"
node --check "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" XDG_DATA_HOME="$W/data" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 240); do [ -f "$W/r.json" ] && break; sleep 1; done
kill $P 2>/dev/null || true
PX=$(ffmpeg -v error -ss 1 -i "$W/out.mp4" -frames:v 1 -vf "crop=iw/4:ih/4:iw*0.4:ih*0.4,scale=1:1" -f rawvideo -pix_fmt rgb24 - | od -An -tu1 | tr -s ' ')
echo "exported centre pixel: [$PX] (pure red 255,0,0 through sepia is about 100,89,69)"
python3 - "$W/r.json" "$PX" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); bad=0
c=[int(x) for x in sys.argv[2].split()]
extra=[("exported: red became a brownish sepia (not red any more)",60<c[0]<150 and 50<c[1]<130 and 30<c[2]<110 and abs(c[0]-c[1])<45)]
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
for n,x in extra:
    print(("PASS" if x else "FAIL"),n); bad+=not x
tot=len(r["steps"])+len(extra); print(f"{tot-bad}/{tot} video workflow checks passed"); sys.exit(1 if bad else 0)
PY
