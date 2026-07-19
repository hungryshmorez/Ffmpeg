// =============================================================================
// preview-fx.mjs — Live FX in the Preview tab
// -----------------------------------------------------------------------------
// The Preview tab can now run the source through the shared effect engine live
// and record it to the Media Bin. Verified on real canvas pixels (never bytes):
//   • the effect list includes look-engine effects AND real FFShaderPlus shader
//     passes (pixel sort / halation / film grain — the library Trip Cam uses)
//   • applyEffect does what it claims (grayscale→R=G=B, invert→255−x, vibrant
//     widens the channel spread) and the shader passes actually alter pixels
//   • renderFrameFrom paints the selected effect onto #pv-fx
//   • entering the "Live FX" preview mode starts the render loop; leaving stops it
//   • Record → Bin runs the exact TripCam.startRec path and lands a decodable
//     video clip in the Media Bin (ready for further ffmpeg work)
//
//   node .test/preview-fx.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8245);
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
  await page.waitForFunction(() => !!(window.FFPreviewFX && window.FFPreviewFX.applyEffect && window.TripCam), { timeout: 60000 });
  durable('[boot] FFPreviewFX present');

  // ---- effects + pixel behaviour
  const r1 = await page.evaluate(() => {
    const FX = window.FFPreviewFX, W = 24, H = 24;
    const frame = () => { const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < d.length; i += 4) { d[i] = 30 + (i % 200); d[i + 1] = 100; d[i + 2] = 200 - (i % 150); d[i + 3] = 255; } return { data: d, width: W, height: H }; };
    const spread = (im) => { let s = 0, n = 0; for (let i = 0; i < im.data.length; i += 4) { const l = 0.299 * im.data[i] + 0.587 * im.data[i + 1] + 0.114 * im.data[i + 2]; s += Math.abs(im.data[i] - l) + Math.abs(im.data[i + 2] - l); n += 2; } return s / n; };
    const diff = (a, b) => { let d = 0; for (let i = 0; i < a.data.length; i += 4) d += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]); return d / (a.data.length / 4); };
    const ids = FX.EFFECTS.map((e) => e.id);
    const hasShaders = ['pixelsort', 'halation', 'filmgrain'].every((id) => ids.includes(id));

    const g = FX.applyEffect(frame(), 'grayscale', 1);
    let gray = true; for (let i = 0; i < g.data.length; i += 4) if (g.data[i] !== g.data[i + 1] || g.data[i + 1] !== g.data[i + 2]) { gray = false; break; }
    const base = frame(); const inv = FX.applyEffect(frame(), 'invert', 1);
    let invOk = true; for (let i = 0; i < inv.data.length; i += 4) if (inv.data[i] !== 255 - base.data[i]) { invOk = false; break; }
    const vib = FX.applyEffect(frame(), 'vibrant', 1);
    const vibWider = spread(vib) > spread(frame()) * 1.3;

    // real shader passes actually change pixels
    const grainChanged = diff(FX.applyEffect(frame(), 'filmgrain', 1), frame()) > 0.5;
    const sortChanged = diff(FX.applyEffect(frame(), 'pixelsort', 1), frame()) > 0.5;

    return { count: FX.EFFECTS.length, hasShaders, gray, invOk, vibWider, grainChanged, sortChanged };
  });
  ok('Live FX exposes look effects + real FFShaderPlus shader passes (pixel sort / halation / grain)', r1.hasShaders && r1.count >= 12, `${r1.count} effects`);
  ok('applyEffect behaves: grayscale→R=G=B, invert→255−x, vibrant widens spread', r1.gray && r1.invOk && r1.vibWider);
  ok('the real shader passes actually alter pixels (film grain + pixel sort)', r1.grainChanged && r1.sortChanged);

  // ---- renderFrameFrom paints the effect onto #pv-fx; mode start/stop
  const r2 = await page.evaluate(() => {
    const FX = window.FFPreviewFX;
    FX.populate();
    const sel = document.getElementById('pv-fx-effect');
    const populated = !!sel && sel.options.length === FX.EFFECTS.length;
    // render a grayscale frame onto the canvas (no source → shared test frame)
    FX.setEffect('grayscale');
    const dst = document.getElementById('pv-fx');
    FX.renderFrameFrom(null, dst);
    const px = dst.getContext('2d').getImageData(0, 0, dst.width, dst.height).data;
    let canvasGray = true; for (let i = 0; i < px.length; i += 400) if (px[i] !== px[i + 1] || px[i + 1] !== px[i + 2]) { canvasGray = false; break; }

    // entering FX mode starts the loop; another mode stops it
    if (typeof window.setPreviewMode === 'function') window.setPreviewMode('fx');
    document.querySelector('#preview-modes .mode-btn[data-mode="fx"]').click();
    const started = FX.isRunning();
    document.querySelector('#preview-modes .mode-btn[data-mode="source"]').click();
    const stopped = !FX.isRunning();
    return { populated, canvasGray, started, stopped };
  });
  ok('the effect select is populated and renderFrameFrom paints the effect onto #pv-fx', r2.populated && r2.canvasGray);
  ok('entering the Live FX mode starts the render loop; leaving stops it', r2.started && r2.stopped);

  // ---- Record → Bin: the FX canvas becomes a decodable clip in the Media Bin
  const r3 = await page.evaluate(async () => {
    let recBlob = null, addedName = null;
    const realAdd = window.addBlobToBin;
    window.addBlobToBin = async (blob, name, type) => { recBlob = blob; addedName = name; return realAdd ? realAdd(blob, name, type) : null; };

    const FX = window.FFPreviewFX;
    FX.setEffect('vhs');
    FX.start();
    // force the frames to differ so the capture isn't a single static image
    let a = 0; const anim = setInterval(() => { a = (a + 0.2) % 2; FX.setAmount(a); }, 40);
    const on = FX.record();               // start recording the #pv-fx canvas
    await new Promise((r) => setTimeout(r, 1400));
    FX.record();                          // toggle → stop
    clearInterval(anim); FX.stop();
    for (let i = 0; i < 40 && !recBlob; i++) await new Promise((r) => setTimeout(r, 100));
    if (!recBlob) return { started: on, hadBlob: false };

    const url = URL.createObjectURL(recBlob);
    const v = document.createElement('video'); v.src = url; v.muted = true;
    await new Promise((res) => { v.onloadedmetadata = res; v.onerror = res; setTimeout(res, 4000); });
    let advanced = false;
    try { await v.play(); await new Promise((r) => setTimeout(r, 400)); advanced = v.currentTime > 0; v.pause(); } catch (_) {}
    URL.revokeObjectURL(url);
    return { started: on, hadBlob: true, sizeKB: recBlob.size / 1024, w: v.videoWidth, h: v.videoHeight, advanced, addedName };
  });
  ok('Record → Bin captures the FX canvas to a decodable Media-Bin clip (ffmpeg-ready)',
     r3.started && r3.hadBlob && r3.sizeKB > 5 && r3.w > 0 && r3.advanced && !!r3.addedName,
     `${(r3.sizeKB || 0).toFixed(0)}KB ${r3.w}×${r3.h} advanced=${r3.advanced} name=${r3.addedName}`);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 6 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
