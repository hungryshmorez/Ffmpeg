// =============================================================================
// midi-in.mjs — #69 MIDI clock sync (slave)
// -----------------------------------------------------------------------------
// The clock decoder + sequencer slaving are verified by feeding a synthetic
// realtime stream (the only device-gated part is receiving real hardware bytes):
//   • 6 clock pulses = one 16th step: START then 24 clocks → 4 step callbacks
//   • transport: START sets playing + resets, STOP clears, CONTINUE resumes
//     without a reset; clock while stopped advances nothing
//   • BPM is derived from the pulse interval (20.83 ms spacing → ~120 BPM)
//   • a raw MIDIMessageEvent-shaped {data:[...]} is accepted
//   • end-to-end: slaving the real VJ sequencer — START + 24 clocks steps its
//     playhead 0→4 and STOP halts it
//
//   node .test/midi-in.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8248);
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
  await page.waitForFunction(() => !!(window.FFMidiIn && window.FFMidiIn.handleMessage), { timeout: 60000 });
  durable('[boot] FFMidiIn present');

  const r = await page.evaluate(() => {
    const M = window.FFMidiIn;

    // pulse counting: 24 clocks after START → 4 step callbacks
    M.reset();
    let steps = 0;
    M.setCallbacks({ onStep: () => steps++, onStart: null, onStop: null, onContinue: null, onTempo: null });
    M.handleMessage([M.START]);
    const playingAfterStart = M.isPlaying();
    for (let i = 0; i < 24; i++) M.handleMessage([M.CLOCK], i * 20);
    const stepCount = steps;

    // transport: STOP halts; clock while stopped advances nothing
    M.handleMessage([M.STOP]);
    const stoppedFlag = !M.isPlaying();
    const before = steps;
    for (let i = 0; i < 12; i++) M.handleMessage([M.CLOCK], 1000 + i * 20);
    const noAdvanceWhenStopped = steps === before;
    // CONTINUE resumes without reset
    M.handleMessage([M.CONTINUE]);
    const resumed = M.isPlaying();

    // BPM derivation: 20.833 ms spacing → ~120
    M.reset(); M.setCallbacks({ onStep: null });
    M.handleMessage([M.START]);
    for (let i = 0; i <= 20; i++) M.handleMessage([M.CLOCK], i * (60000 / (120 * 24)));
    const bpm = M.bpm();
    const bpmOk = Math.abs(bpm - 120) < 1.0;

    // raw event shape {data:[...]}
    M.reset(); let evStep = 0; M.setCallbacks({ onStep: () => evStep++ });
    M.handleMessage({ data: [M.START], timeStamp: 0 });
    for (let i = 0; i < 6; i++) M.handleMessage({ data: [M.CLOCK], timeStamp: i * 20 });
    const eventShapeOk = evStep === 1;

    return { playingAfterStart, stepCount, stoppedFlag, noAdvanceWhenStopped, resumed, bpm, bpmOk, eventShapeOk };
  });
  ok('#69 6 pulses = one step: START then 24 clocks → 4 step callbacks', r.playingAfterStart && r.stepCount === 4, `steps=${r.stepCount}`);
  ok('#69 transport: STOP halts (clock advances nothing while stopped), CONTINUE resumes', r.stoppedFlag && r.noAdvanceWhenStopped && r.resumed);
  ok('#69 BPM derived from the pulse interval (20.83 ms → ~120)', r.bpmOk, `bpm=${r.bpm}`);
  ok('#69 a raw MIDIMessageEvent {data:[…]} is accepted', r.eventShapeOk);

  // end-to-end: slave the real VJ sequencer
  const r2 = await page.evaluate(() => {
    if (!(window.FFVJ && window.FFVJ.build)) return { noVJ: true };
    window.FFVJ.build();
    const M = window.FFMidiIn;
    M.reset();
    const slaved = M.slaveVJ(true);
    M.handleMessage([M.START]);            // VJ.extStart → step 0, playing
    const startStep = window.FFVJ.S.step, playing = window.FFVJ.S.playing;
    for (let i = 0; i < 24; i++) M.handleMessage([M.CLOCK], i * 20);  // 4 steps
    const advancedStep = window.FFVJ.S.step;
    M.handleMessage([M.STOP]);
    const halted = !window.FFVJ.S.playing;
    M.slaveVJ(false);
    return { slaved, startStep, playing, advancedStep, halted, ext: window.FFVJ.S.extClock };
  });
  if (r2.noVJ) ok('#69 slaving the real VJ sequencer to the clock', false, 'no FFVJ');
  else ok('#69 slaving the real VJ sequencer: START→step 0, 24 clocks→step 4, STOP halts',
     r2.slaved && r2.startStep === 0 && r2.playing && r2.advancedStep === 4 && r2.halted,
     `start=${r2.startStep} adv=${r2.advancedStep} halted=${r2.halted}`);

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
