#!/usr/bin/env bash
# GUI test for adjustment layers: add one, give it an effect, render a preview and measure it.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-adjustment.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "color=c=red:s=160x240:r=25:d=4" -f lavfi -i "color=c=blue:s=160x240:r=25:d=4" -filter_complex "[0:v][1:v]hstack[v]" -map "[v]" -c:v libx264 -pix_fmt yuv420p "$W/halves.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__SRC__|$W/halves.mp4|g" scripts/uitest/adjustment.js > "$W/t.js"
node --check "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" XDG_DATA_HOME="$W/data" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 240); do [ -f "$W/r.json" ] && break; sleep 1; done
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $P 2>/dev/null || true
python3 - "$W/r.json" <<'PY'
import json,subprocess,sys
r=json.load(open(sys.argv[1])); bad=0
def px(path,t,fx,fy):
    o=subprocess.run(["ffmpeg","-v","error","-ss",str(t),"-i",path,"-frames:v","1","-vf",f"crop=iw/16:ih/16:iw*{fx}:ih*{fy},scale=1:1","-f","rawvideo","-pix_fmt","rgb24","-"],capture_output=True).stdout
    return tuple(o) if len(o)==3 else None
checks=[]
p=r.get("preview")
if p:
    a=px(p,0.5,0.2,0.5); b=px(p,2.0,0.2,0.5); c=px(p,2.0,0.7,0.5)
    checks.append((f"before the layer the left half is red {a}", a is not None and a[0]>150 and a[1]<80))
    checks.append((f"inside the layer both halves are gray {b} {c}", b is not None and c is not None and max(b)-min(b)<30 and max(c)-min(c)<30))
else:
    checks.append(("a preview file was produced",False))
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
for n,c in checks:
    print(("PASS" if c else "FAIL"),n); bad+=not c
tot=len(r["steps"])+len(checks); print(f"{tot-bad}/{tot} adjustment checks passed"); sys.exit(1 if bad else 0)
PY
