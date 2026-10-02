#!/usr/bin/env bash
# GUI test for registering several FFmpeg builds, switching the active one and exporting with another.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-engines.XXXXXX"); mkdir -p "$W/cache" "$W/builds/ffA/bin" "$W/builds/ffB" "$W/builds/orphan"
FF=$(command -v ffmpeg); FP=$(command -v ffprobe)
ln -s "$FF" "$W/builds/ffA/bin/ffmpeg"; ln -s "$FP" "$W/builds/ffA/bin/ffprobe"
ln -s "$FF" "$W/builds/ffB/ffmpeg";     ln -s "$FP" "$W/builds/ffB/ffprobe"
ln -s "$FF" "$W/builds/orphan/ffmpeg"
ffmpeg -v error -y -f lavfi -i "color=c=red:s=160x240:r=25:d=4" -f lavfi -i "sine=f=440:r=44100:d=4" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/src.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__SRC__|$W/src.mp4|g" -e "s|__OUT__|$W/out.mp4|g" -e "s|__BUILDS__|$W/builds|g" scripts/uitest/engines.js > "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 240); do [ -f "$W/r.json" ] && break; sleep 1; done
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $P 2>/dev/null || true
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$W/out.mp4" 2>/dev/null || echo 0)
python3 - "$W/r.json" "$DUR" "$W/cfg" <<'PY'
import json,sys,glob
r=json.load(open(sys.argv[1])); bad=0
dur=float(sys.argv[2] or 0)
files=glob.glob(sys.argv[3]+"/**/settings.json",recursive=True)
st=json.load(open(files[0])) if files else {}
extra=[("exported file made with Build B is about 2 s long",abs(dur-2)<0.3),
       ("settings file keeps Build B registered and no active build after Build A was removed",[e["name"] for e in st.get("engines",[])]==["Build B"] and st.get("active_engine") is None)]
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
for n,c in extra:
    print(("PASS" if c else "FAIL"),n); bad+=not c
tot=len(r["steps"])+len(extra); print(f"{tot-bad}/{tot} FFmpeg builds checks passed"); sys.exit(1 if bad else 0)
PY
