#!/usr/bin/env bash
# GUI test for the media library (SQLite): imports are remembered, the dialog finds and re-imports them, relinking looks where
# the library saw the same content, and missing files can be forgotten.
set -euo pipefail
cd "$(dirname "$0")/../.."
export CARGO_INCREMENTAL=0
W=$(mktemp -d "/tmp/ffworks-library.XXXXXX"); mkdir -p "$W/cache" "$W/data" "$W/a" "$W/archive" "$W/empty"
ffmpeg -v error -y -f lavfi -i testsrc=s=160x120:r=10:d=2 -f lavfi -i sine=f=440:d=2 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$W/a/interview.mp4"
cp "$W/a/interview.mp4" "$W/archive/interview_final.mp4"
ffmpeg -v error -y -f lavfi -i testsrc=s=160x120:r=10:d=1 -c:v libx264 -pix_fmt yuv420p "$W/a/beach holiday.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__W__|$W|g" scripts/uitest/library.js > "$W/t1.js"
sed -e "s|__W__|$W|g" scripts/uitest/library2.js > "$W/t2.js"
node --check "$W/t1.js"; node --check "$W/t2.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" XDG_DATA_HOME="$W/data" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
run() { # <script> <result file>
  FFWORKS_UITEST_SCRIPT="$1" FFWORKS_UITEST_OUT="$2" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
  for i in $(seq 1 120); do [ -f "$2" ] && break; sleep 1; done
  kill $P 2>/dev/null || true; wait $P 2>/dev/null || true
}
run "$W/t1.js" "$W/r1.json"
# between the two launches the original file goes away
rm "$W/a/interview.mp4"
run "$W/t2.js" "$W/r2.json"
python3 - "$W/r1.json" "$W/r2.json" <<'PY'
import json,sys
bad=0;n=0
for f in sys.argv[1:]:
    r=json.load(open(f))
    for s in r["steps"]:
        n+=1
        print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]);bad+=not s["pass"]
print(f'{n-bad}/{n} library steps passed');sys.exit(1 if bad else 0)
PY
