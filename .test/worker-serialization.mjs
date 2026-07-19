// =============================================================================
// worker-serialization.mjs — F4: serialize the single ffmpeg.wasm worker
// -----------------------------------------------------------------------------
// ffmpeg.wasm has ONE worker that processes one message at a time. Overlapping
// exec/readFile/writeFile from different callers (a render + the heap gauge +
// a probe) interleave responses and corrupt the channel. instrumentFfmpeg now
// routes every op through a promise-chain mutex. Verified against a mock worker
// whose ops record concurrency:
//   • fired concurrently, at most ONE op is ever in flight (was 4), FIFO order
//   • a rejecting op does not wedge the queue — later ops still run
//   • terminate() bypasses the queue (it's an abort, must not wait behind ops)
//
//   node .test/worker-serialization.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8255);
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
  await page.waitForFunction(() => typeof window.instrumentFfmpeg === 'function', { timeout: 60000 });
  durable('[boot] instrumentFfmpeg present');

  const r = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let active = 0, maxActive = 0; const order = [];
    // a mock worker: each op is async and records how many run concurrently
    const mk = (label) => async () => { active++; maxActive = Math.max(maxActive, active); order.push(label); await sleep(25); active--; return label; };
    let terminated = false;
    const fake = {
      exec: mk('e'), readFile: mk('r'), writeFile: mk('w'), deleteFile: mk('d'),
      load: mk('l'), terminate: () => { terminated = true; return 'terminated'; },
    };
    window.instrumentFfmpeg(fake);

    // fire a burst of overlapping ops WITHOUT awaiting between them
    const ps = [
      fake.exec(['A'], -1),
      fake.readFile('B'),
      fake.exec(['C'], -1),
      fake.writeFile('D', new Uint8Array(1)),
      fake.deleteFile('E'),
    ];
    // terminate should not have to wait behind the queue
    const termNow = fake.terminate();
    await Promise.all(ps);

    const serialized = maxActive === 1;
    const firstOrder = order.join('');
    const fifo = firstOrder === 'erewd';   // exec,read,exec,write,delete in call order

    // a rejecting op must not wedge the chain
    let queueSurvives = false;
    const throwing = { exec: async () => { throw new Error('boom'); }, readFile: mk('r'), writeFile: mk('w'), deleteFile: mk('d'), load: mk('l'), terminate: () => {} };
    window.instrumentFfmpeg(throwing);
    const p1 = throwing.exec(['X'], -1).catch(() => 'caught');
    const p2 = throwing.readFile('Y');       // must still run after the rejection
    const [a, b] = await Promise.all([p1, p2]);
    queueSurvives = a === 'caught' && b === 'r';

    return { serialized, maxActive, fifo, order: firstOrder, termNow, terminated, queueSurvives };
  });

  ok('F4 overlapping worker ops run strictly one-at-a-time (max 1 in flight)', r.serialized, `maxActive=${r.maxActive}`);
  ok('F4 serialized ops preserve FIFO call order', r.fifo, `order=${r.order}`);
  ok('F4 terminate() bypasses the queue (abort must not wait behind ops)', r.terminated === true && r.termNow === 'terminated');
  ok('F4 a rejecting op does not wedge the queue — later ops still run', r.queueSurvives);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 4 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
