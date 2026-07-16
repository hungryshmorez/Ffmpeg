// =============================================================================
// workflows.mjs — golden multi-workflow matrix (items #6, #7, #100).
// For each workflow: run it on a deterministic clip through the real UI path,
// decode the output, and assert the workflow's SIGNATURE actually landed
// (right resolution / frame count) — not just that bytes came out.
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http'; import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path'; import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';
const RESULTS = process.env.RESULTS || '';
const say = l => { console.log(l); if (RESULTS) try { appendFileSync(RESULTS, l+'\n'); } catch {} };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT || 8150), BASE = `http://localhost:${PORT}`;
const T={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.png':'image/png','.ttf':'font/ttf'};

// Two deterministic seeds:
//   V  = video-only  (testsrc)              → exercises the no-audio -an guard
//   AV = video+audio (testsrc + 440Hz sine) → exercises the split render's
//        video/audio/mux passes (the path my round-trip fix reworked)
const SEED_V  = ['-f','lavfi','-i','testsrc=duration=2:size=640x360:rate=30','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-y','seed.mp4'];
const SEED_AV = ['-f','lavfi','-i','testsrc=duration=2:size=640x360:rate=30','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y','seed.mp4'];

// Each row: { id, seed, check(r) } where r = { frames, w, h, bytes, hasAudio }.
const MATRIX = [
  { id:'downscale-480p', seed:SEED_V,  desc:'480p, no-audio input (-an guard)', check:r => r.h===480 && r.frames>=45 && r.hasAudio===false },
  { id:'downscale-360p', seed:SEED_V,  desc:'360p', check:r => r.h===360 && r.frames>=45 },
  { id:'fps-24',         seed:SEED_V,  desc:'retime to 24fps', check:r => r.frames>=40 && r.frames<=52 },
  { id:'downscale-480p', seed:SEED_AV, desc:'480p, WITH audio (video+audio+mux)', check:r => r.h===480 && r.frames>=45 && r.hasAudio===true },
];

const srv=http.createServer(async(rq,rs)=>{try{let p=rq.url.split('?')[0];if(p==='/')p='/index.html';const f=normalize(join(ROOT,p));const d=await readFile(f);rs.writeHead(200,{'Content-Type':T[extname(f)]||'application/octet-stream','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'});rs.end(d);}catch{rs.writeHead(404).end();}});
await new Promise(r=>srv.listen(PORT,r));
const b=await chromium.launch({executablePath:process.env.PW_EXEC||undefined,args:['--no-sandbox']});
let code=1;
try {
  const pg=await b.newPage(); pg.on('dialog',d=>d.accept().catch(()=>{}));
  await pg.goto(`${BASE}/index.html`,{waitUntil:'load'});
  await pg.waitForFunction(()=>typeof state!=='undefined'&&state.engineReady===true,{timeout:120000});
  say(`[boot] ready (${await pg.evaluate(()=>state.threadMode)})`);
  let pass=0;
  for (const wf of MATRIX) {
    const r = await pg.evaluate(async ({id, SEED}) => {
      // reset the media bin so a prior run's input can't leak in
      state.mediaBin = []; state.activeMediaId = null;
      await ff.exec(SEED,{raw:true});
      const seed=await ff.readFile('seed.mp4');
      const dt=new DataTransfer(); dt.items.add(new File([seed],'seed.mp4',{type:'video/mp4'}));
      const inp=document.querySelector('#file-input'); inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(r=>setTimeout(r,900));
      applyWorkflow(id,true); await new Promise(r=>setTimeout(r,250));
      try { await executeFromUI(); } catch(e){ return {err:'exec:'+(e.message||e)}; }
      if (!state.outputBlobUrl) return {err:'no output'};
      const u8=new Uint8Array(await (await fetch(state.outputBlobUrl)).arrayBuffer());
      const bytes=u8.length; await ff.writeFile('__v.mp4',u8);
      let buf=''; const g=({message})=>buf+=message+'\n'; state.ffmpeg.on('log',g);
      try { await ff.exec(['-hide_banner','-i','__v.mp4','-f','null','-'],{raw:true}); } catch{}
      state.ffmpeg.off('log',g); try{await ff.deleteFile('__v.mp4');}catch{}
      const fr=[...buf.matchAll(/frame=\s*(\d+)/g)]; const frames=fr.length?+fr[fr.length-1][1]:0;
      const m=buf.match(/,\s*(\d+)x(\d+)/); const w=m?+m[1]:0, h=m?+m[2]:0;
      const hasAudio=/Stream\s+#\d+:\d+.*?:\s*Audio:/i.test(buf);
      return { bytes, frames, w, h, hasAudio };
    }, { id: wf.id, SEED: wf.seed });
    const ok = !r.err && wf.check(r);
    if (ok) { pass++; say(`[${wf.id}] PASS — ${wf.desc}: ${r.frames}f ${r.w}x${r.h} ${r.bytes}B`); }
    else say(`[${wf.id}] FAIL — ${JSON.stringify(r)}`);
  }
  say(`==== ${pass}/${MATRIX.length} workflows passed ====`);
  code = pass===MATRIX.length?0:1;
} catch(e){ say('FATAL: '+e.message); } finally { await b.close().catch(()=>{}); srv.close(); }
process.exit(code);
