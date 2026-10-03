#!/usr/bin/env bash
# GUI test: every control in the real UI has an accessible name, dialogs are labelled modal dialogs, images have alt text.
set -euo pipefail
cd "$(dirname "$0")/../.."
export CARGO_INCREMENTAL=0
W=$(mktemp -d "/tmp/ffworks-a11y.XXXXXX"); mkdir -p "$W/cache"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
cp scripts/uitest/a11y.js "$W/t.js"
node --check "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
for i in $(seq 1 120); do [ -f "$W/r.json" ] && break; sleep 1; done
kill $P 2>/dev/null || true
python3 - "$W/r.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]));bad=0
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else "\n    "+s["detail"].replace("\n","\n    "));bad+=not s["pass"]
print(f'{len(r["steps"])-bad}/{len(r["steps"])} accessibility steps passed');sys.exit(1 if bad else 0)
PY
