// =============================================================================
// midi-out.mjs — #71 MIDI output from the sequencer
// -----------------------------------------------------------------------------
// The encoding, clock timing, and sequencer integration are verified against an
// injected output (the physical Web-MIDI delivery is the only device-gated part):
//   • message encoders are correct (note-on/off status+data bytes, channel mask,
//     clock/start/stop realtime bytes) and clockIntervalMs is 24-PPQN accurate
//   • with an injected output, note-on/off for a trigger send the mapped note;
//     the trigger→note map is deterministic from a seed
//   • startClock emits START then a stream of CLOCK pulses; stopClock emits STOP
//   • disabled → nothing is sent and send() with no output never throws
//   • end-to-end: firing / releasing a real VJ trigger emits note-on / note-off
//
//   node .test/midi-out.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8247);
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
  await page.waitForFunction(() => !!(window.FFMidiOut && window.FFMidiOut.noteOn), { timeout: 60000 });
  durable('[boot] FFMidiOut present');

  // ---- encoders + clock math (pure)
  const r1 = await page.evaluate(() => {
    const M = window.FFMidiOut;
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const onOk = eq(M.noteOn(0, 60, 100), [0x90, 60, 100]);
    const offOk = eq(M.noteOff(0, 60), [0x80, 60, 0]);
    const chOk = eq(M.noteOn(2, 60, 100), [0x92, 60, 100]);          // channel in low nibble
    const clampOk = eq(M.noteOn(0, 200, 200), [0x90, 200 & 0x7f, 200 & 0x7f]);
    const rt = M.CLOCK === 0xF8 && M.START === 0xFA && M.STOP === 0xFC && M.PPQN === 24;
    const iv = M.clockIntervalMs(120);                               // 60000/(120*24)=20.833…
    const ivOk = Math.abs(iv - 20.8333) < 0.01 && Math.abs(M.clockIntervalMs(60) - 41.6667) < 0.01;
    return { onOk, offOk, chOk, clampOk, rt, ivOk, iv };
  });
  ok('#71 encoders correct (note on/off bytes, channel mask, data clamp) + realtime constants', r1.onOk && r1.offOk && r1.chOk && r1.clampOk && r1.rt);
  ok('#71 clockIntervalMs is 24-PPQN accurate (120 BPM → 20.83 ms/pulse)', r1.ivOk, `iv=${r1.iv.toFixed(3)}`);

  // ---- injected output: notes + mapping
  const r2 = await page.evaluate(() => {
    const M = window.FFMidiOut;
    const stub = { sent: [], send(b) { this.sent.push(Array.from(b)); } };
    M.setOutput(stub); M.enable(true); M.clearLog();
    M.mapTriggers(['kick', 'snare', 'hat']);           // deterministic notes from 36
    const kickNote = M.noteFor('kick'), snareNote = M.noteFor('snare');
    const mapOk = kickNote === 36 && snareNote === 37;
    M.noteOnFor('snare', 100);
    M.noteOffFor('snare');
    const on = stub.sent.find((m) => m[0] === 0x90 && m[1] === snareNote);
    const off = stub.sent.find((m) => m[0] === 0x80 && m[1] === snareNote);
    return { mapOk, sentOn: !!on, sentOff: !!off, onVel: on && on[2] };
  });
  ok('#71 note-on/off for a trigger send the mapped note to the output; the map is deterministic', r2.mapOk && r2.sentOn && r2.sentOff && r2.onVel === 100);

  // ---- clock stream
  const r3 = await page.evaluate(async () => {
    const M = window.FFMidiOut;
    const stub = { sent: [], send(b) { this.sent.push(Array.from(b)); } };
    M.setOutput(stub); M.enable(true);
    M.startClock(120);
    const firstIsStart = stub.sent[0] && stub.sent[0][0] === M.START;
    await new Promise((r) => setTimeout(r, 180));      // ~8 pulses at 20.8 ms
    M.stopClock();
    const clocks = stub.sent.filter((m) => m[0] === M.CLOCK).length;
    const lastIsStop = stub.sent[stub.sent.length - 1][0] === M.STOP;
    const running = M.isClockRunning();
    return { firstIsStart, clocks, lastIsStop, running };
  });
  ok('#71 startClock emits START then a stream of CLOCK pulses; stopClock emits STOP', r3.firstIsStart && r3.clocks >= 4 && r3.lastIsStop && !r3.running, `${r3.clocks} pulses`);

  // ---- disabled = silent, and send() with no output never throws
  const r4 = await page.evaluate(() => {
    const M = window.FFMidiOut;
    const stub = { sent: [], send(b) { this.sent.push(Array.from(b)); } };
    M.setOutput(stub); M.enable(false); M.clearLog();
    const ret = M.noteOnFor('kick');
    const silent = ret === null && stub.sent.length === 0;
    // no output → log-only, no throw
    M.setOutput({});                                    // object without send
    let threw = false; try { M.enable(true); M.send([0x90, 1, 1]); } catch (_) { threw = true; }
    return { silent, threw };
  });
  ok('#71 disabled sends nothing; send() with no usable output never throws', r4.silent && !r4.threw);

  // ---- end-to-end: a real VJ trigger emits note-on / note-off
  const r5 = await page.evaluate(() => {
    if (!(window.FFVJ && window.FFVJ.build)) return { noVJ: true };
    window.FFVJ.build();
    const M = window.FFMidiOut;
    const stub = { sent: [], send(b) { this.sent.push(Array.from(b)); } };
    M.setOutput(stub); M.enable(true); M.clearLog();
    const ids = Object.keys(window.FFVJ.TRIGGERS);
    M.mapTriggers(ids);
    const id = ids[0];
    window.FFVJ.fire(id);
    window.FFVJ.release(id);
    const note = M.noteFor(id);
    const gotOn = stub.sent.some((m) => m[0] === 0x90 && m[1] === note);
    const gotOff = stub.sent.some((m) => m[0] === 0x80 && m[1] === note);
    return { gotOn, gotOff, id, note };
  });
  if (r5.noVJ) ok('#71 firing/releasing a real VJ trigger emits MIDI note-on/off', false, 'no FFVJ');
  else ok('#71 firing/releasing a real VJ trigger emits MIDI note-on/off', r5.gotOn && r5.gotOff, `${r5.id}→note ${r5.note}`);

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
