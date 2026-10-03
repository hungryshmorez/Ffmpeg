#!/usr/bin/env bash
# GUI test for Rhai scripting: run a script file through the app's command, undo it as one step, refuse a hostile one.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-script.XXXXXX"); mkdir -p "$W/cache"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
cat > "$W/good.rhai" <<'RHAI'
// tint every clip longer than 3 seconds, fade the short ones, and say what was done
let long = 0;
for c in clips() {
    if c.kind != "video" { continue; }
    if c.duration > 3.0 {
        add_effect(c.id, "negate");
        long += 1;
    } else {
        set_opacity(c.id, 0.5);
    }
}
add_marker(1, "script ran: " + long + " long");
print("long clips: " + long);
RHAI
cat > "$W/bad.rhai" <<'RHAI'
add_marker(3, "must not survive");
let f = read_file("/etc/passwd");
RHAI
cat > "$W/loop.rhai" <<'RHAI'
let n = 0;
loop { n += 1; }
RHAI
sed -e "s|__GOOD__|$W/good.rhai|g" -e "s|__BAD__|$W/bad.rhai|g" -e "s|__LOOP__|$W/loop.rhai|g" scripts/uitest/script.js > "$W/t.js"
node --check "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" XDG_DATA_HOME="$W/data" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
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
print(f'{len(r["steps"])-bad}/{len(r["steps"])} script steps passed');sys.exit(1 if bad else 0)
PY
