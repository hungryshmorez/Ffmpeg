// =============================================================================
// live-record.mjs — live effect → Record → Media Bin → (re-usable by ffmpeg)
// -----------------------------------------------------------------------------
// Answers "can I run video through TripCam / the VJ deck, apply an effect, record
// it to the Media Bin, and pile more on with ffmpeg?" by exercising the exact
// path both use: TripCam.startRec(canvas) → MediaRecorder → addBlobToBin +
// FFClips. We animate a canvas (standing in for the live effect output), record
// it, and prove:
//   • startRec/stopRec hands back a NON-EMPTY video blob
//   • it DECODES to real frames (videoWidth>0 and the time advances)
//   • addBlobToBin was called (it lands in the bin as an ordinary clip, so any
//     ffmpeg workflow can then run on it)
//
//   node .test/live-record.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8236);
const BASE = process.env.BASE || `http://localhost:${PORT}`;
const USE_EXTERNAL = !!process.env.BASE;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.map': 'application/json', '.ttf': 'font/ttf' };

function startServer() {
  const srv = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const full = normalize(join(ROOT, p));
      if (!full.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
      const data = await readFile(full);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(full)] || 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch { res.writeHead(404).end('not found: ' + req.url); }
  });
  return new Promise((resolve, reject) => { srv.on('error', reject); srv.listen(PORT, () => resolve(srv)); });
}

let server, browser, code = 1;
const checks = [];
const ok = (name, pass, detail) => { checks.push(pass); durable(`  ${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`); };

try {
  if (!USE_EXTERNAL) { server = await startServer(); console.log(`[server] listening on ${BASE}`); }
  browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.TripCam && window.TripCam.startRec), { timeout: 60000 });
  durable('[boot] TripCam.startRec present');

  const r = await page.evaluate(async () => {
    // spy on the bin add so we know it lands there
    let addedName = null, addedType = null;
    const realAdd = window.addBlobToBin;
    window.addBlobToBin = async (blob, name, type) => { addedName = name; addedType = type; return realAdd ? realAdd(blob, name, type) : null; };
    let recBlob = null;
    // grab the blob TripCam produces by also spying (startRec calls addBlobToBin)
    const grab = window.addBlobToBin;
    window.addBlobToBin = async (blob, name, type) => { recBlob = blob; return grab(blob, name, type); };

    // an animated canvas = the "live effect output"
    const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180;
    const ctx = cv.getContext('2d');
    let t = 0; const anim = setInterval(() => { t += 8; ctx.fillStyle = `hsl(${t % 360},80%,50%)`; ctx.fillRect(0, 0, 320, 180); ctx.fillStyle = '#fff'; ctx.fillRect((t % 300), 60, 40, 40); }, 33);

    window.TripCam.startRec(cv, 30);
    await new Promise((res) => setTimeout(res, 1600));
    window.TripCam.stopRec();
    clearInterval(anim);
    // wait for onstop → blob assembled + addBlobToBin called
    for (let i = 0; i < 40 && !recBlob; i++) await new Promise((res) => setTimeout(res, 100));

    if (!recBlob) return { hadBlob: false };
    const sizeKB = recBlob.size / 1024;

    // decode it — does it play back to real frames?
    const url = URL.createObjectURL(recBlob);
    const v = document.createElement('video'); v.src = url; v.muted = true;
    await new Promise((res) => { v.onloadedmetadata = res; v.onerror = res; setTimeout(res, 4000); });
    let advanced = false;
    try { await v.play(); await new Promise((res) => setTimeout(res, 400)); advanced = v.currentTime > 0; v.pause(); } catch (_) {}
    URL.revokeObjectURL(url);

    return { hadBlob: true, sizeKB, w: v.videoWidth, h: v.videoHeight, advanced, addedName, addedType };
  });

  ok('record → a non-empty video blob comes back', r.hadBlob && r.sizeKB > 5, `${(r.sizeKB || 0).toFixed(0)} KB`);
  ok('the recording decodes to real frames', r.w > 0 && r.h > 0 && r.advanced, `${r.w}×${r.h}, advanced=${r.advanced}`);
  ok('it lands in the Media Bin (addBlobToBin called → ffmpeg-ready)', !!r.addedName, `${r.addedName} (${r.addedType})`);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 3 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
