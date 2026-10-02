#!/usr/bin/env bash
# GUI test for titles / solid colours / stills: drives the real buttons and panels, then checks the exported video's pixels independently.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-gen.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "color=c=red:s=160x240,format=rgba" -f lavfi -i "color=c=blue:s=160x240,format=rgba" -filter_complex "[0:v][1:v]hstack" -frames:v 1 "$W/halves.png"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__PNG__|$W/halves.png|g" -e "s|__OUT__|$W/out.mp4|g" scripts/uitest/generated.js > "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 300); do [ -f "$W/r.json" ] && break; sleep 1; done
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $P 2>/dev/null || true
# Independent checks on the exported 1920x1080 file:
#  t=2: V1 is the green solid, V2 the red title "HELLO" in the middle (red pixels near the centre, none in the corners, green elsewhere)
#  t=8: the PNG (fitted to 1440x1080: red 240..960, blue 960..1680) is shown on V3 over black
python3 - "$W/r.json" "$W/out.mp4" <<'PY'
import json,subprocess,sys
r=json.load(open(sys.argv[1])); out=sys.argv[2]; bad=0
def frame(t):
    d=subprocess.run(["ffmpeg","-v","error","-ss",str(t),"-i",out,"-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","-"],capture_output=True).stdout
    return d if len(d)==1920*1080*3 else b""
def px(f,x,y): i=(y*1920+x)*3; return f[i],f[i+1],f[i+2]
extra=[]
f=frame(2)
if f:
    red=sum(1 for y in range(440,640,2) for x in range(760,1160,2) if px(f,x,y)[0]>200 and px(f,x,y)[1]<70 and px(f,x,y)[2]<70)
    g=px(f,60,60); g2=px(f,1850,1020)
    extra+= [("exported t=2: the red title text is drawn in the middle (%d red samples)"%red, red>150),("exported t=2: the green solid shows around the text %s"%(g,), g[1]>180 and g[0]<70 and g[2]<70),("exported t=2: corners are green, not covered by the title canvas %s"%(g2,), g2[1]>180 and g2[0]<70)]
else: extra.append(("exported frame at t=2 readable",False))
f=frame(8)
if f:
    a=px(f,500,540); b=px(f,1400,540); c=px(f,100,540)
    extra+= [("exported t=8: PNG left half is red %s"%(a,), a[0]>200 and a[2]<70),("exported t=8: PNG right half is blue %s"%(b,), b[2]>200 and b[0]<70),("exported t=8: outside the fitted picture is black %s"%(c,), max(c)<40)]
else: extra.append(("exported frame at t=8 readable",False))
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
for n,c in extra:
    print(("PASS" if c else "FAIL"),n); bad+=not c
tot=len(r["steps"])+len(extra); print(f"{tot-bad}/{tot} title/solid/still checks passed"); sys.exit(1 if bad else 0)
PY
