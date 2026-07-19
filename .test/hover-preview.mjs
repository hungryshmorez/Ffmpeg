// =============================================================================
// hover-preview.mjs — #94 Hover-preview a workflow on the canvas
// -----------------------------------------------------------------------------
// The look shown on hover is derived from each workflow and applied as pure
// per-pixel ops. Verified on REAL canvas ImageData (decoded pixels, never
// bytes):
//   • applyLook ops do what they claim (grayscale → R=G=B, invert → 255−x,
//     saturate>1 widens the channel spread, warm channelGain lifts R over B)
//   • deriveLook grounds the look in the workflow's real ffmpeg command
//     (eq=saturation → a saturate op) and in name/tag keywords (noir → grayscale)
//   • an audio-only workflow reports audio:true (no visual preview)
//   • end-to-end: showFor() paints the overlay canvas and those pixels reflect
//     the look (a grayscale workflow yields a grayscale overlay), and hovering
//     a real workflow card makes the overlay appear.
//
//   node .test/hover-preview.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8241);
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
  await page.waitForFunction(() => !!(window.FFHoverPreview && window.FFHoverPreview.applyLook && window.getAllBuiltInWorkflows), { timeout: 60000 });
  durable('[boot] FFHoverPreview present');

  const r = await page.evaluate(async () => {
    const HP = window.FFHoverPreview;
    const W = 32, H = 32;
    // a colourful frame: distinct R,G,B so channel ops are observable
    const frame = () => {
      const d = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        d[i] = 40 + (x * 6) % 200; d[i + 1] = 90; d[i + 2] = 200 - (y * 5) % 180; d[i + 3] = 255;
      }
      return { data: d, width: W, height: H };
    };

    // --- op: grayscale → R=G=B everywhere ---
    const g = frame(); HP.applyLook(g, [{ type: 'grayscale' }]);
    let grayOk = true;
    for (let i = 0; i < g.data.length; i += 4) if (g.data[i] !== g.data[i + 1] || g.data[i + 1] !== g.data[i + 2]) { grayOk = false; break; }

    // --- op: invert → 255 − original ---
    const base = frame(); const inv = frame(); HP.applyLook(inv, [{ type: 'invert' }]);
    let invOk = true;
    for (let i = 0; i < inv.data.length; i += 4) {
      if (inv.data[i] !== 255 - base.data[i] || inv.data[i + 2] !== 255 - base.data[i + 2]) { invOk = false; break; }
    }

    // --- op: saturate>1 widens spread from luma; saturate=1 no change ---
    const spread = (fr) => { // mean |channel − luma| over pixels
      let s = 0, n = 0;
      for (let i = 0; i < fr.data.length; i += 4) {
        const l = 0.299 * fr.data[i] + 0.587 * fr.data[i + 1] + 0.114 * fr.data[i + 2];
        s += Math.abs(fr.data[i] - l) + Math.abs(fr.data[i + 2] - l); n += 2;
      }
      return s / n;
    };
    const s0 = spread(frame());
    const sat = frame(); HP.applyLook(sat, [{ type: 'saturate', amount: 1.8 }]);
    const s1 = spread(sat);
    const satOk = s1 > s0 * 1.4;

    // --- op: warm channelGain lifts red above blue relative to source ---
    const warm = frame(); HP.applyLook(warm, [{ type: 'channelGain', rgb: [1.2, 1.0, 0.7] }]);
    let rUp = 0, bDown = 0, cnt = 0;
    { const b = frame();
      for (let i = 0; i < warm.data.length; i += 4) { if (warm.data[i] >= b.data[i]) rUp++; if (warm.data[i + 2] <= b.data[i + 2]) bDown++; cnt++; } }
    const warmOk = rUp === cnt && bDown === cnt;

    // --- deriveLook grounded in the real ffmpeg command (eq=saturation) ---
    const satWf = { id: '_t_sat', name: 'X', category: 'color-grading', tags: [], settings: { 'enable-7': true, 'eq-saturation': 1.8 } };
    const satLook = HP.deriveLook(satWf);
    const satParsed = satLook.ops.some((o) => o.type === 'saturate' && Math.abs(o.amount - 1.8) < 0.01);

    // --- deriveLook keyword: noir → grayscale ---
    const noirLook = HP.deriveLook({ id: '_t_noir', name: 'Film Noir', category: 'color', tags: ['black and white', 'monochrome'], settings: {} });
    const noirGray = noirLook.ops.some((o) => o.type === 'grayscale');

    // --- audio-only workflow → audio:true ---
    const all = window.getAllBuiltInWorkflows();
    const audioWf = all.find((w) => /audio/.test(String(w.category)) && !/-vf|eq=/.test(String(window.generateWorkflowCommandString(w) || '')));
    const audioLook = audioWf ? HP.deriveLook(audioWf) : { audio: false };
    const audioFlag = !!audioLook.audio;

    // --- catalogue coverage: most non-audio workflows yield ≥1 visual op ---
    const vids = all.filter((w) => !/audio/.test(String(w.category)));
    let withOps = 0;
    for (const w of vids) { const lk = HP.deriveLook(w); if (lk.ops && lk.ops.length) withOps++; }
    const coverage = vids.length ? withOps / vids.length : 0;

    // --- end-to-end: showFor paints the overlay; a grayscale wf → grayscale overlay ---
    const grWf = { id: '_t_gr', name: 'Mono', category: 'color', tags: ['grayscale'], settings: {} };
    HP.showFor(grWf, null);
    const ov = document.getElementById('wf-hover-preview');
    const shown = !!ov && ov.style.display === 'block';
    const cnv = ov && ov.querySelector('canvas');
    let overlayGray = false;
    if (cnv) {
      const cx = cnv.getContext('2d');
      const px = cx.getImageData(0, 0, cnv.width, cnv.height).data;
      overlayGray = true;
      // sample every 40th pixel; grayscale overlay → R=G=B
      for (let i = 0; i < px.length; i += 160) { if (px[i] !== px[i + 1] || px[i + 1] !== px[i + 2]) { overlayGray = false; break; } }
    }

    // --- hovering a REAL card makes the overlay appear ---
    if (typeof window.renderWorkflows === 'function') window.renderWorkflows();
    HP.attach(document.getElementById('workflows-grid'));
    HP.hide(); await new Promise((r) => setTimeout(r, 80)); // clear the grayscale overlay
    const card = document.querySelector('#workflows-grid .wf-card');
    let hoverShown = false;
    if (card) {
      const target = card.querySelector('.wf-name') || card;
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const ov2 = document.getElementById('wf-hover-preview');
      hoverShown = !!ov2 && ov2.style.display === 'block';
    }

    return { grayOk, invOk, satOk, warmOk, satParsed, noirGray, audioFlag, coverage: Math.round(coverage * 100), shown, overlayGray, hoverShown, cardExists: !!card, audioWf: audioWf ? audioWf.id : null };
  });

  ok('#94 grayscale op → R=G=B, invert op → 255−x, saturate widens spread, warm gain lifts R/B', r.grayOk && r.invOk && r.satOk && r.warmOk,
     `gray=${r.grayOk} inv=${r.invOk} sat=${r.satOk} warm=${r.warmOk}`);
  ok('#94 deriveLook grounds the look in the real command (eq=saturation → saturate op)', r.satParsed);
  ok('#94 deriveLook keyword heuristic (noir/mono → grayscale) & audio workflow → audio:true', r.noirGray && r.audioFlag,
     `noirGray=${r.noirGray} audio=${r.audioFlag} (${r.audioWf})`);
  ok('#94 most video workflows resolve to a visible look', r.coverage >= 60, `${r.coverage}% have ≥1 op`);
  ok('#94 showFor paints the overlay canvas and it reflects the look (grayscale → grayscale pixels)', r.shown && r.overlayGray);
  ok('#94 hovering a real workflow card shows the preview overlay', r.cardExists && r.hoverShown);

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
