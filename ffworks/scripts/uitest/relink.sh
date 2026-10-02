#!/usr/bin/env bash
# GUI test for offline media + relinking (file renamed and moved between launches) and the FFmpeg-path setting.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d "/tmp/ffworks-relink.XXXXXX"); mkdir -p "$W/cache" "$W/src"
ffmpeg -v error -y -f lavfi -i "color=c=red:s=320x240:r=25:d=4" -f lavfi -i "sine=f=440:r=44100:d=4" -c:v libx264 -pix_fmt yuv420p -g 12 -c:a aac -shortest "$W/src/a.mp4"
(cd ui && VITE_UITEST=1 npx vite build >/dev/null); touch src-tauri/src/lib.rs
cargo build -p ffworks-app --features custom-protocol,uitest 2>&1 | tail -1
export DISPLAY=:99 XDG_CACHE_HOME="$W/cache" XDG_CONFIG_HOME="$W/cfg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
pgrep Xvfb >/dev/null || { Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
PRE='const R={ok:true,steps:[]};const step=(n,c,d="")=>{R.steps.push({name:n,pass:!!c,detail:String(d)});if(!c)R.ok=false;};const sleep=m=>new Promise(r=>setTimeout(r,m));const waitFor=async(f,ms=10000)=>{const t=Date.now();while(Date.now()-t<ms){const v=f();if(v)return v;await sleep(50);}return null;};const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];const inv=window.__TAURI_INTERNALS__.invoke;const view=()=>window.__ffworks.useProject.getState().view;const run=f=>window.__ffworks.useProject.getState().run(f);'
POST='await inv("uitest_report",{report:JSON.stringify(R)});})();'
cat > "$W/p1.js" <<JS
(async()=>{$PRE try{await waitFor(()=>\$(".app")&&view());
await window.__ffworks.importPaths(["$W/src/a.mp4"]);await waitFor(()=>\$\$(".media-item").length===1);
\$\$(".media-item")[0].dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));await sleep(300);
await run(()=>inv("save_project",{path:"$W/p.ffworks"}));
step("p1: project with media saved",!view().dirty&&view().offlineMedia.length===0);
}catch(e){step("exception",false,e&&e.stack||e);}
$POST
JS
cat > "$W/p2.js" <<JS
(async()=>{$PRE try{await waitFor(()=>\$(".app")&&view());
await run(()=>inv("open_project",{path:"$W/p.ffworks"}));await sleep(500);
step("opening a project whose media was moved reports it offline",view().offlineMedia.length===1&&!!\$(".offline-banner")&&!!\$(".media-item.offline"),\$(".offline-banner")&&\$(".offline-banner").textContent);
step("the timeline still shows the clips (references intact)",\$\$(".track.video .clip").length===1);
const r=await inv("relink_search",{dir:"$W/moved"});window.__ffworks.useProject.getState().setView(r.state);await sleep(400);
step("relink by content finds the renamed file",r.relinked.length===1&&r.unresolved.length===0,JSON.stringify(r.relinked));
step("banner disappears and media is online",!\$(".offline-banner")&&!\$(".media-item.offline"));
step("media now points at the new location",/renamed copy\.mp4$/.test(view().project.media[0].path),view().project.media[0].path);
\$\$("button").find(b=>b.textContent.includes("Undo")).click();await sleep(300);
step("undo returns to the offline state",view().offlineMedia.length===1);
\$\$("button").find(b=>b.textContent.includes("Redo")).click();await sleep(300);
step("redo relinks again",view().offlineMedia.length===0);
let rejected=false;try{await inv("set_settings",{ffmpegPath:"/definitely/not/ffmpeg",ffprobePath:null});}catch(e){rejected=true;}
step("settings: a bogus FFmpeg path is rejected and not saved",rejected&&(await inv("get_settings")).ffmpeg_path===null);
let v=null;try{v=await inv("set_settings",{ffmpegPath:"$(command -v ffmpeg)",ffprobePath:"$(command -v ffprobe)"});}catch(e){v=String(e);}
step("settings: a real FFmpeg/FFprobe path is accepted and persisted",v&&v.ffmpeg&&(await inv("get_settings")).ffmpeg_path==="$(command -v ffmpeg)",JSON.stringify(v));
}catch(e){step("exception",false,e&&e.stack||e);}
$POST
JS
run_phase() { rm -f "$W/$1.json"; FFWORKS_UITEST_SCRIPT="$W/$1.js" FFWORKS_UITEST_OUT="$W/$1.json" target/debug/ffworks-app >"$W/$1.log" 2>&1 & echo $! > "$W/$1.pid"; for i in $(seq 1 60); do [ -f "$W/$1.json" ] && break; sleep 1; done; kill "$(cat "$W/$1.pid")" 2>/dev/null || true; sleep 1; }
run_phase p1
mkdir -p "$W/moved/deeper"; mv "$W/src/a.mp4" "$W/moved/deeper/renamed copy.mp4"
run_phase p2
python3 - "$W" <<'PY'
import json,sys,os
bad=0;n=0
for p in ("p1","p2"):
    r=json.load(open(os.path.join(sys.argv[1],p+".json")))
    for s in r["steps"]:
        n+=1; print(("PASS" if s["pass"] else "FAIL"),s["name"], "" if s["pass"] else s["detail"][:300]); bad+=not s["pass"]
print(f"{n-bad}/{n} relink/settings steps passed"); sys.exit(1 if bad else 0)
PY
