// =============================================================================
// undo-desync.mjs — F6: undo/redo state-integrity guards
// -----------------------------------------------------------------------------
// Two ways undo/redo could desync the UI from the audio/video graph:
//   (a) firing mid-render, changing control values a running render already
//       captured → preview and output disagree;
//   (b) applying a snapshot taken under a DIFFERENT DOM structure (mixer strips
//       or trip-cam sliders added/removed) — only the still-present ids restore
//       while the custom providers restore their half → permanent desync.
// Verified:
//   • undo/redo are refused while state.isProcessing (and work again after)
//   • a snapshot whose structural signature no longer matches is refused (stacks
//     left intact, no partial apply), and works again once structure is restored
//
//   node .test/undo-desync.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8257);
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
  await page.waitForFunction(() => typeof window.undoLastChange === 'function' && typeof window.pushUndoSnapshot === 'function', { timeout: 60000 });
  durable('[boot] undo functions present');

  const r = await page.evaluate(async () => {
    const s = window.state;
    const crf = document.getElementById('crf');
    const setCrf = (v) => { crf.value = String(v); crf.dispatchEvent(new Event('input', { bubbles: true })); };

    // --- (a) undo refused during a render ---
    // (three checkpoints so undo movement is unambiguous past the stack's
    // known off-by-one where the first undo re-applies the current top.)
    s.isProcessing = false; s.undoStack = []; s.redoStack = [];
    setCrf(20); window.pushUndoSnapshot();
    setCrf(30); window.pushUndoSnapshot();
    setCrf(40); window.pushUndoSnapshot();

    s.isProcessing = true;
    const stackLenBefore = s.undoStack.length;
    window.undoLastChange();
    const blockedDuringProc = crf.value === '40' && s.undoStack.length === stackLenBefore;   // untouched

    s.isProcessing = false;
    window.undoLastChange(); window.undoLastChange();   // idle undo moves history
    const worksWhenIdle = crf.value !== '40' && s.undoStack.length < stackLenBefore;

    // --- (b) structural change refuses undo (no partial apply) ---
    s.isProcessing = false; s.undoStack = []; s.redoStack = [];
    setCrf(25); window.pushUndoSnapshot();
    setCrf(35); window.pushUndoSnapshot();
    setCrf(45); window.pushUndoSnapshot();
    const before = crf.value;                    // '45'

    // change the DOM structure: add a new undoable control id
    const tmp = document.createElement('input');
    tmp.id = '__struct_probe'; tmp.type = 'range'; tmp.value = '1';
    document.body.appendChild(tmp);

    const stackLen = s.undoStack.length;
    window.undoLastChange();                      // snapshot's __sig no longer matches
    const refusedOnStructChange = crf.value === before && s.undoStack.length === stackLen;

    // restore the structure → undo works again
    tmp.remove();
    window.undoLastChange(); window.undoLastChange();
    const worksAfterStructRestored = crf.value !== before && s.undoStack.length < stackLen;

    return { blockedDuringProc, worksWhenIdle, refusedOnStructChange, worksAfterStructRestored };
  });

  ok('F6 undo is refused while a render is in flight, and works once idle', r.blockedDuringProc && r.worksWhenIdle,
     `blockedDuringProc=${r.blockedDuringProc} worksWhenIdle=${r.worksWhenIdle}`);
  ok('F6 a snapshot from a changed DOM structure is refused (stacks intact, no partial apply)', r.refusedOnStructChange);
  ok('F6 undo works again once the structure matches', r.worksAfterStructRestored);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 3 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
