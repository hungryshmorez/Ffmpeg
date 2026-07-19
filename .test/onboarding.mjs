// =============================================================================
// onboarding.mjs — #90 Real onboarding tour
// -----------------------------------------------------------------------------
// A four-step, dismissible, localStorage-gated guided tour. Verified end-to-end
// in the real page (DOM + localStorage, driven through live UI state):
//   • on first run (gate cleared, mode chosen so the picker is gone) the tour
//     AUTO-appears at step 1 with its spotlight on the "Add media" button
//   • Next advances the step text/index and switches to the tab a step targets
//   • the last step reads "Done"; finishing sets the gate and hides the overlay
//   • once gated, start(false) is a no-op; start(true) replays; skip also gates
//   • the cheat-sheet "Take the tour" button launches the tour
//   • with the gate set, the tour does NOT auto-appear on reload
//
//   node .test/onboarding.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8243);
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

  // ---------- Scenario A: first run (mode set so the picker is gone, gate cleared)
  const ctxA = await browser.newContext();
  const page = await ctxA.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.addInitScript(() => { try { localStorage.setItem('ffs.mode', 'both'); localStorage.removeItem('ffstudio.tour.v1'); } catch (_) {} });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.FFOnboarding && window.FFOnboarding.STEPS), { timeout: 60000 });
  durable('[boot] FFOnboarding present');

  // auto-start should raise the tour within ~2s
  let autoUp = false;
  try {
    await page.waitForFunction(() => {
      const ov = document.getElementById('ff-tour');
      return window.FFOnboarding.isActive() && ov && ov.style.display === 'block' && window.FFOnboarding.currentStep() === 0;
    }, { timeout: 4000 });
    autoUp = true;
  } catch (_) { autoUp = false; }

  const a1 = await page.evaluate(() => {
    const O = window.FFOnboarding;
    const card = document.querySelector('#ff-tour .ff-tour-card');
    const titleShown = !!card && card.textContent.includes(O.STEPS[0].title);
    // spotlight sits over the Add-media button
    const spot = document.getElementById('ff-tour').children[0];
    const tgt = document.querySelector('#global-bin-add');
    let spotOnTarget = false;
    if (spot && tgt) {
      const sr = spot.getBoundingClientRect(), tr = tgt.getBoundingClientRect();
      spotOnTarget = spot.style.display !== 'none' && Math.abs(sr.left - tr.left) < 14 && Math.abs(sr.top - tr.top) < 14;
    }
    return { titleShown, spotOnTarget };
  });
  ok('#90 tour auto-appears on first run at step 1, spotlight on the Add-media button', autoUp && a1.titleShown && a1.spotOnTarget,
     `auto=${autoUp} title=${a1.titleShown} spot=${a1.spotOnTarget}`);

  // Next advances text + index; a tab-targeting step switches the tab
  const a2 = await page.evaluate(() => {
    const O = window.FFOnboarding;
    const card = () => document.querySelector('#ff-tour .ff-tour-card');
    const seq = [];
    for (let i = 0; i < O.STEPS.length; i++) {
      seq.push({ idx: O.currentStep(), hasTitle: card().textContent.includes(O.STEPS[O.currentStep()].title), tab: document.body.dataset.tab || (document.querySelector('.tab-btn.active')?.dataset.tab) });
      if (i < O.STEPS.length - 1) O.next();
    }
    // on the editor step the editor tab is active
    const editorStepIdx = O.STEPS.findIndex((s) => s.sel.includes('data-tab="editor"'));
    const editorTabActive = document.querySelector('.tab-btn[data-tab="editor"]')?.classList.contains('active');
    const lastLabel = card().querySelector('[data-tour="next"]').textContent.trim();
    return { seq, advanced: seq.every((s, i) => s.idx === i && s.hasTitle), editorStepIdx, editorTabActive, lastLabel };
  });
  ok('#90 Next advances each step and switches to a step\'s target tab (editor tab active on the editor step)',
     a2.advanced && a2.editorTabActive && a2.lastLabel === 'Done', `advanced=${a2.advanced} editorTab=${a2.editorTabActive} last="${a2.lastLabel}"`);

  // Finishing the last step gates + hides
  const a3 = await page.evaluate(() => {
    const O = window.FFOnboarding;
    O.next(); // from last step → finish
    const ov = document.getElementById('ff-tour');
    return { hidden: ov.style.display === 'none', inactive: !O.isActive(), gated: !O.shouldShow(), lsSet: localStorage.getItem('ffstudio.tour.v1') === 'done' };
  });
  ok('#90 finishing the last step sets the gate and hides the overlay', a3.hidden && a3.inactive && a3.gated && a3.lsSet);

  // Gated: start(false) no-op; start(true) replays; dismiss also gates
  const a4 = await page.evaluate(() => {
    const O = window.FFOnboarding;
    const noop = O.start(false) === false && !O.isActive();
    const replay = O.start(true) === true && O.isActive() && O.currentStep() === 0;
    // dismiss (skip) from step 0
    localStorage.removeItem('ffstudio.tour.v1');
    O.start(true); O.dismiss();
    const skipGates = !O.isActive() && localStorage.getItem('ffstudio.tour.v1') === 'done';
    return { noop, replay, skipGates };
  });
  ok('#90 once gated start(false) is a no-op, start(true) replays, skip also gates', a4.noop && a4.replay && a4.skipGates);

  // Cheat-sheet "Take the tour" button launches it
  const a5 = await page.evaluate(() => {
    const O = window.FFOnboarding;
    O.dismiss(); // ensure closed
    const btn = document.getElementById('tour-replay');
    if (!btn) return { present: false };
    btn.click();
    return { present: true, active: O.isActive() && O.currentStep() === 0 };
  });
  ok('#90 the cheat-sheet "Take the tour" button launches the tour', a5.present && a5.active);
  await ctxA.close();

  // ---------- Scenario B: gate already set → no auto-start on reload
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.addInitScript(() => { try { localStorage.setItem('ffs.mode', 'both'); localStorage.setItem('ffstudio.tour.v1', 'done'); } catch (_) {} });
  await pageB.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await pageB.waitForFunction(() => !!(window.FFOnboarding && window.FFOnboarding.STEPS), { timeout: 60000 });
  await pageB.waitForTimeout(1500); // give auto-start its window
  const b1 = await pageB.evaluate(() => {
    const ov = document.getElementById('ff-tour');
    return { notShown: !window.FFOnboarding.isActive() && (!ov || ov.style.display !== 'block'), gated: !window.FFOnboarding.shouldShow() };
  });
  ok('#90 with the gate set the tour does NOT auto-appear on reload', b1.notShown && b1.gated);
  await ctxB.close();

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
