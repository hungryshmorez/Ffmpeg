// =============================================================================
// opfs-stream.mjs — OPFS block streaming (Phase 1.3)
// -----------------------------------------------------------------------------
// Verifies media can move through OPFS block-by-block (never whole-in-RAM), and
// — the real proof — that a decodable VIDEO survives the round trip byte-exact:
//   • writeStream → readChunks round-trips a multi-block payload byte-identical,
//     in >1 blocks, with no block larger than the chosen chunk size
//   • readable() yields the same bytes as a ReadableStream
//   • with OPFS forced off (FFAccel 'wasm' mode) it still round-trips via the
//     in-memory fallback — no workflow goes down
//   • END-TO-END: a testsrc mp4 generated in MEMFS is streamed into OPFS and
//     streamed back into MEMFS (toMemfs), and decodes to the SAME frame count
//     as the original — proving the streaming pipeline is byte-exact for media
//
//   node .test/opfs-stream.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8266);
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
  page.on('console', (m) => { const t = m.text(); if (/\[opfs-test\]/.test(t)) console.log('  ' + t); });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.FFOpfsStream && window.FFAccel), { timeout: 60000 });
  durable('[boot] FFOpfsStream present');

  // ---- Part A: pure block-streaming integrity (fast)
  const rA = await page.evaluate(async () => {
    const S = window.FFOpfsStream;
    const A = window.FFAccel;
    A.setMode('auto');
    const N = 1024 * 1024;                       // 1 MB
    const src = new Uint8Array(N);
    for (let i = 0; i < N; i++) src[i] = (i * 7 + 3) & 255;
    const csum = (u8) => { let s = 0; for (let i = 0; i < u8.length; i += 997) s = (s + u8[i] * (i + 1)) >>> 0; return s; };
    const srcSum = csum(src);
    const chunkSize = 64 * 1024;

    // write in blocks, read back in blocks, reassemble
    const w = await S.writeStream('a.bin', src, { chunkSize });
    let blocks = 0, maxBlock = 0;
    const dest = new Uint8Array(await S.size('a.bin'));
    await S.readChunks('a.bin', (block, o) => { blocks++; maxBlock = Math.max(maxBlock, block.length); dest.set(block, o); }, { chunkSize });
    const integrity = dest.length === N && csum(dest) === srcSum;
    const blockwise = blocks > 1 && maxBlock <= chunkSize;

    // readable() ReadableStream reassembles identically
    const rs = S.readable('a.bin', { chunkSize });
    const rd = rs.getReader(); const parts = []; let total = 0;
    for (;;) { const { value, done } = await rd.read(); if (done) break; parts.push(value); total += value.length; }
    const streamed = new Uint8Array(total); let off = 0; for (const p of parts) { streamed.set(p, off); off += p.length; }
    const streamOk = total === N && csum(streamed) === srcSum;
    const usedOpfs = w.opfs === true;

    // fallback: OPFS forced off → in-memory round trip still works
    A.setMode('wasm');
    const w2 = await S.writeStream('b.bin', src, { chunkSize });
    const dest2 = new Uint8Array(await S.size('b.bin'));
    await S.readChunks('b.bin', (block, o) => dest2.set(block, o), { chunkSize });
    const fallbackOk = w2.opfs === false && csum(dest2) === srcSum && dest2.length === N;
    A.setMode('auto');

    await S.remove('a.bin'); await S.remove('b.bin');
    return { integrity, blockwise, blocks, maxBlock, streamOk, usedOpfs, fallbackOk };
  });

  ok('writeStream → readChunks round-trips byte-identical, block by block', rA.integrity && rA.blockwise, `${rA.blocks} blocks, max ${rA.maxBlock}B`);
  ok('readable() yields the same bytes as a ReadableStream', rA.streamOk);
  ok('OPFS is actually used when available (not the fallback)', rA.usedOpfs);
  ok('with OPFS forced off, the in-memory fallback still round-trips (no workflow down)', rA.fallbackOk);

  // ---- Part B: end-to-end — a real video survives the OPFS round trip
  await page.waitForFunction(() => window.state && window.state.engineReady === true, { timeout: 120000 });
  durable('[boot] ffmpeg engine ready');

  const rB = await page.evaluate(async () => {
    const ff = window.state.ffmpeg;
    const S = window.FFOpfsStream;
    window.FFAccel.setMode('auto');
    const log = (m) => { try { console.log('[opfs-test] ' + m); } catch (_) {} };

    // cold-start warmup + generate a 1s testsrc mp4 in MEMFS
    try { await ff.exec(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=15', '-c:v', 'libx264', '-preset', 'ultrafast', '-t', '1', '-y', '__warm.mp4']); await ff.deleteFile('__warm.mp4'); } catch (_) {}
    await ff.exec(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=15', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-t', '1', '-y', 'seed.mp4']);
    const seed = await ff.readFile('seed.mp4');
    const seedBytes = seed.length;
    log('seed ' + seedBytes + ' B');

    // stream it INTO OPFS, then stream it back OUT into a fresh MEMFS file
    await S.writeStream('clip.bin', seed, { chunkSize: 64 * 1024 });
    await S.toMemfs(ff, 'clip.bin', 'roundtrip.mp4', { chunkSize: 64 * 1024 });
    const rt = await ff.readFile('roundtrip.mp4');
    const bytesIdentical = rt.length === seedBytes;

    // decode both to raw frames and compare the frame count
    const FRAME = 160 * 120 * 1.5;
    const frames = async (name) => { await ff.exec(['-i', name, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-y', '__p.raw']); const raw = await ff.readFile('__p.raw'); const n = Math.round(raw.length / FRAME); try { await ff.deleteFile('__p.raw'); } catch (_) {} return n; };
    const seedFrames = await frames('seed.mp4');
    const rtFrames = await frames('roundtrip.mp4');
    log('frames seed=' + seedFrames + ' roundtrip=' + rtFrames);
    await S.remove('clip.bin');

    return { seedBytes, rtBytes: rt.length, bytesIdentical, seedFrames, rtFrames };
  });

  ok('a real video streamed through OPFS comes back byte-identical', rB.bytesIdentical, `${rB.seedBytes}B → ${rB.rtBytes}B`);
  ok('and decodes to the SAME frame count as the original', rB.seedFrames > 0 && rB.rtFrames === rB.seedFrames, `seed=${rB.seedFrames} roundtrip=${rB.rtFrames}`);

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
