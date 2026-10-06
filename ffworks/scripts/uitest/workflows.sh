#!/usr/bin/env bash
# GUI test for the browser app's audio workflows: apply one from the Effects panel, edit/refuse its text, export, measure the level.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-wf.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "color=c=black:s=320x240:r=25:d=4" -f lavfi -i "sine=f=1000:r=44100:d=4,volume=4" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/tone.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__SRC__|$W/tone.mp4|g" -e "s|__OUT__|$W/out.wav|g" scripts/uitest/workflows.js > "$W/t.js"
node --check "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" XDG_DATA_HOME="$W/data" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 240); do [ -f "$W/r.json" ] && break; sleep 1; done
kill $P 2>/dev/null || true
M=$(ffmpeg -nostdin -hide_banner -i "$W/out.wav" -af volumedetect -f null - 2>&1 | grep -o 'mean_volume: [-0-9.]*' | awk '{print $2}')
echo "exported mean volume: $M dB (the plain tone is about -9 dB; volume=0.1 is 20 dB lower)"
python3 - "$W/r.json" "$M" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); bad=0
m=float(sys.argv[2])
extra=[("exported: the chain made it ~20 dB quieter than the plain tone",-35<m<-22)]
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
for n,c in extra:
    print(("PASS" if c else "FAIL"),n); bad+=not c
tot=len(r["steps"])+len(extra); print(f"{tot-bad}/{tot} audio workflow checks passed"); sys.exit(1 if bad else 0)
PY
