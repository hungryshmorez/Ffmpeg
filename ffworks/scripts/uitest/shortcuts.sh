#!/usr/bin/env bash
# GUI test for the keyboard shortcut editor: rebind, conflicts, remove, reset, and the change surviving a restart.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-shortcuts.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "testsrc2=s=160x120:r=25:d=6" -f lavfi -i "sine=f=440:r=44100:d=6" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/f.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" XDG_DATA_HOME="$W/data" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
for phase in 1 2; do
  sed "s|__SRC__|$W/f.mp4|g; s|__PHASE__|$phase|g" scripts/uitest/shortcuts.js > "$W/t$phase.js"
  FFWORKS_UITEST_SCRIPT="$W/t$phase.js" FFWORKS_UITEST_OUT="$W/r$phase.json" target/debug/ffworks-app >"$W/app$phase.log" 2>&1 & P=$!
  for i in $(seq 1 120); do [ -f "$W/r$phase.json" ] && break; sleep 1; done
  [ "$phase" = 1 ] && { ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true; }
  kill $P 2>/dev/null || true; wait $P 2>/dev/null || true
done
python3 - "$W/r1.json" "$W/r2.json" <<'PY'
import json,sys
steps=[s for f in sys.argv[1:] for s in json.load(open(f))["steps"]];bad=0
r={"steps":steps}
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]);bad+=not s["pass"]
print(f'{len(r["steps"])-bad}/{len(r["steps"])} shortcuts steps passed');sys.exit(1 if bad else 0)
PY
