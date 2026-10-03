#!/usr/bin/env bash
# GUI test for the local API: it starts from the saved settings, an outside program (curl) edits the open project and the
# editor shows it, web pages are refused, and turning it off in Diagnostics closes the port.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-localapi.XXXXXX"); mkdir -p "$W/cache" "$W/cfg/app.ffworks.desktop"
PORT=$((47000 + RANDOM % 900)); TOKEN="localapitesttoken$RANDOM$RANDOM"
printf '{"local_api": true, "local_api_port": %s, "local_api_token": "%s"}' "$PORT" "$TOKEN" > "$W/cfg/app.ffworks.desktop/settings.json"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
sed -e "s|__PORT__|$PORT|g" -e "s|__TOKEN__|$TOKEN|g" scripts/uitest/localapi.js > "$W/t.js"
node --check "$W/t.js"
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
FFWORKS_UITEST_SCRIPT="$W/t.js" FFWORKS_UITEST_OUT="$W/r.json" target/debug/ffworks-app >"$W/app.log" 2>&1 & P=$!
A="Authorization: Bearer $TOKEN"; U="http://127.0.0.1:$PORT"
# wait for the API, then edit the project from outside the app
for i in $(seq 1 60); do curl -s -H "$A" "$U/v1/status" >/dev/null 2>&1 && break; sleep 1; done
TRACK=$(curl -s -H "$A" "$U/v1/project" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sequences"][0]["tracks"][0]["id"])')
curl -s -H "$A" -X POST "$U/v1/command" -d "{\"type\":\"add_solid\",\"track\":\"$TRACK\",\"start\":\"0\",\"duration\":\"3\",\"color\":\"#ff0000\"}" > "$W/cmd.json"
for i in $(seq 1 120); do [ -f "$W/r.json" ] && break; sleep 1; done
# the JS turned the API off at its end: the port must be closed now
sleep 1
if curl -s -m 2 -H "$A" "$U/v1/status" >/dev/null 2>&1; then echo "FAIL the port is still open after turning the API off"; OPEN=1; else OPEN=0; fi
ffmpeg -v error -y -f x11grab -video_size 1600x1000 -i :99 -frames:v 1 "${SHOT:-$W/final.png}" || true
kill $P 2>/dev/null || true
python3 - "$W/r.json" "$W/cmd.json" "$OPEN" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]));bad=0
cmd=json.load(open(sys.argv[2]))
r["steps"].append({"name":"curl's command was accepted","pass":cmd.get("ok") is True,"detail":json.dumps(cmd)})
r["steps"].append({"name":"the port is closed after turning the API off","pass":sys.argv[3]=="0","detail":""})
for s in r["steps"]:
    print(("PASS" if s["pass"] else "FAIL"),s["name"],"" if s["pass"] else s["detail"][:300]);bad+=not s["pass"]
print(f'{len(r["steps"])-bad}/{len(r["steps"])} local API steps passed');sys.exit(1 if bad else 0)
PY
