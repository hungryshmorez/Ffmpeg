// =============================================================================
// clips.mjs — the Clip Studio sequence export actually concatenates
// -----------------------------------------------------------------------------
// clips.js was another module the window.state fix touched, and its
// exportSequence() hands the concatenated result to addBlobToBin — so before the
// addBlobToBin shim it produced a sequence and dropped it. This adds two clips
// to the library, exports, and DECODES the result: the sequence must contain
// roughly the sum of both clips' frames (proof the concat actually ran), not
// bytes.
//
//   node .test/clips.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8177);
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

  // Build two 1s / 30fps H.264 clips with the wasm core and add them to the
  // Clip Studio library (their duration is clean, so concat timestamps behave).
  const added = await page.evaluate(async () => {
    async function clip(name, size) {
      await ff.exec(['-f', 'lavfi', '-i', `testsrc=duration=1:size=${size}:rate=30`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', name], { raw: true });
      const d = await ff.readFile(name);
      const blob = new Blob([d.slice().buffer], { type: 'video/mp4' });
      try { await ff.deleteFile(name); } catch (_) {}
      return blob;
    }
    const a = await clip('a.mp4', '320x180');
    const b = await clip('b.mp4', '320x180');
    window.FFClips.add(a, 'Take A');
    window.FFClips.add(b, 'Take B');
    return window.FFClips.clips().length;
  });
  ok('two clips added to the library', added === 2, `${added} clips`);

  const binBefore = await page.evaluate(() => (window.state.mediaBin || []).length);

  // Export the sequence (this is the real exported entry point).
  await page.evaluate(async () => { await window.FFClips.exportSequence(); });
  await page.waitForFunction((n) => (window.state.mediaBin || []).some((m) => /sequence_/i.test(m.name)) &&
    window.state.mediaBin.length > n, binBefore, { timeout: 120000 }).catch(() => {});

  const seq = await page.evaluate(async () => {
    const entry = [...(window.state.mediaBin || [])].reverse().find((m) => /sequence_/i.test(m.name));
    if (!entry) return { ok: false, err: 'no sequence in bin' };
    const ab = await (await fetch(entry.blobUrl || entry.url)).arrayBuffer();
    const u8 = new Uint8Array(ab); const bytes = u8.length;
    await ff.writeFile('__s.mp4', u8);
    let buf = ''; const grab = ({ message }) => { buf += message + '\n'; };
    state.ffmpeg.on('log', grab);
    try { await ff.exec(['-hide_banner', '-i', '__s.mp4', '-f', 'null', '-'], { raw: true }); } catch (_) {}
    state.ffmpeg.off('log', grab);
    try { await ff.deleteFile('__s.mp4'); } catch (_) {}
    const all = [...buf.matchAll(/frame=\s*(\d+)/g)];
    return { ok: true, name: entry.name, bytes, frames: all.length ? parseInt(all[all.length - 1][1], 10) : 0 };
  });
  ok('sequence lands in the bin', seq.ok, seq.err);
  // two 1s/30fps clips concatenated ≈ 60 frames
  ok('sequence decodes to the concatenated frames',
    seq.ok && seq.frames >= 45, seq.ok ? `${seq.frames} frames · ${seq.bytes} B` : seq.err);

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
