// =============================================================================
// databend.mjs — real byte-level databending (#66)
// -----------------------------------------------------------------------------
// Corrupt the raw bytes of the encoded stream and decode through the damage.
// Boots the app, drives the "Databend" workflow card, and DECODES the result to
// prove the tolerant decode survived — plus a deterministic unit check that the
// corruptor pokes the frame-data region (and only there).
//
//   node .test/databend.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8198);
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

  // Deterministic unit check: the corruptor pokes bytes and leaves the RIFF
  // header alone (corrupting it would make nothing decode).
  const unit = await page.evaluate(() => {
    const n = 8000; const buf = new Uint8Array(n); for (let i = 0; i < n; i++) buf[i] = (i * 7) & 0xff;
    const r1 = window.FFDatamosh.databendBytes(buf, { rate: 0.01, seed: 42 });
    const r2 = window.FFDatamosh.databendBytes(buf, { rate: 0.01, seed: 42 });
    let sameSeed = r1.corrupted === r2.corrupted;
    for (let i = 0; i < n && sameSeed; i++) sameSeed = r1.bytes[i] === r2.bytes[i];
    // first 100 bytes (header-ish, before the fallback body window) untouched
    let headerIntact = true; for (let i = 0; i < 100; i++) if (r1.bytes[i] !== buf[i]) headerIntact = false;
    return { corrupted: r1.corrupted, sameSeed, headerIntact };
  });
  ok('corruptor pokes bytes, deterministically, header intact',
    unit.corrupted > 0 && unit.sameSeed && unit.headerIntact, `${unit.corrupted} bytes`);

  // Load a seed and run the Databend workflow card for real.
  await page.evaluate(async () => {
    await ff.exec(['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=30',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', 'seed.mp4'], { raw: true });
    const seed = await ff.readFile('seed.mp4');
    const dt = new DataTransfer(); dt.items.add(new File([seed], 'seed.mp4', { type: 'video/mp4' }));
    const input = document.querySelector('#file-input');
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
  });
  const inCat = await page.evaluate(() => window.getAllBuiltInWorkflows().some((w) => w.id === 'databend'));
  ok('databend workflow is in the catalog', inCat);

  const binBefore = await page.evaluate(() => window.state.mediaBin.length);
  await page.evaluate(() => { window.renderWorkflows?.(); document.querySelector('[data-wf-run="databend"]')?.click(); });
  await page.waitForFunction((n) => window.state.mediaBin.some((m) => /DATABEND/i.test(m.name)) && window.state.mediaBin.length > n,
    binBefore, { timeout: 120000 }).catch(() => {});

  const dec = await page.evaluate(async () => {
    const entry = [...window.state.mediaBin].reverse().find((m) => /DATABEND/i.test(m.name));
    if (!entry) return { ok: false, err: 'no DATABEND entry' };
    const u8 = new Uint8Array(await (await fetch(entry.blobUrl || entry.url)).arrayBuffer());
    const bytes = u8.length;
    await ff.writeFile('__db.mp4', u8);
    let buf = ''; const grab = ({ message }) => { buf += message + '\n'; };
    state.ffmpeg.on('log', grab);
    try { await ff.exec(['-hide_banner', '-i', '__db.mp4', '-f', 'null', '-'], { raw: true }); } catch (_) {}
    state.ffmpeg.off('log', grab);
    try { await ff.deleteFile('__db.mp4'); } catch (_) {}
    const all = [...buf.matchAll(/frame=\s*(\d+)/g)];
    return { ok: true, bytes, frames: all.length ? parseInt(all[all.length - 1][1], 10) : 0 };
  });
  ok('databend output decodes through the damage', dec.ok && dec.frames >= 45, dec.ok ? `${dec.frames} frames · ${dec.bytes} B` : dec.err);

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
