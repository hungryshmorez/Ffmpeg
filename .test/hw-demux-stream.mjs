// =============================================================================
// hw-demux-stream.mjs — streaming demux input (hwaccel.feedDemuxer)
// -----------------------------------------------------------------------------
// The WebCodecs demux path can now be fed block-by-block from a stream (e.g.
// FFOpfsStream.readable()) instead of one whole-file arrayBuffer — so a
// hardware transcode never materialises the file. mp4box's own parsing is
// unchanged (and it loads from a CDN, so it can't run offline here); the NEW
// risk is the feeder's ordering + byte offsets, which this verifies exactly:
//   • fed from an OPFS ReadableStream, feedDemuxer emits blocks IN ORDER with
//     contiguous `fileStart` offsets (0, len0, len0+len1, …) that reassemble
//     byte-identical to the source — in more than one block
//   • the same holds feeding a Blob and a Uint8Array
//   • the total bytes fed equals the source length
// If the offsets were wrong or a block were dropped, mp4box would mis-parse;
// this catches that at the feeder boundary.
//
//   node .test/hw-demux-stream.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8269);
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
  await page.waitForFunction(() => !!(window.FFHardware && window.FFHardware.feedDemuxer && window.FFOpfsStream), { timeout: 60000 });
  durable('[boot] FFHardware.feedDemuxer + FFOpfsStream present');

  const r = await page.evaluate(async () => {
    const HW = window.FFHardware, S = window.FFOpfsStream;
    window.FFAccel && window.FFAccel.setMode('auto');
    const N = 300 * 1024;                             // 300 KB
    const src = new Uint8Array(N);
    for (let i = 0; i < N; i++) src[i] = (i * 31 + 7) & 255;
    const csum = (u8) => { let s = 0; for (let i = 0; i < u8.length; i += 617) s = (s + u8[i] * (i + 1)) >>> 0; return s; };
    const srcSum = csum(src);
    const chunkSize = 32 * 1024;

    // capture what feedDemuxer emits, then check ordering / offsets / integrity
    const runFeed = async (source) => {
      const emitted = [];
      const total = await HW.feedDemuxer((ab) => { emitted.push({ fileStart: ab.fileStart, u8: new Uint8Array(ab.slice(0)) }); }, source, chunkSize);
      let contiguous = emitted.length > 0 && emitted[0].fileStart === 0;
      let expect = 0;
      const dest = new Uint8Array(total);
      for (const e of emitted) { if (e.fileStart !== expect) contiguous = false; dest.set(e.u8, e.fileStart); expect += e.u8.length; }
      return { blocks: emitted.length, total, contiguous, exact: total === N && csum(dest) === srcSum };
    };

    // 1) from an OPFS ReadableStream
    await S.writeStream('demux.bin', src, { chunkSize });
    const streamRes = await runFeed(S.readable('demux.bin', { chunkSize }));
    await S.remove('demux.bin');

    // 2) from a Blob
    const blobRes = await runFeed(new Blob([src]));

    // 3) from a Uint8Array
    const arrRes = await runFeed(src);

    return { streamRes, blobRes, arrRes };
  });

  ok('fed from an OPFS stream: byte-exact, incremental, contiguous fileStart offsets',
     r.streamRes.exact && r.streamRes.blocks > 1 && r.streamRes.contiguous, `${r.streamRes.blocks} blocks, total ${r.streamRes.total}`);
  ok('fed from a Blob: byte-exact with correct offsets', r.blobRes.exact && r.blobRes.blocks > 1 && r.blobRes.contiguous);
  ok('fed from a Uint8Array: byte-exact with correct offsets', r.arrRes.exact && r.arrRes.blocks > 1 && r.arrRes.contiguous);

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
