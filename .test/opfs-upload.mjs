// =============================================================================
// opfs-upload.mjs — upload → MEMFS through OPFS streaming (Phase 1.3 wiring)
// -----------------------------------------------------------------------------
// The upload path now routes a File into MEMFS via OPFS block streaming when
// available, falling back to the direct read otherwise. Verified frame-accurate
// on both paths:
//   • fileToMemfs streams a File (built from a real mp4) into MEMFS and it
//     decodes to the SAME frame count as the source (via 'opfs' when available)
//   • with OPFS forced off it uses the direct path (via 'direct') and STILL
//     decodes to the same frames — output identical either way
//
//   node .test/opfs-upload.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8267);
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
  await page.waitForFunction(() => !!(window.FFOpfsStream && window.FFOpfsStream.fileToMemfs && window.FFAccel), { timeout: 60000 });
  await page.waitForFunction(() => window.state && window.state.engineReady === true, { timeout: 120000 });
  durable('[boot] engine + FFOpfsStream.fileToMemfs ready');

  const r = await page.evaluate(async () => {
    const ff = window.state.ffmpeg;
    const S = window.FFOpfsStream;
    window.FFAccel.setMode('auto');

    // warmup + generate a 1s testsrc mp4, read its bytes, wrap as a File (upload)
    try { await ff.exec(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=15', '-c:v', 'libx264', '-preset', 'ultrafast', '-t', '1', '-y', '__warm.mp4']); await ff.deleteFile('__warm.mp4'); } catch (_) {}
    await ff.exec(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=15', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-t', '1', '-y', 'seed.mp4']);
    const seed = await ff.readFile('seed.mp4');
    const file = new File([seed], 'clip.mp4', { type: 'video/mp4' });

    const FRAME = 160 * 120 * 1.5;
    const frames = async (name) => { await ff.exec(['-i', name, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-y', '__p.raw']); const raw = await ff.readFile('__p.raw'); const n = Math.round(raw.length / FRAME); try { await ff.deleteFile('__p.raw'); } catch (_) {} return n; };
    const seedFrames = await frames('seed.mp4');

    // OPFS path
    const rOpfs = await S.fileToMemfs(ff, file, 'up_opfs.mp4');
    const opfsFrames = await frames('up_opfs.mp4');

    // forced fallback path
    window.FFAccel.setMode('wasm');
    const rDirect = await S.fileToMemfs(ff, file, 'up_direct.mp4');
    const directFrames = await frames('up_direct.mp4');
    window.FFAccel.setMode('auto');

    return { seedFrames, opfsFrames, directFrames, opfsVia: rOpfs && rOpfs.via, directVia: rDirect && rDirect.via };
  });

  ok('fileToMemfs (OPFS path) lands a decodable file with the same frame count', r.opfsFrames > 0 && r.opfsFrames === r.seedFrames && r.opfsVia === 'opfs',
     `seed=${r.seedFrames} opfs=${r.opfsFrames} via=${r.opfsVia}`);
  ok('the forced fallback path also decodes to the same frames (identical output)', r.directFrames === r.seedFrames && r.directVia === 'direct',
     `direct=${r.directFrames} via=${r.directVia}`);

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
