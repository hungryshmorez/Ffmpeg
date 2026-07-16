// =============================================================================
// roundtrip.mjs — the test that could not lie (item #1 / #100)
// -----------------------------------------------------------------------------
// Boots the REAL app in headless Chromium, feeds it a deterministic clip, runs a
// workflow through the actual UI path (applyWorkflow → executeFromUI → split
// render → output blob), then DECODES the output and asserts on real frames —
// never bytes. Repeats N times and fails unless every run is green.
//
// Self-contained: it starts its own COOP/COEP static server as a child, so
// `npm test` needs nothing running. Chromium comes from PW_EXEC if set, else
// Playwright's own resolution.
//
//   node .test/roundtrip.mjs [workflow] [runs]
//   node .test/roundtrip.mjs downscale-480p 5
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const WORKFLOW = process.argv[2] || 'downscale-480p';
const RUNS     = Number(process.argv[3] || 5);
const PORT     = Number(process.env.PORT || 8137);
const BASE     = process.env.BASE || `http://localhost:${PORT}`;
// If BASE is provided, assume the server is already running (the harness-friendly
// path). Otherwise start an in-process static server.
const USE_EXTERNAL = !!process.env.BASE;

// Deterministic 2s / 30fps testsrc → 60 frames. Video-only, so it also exercises
// the no-audio guard. Downscale preserves frame count, so we expect ~60 out.
const SEED = ['-f','lavfi','-i','testsrc=duration=2:size=640x360:rate=30',
              '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-y','seed.mp4'];
const EXPECT_MIN_FRAMES = 45;   // 60 nominal; allow slack for muxer edge frames
const EXPECT_MAX_FRAMES = 90;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.json':'application/json', '.wasm':'application/wasm',
  '.png':'image/png', '.map':'application/json', '.ttf':'font/ttf' };

// In-process COOP/COEP static server — no child process (that got SIGKILLed in
// the sandbox); this shares the test's own lifecycle.
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
try {
  if (!USE_EXTERNAL) {
    server = await startServer();
    console.log(`[server] listening on ${BASE}`);
  } else {
    console.log(`[server] using external ${BASE}`);
  }
  browser = await chromium.launch({
    executablePath: process.env.PW_EXEC || undefined,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('  [pageerror]', e.message));
  page.on('dialog', d => d.accept().catch(() => {}));

  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.engineReady === true, { timeout: 120000 });
  const mode = await page.evaluate(() => state.threadMode);
  durable(`[boot] engine ready (threadMode=${mode})`);

  let passes = 0;
  for (let run = 1; run <= RUNS; run++) {
    const r = await page.evaluate(async ({ wf, SEED }) => {
      // fresh deterministic input each run
      await ff.exec(SEED, { raw: true });
      const seed = await ff.readFile('seed.mp4');
      const file = new File([seed], 'seed.mp4', { type: 'video/mp4' });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.querySelector('#file-input');
      input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1000));

      applyWorkflow(wf, true);
      await new Promise(r => setTimeout(r, 250));
      const t0 = performance.now();
      try { await executeFromUI(); }
      catch (e) { return { ok: false, stage: 'exec', err: e.message || String(e) }; }
      const secs = ((performance.now() - t0) / 1000).toFixed(1);

      if (!state.outputBlobUrl) return { ok: false, stage: 'output', err: 'no output blob' };
      const ab = await (await fetch(state.outputBlobUrl)).arrayBuffer();
      const u8 = new Uint8Array(ab);
      const bytes = u8.length;   // read BEFORE writeFile — it transfers (detaches) the buffer
      await ff.writeFile('__verify.mp4', u8);
      let buf = ''; const grab = ({ message }) => { buf += message + '\n'; };
      state.ffmpeg.on('log', grab);
      try { await ff.exec(['-hide_banner', '-i', '__verify.mp4', '-f', 'null', '-'], { raw: true }); } catch (_) {}
      state.ffmpeg.off('log', grab);
      try { await ff.deleteFile('__verify.mp4'); } catch (_) {}
      const all = [...buf.matchAll(/frame=\s*(\d+)/g)];
      const frames = all.length ? parseInt(all[all.length - 1][1], 10) : 0;
      const res = (buf.match(/,\s*(\d+x\d+)/) || [])[1] || '?';
      // the signature filter check (#6): downscale-480p must have scaled to 480p-class
      const scaledOk = /(?:^|x)480\b/.test(res) || res.endsWith('x480');
      return { ok: bytes > 512 && frames > 0, secs, bytes, frames, res, scaledOk };
    }, { wf: WORKFLOW, SEED });

    const framesOk = r.ok && r.frames >= EXPECT_MIN_FRAMES && r.frames <= EXPECT_MAX_FRAMES;
    if (r.ok && framesOk && r.scaledOk) {
      passes++;
      durable(`[run ${run}/${RUNS}] PASS — ${r.frames} frames · ${r.res} · ${r.bytes} bytes · ${r.secs}s`);
    } else {
      durable(`[run ${run}/${RUNS}] FAIL — ${JSON.stringify(r)}` +
        (r.ok && !framesOk ? `  (frames ${r.frames} outside [${EXPECT_MIN_FRAMES},${EXPECT_MAX_FRAMES}])` : ''));
    }
  }

  durable(`==== ${passes}/${RUNS} passed ====`);
  code = passes === RUNS ? 0 : 1;
} catch (e) {
  console.log('FATAL:', e.message);
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
