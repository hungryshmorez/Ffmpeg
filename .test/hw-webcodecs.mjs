// =============================================================================
// hw-webcodecs.mjs — #13 the WebCodecs encode/decode path (codec-adaptive)
// -----------------------------------------------------------------------------
// The hardware path hardcoded H.264, so it couldn't be verified where H.264
// encode is absent (this runner, and many real machines/browsers). It's now
// codec-adaptive — pickEncodeCodec() chooses the best AVAILABLE encoder — which
// makes it verifiable with VP9/AV1/VP8 even without H.264. This drives the real
// VideoEncoder → VideoDecoder round trip via FFHardware.hwSelfTest():
//
//   • the codec picker chooses a codec this machine actually supports, and
//     correctly SKIPS H.264 when it has no H.264 encoder
//   • encoding N synthetic frames through the silicon-backed VideoEncoder and
//     decoding them back yields the SAME frame count
//   • the decoded pixels match the input — a moving pink marker on a dark
//     background survives the encode/decode round trip (real pixels, not bytes)
//
//   node .test/hw-webcodecs.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8278);
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
  browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.FFHardware && window.FFHardware.hwSelfTest && window.FFHardware.pickEncodeCodec), { timeout: 60000 });
  durable('[boot] FFHardware.hwSelfTest present');

  const r = await page.evaluate(async () => {
    const HW = window.FFHardware;
    await HW.probeCodecs();
    const caps = HW.CAPS;
    const pick = HW.pickEncodeCodec({ allowSoftware: true });   // matches what hwSelfTest uses
    const res = await HW.hwSelfTest({ frames: 24, width: 320, height: 240 });
    return { webcodecs: caps.webcodecs, encode: caps.encode, encodeAny: caps.encodeAny, decodeAny: caps.decodeAny, pick, res };
  });

  if (!r.webcodecs) {
    durable('  SKIP — WebCodecs unavailable in this environment');
    durable('==== skipped (no WebCodecs) ====');
    code = 0;
  } else {
    durable(`[caps] encodeHw=${JSON.stringify(r.encode)} encodeAny=${JSON.stringify(r.encodeAny)} pick=${r.pick && r.pick.name}`);
    durable(`[selftest] ${JSON.stringify(r.res)}`);

    const pickedSupported = r.pick && r.encodeAny[r.pick.name] === true;
    ok('the codec picker chooses an encoder this machine actually supports', !!pickedSupported,
       `picked ${r.pick && r.pick.name} (${r.pick && r.pick.codec})`);
    ok('it SKIPS H.264 when there is no H.264 encoder (adaptive, not hardcoded)',
       r.encodeAny['H.264'] === true ? (r.pick.name === 'H.264') : (r.pick.name !== 'H.264'),
       `h264Enc=${r.encodeAny['H.264']} picked=${r.pick && r.pick.name}`);
    ok('encode → decode preserves the frame count (silicon round trip)',
       r.res.ok && r.res.decodedFrames === r.res.expected && r.res.encodedChunks > 0,
       `encoded ${r.res.encodedChunks} chunks → decoded ${r.res.decodedFrames}/${r.res.expected}`);
    ok('the decoded pixels match the input (moving marker + dark bg survived)',
       r.res.markerHits >= r.res.expected * 0.6 && r.res.bgDarks >= r.res.expected * 0.6,
       `markerHits=${r.res.markerHits}/${r.res.expected} bgDarks=${r.res.bgDarks}/${r.res.expected}`);

    const passed = checks.filter(Boolean).length;
    durable(`==== ${passed}/${checks.length} checks passed ====`);
    code = passed === checks.length && checks.length === 4 ? 0 : 1;
  }
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
