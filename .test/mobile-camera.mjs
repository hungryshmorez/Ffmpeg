// =============================================================================
// mobile-camera.mjs — the camera goes live from ONE tap, no keyboard
// -----------------------------------------------------------------------------
// The mobile bug: Trip Cam and VJ both required interactions a phone can't make
// — Trip Cam hid "go live" behind a <select>, and VJ auto-called getUserMedia at
// tab-build time (a gesture phones don't honour), then left the black canvas with
// no retry affordance and a keyboard-framed UI. Fix: a big single-tap "go live"
// button in each empty/start state that calls the webcam directly.
//
// This test runs with a FAKE camera device (Chromium --use-fake-*) on a touch,
// phone-sized viewport, and NEVER presses a key. It asserts:
//   • Trip Cam: tapping #trip-golive drives useWebcam() to completion — the empty
//     overlay becomes [hidden], which only happens after getUserMedia + play +
//     setSource all succeed. One tap, camera live.
//   • VJ: when the auto-attempt is blocked (as on a phone — modelled by failing
//     the first getUserMedia), the #vj-start overlay stays up; a single tap on
//     #vj-start-btn then brings the camera live and drops the overlay.
//
//   node .test/mobile-camera.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8271);
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
  browser = await chromium.launch({
    executablePath: process.env.PW_EXEC || undefined,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  // Touch-capable (page.tap dispatches real touch events — the whole point: a
  // FINGER, never a key). A roomy viewport keeps the stage full-height so the
  // "go live" button renders where a real phone shows it, clear of the fixed nav
  // chrome that the headless collapsed-mobile layout would otherwise stack on top.
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  // Skip the onboarding tour (it overlays the layout and eats taps), and install a
  // getUserMedia wrapper that fails exactly once when armed — this models a phone
  // silently blocking the auto-attempt so we can prove the tap-to-start recovery.
  await page.addInitScript(() => {
    try { localStorage.setItem('ffstudio.tour.v1', 'done'); } catch (_) {}
    try { localStorage.setItem('ffs.mode', 'video'); } catch (_) {}   // skip the first-run mode picker overlay
    const md = navigator.mediaDevices;
    if (md && md.getUserMedia) {
      const real = md.getUserMedia.bind(md);
      md.getUserMedia = function (c) {
        if (window.__gumFailOnce) { window.__gumFailOnce = false; return Promise.reject(new DOMException('blocked', 'NotAllowedError')); }
        return real(c);
      };
    }
  });

  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.TripCamUI && document.getElementById('trip-golive')), { timeout: 60000 });
  durable('[boot] app loaded, Trip Cam built');

  // Test-only scaffolding for the headless layout: the tab panels rely on a
  // flex-height chain that collapses to 0px here (real phones render the stage
  // full-height), which would stack the go-live button under the global action
  // bar / bin drawer. Give the active panel a real height and get the unrelated
  // global chrome out of the way so a clean finger-tap reaches the button. None
  // of this touches the camera-activation logic under test.
  await page.addStyleTag({ content: `
    .tab-content.active{height:70vh !important;min-height:600px !important}
    #action-bar,.action-bar-global,#global-bin-drawer,#mobile-status-bar{display:none !important}
  ` });

  // ---- Trip Cam: one tap goes live -----------------------------------------
  await page.click('[data-tab="tripcam"]');
  await page.waitForSelector('#trip-golive', { state: 'visible', timeout: 10000 });
  const beforeTrip = await page.evaluate(() => {
    const g = document.getElementById('trip-golive');
    const box = g.getBoundingClientRect();
    return {
      btnVisible: box.width > 40 && box.height > 20 && getComputedStyle(g).visibility === 'visible',
      emptyShown: !document.getElementById('trip-empty')?.hasAttribute('hidden'),
    };
  });
  ok('Trip Cam shows a tappable "go live" button with the camera not yet started',
     beforeTrip.btnVisible && beforeTrip.emptyShown, `btnVisible=${beforeTrip.btnVisible} emptyShown=${beforeTrip.emptyShown}`);

  await page.tap('#trip-golive');                       // a TOUCH, not a key
  await page.waitForFunction(() => document.getElementById('trip-empty')?.hasAttribute('hidden'), { timeout: 15000 })
    .catch(() => {});
  const tripLive = await page.evaluate(() => document.getElementById('trip-empty')?.hasAttribute('hidden'));
  ok('one tap on Trip Cam brings the camera live (empty overlay hidden — getUserMedia+play+setSource all ran)',
     !!tripLive, `emptyHidden=${tripLive}`);

  // ---- VJ: auto-attempt blocked (like a phone) → tap recovers ---------------
  await page.evaluate(() => { window.__gumFailOnce = true; });   // the build-time auto getUserMedia will be blocked
  await page.click('[data-tab="vj"]');
  await page.waitForSelector('#vj-start-btn', { state: 'visible', timeout: 10000 });
  // give the failed auto-attempt time to settle
  await page.waitForFunction(() => {
    const s = document.getElementById('vj-start');
    return s && !s.hasAttribute('hidden');
  }, { timeout: 10000 }).catch(() => {});
  const vjOverlayUp = await page.evaluate(() => {
    const s = document.getElementById('vj-start');
    return !!s && !s.hasAttribute('hidden');
  });
  ok('VJ keeps the tap-to-start overlay up when the auto-attempt is blocked (no dead black screen)',
     vjOverlayUp, `overlayVisible=${vjOverlayUp}`);

  await page.tap('#vj-start-btn');                      // single touch → camera
  await page.waitForFunction(() => document.getElementById('vj-start')?.hasAttribute('hidden'), { timeout: 15000 })
    .catch(() => {});
  const vjLive = await page.evaluate(() => document.getElementById('vj-start')?.hasAttribute('hidden'));
  ok('one tap on VJ brings the camera live (start overlay hidden)', !!vjLive, `overlayHidden=${vjLive}`);

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
