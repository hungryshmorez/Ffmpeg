// =============================================================================
// workflows-v4v5.mjs — the "new engine" workflows are actually reachable now
// -----------------------------------------------------------------------------
// WORKFLOWS_V4 (TRUE bitstream datamosh, colour match, hardware path) and
// WORKFLOWS_V5 (real-time motion-vector datamosh) were counted in build-info
// but never merged into getAllBuiltInWorkflows(), and the card dispatch never
// called wf.run(). So a whole crown-jewel category was dead. This proves the
// fix by driving the REAL card-click path and DECODING what lands in the bin:
//
//   • the catalog now contains the v4 + v5 workflows (they render as cards)
//   • clicking "TRUE Datamosh — Bloom" runs the bitstream engine end-to-end and
//     the output decodes to MORE frames than the source (P-frames were
//     duplicated) — real work, observed on decoded frames
//   • clicking "Motion Mosh — Classic Smear" runs the canvas motion engine and
//     the output is a genuinely decodable video (a frame paints in a <video>)
//
// V4 reads through ffmpeg.wasm (H.264 ok headless); V5 reads through a <video>
// element (no H.264 decoder headless) so it is fed a VP9 clip.
//
//   node .test/workflows-v4v5.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8159);
const BASE = process.env.BASE || `http://localhost:${PORT}`;
const USE_EXTERNAL = !!process.env.BASE;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.map': 'application/json', '.ttf': 'font/ttf' };

const SEED = ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=30',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', 'seed.mp4'];

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
  return new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(PORT, () => resolve(srv));
  });
}

let server, browser, code = 1;
const checks = [];
const ok = (name, pass, detail) => {
  checks.push(pass);
  durable(`  ${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`);
};

