#!/usr/bin/env bash
# GUI test for the filter-graph node editor: builds in -> negate -> hue(s=0) -> out with real drags, exports,
# then checks the exported pixels and the saved project file independently.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-graph.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "color=c=red:s=160x240:r=25:d=4" -f lavfi -i "color=c=blue:s=160x240:r=25:d=4" -f lavfi -i "sine=f=440:r=44100:d=4" \
  -filter_complex "[0:v][1:v]hstack[v]" -map "[v]" -map 2:a -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/halves.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__SRC__|$W/halves.mp4|g" -e "s|__OUT__|$W/out.mp4|g" -e "s|__PROJ__|$W/p.ffworks|g" scripts/uitest/graph.js > "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 240); do [ -f "$W/r.json" ] && break; sleep 1; done
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $P 2>/dev/null || true
# GUI project is 1920x1080; the 320x240 source is fitted to 1440x1080 (red x 240..960, blue 960..1680).
# negate: red -> cyan, blue -> yellow; hue s=0 then removes colour, leaving luma: cyan ~179, yellow ~226.
px() { ffmpeg -v error -ss 1 -i "$W/out.mp4" -frames:v 1 -vf "crop=2:2:$1:$2,scale=1:1" -f rawvideo -pix_fmt rgb24 - | od -An -tu1 | tr -s ' '; }
python3 - "$W/r.json" "$(px 600 540)" "$(px 1300 540)" "$(px 100 540)" "$W/p.ffworks" <<'PY'
import json,sys,os
r=json.load(open(sys.argv[1])); bad=0
p=lambda s:[int(x) for x in s.split()]
red,blue,edge=p(sys.argv[2]),p(sys.argv[3]),p(sys.argv[4])
grey=lambda c:max(c)-min(c)<18
extra=[("exported: former red half is grey at about the luma of cyan (179)",grey(red) and abs(red[0]-179)<25),("exported: former blue half is grey at about the luma of yellow (226)",grey(blue) and abs(blue[0]-226)<25),("exported: the letterbox bars (part of the frame the graph sees) are negated to white",min(edge)>225)]
if os.path.exists(sys.argv[5]):
    fx=[e for c in json.load(open(sys.argv[5]))["sequences"][0]["tracks"][0]["clips"] for e in c["effects"]]
    g=fx[0]["graph"]
    extra.append(("saved project file holds the graph with 4 nodes, 3 edges and hue s=0",len(g["nodes"])==4 and len(g["edges"])==3 and ["s","0"] in [o for n in g["nodes"] for o in n["options"]]))
else: extra.append(("project file was saved",False))
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
for n,c in extra:
    print(("PASS" if c else "FAIL"),n); bad+=not c
tot=len(r["steps"])+len(extra); print(f"{tot-bad}/{tot} graph editor checks passed"); sys.exit(1 if bad else 0)
PY
