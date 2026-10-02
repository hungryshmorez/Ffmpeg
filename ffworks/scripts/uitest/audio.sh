#!/usr/bin/env bash
# GUI test for audio pan/fades/effects/mixer: drives the real Inspector and Mixer, then measures the exported file's channels independently.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-audio.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "color=c=black:s=320x240:r=25:d=4" -f lavfi -i "sine=f=1000:r=44100:d=4,volume=4" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/tone.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__SRC__|$W/tone.mp4|g" -e "s|__OUT__|$W/out.mp4|g" scripts/uitest/audio.js > "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 240); do [ -f "$W/r.json" ] && break; sleep 1; done
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $P 2>/dev/null || true
# independent check on the exported file: pan = +1 (hard right) and fades 1 s in / 0.5 s out
ch() { ffmpeg -nostdin -hide_banner -ss "$1" -t "$2" -i "$W/out.mp4" -vn -af "pan=mono|c0=$3,volumedetect" -f null - 2>&1 | grep -o 'mean_volume: [-0-9.]*' | awk '{print $2}'; }
L=$(ch 1.5 1.5 c0); R=$(ch 1.5 1.5 c1); HEAD=$(ch 0 0.2 c1); TAIL=$(ch 3.8 0.2 c1)
echo "left=$L right=$R  fade-in head=$HEAD  mid=$R  tail=$TAIL"
python3 - "$W/r.json" "$L" "$R" "$HEAD" "$TAIL" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); bad=0
L,R,HEAD,TAIL=[float(x) for x in sys.argv[2:6]]
extra=[("exported: hard right pan silences the left channel",L<-60),("exported: the right channel carries the tone",R>-30),("exported: fade-in makes the first 0.2 s much quieter",HEAD<R-12),("exported: fade-out makes the last 0.2 s much quieter",TAIL<R-12)]
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
for n,c in extra:
    print(("PASS" if c else "FAIL"),n); bad+=not c
tot=len(r["steps"])+len(extra); print(f"{tot-bad}/{tot} audio checks passed"); sys.exit(1 if bad else 0)
PY
