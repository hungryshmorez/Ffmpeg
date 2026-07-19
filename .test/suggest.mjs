// =============================================================================
// suggest.mjs — suggest a workflow from content (#88)
// -----------------------------------------------------------------------------
// Pure heuristics over probe metadata, verified DETERMINISTICALLY:
//   • a talking-head clip (audio, 1920×1080, 120 s) → suggests loudnorm + silence
//     trim + auto-reframe, ranked with loudnorm on top
//   • a vertical no-audio short (720×1280, 5 s) → add-music + social-vertical +
//     loop-gif, and NOT the audio-only suggestions
//   • a 4K clip → downscale-1080 shows up
//   • empty/unknown metadata doesn't throw and returns an array
//
//   node .test/suggest.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8224);
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
  await page.waitForFunction(() => !!(window.FFSuggest && window.FFSuggest.suggest), { timeout: 60000 });
  durable('[boot] FFSuggest present');

  const r = await page.evaluate(async () => {
    const S = window.FFSuggest.suggest;
    const ids = (list) => list.map((x) => x.id);

    const talkingHead = S({ hasAudio: true, hasVideo: true, duration: 120, width: 1920, height: 1080 });
    const th = ids(talkingHead);

    const verticalShort = S({ hasAudio: false, hasVideo: true, duration: 5, width: 720, height: 1280 });
    const vs = ids(verticalShort);

    const fourK = S({ hasAudio: true, hasVideo: true, duration: 300, width: 3840, height: 2160 });
    const fk = ids(fourK);

    let threw = false, arr = true;
    try { const e = S({}); arr = Array.isArray(e); } catch (_) { threw = true; }

    return {
      thHasAll: th.includes('loudnorm') && th.includes('silence-trim') && th.includes('auto-reframe') && talkingHead[0].id === 'loudnorm',
      vsRightNoAudio: vs.includes('add-music') && vs.includes('social-vertical') && vs.includes('loop-gif') && !vs.includes('loudnorm') && !vs.includes('silence-trim'),
      fourKDownscale: fk.includes('downscale-1080'),
      emptyOk: !threw && arr,
      dbg: { th, vs, fk },
    };
  });

  ok('#88 talking-head → loudnorm (top) + silence-trim + auto-reframe', r.thHasAll, `[${r.dbg.th}]`);
  ok('#88 vertical no-audio short → add-music + social-vertical + loop, no audio-only steps', r.vsRightNoAudio, `[${r.dbg.vs}]`);
  ok('#88 4K clip → downscale-1080 suggested', r.fourKDownscale, `[${r.dbg.fk}]`);
  ok('#88 empty metadata is handled (no throw, returns array)', r.emptyOk);

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
