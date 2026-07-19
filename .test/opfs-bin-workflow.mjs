// =============================================================================
// opfs-bin-workflow.mjs — the OPFS→MEMFS→wasm handoff is bulletproof
// -----------------------------------------------------------------------------
// Proves the bridge between the OPFS stream loader and the legacy ffmpeg.wasm
// execution context end-to-end, through the REAL upload UI (#file-input change
// → handleFilesUpload → FFOpfsStream.fileToMemfs), for BOTH engine paths:
//   • Handoff:     a deterministic 640x360 / 60-frame testsrc is uploaded and
//                  binned via the OPFS load path.
//   • Execution:   the standard 'downscale-480p' workflow runs on that clip
//                  through the normal wasm pipeline (applyWorkflow → run).
//   • Verification: the output decodes to ~60 frames AND is scaled to 480p —
//                  if the OPFS→MEMFS handoff dropped a byte or failed to flush,
//                  the decode would fail here.
//   • Fallback:    the exact same sequence with OPFS artificially disabled
//                  (FFAccel 'wasm' mode) proves the graceful in-memory path.
//
//   node .test/opfs-bin-workflow.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8268);
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

const SEED = ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=30',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', 'seed.mp4'];

let server, browser, code = 1;
const checks = [];
const ok = (name, pass, detail) => { checks.push(pass); durable(`  ${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`); };

try {
  if (!USE_EXTERNAL) { server = await startServer(); console.log(`[server] listening on ${BASE}`); }
  browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.engineReady === true && !!window.FFOpfsStream && !!window.FFAccel, { timeout: 120000 });
  durable('[boot] engine + OPFS stream ready');

  // one run through the real upload UI at a given FFAccel mode
  const runOnce = (accelMode) => page.evaluate(async ({ SEED, accelMode }) => {
    window.FFAccel.setMode(accelMode);                 // set BEFORE upload so the load path picks OPFS vs fallback

    // deterministic input, uploaded through the REAL #file-input change handler
    await ff.exec(SEED, { raw: true });
    const seed = await ff.readFile('seed.mp4');
    const file = new File([seed], 'seed.mp4', { type: 'video/mp4' });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.querySelector('#file-input');
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));      // let handleFilesUpload → fileToMemfs settle

    // which path did the upload take through the router?
    const loadPath = window.FFAccel.lastPath('opfs.fileToMemfs');

    // standard workflow on the binned clip via the normal wasm pipeline
    applyWorkflow('downscale-480p', true);
    await new Promise((r) => setTimeout(r, 250));
    try { await executeFromUI(); } catch (e) { return { ok: false, err: e.message }; }
    if (!state.outputBlobUrl) return { ok: false, err: 'no output blob' };

    // decode the output — frame count + resolution
    const u8 = new Uint8Array(await (await fetch(state.outputBlobUrl)).arrayBuffer());
    const bytes = u8.length;
    await ff.writeFile('__verify.mp4', u8);
    let buf = ''; const grab = ({ message }) => { buf += message + '\n'; };
    state.ffmpeg.on('log', grab);
    try { await ff.exec(['-hide_banner', '-i', '__verify.mp4', '-f', 'null', '-'], { raw: true }); } catch (_) {}
    state.ffmpeg.off('log', grab);
    try { await ff.deleteFile('__verify.mp4'); } catch (_) {}
    const fm = [...buf.matchAll(/frame=\s*(\d+)/g)];
    const frames = fm.length ? parseInt(fm[fm.length - 1][1], 10) : 0;
    const res = (buf.match(/,\s*(\d+x\d+)/) || [])[1] || '?';
    window.FFAccel.setMode('auto');
    return { ok: bytes > 512 && frames > 0, bytes, frames, res, loadPath };
  }, { SEED, accelMode });

  // --- OPFS path ---
  const o = await runOnce('auto');
  const opfsOk = o.ok && o.frames >= 45 && o.frames <= 90 && /x480$/.test(o.res) && o.loadPath === 'accel';
  ok('OPFS load → bin → downscale-480p decodes to ~60 frames at 480p (handoff intact)', opfsOk,
     `path=${o.loadPath} frames=${o.frames} res=${o.res}`);

  // --- forced fallback path (OPFS disabled) ---
  const f = await runOnce('wasm');
  const fbOk = f.ok && f.frames >= 45 && f.frames <= 90 && /x480$/.test(f.res) && f.loadPath === 'fallback';
  ok('with OPFS disabled, the in-memory fallback produces the same result', fbOk,
     `path=${f.loadPath} frames=${f.frames} res=${f.res}`);

  ok('both load paths yield an identical frame count and resolution', o.frames === f.frames && o.res === f.res,
     `opfs=${o.frames}/${o.res} fallback=${f.frames}/${f.res}`);

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
