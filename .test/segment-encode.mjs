// =============================================================================
// segment-encode.mjs — #21 Parallel segment encoding
// -----------------------------------------------------------------------------
// Time-split → per-segment encode (bounded concurrency) → concat copy.
//   Pure/fast:
//     • planSegments tiles [0,duration) with no gaps/overlaps (by count & by sec)
//     • segmentArgs injects -ss/-t, drops old times, redirects output
//     • concatList format; runPool honours the concurrency limit, keeps order,
//       and fails fast on a worker error
//   Real end-to-end (ffmpeg.wasm):
//     • a 2s testsrc clip split into 2 segments and concatenated DECODES to a
//       full-length (~2s) playable video — proving the whole pipeline is correct
//
//   node .test/segment-encode.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8251);
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
  page.on('console', (m) => { const t = m.text(); if (/\[seg\]/.test(t)) console.log('  ' + t); });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.FFSegment && window.FFSegment.planSegments), { timeout: 60000 });
  durable('[boot] FFSegment present');

  // ---- Part A: pure planner / args / pool
  const rA = await page.evaluate(async () => {
    const S = window.FFSegment;
    // plan by count
    const p3 = S.planSegments(10, { segments: 3 });
    const covers = Math.abs(p3.reduce((s, x) => s + x.t, 0) - 10) < 1e-4;
    const noGap = p3.every((x, i) => i === 0 || Math.abs(x.ss - (p3[i - 1].ss + p3[i - 1].t)) < 1e-4);
    const planCountOk = p3.length === 3 && covers && noGap && Math.abs(p3[0].ss) < 1e-9;
    // plan by seconds (7s @ 3s → 3,3,1)
    const pS = S.planSegments(7, { segmentSec: 3 });
    const planSecOk = pS.length === 3 && Math.abs(pS[2].t - 1) < 1e-4 && Math.abs(pS.reduce((s, x) => s + x.t, 0) - 7) < 1e-4;

    // segmentArgs
    const base = ['-ss', '9', '-i', 'in.mp4', '-c:v', 'libx264', '-t', '99', '-y', 'out.mp4'];
    const a = S.segmentArgs(base, { index: 1, ss: 2.5, t: 1.25 }, '__seg_1.mp4');
    const argsOk = a.join(' ') === '-ss 2.5 -i in.mp4 -t 1.25 -c:v libx264 -y __seg_1.mp4';

    // concat list
    const listOk = S.concatList(['__seg_0.mp4', '__seg_1.mp4']) === "file '__seg_0.mp4'\nfile '__seg_1.mp4'\n";

    // pool: 6 items, concurrency 2 → max 2 in flight, ordered results
    let active = 0, maxActive = 0;
    const items = [0, 1, 2, 3, 4, 5];
    const res = await S.runPool(items, async (v) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active--; return v * 10;
    }, 2);
    const poolOk = maxActive === 2 && res.join(',') === '0,10,20,30,40,50';

    // pool fails fast on a worker error
    let threw = false;
    try { await S.runPool([1, 2, 3], async (v) => { if (v === 2) throw new Error('boom'); await new Promise((r) => setTimeout(r, 5)); return v; }, 3); }
    catch (_) { threw = true; }

    return { planCountOk, planSecOk, argsOk, listOk, poolOk, maxActive, threw };
  });
  ok('#21 planSegments tiles the duration with no gaps/overlaps (by count and by seconds)', rA.planCountOk && rA.planSecOk);
  ok('#21 segmentArgs injects -ss/-t, drops old times, redirects output', rA.argsOk);
  ok('#21 concatList format + runPool honours the concurrency limit and keeps order', rA.listOk && rA.poolOk, `maxActive=${rA.maxActive}`);
  ok('#21 runPool fails fast when a worker errors', rA.threw);

  // ---- Part B: real end-to-end split → encode → concat → decode
  await page.waitForFunction(() => window.state && window.state.engineReady === true, { timeout: 120000 });
  durable('[boot] ffmpeg engine ready');

  const rB = await page.evaluate(async () => {
    const ff = window.state.ffmpeg;
    const exec = (args) => ff.exec(args);
    const log = (m) => { try { console.log('[seg] ' + m); } catch (_) {} };

    // cold-start warmup (first x264 call often aborts) then generate a 2s input
    try { await exec(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=15', '-c:v', 'libx264', '-preset', 'ultrafast', '-t', '1', '-y', '__warm.mp4']); await ff.deleteFile('__warm.mp4'); } catch (_) {}
    await exec(['-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=15', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-t', '2', '-y', 'seg_input.mp4']);
    const inBytes = (await ff.readFile('seg_input.mp4')).length;
    log('input ' + inBytes + ' B');

    const base = ['-i', 'seg_input.mp4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-y', '__ignored.mp4'];
    let progress = 0;
    const r = await window.FFSegment.encodeSegments(
      { exec, writeFile: (n, d) => ff.writeFile(n, d), deleteFile: (n) => ff.deleteFile(n) },
      base, 'seg_out.mp4',
      { duration: 2, segments: 2, segmentExt: 'mp4', concurrency: 1, onProgress: (d, t) => { progress = d + '/' + t; } });
    log('encoded segments=' + r.segFiles.length + ' progress=' + progress);

    const out = await ff.readFile('seg_out.mp4');
    const outBytes = out.byteLength || out.length || 0;

    // Verify by DECODING with ffmpeg (headless Chromium has no h264 <video>
    // decode). Decode both the source and the concat output to raw yuv420p and
    // count frames — a correct split→concat has the SAME frame count as the
    // source (~30 for 2 s @ 15 fps), proving it is full-length and playable.
    const FRAME = 160 * 120 * 1.5;                       // yuv420p bytes/frame
    const frameCount = async (name) => {
      await exec(['-i', name, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-y', '__probe.raw']);
      const raw = await ff.readFile('__probe.raw'); const n = Math.round((raw.length || 0) / FRAME);
      try { await ff.deleteFile('__probe.raw'); } catch (_) {}
      return n;
    };
    const srcFrames = await frameCount('seg_input.mp4');
    const outFrames = await frameCount('seg_out.mp4');
    log('frames src=' + srcFrames + ' out=' + outFrames);
    return { segCount: r.segFiles.length, planLen: r.plan.length, outBytes, srcFrames, outFrames, progress };
  });
  ok('#21 real split → encode → concat yields a decodable video (2 segments)', rB.segCount === 2 && rB.planLen === 2 && rB.outBytes > 1000 && rB.outFrames > 0, `${rB.outBytes}B, ${rB.outFrames} frames decoded`);
  ok('#21 the concatenated output is full-length — same frame count as the source', Math.abs(rB.outFrames - rB.srcFrames) <= 2 && rB.outFrames >= 25, `src=${rB.srcFrames} out=${rB.outFrames} frames`);

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
