#!/usr/bin/env bash
# GUI test: a slow preview (a pixel sort over 1080p) can be cancelled; nothing is left behind and the next preview works.
set -euo pipefail
cd "$(dirname "$0")/../.."
export CARGO_INCREMENTAL=0
W=$(mktemp -d "/tmp/ffworks-pcancel.XXXXXX"); mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "nullsrc=s=1920x1080:r=30:d=12,format=yuv420p,geq=lum='mod(X*97+Y*13,256)':cb=128:cr=128" -c:v ffv1 "$W/big.mkv"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__SRC__|$W/big.mkv|g" scripts/uitest/previewcancel.js > "$W/t.js"
node --check "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 300); do [ -f "$W/r.json" ] && break; sleep 1; done
sleep 1
LEFT=$(find "$W/cache" \( -name '*.partial.mkv' -o -name '*.ffworks-partial.*' -o -name 'nest-*.render.mkv' \) 2>/dev/null | wc -l)
kill $P 2>/dev/null || true
python3 - "$W/r.json" "$LEFT" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]));bad=0
r["steps"].append({"name":"no partial files are left in the cache","pass":sys.argv[2]=="0","detail":sys.argv[2]+" left"})
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]);bad+=not s["pass"]
print(f'{len(r["steps"])-bad}/{len(r["steps"])} preview-cancel steps passed');sys.exit(1 if bad else 0)
PY