try {
  if (!USE_EXTERNAL) { server = await startServer(); console.log(`[server] listening on ${BASE}`); }
  else console.log(`[server] using external ${BASE}`);

  browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));

  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.engineReady === true, { timeout: 120000 });
  durable('[boot] engine ready');

  // Catalog now contains the v4 + v5 workflows (Fix 1).
  const cat = await page.evaluate(() => {
    const ids = new Set(window.getAllBuiltInWorkflows().map((w) => w.id));
    return {
      bloom: ids.has('true-datamosh-bloom'),
      smear: ids.has('true-datamosh-smear'),
      mosh: [...ids].some((id) => id.startsWith('mosh-')),
      total: ids.size,
    };
  });
  ok('v4 + v5 workflows are in the catalog',
    cat.bloom && cat.smear && cat.mosh, `${cat.total} total`);

  // ---- V4: TRUE Datamosh — Bloom, via the real card click ----
  // Load the H.264 seed through the file input so state.inputFile is set.
  const srcFrames = await page.evaluate(async ({ SEED }) => {
    await ff.exec(SEED, { raw: true });
    const seed = await ff.readFile('seed.mp4');
    const file = new File([seed], 'seed.mp4', { type: 'video/mp4' });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.querySelector('#file-input');
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    // decode the source frame count for comparison
    let buf = ''; const grab = ({ message }) => { buf += message + '\n'; };
    state.ffmpeg.on('log', grab);
    try { await ff.exec(['-hide_banner', '-i', state.inputFile.virtualName, '-f', 'null', '-'], { raw: true }); } catch (_) {}
    state.ffmpeg.off('log', grab);
    const all = [...buf.matchAll(/frame=\s*(\d+)/g)];
    return all.length ? parseInt(all[all.length - 1][1], 10) : 0;
  }, { SEED });
  durable(`[v4] source decodes to ${srcFrames} frames`);

  const binBefore = await page.evaluate(() => (window.state.mediaBin || []).length);

  // Click the real card button — this exercises the dispatch fix (Fix 2).
  const clicked = await page.evaluate(() => {
    window.renderWorkflows?.();
    const b = document.querySelector('[data-wf-run="true-datamosh-bloom"]');
    if (!b) return false;
    b.click();
    return true;
  });
  ok('TRUE Datamosh — Bloom card is clickable', clicked);

  // Wait for the moshed clip to appear in the bin.
  await page.waitForFunction(
    (n) => (window.state.mediaBin || []).some((m) => /DATAMOSH/i.test(m.name)) &&
           window.state.mediaBin.length > n,
    binBefore, { timeout: 120000 }).catch(() => {});

  const v4 = await page.evaluate(async () => {
    const entry = [...(window.state.mediaBin || [])].reverse().find((m) => /DATAMOSH/i.test(m.name));
    if (!entry) return { ok: false, err: 'no DATAMOSH entry in bin' };
    const url = entry.blobUrl || entry.url;
    const ab = await (await fetch(url)).arrayBuffer();
    const u8 = new Uint8Array(ab);
    const bytes = u8.length;
    await ff.writeFile('__v4.mp4', u8);
    let buf = ''; const grab = ({ message }) => { buf += message + '\n'; };
    state.ffmpeg.on('log', grab);
    try { await ff.exec(['-hide_banner', '-i', '__v4.mp4', '-f', 'null', '-'], { raw: true }); } catch (_) {}
    state.ffmpeg.off('log', grab);
    try { await ff.deleteFile('__v4.mp4'); } catch (_) {}
    const all = [...buf.matchAll(/frame=\s*(\d+)/g)];
    return { ok: true, name: entry.name, bytes, frames: all.length ? parseInt(all[all.length - 1][1], 10) : 0 };
  });
  // Bloom duplicates P-frames → the decoded output has MORE frames than the source.
  ok('bloom output decodes to real frames',
    v4.ok && v4.frames >= 45, v4.ok ? `${v4.frames} frames · ${v4.bytes} B` : v4.err);
  ok('bloom actually duplicated frames (output > source)',
    v4.ok && v4.frames > srcFrames, v4.ok ? `${v4.frames} > ${srcFrames}` : v4.err);

  // ---- V5: Motion Mosh — Classic Smear, fed a VP9 clip (headless has no H.264) ----
  const binBefore5 = await page.evaluate(async () => {
    // a short VP9 webm the <video> element can decode headless
    function makeClip(ms = 1500) {
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180;
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
          ctx.fillStyle = '#123'; ctx.fillRect(0, 0, 320, 180);
          ctx.fillStyle = '#fff';
          ctx.fillRect((t * 120) % 320, 40 + 60 * Math.sin(t * 3), 60, 60);   // motion to estimate
          if (performance.now() - t0 < ms) requestAnimationFrame(draw); else rec.stop();
        };
        draw();
      });
    }
    const blob = await makeClip();
    const file = new File([blob], 'motion.webm', { type: 'video/webm' });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.querySelector('#file-input');
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    // The bin already holds the v4 clips, so loading a file doesn't auto-select
    // it — a real user clicks the new clip to make it active. Do the same so the
    // motion mosh runs on the VP9 source (headless can't decode the h.264 one).
    const webm = [...window.state.mediaBin].reverse().find((m) => /motion\.webm/.test(m.name));
    if (webm && typeof window.setActiveMedia === 'function') window.setActiveMedia(webm.id);
    return (window.state.mediaBin || []).length;
  });
  ok('VP9 source is active for motion mosh',
    (await page.evaluate(() => window.state.inputFile && /webm/.test(window.state.inputFile.mime || ''))));

  const clicked5 = await page.evaluate(() => {
    window.renderWorkflows?.();
    const b = document.querySelector('[data-wf-run^="mosh-"]');
    if (!b) return false;
    b.click();
    return true;
  });
  ok('Motion Mosh card is clickable', clicked5);

  await page.waitForFunction(
    (n) => (window.state.mediaBin || []).some((m) => /MOTION MOSH/i.test(m.name)) &&
           window.state.mediaBin.length > n,
    binBefore5, { timeout: 120000 }).catch(() => {});

  const v5 = await page.evaluate(async () => {
    const entry = [...(window.state.mediaBin || [])].reverse().find((m) => /MOTION MOSH/i.test(m.name));
    if (!entry) return { ok: false, err: 'no MOTION MOSH entry in bin' };
    const url = entry.blobUrl || entry.url;
    // observe a decoded frame: load into a <video> and require a painted frame
    const v = document.createElement('video');
    v.src = url; v.muted = true;
    const good = await new Promise((res) => {
      v.onloadeddata = () => res(v.readyState >= 2 && v.videoWidth > 0);
      v.onerror = () => res(false);
      setTimeout(() => res(v.readyState >= 2 && v.videoWidth > 0), 8000);
    });
    return { ok: good, name: entry.name, w: v.videoWidth, h: v.videoHeight, dur: v.duration };
  });
  ok('motion-mosh output is a decodable video',
    v5.ok, v5.ok ? `${v5.w}x${v5.h} · ${(v5.dur || 0).toFixed(1)}s` : v5.err);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 7 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
