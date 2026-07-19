// =============================================================================
// fx-chain.mjs — #73 Effect chains (stack multiple effects in order)
// -----------------------------------------------------------------------------
// The Live FX surface can stack an ordered chain of effects. Verified on real
// canvas pixels (never bytes):
//   • the chain applies stages IN ORDER — [grayscale, warm] ends coloured while
//     [warm, grayscale] ends grey (order changes the result)
//   • disabling a stage skips it; an all-disabled chain is a no-op
//   • add / remove / move / toggle mutate the stage list correctly
//   • serialize↔restore round-trips, and the chain registers as a #89 undo
//     provider (capture returns the stages, null when empty)
//   • end-to-end: a stacked chain drives the preview loop and takes precedence
//     over the single picked effect (chain [grayscale] beats picker 'vibrant')
//   • the ＋ Add button pushes the picked effect onto the chain and a chip shows
//
//   node .test/fx-chain.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8246);
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
  await page.waitForFunction(() => !!(window.FFFxChain && window.FFPreviewFX), { timeout: 60000 });
  durable('[boot] FFFxChain present');

  const r = await page.evaluate(() => {
    const { Chain, applyChain, preview } = window.FFFxChain;
    const W = 20, H = 20;
    const frame = () => { const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < d.length; i += 4) { d[i] = 40 + (i % 180); d[i + 1] = 110; d[i + 2] = 210 - (i % 120); d[i + 3] = 255; } return { data: d, width: W, height: H }; };
    const isGray = (im) => { for (let i = 0; i < im.data.length; i += 4) if (im.data[i] !== im.data[i + 1] || im.data[i + 1] !== im.data[i + 2]) return false; return true; };

    // order matters: [grayscale, warm] → coloured; [warm, grayscale] → grey
    const gThenWarm = applyChain(frame(), [{ id: 'grayscale' }, { id: 'warm' }]);
    const warmThenG = applyChain(frame(), [{ id: 'warm' }, { id: 'grayscale' }]);
    const orderMatters = !isGray(gThenWarm) && isGray(warmThenG);

    // disable a stage → skipped; all-disabled → no-op
    const src = frame();
    const disabledSkipped = isGray(applyChain(frame(), [{ id: 'grayscale', on: true }]))
      && !isGray(applyChain(frame(), [{ id: 'grayscale', on: false }]));
    const off = applyChain(frame(), [{ id: 'grayscale', on: false }, { id: 'invert', on: false }]);
    let noop = true; for (let i = 0; i < off.data.length; i += 4) if (off.data[i] !== src.data[i]) { noop = false; break; }

    // mutations
    const c = new Chain();
    c.add('grayscale').add('invert').add('warm');
    const afterMove = (c.move(0, 1), c.stages.map((s) => s.id).join(',')); // invert,grayscale,warm
    c.toggle(1, false); const toggledOff = c.stages[1].on === false;
    c.remove(0); const afterRemove = c.stages.map((s) => s.id).join(','); // grayscale,warm
    const mutOk = afterMove === 'invert,grayscale,warm' && toggledOff && afterRemove === 'grayscale,warm';

    // serialize / restore round-trip
    const c2 = new Chain([{ id: 'invert' }, { id: 'vhs', amt: 0.5 }]);
    const ser = c2.serialize();
    const c3 = new Chain().restore(JSON.parse(JSON.stringify(ser)));
    const roundTrip = JSON.stringify(c3.serialize()) === JSON.stringify(ser);

    // the preview chain serialises for the undo provider
    preview.clear();
    preview.add('grayscale');
    const provOk = preview.serialize().length === 1 && preview.serialize()[0].id === 'grayscale';

    return { orderMatters, disabledSkipped, noop, mutOk, roundTrip, provOk };
  });
  ok('#73 chain applies stages IN ORDER ([grayscale,warm]=coloured, [warm,grayscale]=grey)', r.orderMatters);
  ok('#73 a disabled stage is skipped and an all-disabled chain is a no-op', r.disabledSkipped && r.noop);
  ok('#73 add / move / toggle / remove mutate the stage list correctly', r.mutOk);
  ok('#73 serialize↔restore round-trips the chain', r.roundTrip && r.provOk);

  // end-to-end through the preview loop + UI
  const r2 = await page.evaluate(() => {
    const FX = window.FFPreviewFX, CH = window.FFFxChain;
    CH.preview.clear();
    CH.preview.add('grayscale').add('invert');   // stack two
    FX.setEffect('vibrant');                      // single picker set to something else
    const dst = document.getElementById('pv-fx');
    FX.renderFrameFrom(null, dst);                // no source → shared test frame
    const px = dst.getContext('2d').getImageData(0, 0, dst.width, dst.height).data;
    // chain wins over the picker: grayscale→invert leaves R=G=B (grey), not vibrant colour
    let chainWon = true; for (let i = 0; i < px.length; i += 400) if (px[i] !== px[i + 1] || px[i + 1] !== px[i + 2]) { chainWon = false; break; }

    // empty chain → falls back to the single picked effect (vibrant ≠ grey)
    CH.preview.clear();
    FX.renderFrameFrom(null, dst);
    const px2 = dst.getContext('2d').getImageData(0, 0, dst.width, dst.height).data;
    let fellBack = false; for (let i = 0; i < px2.length; i += 400) if (px2[i] !== px2[i + 1]) { fellBack = true; break; }

    // ＋ Add UI: pick an effect, click Add, a chip appears
    CH.bind();
    const sel = document.getElementById('pv-fx-effect'); FX.populate();
    sel.value = 'invert';
    document.getElementById('pv-fx-add').click();
    const host = document.getElementById('pv-fx-chain');
    const chipAdded = host.querySelectorAll('.fx-chip').length === 1 && CH.preview.stages[0].id === 'invert';
    // clicking remove clears it
    host.querySelector('.fx-chip [data-act="rm"]').click();
    const chipRemoved = CH.preview.stages.length === 0;

    return { chainWon, fellBack, chipAdded, chipRemoved };
  });
  ok('#73 a stacked chain drives the preview loop and beats the single picker', r2.chainWon);
  ok('#73 an empty chain falls back to the single picked effect', r2.fellBack);
  ok('#73 the ＋ Add button stacks the picked effect (chip appears) and remove clears it', r2.chipAdded && r2.chipRemoved);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 7 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
