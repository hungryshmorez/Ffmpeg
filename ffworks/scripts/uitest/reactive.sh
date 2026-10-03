#!/usr/bin/env bash
# GUI test: an effect parameter follows the clip's loudness ("Follow audio"), then undo.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-reactive.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "color=c=gray:s=160x120:r=25:d=4" -f lavfi -i "sine=f=440:r=48000:d=4,volume='if(lt(t,2),0.01,1)':eval=frame" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/f.mp4"
ffmpeg -v error -y -f lavfi -i "color=c=white:s=160x120:r=25:d=4" -f lavfi -i "aevalsrc='0.8*sin(2*PI*1000*t)*between(mod(t,1),0.4,0.46)':s=48000:d=4" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/clicks.mp4"
python3 - "$W/song.mid" <<'PY'
import struct,sys
ev=bytes([0x00,0xB0,0x01,0x00])+bytes([0x8F,0x00,0xB0,0x01,0x7F])+bytes([0x00,0xFF,0x2F,0x00])  # CC1 = 0 at tick 0, 127 at tick 1920 (4 beats at 120 bpm = 2 s)
open(sys.argv[1],"wb").write(b"MThd"+struct.pack(">IHHH",6,0,1,480)+b"MTrk"+struct.pack(">I",len(ev))+ev)
PY
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed "s|__SRC__|$W/f.mp4|g; s|__CLICKS__|$W/clicks.mp4|g; s|__MIDI__|$W/song.mid|g" scripts/uitest/reactive.js > "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 120); do [ -f "$W/r.json" ] && break; sleep 1; done
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $P 2>/dev/null || true
python3 - "$W/r.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]));bad=0
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]);bad+=not s["pass"]
print(f'{len(r["steps"])-bad}/{len(r["steps"])} reactive steps passed');sys.exit(1 if bad else 0)
PY
