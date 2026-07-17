// =============================================================================
// datamosh2.mjs — two-clip datamosh end-to-end (#62)
// -----------------------------------------------------------------------------
// The moshAcross CORE is verified deterministically in mosh-family.mjs. This
// drives the whole UI path: two VP9 clips into the bin, select both, click the
// "Datamosh A→B" bin button, and assert a decodable video lands in the bin.
// (Headless has no H.264 <video> decoder, so the sources are VP9 webm; the
// output blob is played back in a <video> to prove real decoded frames.)
//
//   node .test/datamosh2.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8196);
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
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.engineReady === true, { timeout: 120000 });
  durable('[boot] engine ready');

  const setup = await page.evaluate(async () => {
    function makeClip(mover, ms = 1400) {
      const cv = document.createElement('canvas'); cv.width = 240; cv.height = 135;
      const ctx = cv.getContext('2d');
      const stream = cv.captureStream(20);
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      const rec = new MediaRecorder(stream, { mimeType: mime });
      const chunks = []; rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      return new Promise((res) => {
        rec.onstop = () => res(new Blob(chunks, { type: 'video/webm' }));
        rec.start();
        const t0 = performance.now();
        const draw = () => {
          const t = (performance.now() - t0) / 1000;
          mover(ctx, t);
          if (performance.now() - t0 < ms) requestAnimationFrame(draw); else rec.stop();
        };
        draw();
      });
    }
    // motion clip: a bar sweeping across (strong horizontal motion)
    const motion = await makeClip((ctx, t) => {
      ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 240, 135);
      ctx.fillStyle = '#fff'; ctx.fillRect((t * 200) % 240, 0, 50, 135);
    });
    // picture clip: coloured bands (distinct content)
    const picture = await makeClip((ctx) => {
      for (let i = 0; i < 6; i++) { ctx.fillStyle = `hsl(${i * 60},70%,50%)`; ctx.fillRect(i * 40, 0, 40, 135); }
    });
    const feed = (blob, name) => {
      const dt = new DataTransfer(); dt.items.add(new File([blob], name, { type: 'video/webm' }));
      const input = document.querySelector('#file-input');
      input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    feed(motion, 'motion.webm');
    await new Promise((r) => setTimeout(r, 700));
    feed(picture, 'picture.webm');
    await new Promise((r) => setTimeout(r, 900));
    // select BOTH clips (motion first, then picture — order = motion→picture)
    const ids = window.state.mediaBin.map((m) => m.id);
    document.querySelectorAll('.bin-card-checkbox').forEach((cb) => {
      if (ids.includes(cb.dataset.checkId)) { if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); } }
    });
    return { bin: window.state.mediaBin.length, hasBtn: !!document.getElementById('bin-op-datamosh') };
  });
  ok('two clips in bin + datamosh button present', setup.bin >= 2 && setup.hasBtn, `${setup.bin} clips`);

  const binBefore = await page.evaluate(() => window.state.mediaBin.length);
  await page.evaluate(() => document.getElementById('bin-op-datamosh').click());
  await page.waitForFunction((n) => window.state.mediaBin.some((m) => /DATAMOSH A→B/i.test(m.name)) && window.state.mediaBin.length > n,
    binBefore, { timeout: 120000 }).catch(() => {});

  const out = await page.evaluate(async () => {
    const entry = [...window.state.mediaBin].reverse().find((m) => /DATAMOSH A→B/i.test(m.name));
    if (!entry) return { ok: false, err: 'no datamosh entry in bin' };
    const v = document.createElement('video'); v.src = entry.blobUrl || entry.url; v.muted = true;
    const good = await new Promise((res) => {
      v.onloadeddata = () => res(v.readyState >= 2 && v.videoWidth > 0);
      v.onerror = () => res(false);
      setTimeout(() => res(v.readyState >= 2 && v.videoWidth > 0), 8000);
    });
    return { ok: good, w: v.videoWidth, h: v.videoHeight, dur: v.duration };
  });
  ok('two-clip datamosh output is a decodable video', out.ok, out.ok ? `${out.w}x${out.h}` : out.err);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 2 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
