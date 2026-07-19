// =============================================================================
// wf-thumbs.mjs — #93 Workflow thumbnails
// -----------------------------------------------------------------------------
// Each workflow card gets a static thumbnail = the workflow's look applied to a
// canonical reference frame. Verified on REAL canvas pixels (never bytes):
//   • renderThumb is grounded in the #94 look engine: a grayscale workflow's
//     thumbnail is grayscale (R=G=B) while the canonical frame is colourful
//   • a saturate workflow's thumbnail widens the channel spread vs the canon
//   • two different looks (grayscale vs invert) produce different thumbnails
//   • decorate() injects exactly one .wf-thumb canvas per card and each carries
//     real, non-uniform content
//   • an audio-only workflow renders a non-blank (waveform) tile without error
//
//   node .test/wf-thumbs.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8242);
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
  await page.waitForFunction(() => !!(window.FFWfThumb && window.FFHoverPreview && window.getAllBuiltInWorkflows), { timeout: 60000 });
  durable('[boot] FFWfThumb present');

  const r = await page.evaluate(async () => {
    const T = window.FFWfThumb;
    const mk = () => { const c = document.createElement('canvas'); c.width = T.THUMB_W; c.height = T.THUMB_H; return c; };
    const read = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const spread = (px) => { let s = 0, n = 0; for (let i = 0; i < px.length; i += 4) { const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; s += Math.abs(px[i] - l) + Math.abs(px[i + 2] - l); n += 2; } return s / n; };
    const isGray = (px) => { for (let i = 0; i < px.length; i += 4) if (px[i] !== px[i + 1] || px[i + 1] !== px[i + 2]) return false; return true; };
    const uniform = (px) => { const r = px[0], g = px[1], b = px[2]; for (let i = 4; i < px.length; i += 4) if (px[i] !== r || px[i + 1] !== g || px[i + 2] !== b) return false; return true; };
    const diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return d / (a.length / 4); };

    // canon reference frame is colourful (has channel spread)
    const canonSpread = spread(read((() => { const c = mk(); const cx = c.getContext('2d'); cx.putImageData(T.canon(), 0, 0); return c; })()));

    // grayscale workflow → grayscale thumbnail
    const grC = mk(); T.renderThumb(grC, { id: '_g', name: 'Mono', category: 'color', tags: ['grayscale'], settings: {} });
    const grPx = read(grC);
    const grayThumb = isGray(grPx);

    // saturate workflow → wider spread than canon
    const satC = mk(); T.renderThumb(satC, { id: '_s', name: 'Vivid Pop', category: 'color', tags: ['vibrant', 'saturate'], settings: {} });
    const satSpread = spread(read(satC));
    const satWider = satSpread > canonSpread * 1.2;

    // invert workflow differs clearly from grayscale workflow
    const invC = mk(); T.renderThumb(invC, { id: '_i', name: 'Negative', category: 'color', tags: ['invert'], settings: {} });
    const looksDiffer = diff(read(invC), grPx) > 20;

    // audio workflow → non-blank waveform tile, no throw
    const all = window.getAllBuiltInWorkflows();
    const audioWf = all.find((w) => /audio/.test(String(w.category)) && !/-vf|eq=/.test(String(window.generateWorkflowCommandString(w) || '')));
    const auC = mk(); let audioOk = false;
    if (audioWf) { const look = T.renderThumb(auC, audioWf); audioOk = !!look && look.audio === true && !uniform(read(auC)); }

    // decorate() the real grid: one .wf-thumb per card, all non-uniform
    if (typeof window.renderWorkflows === 'function') window.renderWorkflows();
    const grid = document.getElementById('workflows-grid');
    T.decorate(grid);
    const cards = grid.querySelectorAll('.wf-card');
    let oneEach = cards.length > 0, allContent = true, sampled = 0;
    cards.forEach((card) => {
      const thumbs = card.querySelectorAll('.wf-thumb');
      if (thumbs.length !== 1) oneEach = false;
      if (thumbs[0] && sampled < 25) { sampled++; if (uniform(read(thumbs[0]))) allContent = false; }
    });
    // idempotent: decorating again adds no duplicates
    T.decorate(grid);
    let stillOne = true;
    grid.querySelectorAll('.wf-card').forEach((c) => { if (c.querySelectorAll('.wf-thumb').length !== 1) stillOne = false; });

    return { grayThumb, satWider, looksDiffer, audioOk, oneEach, allContent, stillOne, cardCount: cards.length, canonSpread: Math.round(canonSpread), satSpread: Math.round(satSpread) };
  });

  ok('#93 renderThumb is grounded in the look engine (grayscale workflow → grayscale thumbnail)', r.grayThumb);
  ok('#93 a saturate workflow widens the thumbnail channel spread vs the canonical frame', r.satWider, `canon=${r.canonSpread} sat=${r.satSpread}`);
  ok('#93 different looks produce visibly different thumbnails (invert ≠ grayscale)', r.looksDiffer);
  ok('#93 an audio-only workflow renders a non-blank waveform tile', r.audioOk);
  ok('#93 decorate() injects exactly one non-blank thumbnail per card (idempotent)', r.oneEach && r.allContent && r.stillOne, `${r.cardCount} cards`);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 5 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
