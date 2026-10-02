#!/usr/bin/env bash
# Crash-recovery test: launch, edit, wait for autosave, `kill -9` the app, relaunch and recover; then save and
# confirm the next launch does NOT offer recovery. Uses the same in-webview test hook as run.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-recovery.XXXXXX")
mkdir -p "$W/cache"
ffmpeg -v error -y -f lavfi -i "color=c=red:s=320x240:r=25:d=4" -f lavfi -i "sine=f=440:r=44100:d=4" -c:v libx264 -pix_fmt yuv420p -g 12 -c:a aac -shortest "$W/a.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null)
touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" FFWORKS_AUTOSAVE_SECS=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
PRE='const R={ok:true,steps:[]};const step=(n,c,d="")=>{R.steps.push({name:n,pass:!!c,detail:String(d)});if(!c)R.ok=false;};const sleep=m=>new Promise(r=>setTimeout(r,m));const waitFor=async(f,ms=10000)=>{const t=Date.now();while(Date.now()-t<ms){const v=f();if(v)return v;await sleep(50);}return null;};const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];const inv=window.__TAURI_INTERNALS__.invoke;const view=()=>window.__ffworks.useProject.getState().view;'
POST='await inv("uitest_report",{report:JSON.stringify(R)});})();'
# phase 1: make unsaved edits
cat > "$W/p1.js" <<JS
(async()=>{$PRE try{await waitFor(()=>\$(".app")&&view());
await window.__ffworks.importPaths(["$W/a.mp4"]);await waitFor(()=>\$\$(".media-item").length===1);
\$\$(".media-item")[0].dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));await sleep(300);
window.__ffworks.usePlayhead.getState().setT(2);
\$\$("button").find(b=>b.textContent.includes("Split")).click();await sleep(300);
step("phase1: unsaved project with a split clip",view().dirty&&\$\$(".track.video .clip").length===2);
await sleep(3500);}catch(e){step("exception",false,e&&e.stack||e);}
$POST
JS
# phase 2: after the crash
cat > "$W/p2.js" <<JS
(async()=>{$PRE try{await waitFor(()=>\$(".app")&&view());
const dlg=await waitFor(()=>\$("[aria-label='Recover unsaved work']"));
step("phase2: recovery dialog is offered after the crash",!!dlg,dlg&&dlg.textContent);
step("dialog reports 4 clips (2 video + 2 linked audio)",dlg&&/\(4 clips\)/.test(dlg.textContent),dlg&&dlg.textContent);
step("before recovering, the project is empty",\$\$(".track.video .clip").length===0);
\$\$("button").find(b=>b.textContent==="Recover").click();await sleep(800);
step("Recover restores both video clips and linked audio",\$\$(".track.video .clip").length===2&&\$\$(".track.audio .clip").length===2,\$\$(".track.video .clip").length);
step("recovered project is still marked unsaved",view().dirty===true);
step("dialog closes",!\$("[aria-label='Recover unsaved work']"));
await window.__ffworks.useProject.getState().run(()=>inv("save_project",{path:"$W/saved.ffworks"}));
step("explicit save clears the dirty flag",view().dirty===false);
}catch(e){step("exception",false,e&&e.stack||e);}
$POST
JS
# phase 3: clean state
cat > "$W/p3.js" <<JS
(async()=>{$PRE try{await waitFor(()=>\$(".app")&&view());await sleep(2500);
step("phase3: no recovery offered after a deliberate save",!\$("[aria-label='Recover unsaved work']"));
}catch(e){step("exception",false,e&&e.stack||e);}
$POST
JS
run_phase() { # $1=name $2=wait-for-report
  rm -f "$W/$1.json"
  FFWORKS_UITEST_SCRIPT="$W/$1.js" FFWORKS_UITEST_OUT="$W/$1.json" target/debug/ffworks-app >"$W/$1.log" 2>&1 &
  echo $! > "$W/$1.pid"
  for i in $(seq 1 90); do [ -f "$W/$1.json" ] && break; sleep 1; done
}
run_phase p1
echo "autosave files after phase 1:"; ls -la "$W/cache"/*/recovery 2>/dev/null || find "$W/cache" -name 'recovery*'
kill -9 "$(cat "$W/p1.pid")"; sleep 1   # simulated crash: no clean shutdown, no close handler
run_phase p2
kill "$(cat "$W/p2.pid")" 2>/dev/null || true; sleep 1
run_phase p3
kill "$(cat "$W/p3.pid")" 2>/dev/null || true
python3 - "$W" <<'PY'
import json,sys,os
bad=0;n=0
for p in ("p1","p2","p3"):
    r=json.load(open(os.path.join(sys.argv[1],p+".json")))
    for s in r["steps"]:
        n+=1; print(("PASS" if s["pass"] else "FAIL"),s["name"], "" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
print(f"{n-bad}/{n} recovery steps passed"); sys.exit(1 if bad else 0)
PY
