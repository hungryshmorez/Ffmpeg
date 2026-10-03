#!/usr/bin/env bash
# GUI test for the built-in pixel sort: adds it from the Effects panel, renders a processed preview and an export, then
# measures that the rows of the real pictures are sorted (they are not in the source).
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-pixelsort.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "nullsrc=s=320x240:r=25:d=4,format=yuv420p,geq=lum='mod(X*97+Y*13,256)':cb=128:cr=128" -c:v ffv1 "$W/noise.mkv"
ffmpeg -v error -y -f lavfi -i "nullsrc=s=320x240:r=25,format=yuv420p,geq=lum='if(lt(X,160),255,0)':cb=128:cr=128" -frames:v 1 "$W/mask.png"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__SRC__|$W/noise.mkv|g" -e "s|__OUT__|$W/out.mkv|g" -e "s|__MASK__|$W/mask.png|g" -e "s|__OUT2__|$W/out2.mkv|g" scripts/uitest/pixelsort.js > "$W/t.js"
node --check "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 300); do [ -f "$W/r.json" ] && break; sleep 1; done
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $P 2>/dev/null || true
python3 - "$W/r.json" "$W/noise.mkv" <<'PY'
import json,subprocess,sys
r=json.load(open(sys.argv[1])); src=sys.argv[2]; bad=0
def gray(path,t):
    o=subprocess.run(["ffmpeg","-v","error","-ss",str(t),"-i",path,"-frames:v","1","-vf","format=gray","-f","rawvideo","-"],capture_output=True).stdout
    return o
# a preview may be scaled down, so ask ffprobe for the size
def dims(path):
    o=subprocess.run(["ffprobe","-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","csv=p=0",path],capture_output=True,text=True).stdout.strip().split(",")
    return int(o[0]),int(o[1])
def fall_ratio(path,t,slack):
    w,h=dims(path); b=gray(path,t)
    if len(b)!=w*h: return None
    n=bad=0
    for y in range(h):
        row=b[y*w:(y+1)*w]
        for x in range(1,w):
            n+=1; bad+= row[x] < row[x-1]-slack
    return bad/n
checks=[]
src=fall_ratio(src,0.5,3); checks.append(("source rows are not sorted (control)",src is not None and src>0.3))
for label,path,t,slack in (("preview",r.get("preview"),0.5,14),("export",r.get("out"),1.0,3)):
    f=fall_ratio(path,t,slack) if path else None
    checks.append((f"{label} rows are sorted ({f})",f is not None and f<0.05))
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
for n,c in checks:
    print(("PASS" if c else "FAIL"),n); bad+=not c
tot=len(r["steps"])+len(checks); print(f"{tot-bad}/{tot} pixel sort checks passed"); sys.exit(1 if bad else 0)
PY
