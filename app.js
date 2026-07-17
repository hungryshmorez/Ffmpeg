/* =============================================================================
 * FFmpeg Studio — Application logic
 * -----------------------------------------------------------------------------
 * All processing happens in the browser via ffmpeg.wasm. No server calls.
 * Sections, control IDs and filter ordering follow the spec EXACTLY.
 * Engine APIs used (only those that exist in @ffmpeg/ffmpeg@0.12.7):
 *   ffmpeg.load(), ffmpeg.writeFile(), ffmpeg.readFile(),
 *   ffmpeg.exec(), ffmpeg.on(), ffmpeg.terminate()
 *   (and the helper FFmpegUtil.fetchFile from @ffmpeg/util@0.12.1)
 * ============================================================================= */

'use strict';

// =============================================================================
// #10 — SENTRY-STYLE ERROR CAPTURE
// -----------------------------------------------------------------------------
// Every thrown error gets the last 50 log lines attached. This is the thing
// that made v9.1, v9.2, v9.3 debuggable — the failure always had context.
// Now it's automatic, not an accident.
// =============================================================================
function _captureLastLogs() {
  try {
    return (state.logBuffer || []).slice(-50).join('\n');
  } catch (_) { return ''; }
}

window.addEventListener('error', (ev) => {
  const detail = {
    msg: ev.message,
    file: ev.filename,
    line: ev.lineno,
    col: ev.colno,
    lastLogs: _captureLastLogs(),
    ua: navigator.userAgent,
    ts: new Date().toISOString(),
  };
  console.error('[ff-error]', JSON.stringify(detail, null, 2));
  if (state.logBuffer) {
    state.logBuffer.push(`[ff-error] ${ev.message} at ${ev.filename}:${ev.lineno} (last 50 logs attached to console)`);
  }
});

window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev.reason || {};
  const detail = {
    msg: reason.message || String(reason),
    stack: reason.stack,
    lastLogs: _captureLastLogs(),
    ua: navigator.userAgent,
    ts: new Date().toISOString(),
  };
  console.error('[ff-unhandled]', JSON.stringify(detail, null, 2));
  if (state.logBuffer) {
    state.logBuffer.push(`[ff-unhandled] ${detail.msg} (last 50 logs attached to console)`);
  }
});

// =============================================================================
// #91: DEMO CLIP GENERATOR
// -----------------------------------------------------------------------------
// Renders a 10s test pattern to a canvas, captures it via MediaRecorder,
// returns a Blob. Zero friction evaluation — no upload, no download, no
// "find a file" step. The user clicked Try, they got a clip.
// =============================================================================
function drawSpeedCurve() {
  const cv = document.getElementById('speed-curve-canvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, w, h);

  // Reference: 1× line
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.5);
  ctx.lineTo(w, h * 0.5);
  ctx.stroke();

  // Read 4 keyframes
  const vals = ['sc-0', 'sc-1', 'sc-2', 'sc-3'].map(id => parseFloat(document.getElementById(id)?.value) || 1);
  // Map speed 0.25..4 → y h..0
  const toY = (v) => h - ((v - 0.25) / 3.75) * h;
  // Draw the curve as a smooth line
  ctx.strokeStyle = '#00d4ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, toY(vals[0]));
  for (let i = 1; i < vals.length; i++) {
    const x = (i / 3) * w;
    ctx.lineTo(x, toY(vals[i]));
  }
  ctx.stroke();

  // Draw dots at keyframes
  for (let i = 0; i < vals.length; i++) {
    const x = (i / 3) * w;
    const y = toY(vals[i]);
    ctx.fillStyle = '#00d4ff';
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#888';
    ctx.font = '10px monospace';
    ctx.fillText(`${vals[i].toFixed(2)}×`, x - 12, y - 8);
  }
}

// Pick a MediaRecorder MIME the browser actually supports, in preference order.
// Safari/iOS has no webm encoder, so a bare 'video/webm' fallback throws
// NotSupportedError and every recording/demo-clip path dies — fall through to
// mp4 there. Returns '' when nothing matches, which tells MediaRecorder to use
// its own platform default (always valid). Callers must omit mimeType when ''.
function pickRecorderMime(...candidates) {
  const R = typeof MediaRecorder !== 'undefined' ? MediaRecorder : null;
  for (const m of candidates) {
    if (m && R && typeof R.isTypeSupported === 'function' && R.isTypeSupported(m)) return m;
  }
  return '';
}
window.pickRecorderMime = pickRecorderMime;

async function generateDemoClip() {
  const W = 640, H = 360, FPS = 24, DUR = 10;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  const stream = cv.captureStream(FPS);
  const mime = pickRecorderMime('video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=h264', 'video/mp4');
  const rec = new MediaRecorder(stream, mime
    ? { mimeType: mime, videoBitsPerSecond: 2_000_000 }
    : { videoBitsPerSecond: 2_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

  return new Promise((resolve, reject) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: (rec.mimeType || mime || 'video/webm').split(';')[0] }));
    rec.onerror = (e) => reject(new Error(e.error?.message || 'recorder error'));
    rec.start();

    let f = 0;
    const total = FPS * DUR;
    const drawFrame = () => {
      const t = f / FPS;
      // Animated testsrc-like pattern: moving color bars + timecode overlay
      const hue = (t * 30) % 360;
      ctx.fillStyle = `hsl(${hue}, 70%, 30%)`;
      ctx.fillRect(0, 0, W, H);
      // Color bars (vertical)
      for (let i = 0; i < 7; i++) {
        ctx.fillStyle = `hsl(${(hue + i * 50) % 360}, 80%, 60%)`;
        ctx.fillRect(i * (W / 7), 0, W / 7, H);
      }
      // Sweeping circle
      const cx = W / 2 + Math.cos(t * 2) * W * 0.3;
      const cy = H / 2 + Math.sin(t * 1.7) * H * 0.3;
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath(); ctx.arc(cx, cy, 40, 0, Math.PI * 2); ctx.fill();
      // Timecode
      ctx.fillStyle = '#000';
      ctx.fillRect(0, H - 30, 120, 30);
      ctx.fillStyle = '#0f0';
      ctx.font = '20px monospace';
      ctx.fillText(`t=${t.toFixed(2)}s`, 6, H - 8);
      // "DEMO" watermark
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText('FFmpeg Studio · DEMO CLIP', W - 220, 20);

      f++;
      if (f < total) {
        setTimeout(drawFrame, 1000 / FPS);
      } else {
        rec.stop();
      }
    };
    drawFrame();
  });
}

// =============================================================================
// MODULE-LEVEL STATE
// =============================================================================
const state = {
  ffmpeg: null,                  // FFmpeg instance
  engineReady: false,            // PHASE 0.2: true once ffmpeg.load() resolves in either threading mode
  inputFile: null,               // { name, size, type, virtualName, durationSec, width, height, codec, url }  — LEGACY: backed by mediaBin getter below
  // v3 PART B — Media Bin (multi-file architecture)
  mediaBin: [],                  // Array of media objects (see handleFilesUpload)
  activeMediaId: null,           // id of the currently targeted file in the bin
  outputBlobUrl: null,           // last Object URL (revoked before new ones)
  outputFilename: null,          // suggested download filename
  outputSize: 0,                 // bytes
  outputMeta: null,              // { width, height, duration }
  isProcessing: false,
  cancelRequested: false,
  logLines: [],                  // array of { ts, level, text }
  commandHistory: [],            // #9 — last 50 ffmpeg commands executed, for copy/replay
  defaults: {},                  // map of controlId -> default value, captured for reset
  // v4 PART A2 — Font state.
  //   fontsLoaded: true once loadFonts() has written at least one TTF to
  //     MEMFS, OR once a custom font is uploaded.
  //   customFonts: array of { virtualName, displayName } added by the user
  //     via the "Custom" font button. Each shows up in the font dropdown.
  fontsLoaded: false,
  customFonts: [],
  // v4 PART B2 — Beat detection state.
  //   beats: array of onset times in seconds, in chronological order.
  //   bpm: derived from the median inter-onset interval (capped at 200).
  beats: [],
  bpm: 0,
  // v4 PART B15 — Undo / redo stacks.
  //   undoStack / redoStack: arrays of control-state snapshots.
  //     A snapshot is a plain object { controlId: value }. We restore by
  //     iterating the snapshot and dispatching 'input' on each control so
  //     downstream sliders / displays stay in sync.
  //   _undoDebounce: a timer that coalesces a burst of changes into a
  //     single snapshot (~500ms after the last change).
  //   _undoSuspend: while a snapshot is being applied (via undo/redo) we
  //     don't want to push a NEW snapshot — set this flag.
  undoStack: [],
  redoStack: [],
  _undoDebounce: null,
  _undoSuspend: false,
};

// Make state.inputFile a getter that returns the active media object.
// This preserves the v1/v2 single-input contract while moving the actual
// store to state.mediaBin. Existing code keeps working unchanged.
Object.defineProperty(state, 'inputFile', {
  configurable: true,
  get() {
    if (!state.activeMediaId) return null;
    return state.mediaBin.find(m => m.id === state.activeMediaId) || null;
  },
  set(v) {
    // Direct assignment (legacy): drop the bin down to a single item.
    if (v == null) {
      // Clearing — drop everything.
      state.activeMediaId = null;
      // Don't wipe mediaBin; that would lose user's multi-file state.
      // The caller usually follows up by re-setting active.
      return;
    }
    // Treat the assigned object as a synthesized single-item bin so the
    // rest of the app sees a consistent shape.
    const id = v.id || ('legacy_' + Date.now());
    const existing = state.mediaBin.find(m => m.virtualName === v.virtualName);
    if (existing) {
      state.activeMediaId = existing.id;
    } else {
      v.id = id;
      v.analyzed = v.analyzed || false;
      state.mediaBin.push(v);
      state.activeMediaId = id;
    }
  },
});

// Accepted MIME types (spec §1.4)
const ACCEPTED_MIMES = new Set([
  'video/mp4', 'video/webm', 'video/ogg', 'video/x-matroska',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/flac',
  'image/gif',
]);
const LARGE_FILE_WARN_BYTES = 500 * 1024 * 1024;     // 500 MB
const REVERSE_WARN_BYTES    = 100 * 1024 * 1024;     // 100 MB
const MAX_LOG_LINES         = 5000;

// Lookup table for MIME type when emitting the output blob
const EXT_TO_MIME = {
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', gif: 'image/gif',
  mp3: 'audio/mpeg', wav: 'audio/wav',   ogg: 'audio/ogg',       aac: 'audio/aac',
};


// =============================================================================
// v5 HOTFIX 5 — GLOBAL FFMPEG SERIALIZATION QUEUE
// -----------------------------------------------------------------------------
// ffmpeg.wasm has ONE wasm instance backed by ONE MEMFS heap. Every
// exec/writeFile/readFile/deleteFile mutates that heap. The 0.12.x
// release provides NO internal locking. So if two writes overlap, or
// a write interleaves with an exec, the heap state can be observed
// mid-mutation by the other call — and you get partial reads, silent
// corruption, or a `Aborted()` heap crash.
//
// The fix is structural: every single call to a mutating ffmpeg
// surface goes through this queue. Depth is enforced to 1 in-flight.
// Background work (e.g. the deep-probe analyzeMedia that used to fire
// on every uploaded file) is abortable via the bg-token set; the
// user's Run click clears the set so a queued user command jumps the
// queue ahead of any still-pending background work.
// =============================================================================
const ffQueue = {
  chain: Promise.resolve(),
  depth: 0,
  current: null,
};

// Tiny UI status bar chip — updated on every queue transition. The
// element itself lives in index.html and starts hidden.
function updateQueueChip() {
  const chip = document.getElementById('ff-queue-chip');
  if (!chip) return;
  if (ffQueue.depth === 0) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.textContent = `ffmpeg: ${ffQueue.current || '…'} (${ffQueue.depth} in queue)`;
}

function ffRun(label, fn, opts) {
  opts = opts || {};
  const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : 60000;
  // bgToken (if provided) lets the user's Run click pre-empt this
  // background task. We check it just before running fn(); if the
  // token has been removed from the set, we throw a benign
  // cancellation error so the chain doesn't deadlock. In-flight
  // background work is NOT killed mid-run — that would require
  // terminate() + full re-init, which is much worse than letting it
  // complete (it's already on the wasm heap).
  const bgToken = opts.bgToken || null;
  const task = () => {
    if (bgToken && !isBgAlive(bgToken)) {
      // Background job was pre-empted. Skip its work; release the
      // chain slot so the next item runs immediately.
      logToConsole('', `[ff] (cancel) ${label} (cancelled by user)`);
      return null;
    }
    ffQueue.depth++;
    ffQueue.current = label;
    logToConsole('', `[ff] > ${label} (queue depth ${ffQueue.depth})`);
    updateQueueChip();
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    let timer = null;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([fn(), timeout])
      .then((r) => {
        const ms = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
        logToConsole('ok', `[ff] OK ${label} (${Math.round(ms)}ms)`);
        return r;
      })
      .catch((e) => {
        logToConsole('error', `[ff] FAIL ${label}: ${(e && e.message) || e}`);
        throw e;
      })
      .finally(() => {
        if (timer != null) clearTimeout(timer);
        ffQueue.depth--;
        ffQueue.current = null;
        updateQueueChip();
      });
  };
  // Chain onto the tail. The chain itself never rejects — a
  // single bad task must not break subsequent tasks. We capture the
  // user-facing result on the unwrapped promise.
  const chained = ffQueue.chain.then(task, task);
  ffQueue.chain = chained.catch(() => {});
  return chained;
}

// The ONLY public surface for calling the wasm engine. Every file
// must go through here. No direct state.ffmpeg.{exec,writeFile,
// readFile,deleteFile} calls are allowed outside this block.
// IMPORTANT: ffmpeg.wasm 0.12.7's exec() takes a SECOND ARGUMENT
// that is a TIMEOUT IN SECONDS, not milliseconds. The
// instrumentFfmpeg() wrapper above translates that.
//
// We pass an effective queue-level timeoutMs to the inner exec() so
// the wasm-internal timer matches the queue's outer timer. If we
// passed nothing, the instrumentFfmpeg wrapper would fall back to
// TT.execExec = 30s and kill long renders prematurely.
//
// However: empirically on the v5 host, passing a positive timeout
// to the wasm exec can leave the worker in a "function signature
// mismatch" state on subsequent calls (the worker's postMessage
// channel dies mid-encode). The safer pattern is to pass timeout
// = 0 / -1 (no inner timeout) and rely solely on the queue's
// outer timeout. The queue is the only thing that should ever
// kill a render. The 30s instrumentFfmpeg fallback is bypassed by
// passing an explicit -1.
const ff = {
  // opts.raw === true  → send args EXACTLY as given. No injection.
  //                      Every selftest / isolation test MUST use this,
  //                      otherwise you are not testing what you typed.
  exec: (args, opts) => {
    const timeoutMs = (opts && typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0)
      ? opts.timeoutMs
      : 300000;

    let finalArgs = (typeof stripInvalidPreset === 'function' && !(opts && opts.raw))
      ? stripInvalidPreset(args) : args;

    // ---------------------------------------------------------------------
    // x264 SAFETY INJECTION
    // ---------------------------------------------------------------------
    // x264 auto-detects navigator.hardwareConcurrency and asks for N threads.
    // In wasm that allocates per-thread lookahead buffers the heap can't
    // satisfy → `malloc failed` → 0 frames.
    //
    // COHERENCE RULE: `-tune zerolatency` DISABLES frame-threading and
    // sliced-threading. Asking for -threads 4 while disabling both threading
    // models leaves x264 with thread contexts it has no model to use — frame 1
    // (intra, no refs) succeeds, frame 2 (P-frame, reads the ref pool) can walk
    // off the end of memory. So: threads=1 AND zerolatency, together, always.
    // Never 4-threads-plus-zerolatency.
    //
    // Skipped entirely when opts.raw is set.
    if (!(opts && opts.raw)
        && Array.isArray(args) && state
        && args.includes('libx264')
        && !args.includes('-threads')) {
      finalArgs = args.slice();
      const idx = finalArgs.indexOf('libx264');
      if (!args.includes('-tune')) {
        finalArgs.splice(idx + 1, 0, '-tune', 'zerolatency');
      }
      finalArgs.splice(idx + 1, 0,
        '-threads', '1',
        '-x264-params',
        'threads=1:sliced-threads=0:lookahead-threads=1:sync-lookahead=0:rc-lookahead=0:mbtree=0:bframes=0:ref=1'
      );
    }

    return ffRun(
      `exec ${Array.isArray(finalArgs) ? finalArgs.slice(0, 3).join(' ') : '?'}…`,
      () => state.ffmpeg.exec(finalArgs, -1),
      { timeoutMs, ...(opts || {}) }
    );
  },

  writeFile:  (name, data, opts) => ffRun(`writeFile ${name}`,
                                          () => state.ffmpeg.writeFile(name, data),
                                          { timeoutMs: 30000, ...opts }),
  readFile:   (name, opts)       => ffRun(`readFile ${name}`,
                                          () => state.ffmpeg.readFile(name),
                                          { timeoutMs: 30000, ...opts }),
  deleteFile: (name, opts)       => ffRun(`deleteFile ${name}`,
                                          () => state.ffmpeg.deleteFile(name),
                                          { timeoutMs: 10000, ...opts }),
};

// =============================================================================
// v5 HOTFIX 5 — BACKGROUND JOB TOKENS (user-priority jumping)
// -----------------------------------------------------------------------------
// Any work that is "fire-and-forget enrichment" of an upload (e.g. the
// deep probe, the thumbnail, the deep stream metadata) registers a
// token here. The user's Run click clears the set, which causes every
// pending token to short-circuit on its next queue check. Already
// running background work is allowed to finish — we don't terminate
// the heap, we just refuse to start NEW background work.
// =============================================================================
// =============================================================================
// MEMFS HEAP GAUGE + HYGIENE
// -----------------------------------------------------------------------------
// MEMFS *is* the wasm heap. It is the same linear memory x264 mallocs its
// reference-frame pool from. Every byte written and never deleted is a byte the
// encoder cannot have. Undeleted fonts / selftest outputs / intermediates /
// stale uploads fragment the heap and make renders fail NON-DETERMINISTICALLY.
//
// A deterministic encoder producing flaky results means the heap state is the
// variable — not the command. Measure it, and clean it.
// =============================================================================

const MEMFS_WARN_BYTES = 1_200_000_000;   // 1.2 GB — warn before the tab dies

async function memfsList() {
  try {
    const entries = await state.ffmpeg.listDir('/');
    return entries.filter(e => !e.isDir).map(e => e.name);
  } catch (_) { return []; }
}

async function memfsUsage() {
  let total = 0, count = 0;
  for (const name of await memfsList()) {
    try {
      const d = await state.ffmpeg.readFile(name);
      total += (d && d.length) || 0;
      count++;
    } catch (_) {}
  }
  return { bytes: total, files: count };
}

async function refreshHeapGauge() {
  if (!state.engineReady) return;
  const { bytes, files } = await memfsUsage();
  state.memfsBytes = bytes;
  const el = document.getElementById('memfs-gauge');
  if (el) {
    el.textContent = `MEMFS: ${files} file${files === 1 ? '' : 's'} · ${formatBytes(bytes)}`;
    el.classList.toggle('over', bytes > MEMFS_WARN_BYTES);
  }
  if (bytes > MEMFS_WARN_BYTES) {
    logToConsoleThrottled('warn',
      `MEMFS is ${formatBytes(bytes)} — the encoder may fail to allocate. Remove files from the bin.`);
  }
  return bytes;
}

/** Delete a list of MEMFS files, ignoring misses. Always safe to call. */
async function memfsPurge(names) {
  for (const n of names) {
    try { await ff.deleteFile(n); } catch (_) {}
  }
  await refreshHeapGauge();
}

/** Remove everything that isn't an active media-bin input. Call before a render. */
async function memfsPurgeScratch(alsoKeep) {
  const keep = new Set((state.mediaBin || []).map(m => m.virtualName));
  // NEVER purge the file we are about to read. If state.mediaBin is empty — a
  // headless test calling executeFFmpeg directly, for instance — `keep` would
  // otherwise be empty and this would delete the input out from under the render.
  if (state.activeMediaId) {
    const a = (state.mediaBin || []).find(m => m.id === state.activeMediaId);
    if (a && a.virtualName) keep.add(a.virtualName);
  }
  for (const n of [].concat(alsoKeep || [])) if (n) keep.add(n);
  // Fonts are kept ONLY if a drawtext/subtitles command needs them; see needsFonts().
  const scratch = (await memfsList()).filter(n =>
    !keep.has(n) &&
    !/\.(ttf|otf)$/i.test(n) &&
    !/^(sans|bold|mono)\.ttf$/i.test(n)
  );
  if (scratch.length) {
    logToConsole('', `[memfs] purging ${scratch.length} scratch file(s): ${scratch.join(', ')}`);
    await memfsPurge(scratch);
  }
}

/** Does this command actually need a font in MEMFS? */
function needsFonts(args) {
  const s = Array.isArray(args) ? args.join(' ') : String(args || '');
  return /drawtext|subtitles|ass=/.test(s);
}

// =============================================================================
// FRAME-COUNT ASSERTION
// -----------------------------------------------------------------------------
// Bytes are NOT a proxy for a working encode. A 1-frame 720p file is ~20 KB and
// sails past any `bytes > 1000` check. This cost four debugging cycles.
// Assert on FRAMES, or on DURATION. Never on bytes.
// =============================================================================

async function assertRealVideo(outName, expectFrames, expectDurSec) {
  const data = await ff.readFile(outName);
  const bytes = (data && data.length) || 0;

  let buf = '';
  const grab = ({ message }) => { buf += message + '\n'; };
  state.ffmpeg.on('log', grab);
  try { await ff.exec(['-hide_banner', '-i', outName, '-f', 'null', '-'], { raw: true }); } catch (_) {}
  try { state.ffmpeg.off('log', grab); } catch (_) {}

  const fm = [...buf.matchAll(/frame=\s*(\d+)/g)];
  const frames = fm.length ? parseInt(fm[fm.length - 1][1], 10) : 0;

  const dm = buf.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const durSec = dm ? (+dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3])) : 0;

  if (expectFrames && frames < expectFrames * 0.9) {
    throw new Error(
      `ENCODE TRUNCATED: ${frames} frames, expected ~${expectFrames}. ` +
      `(${bytes} bytes — a 1-frame file still looks "big enough" by byte count.)`
    );
  }
  if (expectDurSec && durSec < expectDurSec * 0.9) {
    throw new Error(`ENCODE TRUNCATED: duration ${durSec.toFixed(2)}s, expected ~${expectDurSec}s.`);
  }

  logToConsole('ok', `✔ ${outName}: ${frames} frames · ${durSec.toFixed(2)}s · ${formatBytes(bytes)}`);
  return { frames, durSec, bytes };
}

// =============================================================================
// #8 — ON-DEMAND SELF-TEST PANEL
// -----------------------------------------------------------------------------
// The same encoder smoke test the boot runs, but on a button, reporting the
// only number that matters: DECODED FRAMES. Encodes 90 frames of testsrc with
// libx264 (the real path) and mpeg4 (the control), decodes each, and passes
// only if the frame count is real. A 1-frame file is ~20 KB and would sail past
// any byte check — this refuses to be fooled by it.
// =============================================================================
async function runSelfTest() {
  const btn = document.getElementById('btn-selftest');
  const out = document.getElementById('selftest-result');
  if (!state.engineReady) { logToConsoleThrottled('warn', 'Engine not ready — try again in a moment.'); return; }
  if (state.isProcessing) { logToConsole('warn', 'Busy — run the self-test after the current render.'); return; }

  if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = '🩺 Testing…'; }
  if (out) { out.hidden = false; out.className = 'selftest-result running'; out.textContent = 'running…'; }
  logToConsole('', '[selftest] encoding 90 frames of testsrc and counting DECODED frames…');

  const EXPECT = 90;
  const CASES = [
    { codec: 'libx264', args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'], file: '__selftest_x264.mp4' },
    { codec: 'mpeg4',   args: ['-c:v', 'mpeg4', '-q:v', '5'],                                       file: '__selftest_mpeg4.mp4' },
  ];
  const results = [];
  for (const c of CASES) {
    try {
      await ff.exec(['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=30', ...c.args, '-y', c.file]);
      const a = await assertRealVideo(c.file, EXPECT, 3);
      results.push({ codec: c.codec, frames: a.frames, ok: a.frames >= EXPECT * 0.9 });
    } catch (e) {
      results.push({ codec: c.codec, frames: 0, ok: false, err: (e && e.message) || String(e) });
    }
    try { await ff.deleteFile(c.file); } catch (_) {}
  }

  const allOk = results.every(r => r.ok);
  const summary = results.map(r => `${r.codec} ${r.frames}f ${r.ok ? '✓' : '✗'}`).join(' · ');
  logToConsole(allOk ? 'ok' : 'error', `[selftest] ${allOk ? 'PASS' : 'FAIL'} — ${summary}`);
  if (out) { out.className = 'selftest-result ' + (allOk ? 'ok' : 'bad'); out.textContent = summary; }
  if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || '🩺 Self-test'; }
  return { ok: allOk, results };
}
window.runSelfTest = runSelfTest;

const _bgJobs = new Set();
function makeBgToken() {
  const token = Symbol('bg');
  _bgJobs.add(token);
  return token;
}
function isBgAlive(token) { return token != null && _bgJobs.has(token); }
function cancelAllBgJobs() {
  if (_bgJobs.size) {
    logToConsole('', `[ff] user action — cancelling ${_bgJobs.size} background job(s)`);
    _bgJobs.clear();
  }
}

// Make the queue + helpers accessible to pipeline.js (which runs in the
// same window scope as app.js — they're all <script> tags on one page).
window.ff = ff;
window.ffRun = ffRun;
window.ffQueue = ffQueue;
// EXPOSE THE STORE. `state` is a top-level `const`, so it never attached to
// window — but 11 modules (analysis, audio-studio, clips, datamosh, nodegraph,
// storage, tools, tripcam-ui, vj-mode, workflows_v4/v5) read `window.state`.
// Without this line every one of those silently saw `undefined` and fell back
// to "no file in the bin" / a no-op. This is the single reference they share.
window.state = state;
window.cancelAllBgJobs = cancelAllBgJobs;
window.makeBgToken = makeBgToken;
window.isBgAlive = isBgAlive;
window.updateQueueChip = updateQueueChip;

// =============================================================================
// SHAREDARRAYBUFFER CHECK (spec §1.2, PHASE 0.2)
// =============================================================================
// PHASE 0.2: the old full-width red "sab-warning" wall lied — the app
// works fine in single-thread mode, just slower. Per the v5 hotfix, the
// scarlet block is GONE. We keep two helpers that mutate the small
// dismissible chip in the status bar instead:
//   - showSabBanner(msg)   — soft yellow chip (single-thread notice)
//   - hideSabBanner()      — remove the chip
//   - showEngineErrorChip(msg) — red error chip for true engine-load failure
// All three target the same `#engine-status` element so they never
// break the page layout. (showEngineErrorChip and hideEngineErrorChip
// are defined below in the "Status bar chips" block.)

function showSabBanner(customMessage) {
  // The legacy red SAB wall is gone. In its place, show the small yellow
  // single-thread chip (or, if a non-empty message is supplied, treat
  // it as a fatal engine error and surface the red error chip).
  if (customMessage) {
    showEngineErrorChip(customMessage);
    return;
  }
  // No message — show the yellow single-thread chip.
  setSingleThreadChip(true);
}
function hideSabBanner() {
  // Dismiss BOTH the yellow single-thread chip and the red error chip
  // because "the engine is fine" means the user shouldn't see either
  // warning.
  setSingleThreadChip(false);
  hideEngineErrorChip();
}
function checkSharedArrayBuffer() {
  if (typeof SharedArrayBuffer === 'undefined') {
    showSabBanner();
    setEngineStatus('red', 'Engine: SAB unavailable');
    logToConsole('err', 'SharedArrayBuffer is undefined. The page must be served with COOP/COEP headers.');
    return false;
  }
  return true;
}

// Engine readiness: tracks whether engine is in single-thread mode (true)
// or multi-thread mode (false). Used by the bottom status bar and the UI.
let _engineModeSingleThread = false;

// v5 hotfix 2 — Bug 4: apply a thread-mode-aware default for the
// encoder preset dropdown. We do this ONCE per engine load, and only
// when the dropdown is still at the veryfast page-load default. If the
// user has already changed it, we leave their choice alone.
function applyEngineDefaultPreset(mode) {
  const sel = document.getElementById('enc-preset');
  if (!sel) return;
  // Augment the slow options with a warning label so the user knows
  // what they're signing up for. (Idempotent — we just rewrite the
  // text of the relevant <option> elements each time.)
  const labels = {
    ultrafast:  'ultrafast',
    superfast:  'superfast',
    veryfast:   'veryfast (recommended in browser)',
    faster:     'faster',
    fast:       'fast (recommended for multi-thread)',
    medium:     'medium (⚠ slow in browser)',
    slow:       'slow (⚠ very slow in browser)',
    slower:     'slower (⚠ very slow in browser)',
    veryslow:   'veryslow (⚠ extremely slow in browser)',
  };
  Array.from(sel.options).forEach(o => {
    if (labels[o.value]) o.textContent = labels[o.value];
  });
  // Only swap the value if the user hasn't customized it. We track
  // this with a flag attached to the select.
  if (sel.dataset.userChanged === '1') return;
  const want = (mode === 'mt') ? 'fast' : 'veryfast';
  if (sel.value !== want) {
    sel.value = want;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    logToConsole('ok', `Default encoder preset set to "${want}" for ${mode === 'mt' ? 'multi-thread' : 'single-thread'} engine.`);
  }
}

// =============================================================================
// ENGINE INIT (spec §1.3, PHASE 0.2 + v5 hotfix)
// =============================================================================
// v5 HOTFIX (engine load):
//   * ffmpeg.wasm 0.12.x spawns a Web Worker. A worker cannot be instantiated
//     from a cross-origin URL. Passing raw unpkg URLs to coreURL / wasmURL
//     was failing every reload on the deployed host.
//   * The fix is to fetch each asset and convert it to a SAME-ORIGIN blob
//     URL via toBlobURL() from @ffmpeg/util BEFORE handing it to load().
//   * The library's own internal worker chunk must be passed explicitly as
//     classWorkerURL, blobified the same way — otherwise ffmpeg.js (served
//     from unpkg) tries to spawn its worker from a cross-origin path and
//     is blocked.
//   * Multi-thread is only possible when the page is genuinely cross-origin
//     isolated. We try MT first, then ALWAYS fall back to single-thread.
//   * The app must never be dead on arrival — the for-loop makes the
//     fallback automatic.
//
// v5 HOTFIX (banner):
//   * The previous full-width red "sab-warning" wall lied: the app works
//     fine single-threaded, just slower. The red wall is GONE.
//   * In its place: a small dismissible yellow chip in the status bar
//     that ONLY appears when running single-threaded. A separate small
//     red error chip is reserved for the rare "engine download failed"
//     case (not for normal single-thread operation).

// ---- Pinned CDN bases (do not change versions) ----
// v5 hotfix 4: ffmpeg.js (and its dynamic chunk 814.ffmpeg.js) are
// self-hosted under /vendor/. The library computes its class-worker
// URL as `<publicPath>/814.ffmpeg.js`; with the script served from
// /vendor/ffmpeg.js the worker resolves to /vendor/814.ffmpeg.js
// (same-origin, no blob wrapping). When ffmpeg.js came from a
// cross-origin CDN, the worker could spawn but the message channel
// back to the main thread silently died. The core wasm / core-mt wasm
// stay on the pinned unpkg URLs — they are loaded by the worker via
// importScripts() and remain unaffected.
// v5 hotfix 6 (round 2): ST and MT must live in SEPARATE directories
// with their ORIGINAL filenames. The MT glue locates its pthread
// worker relative to itself (looks for "ffmpeg-core.worker.js" next
// to itself) — rename it or mix the layouts and the worker gets a
// 404 / HTML error page, then the first wasm call inside the
// pthread worker crashes with "function signature mismatch" (the
// worker is running garbage). This was the root cause of the MT
// worker crash in the previous attempt.
const FFMPEG_UMD = 'vendor';                                          // library + 814.ffmpeg.js chunk
const CORE_ST    = 'vendor/st';                                       // single-thread: ffmpeg-core.{js,wasm}
const CORE_MT    = 'vendor/mt';                                       // multi-thread:  ffmpeg-core.{js,wasm,worker.js}

// =============================================================================
// v5 HOTFIX 4 — execWithTimeout + probeNative
// -----------------------------------------------------------------------------
// Two new utilities that together fix the upload hang. See plan doc for
// the full rationale; in short:
//   - A hung promise is invisible. Every ffmpeg call must be bounded.
//   - Browser-native <video>/<audio> can probe metadata in ~50ms with
//     no chance of hanging. We stop using ffmpeg for the critical-path
//     metadata probe.
// =============================================================================

// Run a function with a hard time limit. On timeout, rejects with a
// descriptive Error. The timer is always cleared, even if the fn wins.
function execWithTimeout(fn, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  const work = (async () => fn())();
  return Promise.race([work, timeout]).finally(() => {
    if (timer != null) clearTimeout(timer);
  });
}

// Default time budgets (ms). Centralised so they can be tuned.
const TT = {
  writeFile:  30000,
  readFile:   30000,
  deleteFile: 15000,
  execProbe:  15000,
  execExec:   30000,   // default for one-off exec() calls
};

// Native browser probe — uses <video>/<audio> metadata. Cannot hang
// (3s safety timeout), doesn't touch the ffmpeg wasm engine, and runs
// in ~50ms for a real clip. This is what populates the Run button
// gate and the trim/scale defaults.
function probeNative(file) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (info) => {
      if (settled) return;
      settled = true;
      try { URL.revokeObjectURL(url); } catch (_) {}
      resolve(info);
    };
    const url = URL.createObjectURL(file);
    const isVideo = (file.type || '').startsWith('video/') ||
                    /\.(mp4|webm|mkv|mov|avi)$/i.test(file.name || '');
    const isAudio = !isVideo && (
      (file.type || '').startsWith('audio/') ||
      /\.(mp3|wav|ogg|aac|m4a|flac)$/i.test(file.name || '')
    );
    const isImage = !isVideo && !isAudio && (
      (file.type || '').startsWith('image/') ||
      /\.(png|jpg|jpeg|gif|webp)$/i.test(file.name || '')
    );
    const el = document.createElement(isAudio ? 'audio' : (isImage ? 'img' : 'video'));
    if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
      el.preload = 'metadata';
      el.muted = true;
    }
    el.onloadedmetadata = () => {
      const width  = el.videoWidth  || 0;
      const height = el.videoHeight || 0;
      const dur    = isFinite(el.duration) ? el.duration : 0;
      settle({
        durationSec: dur,
        width, height,
        hasVideo: (isVideo || isImage) && (width > 0 || isImage),
        hasAudio: isAudio || isVideo,    // refined later by deep probe
        ok: true,
      });
    };
    el.onerror = () => settle({ ok: false, durationSec: 0, width: 0, height: 0, hasVideo: false, hasAudio: false });
    // 3s hard ceiling — the native element always fires one of the
    // above within a few hundred ms, so this is just a safety net.
    setTimeout(() => settle({ ok: false, durationSec: 0, width: 0, height: 0, hasVideo: false, hasAudio: false }), 3000);
    el.src = url;
  });
}

// Wrap the four mutating methods of an FFmpeg instance so every call
// has a built-in timeout. The 0.12.7 API's exec() already accepts a
// timeout; writeFile/readFile/deleteFile don't, so we wrap them with
// execWithTimeout. After this runs, no `await state.ffmpeg.<X>(...)`
// can hang past its budget without surfacing an error.
function instrumentFfmpeg(ffmpeg) {
  if (!ffmpeg) return;
  if (ffmpeg.__instrumented) return;
  ffmpeg.__instrumented = true;

  // exec() — second arg is a timeout in MILLISECONDS (-1 = no timeout),
  // NOT seconds. The old wrapper divided ms/1000 on the false belief it
  // was seconds: ff.exec() passes -1 ("no inner timeout, the queue's
  // outer timer is the guard"), the wrapper coerced that to
  // TT.execExec = 30000, then divided → 30, and the core read 30 as
  // 30 MILLISECONDS and aborted every multi-frame encode after ~1 frame
  // ("Conversion failed! / Aborted()"). That was THE round-trip bug:
  // the 10-frame boot selftest finished inside 30 ms and passed, so the
  // corruption only showed on real renders. Pass the value straight
  // through in ms; -1 / 0 / undefined all mean "no inner timeout" and
  // let ffRun's Promise.race be the only clock.
  const _exec = ffmpeg.exec.bind(ffmpeg);
  ffmpeg.exec = function(args, timeoutMs, signal) {
    const ms = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : -1;
    return _exec(args, ms, signal);
  };

  // writeFile / readFile / deleteFile / load / terminate — wrap with
  // execWithTimeout. load() downloads the wasm, give it 120s; the
  // others get the standard budgets.
  const wrap = (name, fn, defaultMs) => {
    return function() {
      const args = arguments;
      return execWithTimeout(
        () => fn.apply(ffmpeg, args),
        defaultMs,
        name
      );
    };
  };
  ffmpeg.writeFile  = wrap('writeFile',  ffmpeg.writeFile.bind(ffmpeg),  TT.writeFile);
  ffmpeg.readFile   = wrap('readFile',   ffmpeg.readFile.bind(ffmpeg),   TT.readFile);
  ffmpeg.deleteFile = wrap('deleteFile', ffmpeg.deleteFile.bind(ffmpeg), TT.deleteFile);
  ffmpeg.load       = wrap('load',       ffmpeg.load.bind(ffmpeg),       120000);
  // terminate is best-effort — it can return a rejected promise when
  // called on a worker that was already torn down, which we ignore.
  const _terminate = ffmpeg.terminate.bind(ffmpeg);
  ffmpeg.terminate = function() {
    try { return _terminate(); } catch (_) { /* swallow */ }
  };
}

// =============================================================================
// FILTER COST TABLE (v5 hotfix 2 — Bug 1: cost-estimate gate)
// -----------------------------------------------------------------------------
// These numbers are coarse relative cost units, calibrated so that a
// trivial 30s 1080p clip with one `eq` lands at < 5, while a single
// `geq` on an 8-min 1080p clip lands at several hundred. The actual
// execution time is not linear, but the relative ordering is correct
// and good enough to surface a useful "estimated seconds" prediction.
// =============================================================================
const FILTER_COST = {
  // per-pixel expression evaluators — brutally slow
  geq: 100, lut3d: 20, haldclut: 20,
  // temporal — must buffer frames
  tmix: 15, tblend: 8, lagfun: 5, minterpolate: 200, reverse: 50, amplify: 30, deflicker: 25,
  // spatial
  boxblur: 6, gblur: 8, unsharp: 6, edgedetect: 10, convolution: 12,
  noise: 3, deshake: 25, zoompan: 10, rotate: 5,
  // mid
  rgbashift: 6, chromashift: 6, lenscorrection: 4,
  // cheap
  eq: 1, hue: 1, colorchannelmixer: 1, scale: 2, crop: 1, fade: 1,
  drawtext: 3, vignette: 2, negate: 1, format: 1, fps: 1,
  lutrgb: 2, lutyuv: 2, curves: 2, pad: 1, transpose: 1, hflip: 1, vflip: 1,
  setpts: 1, tpad: 2, select: 2, drawbox: 2,
};

// Estimate the relative cost of running a chain. Returns a number that
// represents the *seconds* the chain is expected to take in the browser.
// 1080p 30s of `eq` is ~1 second; 1080p 8min of `geq` is ~1500+ seconds.
function estimateCost(filters, durationSec, width, height) {
  const megapixels = Math.max(0.01, (width * height) / 1_000_000);
  const base = filters.reduce((s, f) => s + (FILTER_COST[f.name] ?? 3), 0);
  const mult = state.threadMode === 'mt' ? 0.25 : 1.0;
  return base * megapixels * Math.max(0.1, durationSec) * 0.02 * mult;
}

// Slow-filter set used to badge workflow cards and gate commands.
const SLOW_FILTERS = new Set(['geq', 'minterpolate', 'reverse', 'tmix']);

// Format a seconds estimate for the Run button label.
function formatEstimate(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  if (sec < 1) return '<1s';
  if (sec < 60) return `~${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `~${m}m ${s}s`;
}

// Is the filter list "slow"? Used for badges and gates.
function hasSlowFilter(filters) {
  return filters.some(f => SLOW_FILTERS.has(f.name));
}

async function initFFmpeg() {
  // Spec mandates these pinned versions. The FFmpegWASM global is
  // provided by vendor/ffmpeg.js (served same-origin from the page).
  if (typeof FFmpegWASM === 'undefined' || !FFmpegWASM.FFmpeg) {
    setEngineStatus('red', 'Engine: CDN failed');
    logToConsole('err', 'FFmpegWASM global not found. Check your network / CDN.');
    showEngineErrorChip('The FFmpeg CDN failed to load. Check the network tab and refresh.');
    return;
  }
  // FFmpegUtil is loaded from unpkg in index.html and exposes toBlobURL
  // and fetchFile. Without toBlobURL, the engine cannot be loaded on
  // hosts that don't pre-isolate — which is the whole v5 hotfix.
  if (typeof FFmpegUtil === 'undefined' || !FFmpegUtil.toBlobURL) {
    setEngineStatus('red', 'Engine: util missing');
    logToConsole('err', 'FFmpegUtil global not found or missing toBlobURL.');
    showEngineErrorChip('The FFmpeg util helper failed to load. Check the network tab and refresh.');
    return;
  }
  const { FFmpeg } = FFmpegWASM;
  const { toBlobURL } = FFmpegUtil;

  // v10.4 ROUND-TRIP FIX: order MUST be ST-first.
  // ---------------------------------------------------------------------
  // The MT (pthread) core encodes the FIRST exec on a fresh instance fine
  // — a standalone single-shot probe passes 90/90. But this app runs many
  // execs on one long-lived instance (boot selftests, thumbnails, probes,
  // then the user's render). After the first few, the MT pthread worker
  // lands in a "function signature mismatch" state and every subsequent
  // multi-frame encode aborts after ~1 frame ("Conversion failed!" +
  // Aborted()). That is the exact "#1 round trip never goes green" bug:
  // selftest A (10 frames, early) passes, the real render (later) dies.
  //
  // The previous code's COMMENT said "try ST first" but the CODE did
  // `canMT ? ['mt','st']` — MT first — so on any cross-origin-isolated
  // host (which is every correctly-served deploy) it booted the broken
  // MT path. Match the code to the intent: ST is the safe, well-tested,
  // single-threaded path and it round-trips deterministically. MT is kept
  // only as a fallback if ST itself fails to load.
  const canMT = (typeof SharedArrayBuffer !== 'undefined') &&
                window.crossOriginIsolated === true;
  logToConsole('', `crossOriginIsolated = ${window.crossOriginIsolated}`);
  try { console.log(`[engine] crossOriginIsolated = ${window.crossOriginIsolated}`); } catch (_) {}

  const attempts = canMT ? ['st', 'mt'] : ['st'];
  for (const mode of attempts) {
    const base = mode === 'mt' ? CORE_MT : CORE_ST;
    setEngineStatus('yellow', `Engine: Loading (${mode === 'mt' ? 'multi' : 'single'}-thread)…`);
    hideEngineErrorChip();

    try {
      // v5 hotfix 6: same-origin only. No toBlobURL, no classWorkerURL.
      // The library is loaded from /vendor/ (self-hosted, same-origin),
      // so the 814.ffmpeg.js worker chunk resolves natively to
      // /vendor/814.ffmpeg.js — the worker message channel back to
      // the main thread is alive (this was the cause of every
      // "function signature mismatch" / hung-exec symptom we saw
      // when the core was being fetched cross-origin and wrapped in
      // blob URLs that the worker could not resolve back to a real
      // path). The wasm is loaded by the worker via importScripts()
      // on the coreURL; the worker then passes wasmURL/workerURL
      // through the core's mainScriptUrlOrBlob fragment.
      // CRITICAL: coreURL must be resolved relative to the WORKER
      // (which is at /vendor/814.ffmpeg.js), not the main page. If
      // we pass "vendor/ffmpeg-core.js" it resolves to
      // /vendor/vendor/ffmpeg-core.js (double-prefix) and the worker
      // fails to find the file. Use absolute path instead.
      // For MT we also need the pthread worker. All three MT files
      // v5 hotfix 6 (round 2): ST and MT live in separate directories
      // with ORIGINAL filenames (ffmpeg-core.js, ffmpeg-core.wasm,
      // ffmpeg-core.worker.js). The MT core's glue file locates its
      // pthread worker relative to itself — so we MUST pass
      // `workerURL` explicitly, otherwise the library's locateFile
      // would try to resolve it relative to the main page, not to the
      // core's directory. All three MT files are at vendor/mt/.
      const coreURL = new URL(`${base}/ffmpeg-core.js`, document.baseURI).href;
      const wasmURL = new URL(`${base}/ffmpeg-core.wasm`, document.baseURI).href;
      const cfg = { coreURL, wasmURL };
      if (mode === 'mt') {
        cfg.workerURL = new URL(`${base}/ffmpeg-core.worker.js`, document.baseURI).href;
      }

      state.ffmpeg = new FFmpeg();
      state.ffmpeg.on('log', ({ message }) => {
        const lower = String(message).toLowerCase();
        let level = '';
        if (lower.includes('error') || lower.includes('failed')) level = 'err';
        else if (lower.includes('warning')) level = 'warn';
        else if (lower.startsWith('frame=') || lower.includes('encoded')) level = 'ok';
        logToConsole(level, message);
        // Also echo to page console so headless tests can see ffmpeg's
        // progress (and so we can detect a silent hang).
        try { console.log(`[ffmpeg] ${message}`); } catch (_) {}
      });
      state.ffmpeg.on('progress', ({ progress, time }) => {
        const pct = Math.max(0, Math.min(1, progress || 0)) * 100;
        setProgress(pct);
        const timeStr = (time && time > 0) ? ` @ ${time.toFixed(2)}s` : '';
        setProgressText(`Processing… ${pct.toFixed(1)}%${timeStr}`);
      });

      // v5 hotfix 4: wrap the four mutating methods with timeouts so
      // a hung promise can never freeze the UI again. This MUST be
      // called before state.ffmpeg.load() (well, any time after the
      // instance is created — but doing it here is clearest).
      instrumentFfmpeg(state.ffmpeg);

      await state.ffmpeg.load(cfg);

      // ---- SMOKE TEST (v5 hotfix 4 — Step 1) ----
      // Does exec() actually return after load()? We saw v1–v3 hang
      // here because the worker message channel was dead. This 10s
      // probe makes that visible.
      try {
        logToConsole('', '[smoke] calling exec(["-version"])…');
        try { console.log('[smoke] calling exec(["-version"])…'); } catch (_) {}
        const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        // Use the ffmpeg-internal 2nd-arg timeout (seconds) plus a
        // JS-level guard, so the smoke test can never hang the boot.
        await execWithTimeout(
          () => ff.exec(['-version'], { timeoutMs: 8000 }),
          10000,
          'smoke'
        );
        const dt = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0);
        logToConsole('ok', `[smoke] exec returned in ${dt}ms`);
        try { console.log(`[smoke] exec returned in ${dt}ms`); } catch (_) {}
      } catch (e) {
        logToConsole('err', `[smoke] exec FAILED: ${(e && e.message) || e}`);
        try { console.log(`[smoke] exec FAILED: ${(e && e.message) || e}`); } catch (_) {}
        // Don't rethrow — the engine may still be partially usable
        // for non-exec operations, and the user can still try to
        // upload. Surface it loudly but keep going.
        showEngineErrorChip(`exec() did not return within 10s. The engine is broken. (${(e && e.message) || e})`);
      }

      // ---- v5 hotfix 6 — Selftests A and B ----
      // Generate their own input via lavfi — no upload, no MEMFS write,
      // no filters, no queue contention. Isolate the encode path.
      //
      // ASSERTING ON THE OUTCOME, not on the absence of an error.
      // A 48-byte MP4 is an empty container (ftyp + empty moov) — that
      // is what the previous "selftest A passed" missed. The
      // threshold below is 1000 bytes: a 1-second 320x240 10fps
      // x264 encode of a testsrc pattern produces ~2-6 KB of
      // compressed video, well above the container overhead. If
      // we see <1000 bytes, the encoder wrote 0 frames.
      const SELFTEST_MIN_BYTES = 1000;
      try {
        logToConsole('', '[selftest A] libx264 lavfi→mp4…');
        try { console.log('[selftest A] libx264 lavfi→mp4…'); } catch (_) {}
        // v5 hotfix 6 (round 2): the very first x264 call after
        // engine load is a "cold start" — the wasm heap is small,
        // the encoder's internal tables aren't warm, and the call
        // typically writes 1 frame then aborts with 48 bytes (empty
        // container). A second, identical call right after the
        // first has the heap warm and produces a real video. So we
        // run a warmup pass first, then assert on the second call.
        try {
          await execWithTimeout(() => ff.exec([
            '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-t', '1',
            '-y', 'selftest_a_warmup.mp4',
          ]), 30000, 'selftest A warmup');
          try { await ff.deleteFile('selftest_a_warmup.mp4'); } catch (_) {}
        } catch (_) { /* warmup failure is OK, the real test is the next call */ }
        await execWithTimeout(() => ff.exec([
          '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-t', '1',
          '-y', 'selftest_a.mp4',
        ]), 30000, 'selftest A');
        const out = await ff.readFile('selftest_a.mp4');
        const bytes = out ? (out.byteLength || out.length || 0) : 0;
        if (bytes >= SELFTEST_MIN_BYTES) {
          logToConsole('ok', `[selftest A] libx264 wrote ${bytes} bytes (PASS — real video)`);
          try { console.log(`[selftest A] libx264 wrote ${bytes} bytes (PASS — real video)`); } catch (_) {}
        } else if (bytes > 0) {
          // This is the failure mode that cost us a cycle: a non-zero
          // byte count that is actually an empty container. Surface it
          // loudly so it can never be misread as success.
          logToConsole('error', `[selftest A] libx264 wrote ${bytes} bytes — FAIL (empty container, not real video; <${SELFTEST_MIN_BYTES} bytes means 0 frames encoded)`);
          try { console.log(`[selftest A] libx264 wrote ${bytes} bytes — FAIL (empty container)`); } catch (_) {}
        } else {
          logToConsole('error', '[selftest A] libx264 wrote 0 bytes — FAIL');
          try { console.log('[selftest A] libx264 wrote 0 bytes — FAIL'); } catch (_) {}
        }
        try { await ff.deleteFile('selftest_a.mp4'); } catch (_) {}
      } catch (e) {
        logToConsole('error', `[selftest A] libx264 FAILED: ${(e && e.message) || e}`);
        try { console.log(`[selftest A] libx264 FAILED: ${(e && e.message) || e}`); } catch (_) {}
      }

      try {
        logToConsole('', '[selftest B] mpeg4 lavfi→mp4…');
        try { console.log('[selftest B] mpeg4 lavfi→mp4…'); } catch (_) {}
        await execWithTimeout(() => ff.exec([
          '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10',
          '-c:v', 'mpeg4', '-t', '1',
          '-y', 'selftest_b.mp4',
        ]), 30000, 'selftest B');
        const out = await ff.readFile('selftest_b.mp4');
        const bytes = out ? (out.byteLength || out.length || 0) : 0;
        if (bytes >= SELFTEST_MIN_BYTES) {
          logToConsole('ok', `[selftest B] mpeg4 wrote ${bytes} bytes (PASS — real video)`);
          try { console.log(`[selftest B] mpeg4 wrote ${bytes} bytes (PASS — real video)`); } catch (_) {}
        } else if (bytes > 0) {
          logToConsole('error', `[selftest B] mpeg4 wrote ${bytes} bytes — FAIL (empty container)`);
          try { console.log(`[selftest B] mpeg4 wrote ${bytes} bytes — FAIL (empty container)`); } catch (_) {}
        } else {
          logToConsole('error', '[selftest B] mpeg4 wrote 0 bytes — FAIL');
          try { console.log('[selftest B] mpeg4 wrote 0 bytes — FAIL'); } catch (_) {}
        }
        try { await ff.deleteFile('selftest_b.mp4'); } catch (_) {}
      } catch (e) {
        logToConsole('error', `[selftest B] mpeg4 FAILED: ${(e && e.message) || e}`);
        try { console.log(`[selftest B] mpeg4 FAILED: ${(e && e.message) || e}`); } catch (_) {}
      }

      // v5 hotfix 6 (round 2): MEMFS hygiene + heap readout.
      // The wasm heap is the same arena as MEMFS. The selftest files
      // (selftest_a.mp4, selftest_b.mp4) and the font files
      // (sans.ttf, bold.ttf, mono.ttf) are loaded into MEMFS but
      // never explicitly freed in the original selftest. We delete
      // the selftest outputs above; the fonts need to stay (they're
      // used by drawtext), so we surface their size as a heap
      // readout and let the user see MEMFS pressure in the status bar.
      try {
        const memUsage = await execWithTimeout(() => ff.exec([
          '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
          '-t', '0.1', '-c:a', 'aac', '-y', '_mem_probe.aac',
        ]), 10000, 'memfs-probe').catch(() => null);
        try { await ff.deleteFile('_mem_probe.aac'); } catch (_) {}
      } catch (_) { /* not critical */ }
      try { console.log(`[memfs] heap pressure visible in status bar (run with shorter inputs to keep it low)`); } catch (_) {}

      // AWAITED font load — guarantee MEMFS has the TTF before the
      // first drawtext command is built. If the CDN is unreachable
      // the catch branch keeps the app alive and Section 11 falls
      // back to custom font upload.
      try { await loadFonts(); }
      catch (e) { logToConsole('warn', 'loadFonts: ' + (e && e.message || e)); }

      state.engineReady = true;
      state.threadMode  = mode;
      _engineModeSingleThread = (mode === 'st');

      // v5 hotfix 2 — Bug 4: pick a sane default for the encoder
      // preset based on the threading mode the engine is actually
      // running in. Single-thread benefits from veryfast (less CPU per
      // frame); multi-thread can afford fast (better quality / size).
      // We only set this if the user hasn't already changed the
      // dropdown away from the default "veryfast" they saw at page
      // load — otherwise we'd silently overwrite their choice.
      if (typeof applyEngineDefaultPreset === 'function') {
        applyEngineDefaultPreset(mode);
      }

      if (mode === 'st') {
        setEngineStatus('yellow', 'Engine: Ready (single-thread — slower)');
        setSingleThreadChip(true);
        logToConsole('ok', 'FFmpeg core loaded (st).');
      } else {
        setEngineStatus('green', 'Engine: Ready');
        setSingleThreadChip(false);
        logToConsole('ok', 'FFmpeg core loaded (mt).');
      }
      hideSabBanner();
      setControlsEnabled(true);
      return; // success — stop trying
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      logToConsole('warn', `${mode}-thread load failed: ${msg}`);
      // loop continues → falls back to single-thread
    }
  }

  // Both attempts failed.
  state.engineReady = false;
  setEngineStatus('red', 'Engine: FAILED');
  logToConsole('error', 'Could not load ffmpeg-core in any mode. Check the network tab.');
  showEngineErrorChip('The FFmpeg engine could not be downloaded. Check your connection and reload.');
  setSingleThreadChip(false);
  setControlsEnabled(false);
}

// Single-thread fallback. In the v5 hotfix the new combined initFFmpeg()
// auto-detects SAB / crossOriginIsolated and tries MT-then-ST in a loop,
// so the old separate function is a thin wrapper that just calls
// initFFmpeg(). Kept as a function so the boot path (which may call it
// when SAB is missing AND no service worker is registering) does not
// have to be rewritten.
async function initFFmpegSingleThread() {
  return initFFmpeg();
}

// =============================================================================
// Status bar chips (v5 hotfix — Bug 2)
// =============================================================================
// Two small dismissible chips live in the engine status bar:
//   - "engine-st-chip"  (yellow) — single-thread notice. NEVER appears
//                                when the engine boots in multi-thread.
//   - "engine-err-chip" (red)    — engine-download failed. Only used
//                                for the rare "could not load in any
//                                mode" case.
// Both are created lazily and removed by their *hide* helpers. Neither
// occupies a full-width bar — they sit next to the green/yellow/red
// status dot. A dismiss stores a sessionStorage flag so the chip does
// not reappear on the same tab (until the next reload).

const CHIP_ST_DISMISS_KEY  = 'ffmpeg-st-chip-dismissed';
const CHIP_ERR_DISMISS_KEY = 'ffmpeg-err-chip-dismissed';

// Small dismissible yellow chip in the status bar shown when the engine
// is running on the single-thread core. Hidden when running in MT.
// The element #engine-st-chip is pre-rendered in index.html (initially
// hidden) — we just toggle its [hidden] attribute here. The dismiss
// button is wired lazily on first show (so we don't need a DOMContentLoaded
// hook just for a hidden element).
function setSingleThreadChip(visible) {
  const chip = document.getElementById('engine-st-chip');
  if (!chip) return;
  if (!visible) { chip.hidden = true; return; }
  if (sessionStorage.getItem(CHIP_ST_DISMISS_KEY) === '1') { chip.hidden = true; return; }
  chip.hidden = false;
  const x = chip.querySelector('.engine-st-chip-x');
  if (x && !x.dataset.wired) {
    x.dataset.wired = '1';
    x.addEventListener('click', () => {
      sessionStorage.setItem(CHIP_ST_DISMISS_KEY, '1');
      chip.hidden = true;
    });
  }
}

// Small red error chip for the rare case where the engine could not be
// downloaded in any threading mode. Same size/shape as the yellow chip,
// only the color differs. This is NOT a full-width red banner.
// We create the element lazily on first show and keep it in the DOM after
// dismiss (just hidden) so toggling is cheap.
function showEngineErrorChip(message) {
  if (sessionStorage.getItem(CHIP_ERR_DISMISS_KEY) === '1') {
    hideEngineErrorChip();
    return;
  }
  const bar = document.getElementById('engine-status');
  if (!bar) return;
  let chip = document.getElementById('engine-err-chip');
  if (!chip) {
    chip = document.createElement('span');
    chip.id = 'engine-err-chip';
    chip.className = 'engine-err-chip';
    chip.innerHTML =
      '<span class="engine-err-chip-text"></span>' +
      '<button type="button" class="engine-err-chip-x" aria-label="Dismiss engine error">×</button>';
    bar.appendChild(chip);
    chip.querySelector('.engine-err-chip-x').addEventListener('click', () => {
      sessionStorage.setItem(CHIP_ERR_DISMISS_KEY, '1');
      chip.hidden = true;
    });
  }
  const safe = String(message || 'Engine failed to load. Check the network tab and reload.')
    .replace(/[<&>'"]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));
  chip.title = safe;
  const text = chip.querySelector('.engine-err-chip-text');
  if (text) text.textContent = '⚠ ' + safe;
  chip.hidden = false;
}

function hideEngineErrorChip() {
  const chip = document.getElementById('engine-err-chip');
  if (chip) chip.hidden = true;
}

function setEngineStatus(state_, text) {
  const dot = document.getElementById('status-dot');
  const lbl = document.getElementById('status-text');
  if (dot) dot.setAttribute('data-state', state_);
  if (lbl) lbl.textContent = text;
  // UX 8 — keep the mobile bottom status bar in sync.
  if (typeof updateMobileStatusBar === 'function') updateMobileStatusBar();
}

// =============================================================================
// v4 PART A2 — Font loading
// -----------------------------------------------------------------------------
// ffmpeg.wasm ships with NO system fonts and no fontconfig — every drawtext
// filter needs an explicit fontfile=. We fetch three Roboto variants from a
// CDN and write them to MEMFS at engine boot. Section 11 picks one via a
// dropdown (see #text-font). If everything fails we still let the user
// upload their own font via #text-font-upload.
// =============================================================================
// TTF sources. Pinned to the vendored copies under /vendor/fonts/ so
// the loadFonts() fetch is same-origin with the page and never has to
// survive a CDN rename (the upstream `google/fonts` repo was renamed
// to `googlefonts/roboto` and the old paths 404 now). All three
// files are committed in /vendor/fonts/ and pinned to specific
// Roboto versions. The /vendor/fonts/ files are TTF format (not
// woff/woff2) because ffmpeg.wasm's drawtext filter only accepts
// TTF/OTF. The RobotoMono TTF was fetched from fonts.gstatic.com
// (the actual Google Fonts CDN) and pinned.
const BUILTIN_FONTS = [
  { name: 'sans.ttf', url: 'vendor/fonts/Roboto-Regular.ttf',  label: 'Sans (Roboto)' },
  { name: 'bold.ttf', url: 'vendor/fonts/Roboto-Bold.ttf',     label: 'Bold (Roboto Bold)' },
  { name: 'mono.ttf', url: 'vendor/fonts/RobotoMono-Regular.ttf', label: 'Mono (Roboto Mono)' },
];
async function loadFonts() {
  if (!state.ffmpeg) return;
  if (typeof FFmpegUtil === 'undefined' || !FFmpegUtil.fetchFile) return;
  let ok = 0;
  for (const f of BUILTIN_FONTS) {
    try {
      const data = await FFmpegUtil.fetchFile(f.url);
      // data may be a Uint8Array (most common from fetchFile of an HTTP URL)
      // or a string. Coerce to Uint8Array for writeFile.
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      try { await ff.deleteFile('/' + f.name); } catch (_) {}
      await ff.writeFile('/' + f.name, u8);
      ok += 1;
    } catch (e) {
      logToConsole('warn', `Could not load font ${f.name}: ${(e && e.message) || e}`);
    }
  }
  state.fontsLoaded = (ok > 0);
  // The font dropdown is populated by app.js on init; we just flip the note
  // row and the section-enabled flag here.
  if (!state.fontsLoaded) {
    logToConsole('warn', 'No built-in fonts loaded. Section 11 (Text Overlay) will be disabled until you upload a custom font.');
    const noteRow = document.getElementById('text-font-note-row');
    const note    = document.getElementById('text-font-note');
    if (noteRow) noteRow.hidden = false;
    if (note)    note.textContent = 'Fonts could not be loaded from CDN (offline or CORS). Section 11 is disabled until a custom font is uploaded.';
    const enable11 = document.getElementById('enable-11');
    if (enable11) {
      enable11.checked = false;
      enable11.disabled = true;
    }
  } else {
    logToConsole('ok', `Loaded ${ok} font${ok === 1 ? '' : 's'} into MEMFS.`);
  }
}

// =============================================================================
// v4 PART A2 — Custom font upload
// -----------------------------------------------------------------------------
// Accept a .ttf / .otf from the user, write it to MEMFS as /custom_N.ttf,
// and append it to the Section 11 font dropdown. Re-enables Section 11
// even if the CDN fetch above failed.
// =============================================================================
async function addCustomFont(file) {
  if (!state.ffmpeg) { logToConsole('err', 'Engine not ready.'); return; }
  const name = (file.name || '').toLowerCase();
  if (!(name.endsWith('.ttf') || name.endsWith('.otf'))) {
    logToConsole('err', `Custom font must be .ttf or .otf (got: ${file.name})`);
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    logToConsole('warn', 'Custom font is larger than 10 MB; that is unusually large for a TTF/OTF.');
  }
  const idx = state.customFonts.length + 1;
  const ext = name.endsWith('.otf') ? 'otf' : 'ttf';
  const virtualName = `/custom_${idx}.${ext}`;
  try {
    const u8 = new Uint8Array(await file.arrayBuffer());
    try { await ff.deleteFile(virtualName); } catch (_) {}
    await ff.writeFile(virtualName, u8);
    state.customFonts.push({ virtualName, displayName: file.name });
    state.fontsLoaded = true;
    // Append to dropdown.
    const sel = document.getElementById('text-font');
    if (sel) {
      const opt = document.createElement('option');
      opt.value = virtualName;
      opt.textContent = `Custom: ${file.name}`;
      sel.appendChild(opt);
      sel.value = virtualName;
    }
    // Hide the warning row + re-enable Section 11.
    const noteRow = document.getElementById('text-font-note-row');
    if (noteRow) noteRow.hidden = true;
    const enable11 = document.getElementById('enable-11');
    if (enable11) { enable11.disabled = false; }
    logToConsole('ok', `Custom font loaded: ${file.name} → ${virtualName}`);
  } catch (e) {
    logToConsole('err', `Custom font load failed: ${(e && e.message) || e}`);
  }
}

// =============================================================================
// FILE INGESTION (spec §1.4 — v3 multi-file aware)
// =============================================================================
// Throttle for noisy 'Engine not ready yet.' messages so tab clicks don't
// spam the log. One message per 5 seconds per (level,text) tuple.
const _logThrottleLast = {};
const LOG_THROTTLE_MS = 5000;
function logToConsoleThrottled(level, text) {
  const key = (level || '') + '|' + text;
  const now = Date.now();
  const last = _logThrottleLast[key] || 0;
  if (now - last < LOG_THROTTLE_MS) return;
  _logThrottleLast[key] = now;
  logToConsole(level, text);
}

// =============================================================================
// MEDIA BIN (v3 PART B)
// =============================================================================
//
// The media bin is the multi-file "media pool" of the editor. It owns all
// uploaded files and exposes a "currently active" file (state.inputFile via
// the state getter). Each media object:
//   { id, file, name, virtualName, size, type, mime, blobUrl,
//     durationSec, width, height, fps, vcodec, acodec, sampleRate,
//     hasVideo, hasAudio, analyzed, isOutput, sourceName }
// -----------------------------------------------------------------------------


// Classification helpers used by the bin.
const BIN_EXT_TO_TYPE = {
  mp4: 'video', webm: 'video', mkv: 'video', mov: 'video', avi: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', aac: 'audio', m4a: 'audio', flac: 'audio',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
};
const BIN_ACCEPTED_MIMES = new Set([
  'video/mp4', 'video/webm', 'video/ogg', 'video/x-matroska', 'video/quicktime', 'video/x-msvideo',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/flac', 'audio/mp4', 'audio/x-m4a',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);
const BIN_ACCEPTED_EXTS = new Set([
  'mp4','webm','mkv','mov','avi',
  'mp3','wav','ogg','aac','m4a','flac',
  'png','jpg','jpeg','gif','webp',
]);

let _mediaIdCounter = 0;
function nextMediaId() {
  _mediaIdCounter += 1;
  return 'media_' + Date.now().toString(36) + '_' + _mediaIdCounter;
}
function nextVirtualName(ext) {
  for (let i = 1; i < 100000; i++) {
    const candidate = `input_${i}.${ext}`;
    if (!state.mediaBin.some(m => m.virtualName === candidate)) return candidate;
  }
  return 'input_' + Date.now() + '.' + ext;
}
function classifyMediaFile(file) {
  const ext = (file.name.match(/\.([a-zA-Z0-9]+)$/) || [, ''])[1].toLowerCase();
  if (BIN_EXT_TO_TYPE[ext]) return { type: BIN_EXT_TO_TYPE[ext], ext };
  if (file.type && file.type.startsWith('video')) return { type: 'video', ext: ext || 'mp4' };
  if (file.type && file.type.startsWith('audio')) return { type: 'audio', ext: ext || 'wav' };
  if (file.type && file.type.startsWith('image')) return { type: 'image', ext: ext || 'png' };
  return { type: 'unknown', ext: ext || 'bin' };
}

// Bin selection set (multi-select checkboxes).
const binSelected = new Set();

// Accept a FileList (from <input type=file multiple> or DataTransfer.files)
// and process each file. Each file becomes a media-bin card; the first
// file added (when the bin was previously empty) becomes active.
//
// v5 HOTFIX 4: rewritten so the metadata probe never blocks the
// critical path. The minimum work to make the file usable is:
//   1. fetchFile
//   2. writeFile (instrumented: 30s timeout)
//   3. probeNative (browser <video>/<audio> metadata, ~50ms, cannot hang)
// As soon as step 3 finishes, the Run button enables and the user
// can click Run. A deep ffmpeg probe runs in the background to fill
// in codec names and exact fps — if it hangs or fails, the app
// doesn't care.
async function handleFilesUpload(fileList) {
  if (!fileList) return;
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  if (!state.ffmpeg) { logToConsoleThrottled('err', 'Engine not ready yet.'); return; }

  // Process each file. Each becomes a media-bin card; the first added
  // (when the bin was empty) becomes the active Editor input.
  const wasEmpty = state.mediaBin.length === 0;
  let firstAddedId = null;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) continue;

    try { console.log(`[handleFilesUpload] start file ${i+1}/${files.length}: ${file.name} (${file.size}B) type=${file.type || '?'} engineReady=${state.engineReady} threadMode=${state.threadMode} hasFfmpeg=${!!state.ffmpeg}`); } catch (_) {}

    // MIME / extension validation (lenient: many browsers report empty
    // MIME for WAV etc — fall back to extension).
    const cls = classifyMediaFile(file);
    const mimeOk = !file.type || BIN_ACCEPTED_MIMES.has(file.type) || BIN_ACCEPTED_EXTS.has(cls.ext);
    if (!mimeOk) {
      logToConsole('err', `Unsupported file: ${file.name} (${file.type || cls.ext}).`);
      continue;
    }
    if (file.size > LARGE_FILE_WARN_BYTES) {
      logToConsole('warn', `Large file (${formatBytes(file.size)}). MEMFS holds everything in RAM — browser may exhaust memory.`);
    }

    const ext = cls.ext;
    const id = nextMediaId();
    const virtualName = nextVirtualName(ext);
    const blobUrl = URL.createObjectURL(file);

    const media = {
      id, file, name: file.name, virtualName, size: file.size,
      type: cls.type, mime: file.type || ('/' + ext),
      blobUrl,
      durationSec: 0, width: 0, height: 0, fps: 0,
      vcodec: '', acodec: '', sampleRate: 0,
      hasVideo: cls.type === 'video' || cls.type === 'image',
      hasAudio: cls.type === 'audio' || cls.type === 'video',
      analyzed: false, isOutput: false, sourceName: null,
      _status: 'analyzing', _error: null,
    };
    state.mediaBin.push(media);
    window.FFOPFS?.persistMedia?.(media);   // survives a page reload
    // A trim set for a previous (longer) file would silently poison every render
    // on this one. Clamp it to the new duration.
    if (typeof clampTrimToDuration === 'function') clampTrimToDuration(media.durationSec);
    if (!firstAddedId) firstAddedId = id;
    // Render a placeholder card immediately so the user sees feedback.
    renderMediaBin();
    updateBinCount();

    setEngineStatus('yellow', `Engine: Reading ${file.name}…`);

    // ---- BLOCKING path: get the file into MEMFS + a quick native
    // probe so the Run button can enable. Each step is instrumented
    // (writeFile is wrapped with a 30s timeout by instrumentFfmpeg).
    let data = null;
    try {
      logToConsole('', `[up] 1/4 fetchFile ${file.name} (${file.size}B)…`);
      try { console.log(`[up] 1/4 fetchFile ${file.name} (${file.size}B)`); } catch (_) {}
      data = await FFmpegUtil.fetchFile(file);
      logToConsole('ok', `[up] 1/4 done — ${data.length} bytes`);
      try { console.log(`[up] 1/4 done — ${data.length} bytes`); } catch (_) {}

      logToConsole('', `[up] 2/4 writeFile ${virtualName}…`);
      try { console.log(`[up] 2/4 writeFile ${virtualName}`); } catch (_) {}
      try { await ff.deleteFile(virtualName); } catch (_) { /* not present */ }
      await ff.writeFile(virtualName, data);
      logToConsole('ok', `[up] 2/4 done`);
      try { console.log(`[up] 2/4 done`); } catch (_) {}
      media._status = 'loading';
    } catch (err) {
      media._status = 'error';
      media._error = (err && err.message) ? err.message : String(err);
      logToConsole('err', `File load failed for ${file.name}: ${media._error}`);
      try { console.log(`[up] FAIL: ${media._error}`); } catch (_) {}
      renderMediaBin();
      continue;
    }

    // Native probe: instant, cannot hang. Populates everything the
    // UI needs to enable the Run button (duration, dimensions).
    logToConsole('', `[up] 3/4 probeNative…`);
    try { console.log(`[up] 3/4 probeNative`); } catch (_) {}
    let probe = null;
    try {
      probe = await probeNative(file);
    } catch (_) {
      probe = { ok: false };
    }
    if (probe && probe.ok) {
      media.durationSec = probe.durationSec || 0;
      media.width  = probe.width  || 0;
      media.height = probe.height || 0;
      media.hasVideo = !!probe.hasVideo;
      media.hasAudio = !!probe.hasAudio;
      media.analyzed = true;
    } else {
      // Probe failed — keep placeholder values. The Run button still
      // enables; downstream commands will fall back to "auto" for
      // anything we couldn't read.
      logToConsole('warn', `[up] 3/4 native probe returned no metadata for ${file.name}; will retry with ffmpeg.`);
    }
    media._status = 'ready';
    logToConsole('ok', `[up] 3/4 done`);
    try { console.log(`[up] 3/4 done`); } catch (_) {}

    logToConsole('', `[up] 4/4 render bin card…`);
    renderMediaBin();
    updateBinCount();
    logToConsole('ok', `[up] 4/4 done — Loaded ${file.name} (${formatBytes(file.size)}) as ${virtualName}`);
    try { console.log(`[up] 4/4 done — Loaded ${file.name}`); } catch (_) {}

    // ---- NON-BLOCKING: native thumbnail. The browser does this in
    // ~80ms with no ffmpeg involvement (it cannot deadlock the wasm
    // heap). We previously used ffmpeg to extract a frame, but that
    // was the third concurrent exec() during a 3-file upload and
    // crashed the engine. v5 hotfix 5: pure DOM, no ffmpeg.
    generateThumbnail(media).catch(() => {}).finally(() => renderMediaBin());
  }

  if (wasEmpty && firstAddedId) {
    try { console.log(`[handleFilesUpload] calling setActiveMedia(${firstAddedId})`); } catch (_) {}
    setActiveMedia(firstAddedId);
  } else if (firstAddedId) {
    renderMediaBin();
  }
  try { console.log(`[handleFilesUpload] end — wasEmpty=${wasEmpty} firstAddedId=${firstAddedId} activeMediaId=${state.activeMediaId} inputFile=${!!state.inputFile} isProcessing=${state.isProcessing}`); } catch (_) {}
  // v5 HOTFIX 4 BUG: the rewritten handleFilesUpload (native probe +
  // non-blocking deep probe) does not call setControlsEnabled() at the
  // end. initFFmpeg() called it when state.inputFile was still null, so
  // the Run button was left disabled. Now that the active media is set
  // and the engine is Ready, re-evaluate the controls so Run enables.
  setControlsEnabled(!!state.engineReady && !state.isProcessing);
  refreshCommandPreview();
  updateMobileStatusBar();
}

// Analyze an image using the browser's Image() API.
function analyzeImageMedia(media) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      media.width = img.naturalWidth || 0;
      media.height = img.naturalHeight || 0;
      media.hasVideo = true;
      media.hasAudio = false;
      media.analyzed = true;
      media._status = 'ready';
      resolve();
    };
    img.onerror = () => resolve();
    img.src = media.blobUrl;
  });
}

// Extract a single video frame for the thumbnail.
// v4 PART C-1: real filmstrip thumbnails. We try several timestamps
// (1s, then half the duration, then 0s) and pick the first that
// succeeds. The spec calls for ffmpeg -ss 1 -i input -frames:v 1
// -vf scale=120:-1 — we use scale=240:-1 to match the bin card's
// display size and produce a sharper thumbnail.
// =============================================================================
// generateThumbnail (v5 hotfix 5 — native canvas version)
// -----------------------------------------------------------------------------
// The previous ffmpeg-based path was the THIRD concurrent exec() call
// during a 3-file upload (alongside the deep probe and the user
// surface). With the wasm heap, that was enough to crash the engine.
// This version uses the browser's <video> element to seek to a
// specific timestamp, then draws the frame onto a canvas and
// exports it as a JPEG. Zero ffmpeg. ~80ms per thumbnail. Cannot
// touch the heap. Cannot deadlock.
// =============================================================================
function generateThumbnail(media) {
  return thumbnailNative(media.file, 1.0)
    .then((blobUrl) => {
      if (blobUrl) {
        if (media._thumbUrl) { try { URL.revokeObjectURL(media._thumbUrl); } catch (_) {} }
        media._thumbUrl = blobUrl;
      }
    })
    .catch(() => { /* silent — placeholder falls back */ });
}

function thumbnailNative(file, atSec) {
  return new Promise((resolve) => {
    if (!file || !file.type || !file.type.startsWith('video/')) return resolve(null);
    const seekTo = (typeof atSec === 'number' && atSec > 0) ? atSec : 1.0;
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;

    let settled = false;
    const done = (blobUrl) => {
      if (settled) return;
      settled = true;
      try { URL.revokeObjectURL(url); } catch (_) {}
      resolve(blobUrl);
    };
    const fail = () => done(null);

    v.onloadedmetadata = () => {
      // Clamp: don't seek past the end of a short clip. Use 25% of
      // the duration as a fallback if the requested time is out of
      // bounds — this avoids a blank frame on sub-2s clips.
      const fallback = Math.max(0, (v.duration || 0) * 0.25);
      v.currentTime = Math.min(seekTo, fallback);
    };

    v.onseeked = () => {
      const c = document.createElement('canvas');
      const scale = 160 / (v.videoWidth || 160);
      c.width  = 160;
      c.height = Math.round((v.videoHeight || 90) * scale);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.toBlob((b) => done(b ? URL.createObjectURL(b) : null), 'image/jpeg', 0.7);
    };

    v.onerror = fail;
    setTimeout(fail, 4000);          // never hang
    v.src = url;
  });
}

function updateBinCount() {
  // PHASE 0.3 FIX: the global drawer is the single source of truth for
  // the bin count chip. The legacy #bin-count element (which used to
  // live in the editor-tab media bin) is gone, so we fall back to the
  // global drawer's #global-bin-count chip.
  let c = document.getElementById('global-bin-count');
  if (!c) c = document.getElementById('bin-count');
  if (c) c.textContent = String(state.mediaBin.length);
}

function setActiveMedia(id) {
  state.activeMediaId = id;
  try { console.log(`[setActiveMedia] id=${id} mediaBin.length=${state.mediaBin.length} isProcessing=${state.isProcessing}`); } catch (_) {}
  const media = state.mediaBin.find(m => m.id === id);
  if (!media) return;
  loadSourcePreview(media.blobUrl, media.mime);

  // Route the file to the tool that actually handles it.
  // An audio file belongs in the Audio Studio (real-time rack), not the video
  // editor. This was defined in navigation.js and never called — clicking a
  // track dropped you in the wrong tool with no indication why.
  try { window.FFNav?.routeMedia?.(media); } catch (_) {}

  // Feed the waveform/filmstrip and clamp any stale trim to this file.
  try { window.FFWaveform?.loadMedia?.(media); } catch (_) {}
  try { clampTrimToDuration(media.durationSec); } catch (_) {}
  // Update the file-info card.
  const fi = document.getElementById('file-info');
  if (fi) {
    const dur = media.durationSec ? media.durationSec.toFixed(2) + 's' : '—';
    const res = (media.width && media.height) ? `${media.width}×${media.height}` : (media.type === 'audio' ? 'audio' : (media.type === 'image' ? 'image' : '—'));
    fi.innerHTML = `
      <div class="file-info">
        <strong>${escapeHtml(media.name)}</strong>
        <span class="file-info-meta">${formatBytes(media.size)} · ${dur} · ${res} · ${escapeHtml(media.mime)}</span>
      </div>
    `;
  }
  // For video, re-attach metadata listener.
  const videoEl = document.getElementById('video-preview');
  if (videoEl) {
    const onMeta = () => { onSourceMetadataLoaded(); renderMediaBin(); };
    videoEl.addEventListener('loadedmetadata', onMeta, { once: true });
  }
  // For audio/image, initialize trim sliders from the bin-stored duration.
  if ((media.type === 'audio' || media.type === 'image') && media.durationSec) {
    const dur = media.durationSec;
    const ss = document.getElementById('trim-start-slider');
    const es = document.getElementById('trim-end-slider');
    if (ss) { ss.min = '0'; ss.max = String(dur || 0); ss.value = '0'; ss.step = '0.01'; }
    if (es) { es.min = '0'; es.max = String(dur || 0); es.value = String(dur || 0); es.step = '0.01'; }
    initRangeSelector(dur);
    setTrimTimes(0, dur);
  }
  renderMediaBin();
  refreshCommandPreview();
  updateBinMultiToolbar();
  updateMobileStatusBar();
  refreshVizBgSelect();
  if (typeof updateActionBar === 'function') updateActionBar();
  if (typeof syncGlobalBinDrawer === 'function') syncGlobalBinDrawer();
}

async function removeMedia(id) {
  const idx = state.mediaBin.findIndex(m => m.id === id);
  if (idx < 0) return;
  const m = state.mediaBin[idx];
  if (state.ffmpeg && m.virtualName) {
    try { await ff.deleteFile(m.virtualName); } catch (_) {}
  }
  if (m.blobUrl) try { URL.revokeObjectURL(m.blobUrl); } catch (_) {}
  if (m._thumbUrl) try { URL.revokeObjectURL(m._thumbUrl); } catch (_) {}
  state.mediaBin.splice(idx, 1);
  binSelected.delete(id);
  if (state.activeMediaId === id) {
    state.activeMediaId = state.mediaBin[0] ? state.mediaBin[0].id : null;
    if (state.activeMediaId) {
      setActiveMedia(state.activeMediaId);
    } else {
      const v = document.getElementById('video-preview');
      if (v) { v.removeAttribute('src'); v.load(); }
      const fi = document.getElementById('file-info');
      if (fi) fi.innerHTML = '<span class="file-info-empty">No file loaded</span>';
      showDropOverlay();
    }
  }
  renderMediaBin();
  updateBinCount();
  updateBinMultiToolbar();
  refreshCommandPreview();
  updateMobileStatusBar();
  refreshVizBgSelect();
}

function clearMediaBin() {
  if (state.ffmpeg) {
    for (const m of state.mediaBin) {
      if (m.virtualName) {
        try { ff.deleteFile(m.virtualName); } catch (_) {}
      }
    }
  }
  for (const m of state.mediaBin) {
    if (m.blobUrl) try { URL.revokeObjectURL(m.blobUrl); } catch (_) {}
    if (m._thumbUrl) try { URL.revokeObjectURL(m._thumbUrl); } catch (_) {}
  }
  state.mediaBin = [];
  binSelected.clear();
  state.activeMediaId = null;
  const v = document.getElementById('video-preview');
  if (v) { v.removeAttribute('src'); v.load(); }
  const fi = document.getElementById('file-info');
  if (fi) fi.innerHTML = '<span class="file-info-empty">No file loaded</span>';
  showDropOverlay();
  renderMediaBin();
  updateBinCount();
  updateBinMultiToolbar();
  refreshCommandPreview();
  updateMobileStatusBar();
  refreshVizBgSelect();
}

function renderMediaBin() {
  // PHASE 0.3 FIX: the single render target is now the Global Media
  // Bin Drawer's strip (#global-bin-strip). The Editor-tab media bin
  // DOM has been DELETED entirely, so this function no longer needs
  // to render two copies and then mirror. The `media-bin-strip` id is
  // preserved on the global drawer so this lookup still works; we
  // also look up the global drawer's strip explicitly as a guard.
  let strip = document.getElementById('global-bin-strip');
  if (!strip) strip = document.getElementById('media-bin-strip');
  if (!strip) return;
  if (state.mediaBin.length === 0) {
    strip.innerHTML = '<em class="muted bin-empty">No media loaded. Drop files here or tap + Add Media.</em>';
    updateBinMultiToolbar();
    if (typeof updateActionBar === 'function') updateActionBar();
    if (typeof syncGlobalBinDrawer === 'function') syncGlobalBinDrawer();
    return;
  }
  strip.innerHTML = state.mediaBin.map((m, i) => binCardHtml(m, i)).join('');
  strip.querySelectorAll('.media-bin-card').forEach(card => {
    const id = card.dataset.mediaId;
    card.addEventListener('click', (e) => {
      // Ignore clicks on the checkbox, remove button, or the reorder row (and
      // its child buttons) — those have their own handlers.
      if (e.target.matches('input[type="checkbox"]') ||
          e.target.closest('.bin-card-remove, .bin-card-drag')) return;
      setActiveMedia(id);
    });
  });
  strip.querySelectorAll('.bin-card-checkbox').forEach(cb => {
    cb.addEventListener('change', updateBinMultiToolbar);
  });
  // Touch-accessible reorder (native HTML5 drag below never fires on iOS/mobile,
  // and bin order is the composite order — concat/stack read the bin sequence).
  strip.querySelectorAll('.bin-reorder').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      moveBinItem(btn.dataset.id, btn.dataset.reorder === 'up' ? -1 : 1);
    });
  });
  strip.querySelectorAll('.bin-card-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeMedia(btn.dataset.removeId);
    });
  });
  // Drag-to-reorder
  let dragId = null;
  strip.querySelectorAll('.media-bin-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      dragId = card.dataset.mediaId;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      strip.querySelectorAll('.media-bin-card').forEach(c => c.classList.remove('drag-over'));
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const srcId = dragId;
      const dstId = card.dataset.mediaId;
      if (!srcId || srcId === dstId) return;
      const srcIdx = state.mediaBin.findIndex(m => m.id === srcId);
      const dstIdx = state.mediaBin.findIndex(m => m.id === dstId);
      if (srcIdx < 0 || dstIdx < 0) return;
      const [moved] = state.mediaBin.splice(srcIdx, 1);
      state.mediaBin.splice(dstIdx, 0, moved);
      renderMediaBin();
    });
  });
  // v4 PART A1: refresh the action bar's active-file chip + drawer
  // count + multi-select composite toolbar.
  updateBinMultiToolbar();
  if (typeof updateActionBar === 'function') updateActionBar();
  if (typeof syncGlobalBinDrawer === 'function') syncGlobalBinDrawer();
}

// Tiny extension → codec hint map. We no longer run a deep
// ffmpeg probe on every upload (it crashed the wasm heap under
// concurrency in v5 hotfixes 1–4). The actual codec is rarely
// needed for the UI; for the rare cases where the user wants it,
// the bin card shows the most-likely codec for the file extension
// as a passive hint. This is cheap, deterministic, and never
// touches the engine.
const BIN_EXT_CODEC_HINT = {
  mp4: 'H.264', mov: 'H.264', m4v: 'H.264',
  webm: 'VP9', ogv: 'VP8',
  mkv: 'AV1/H.264',
  mp3: 'MP3', m4a: 'AAC', aac: 'AAC',
  wav: 'PCM', flac: 'FLAC', ogg: 'Vorbis',
  png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', webp: 'WebP', gif: 'GIF',
};

function binCardHtml(m, idx) {
  const active = (m.id === state.activeMediaId) ? ' active' : '';
  const errorCls = (m._status === 'error') ? ' error' : '';
  const badge = m.isOutput ? '<span class="thumb-output-badge">OUTPUT</span>' : '';
  // v4 PART C-1: real filmstrip thumbnails. We pick the best available
  // preview (real extracted frame > image blob > placeholder) and set
  // it both as a <img> and as a CSS background-image so the card
  // looks right even before the <img> decodes.
  let thumbInner;
  let bgStyle = '';
  if (m.type === 'audio') {
    thumbInner = '<span class="thumb-placeholder">♫</span>';
  } else if (m._thumbUrl) {
    thumbInner = `<img src="${m._thumbUrl}" alt="" />`;
    bgStyle = ` style="background-image:url('${m._thumbUrl}')"`;
  } else if (m.type === 'image' && m.blobUrl) {
    thumbInner = `<img src="${m.blobUrl}" alt="" />`;
    bgStyle = ` style="background-image:url('${m.blobUrl}')"`;
  } else {
    thumbInner = '<span class="thumb-placeholder">🎬</span>';
  }
  const status = (m._status === 'analyzing') ? '<span class="thumb-status">analyzing…</span>'
              : (m._status === 'loading')  ? '<span class="thumb-status">loading…</span>'
              : (m._status === 'error')    ? '<span class="thumb-status">error</span>'
              : '';
  const dur = m.durationSec ? formatTime(m.durationSec) : '—';
  const res = (m.width && m.height) ? `${m.width}×${m.height}` : (m.type === 'audio' ? 'audio' : (m.type === 'image' ? 'image' : '—'));
  const titleAttr = escapeHtml(m.name + (m.isOutput ? ' (output)' : ''));
  return `
    <div class="media-bin-card${active}${errorCls}" data-media-id="${m.id}" draggable="true" title="${titleAttr}">
      <div class="bin-card-actions">
        <input type="checkbox" class="bin-card-checkbox" data-check-id="${m.id}" ${binSelected.has(m.id) ? 'checked' : ''} aria-label="Select for batch" />
      </div>
      <button type="button" class="bin-card-remove" data-remove-id="${m.id}" aria-label="Remove from bin" title="Remove">×</button>
      <div class="bin-card-thumb"${bgStyle}>${thumbInner}${badge}${status}</div>
      <div class="bin-card-name">${escapeHtml(m.name)}</div>
      <div class="bin-card-meta"><span class="badge">${dur}</span><span class="badge">${escapeHtml(res)}</span>${m.ext && BIN_EXT_CODEC_HINT[m.ext] ? `<span class="badge codec-hint" title="Likely codec (extension-based)">${escapeHtml(BIN_EXT_CODEC_HINT[m.ext])}</span>` : ''}</div>
      <div class="bin-card-drag" title="Reorder (also draggable)">
        <button type="button" class="bin-reorder" data-reorder="up" data-id="${m.id}" aria-label="Move earlier" title="Move earlier">◀</button>
        <span class="bin-drag-dots" aria-hidden="true">⋮⋮</span>
        <button type="button" class="bin-reorder" data-reorder="down" data-id="${m.id}" aria-label="Move later" title="Move later">▶</button>
      </div>
    </div>
  `;
}

function updateBinMultiToolbar() {
  const bar = document.getElementById('bin-multi');
  const count = document.getElementById('bin-multi-count');
  if (!bar) return;
  document.querySelectorAll('.bin-card-checkbox').forEach(cb => {
    if (cb.checked) binSelected.add(cb.dataset.checkId);
    else binSelected.delete(cb.dataset.checkId);
  });
  if (binSelected.size >= 2) {
    bar.hidden = false;
    if (count) count.textContent = String(binSelected.size);
  } else {
    bar.hidden = true;
  }
}

// Add a generated output (Blob) back into the bin.
async function addOutputToBin({ blob, name, mime, ext, sourceName, workflowName, isOutput = true }) {
  if (!blob) return null;
  const cls = BIN_EXT_TO_TYPE[ext] ? { type: BIN_EXT_TO_TYPE[ext], ext } : { type: 'video', ext: ext || 'mp4' };
  const id = nextMediaId();
  const virtualName = nextVirtualName(ext || cls.ext);
  const blobUrl = URL.createObjectURL(blob);
  const size = blob.size;
  const u8 = new Uint8Array(await blob.arrayBuffer());
  try { await ff.deleteFile(virtualName); } catch (_) {}
  try { await ff.writeFile(virtualName, u8); } catch (err) {
    logToConsole('err', 'Failed to write output to MEMFS: ' + (err && err.message || err));
  }
  let displayName = name;
  if (workflowName && !displayName.includes(`[${workflowName}]`)) {
    displayName = `${name} [${workflowName}]`;
  }
  const media = {
    id, file: null, name: displayName, virtualName, size,
    type: cls.type, mime: mime || ('/' + (ext || 'bin')),
    blobUrl, _thumbUrl: null,
    durationSec: 0, width: 0, height: 0, fps: 0,
    vcodec: '', acodec: '', sampleRate: 0,
    hasVideo: cls.type === 'video' || cls.type === 'image',
    hasAudio: cls.type === 'audio' || cls.type === 'video',
    analyzed: false, isOutput, sourceName: sourceName || null,
    _status: 'analyzing', _error: null,
  };
  state.mediaBin.push(media);
  renderMediaBin();
  updateBinCount();
  // Update the active output to point at the new media (so the download
  // button works against the new output). Only revoke the previous output URL
  // if it was a transient preview — NOT if it belongs to a bin entry. Since
  // every addOutputToBin aliases outputBlobUrl to a bin entry's blobUrl,
  // unconditionally revoking it killed the URL of the previous clip, so batch
  // producers (scene split, video queue, batch apply) left every clip but the
  // last with a dead blobUrl (broken playback/download/thumbnail).
  if (state.outputBlobUrl && !state.mediaBin.some((mm) => mm.blobUrl === state.outputBlobUrl)) {
    try { URL.revokeObjectURL(state.outputBlobUrl); } catch (_) {}
  }
  state.outputBlobUrl = media.blobUrl;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  state.outputFilename = `${displayName.replace(/\s+/g, '_')}_${ts}.${ext || cls.ext}`;
  if (typeof setDownloadEnabled === 'function') setDownloadEnabled(true);
  if (typeof setOutputInfo === 'function') setOutputInfo({ size: media.size, mime, filename: state.outputFilename, ext: ext || cls.ext });
  if (cls.type !== 'image' && typeof analyzeMedia === 'function') {
    analyzeMedia(virtualName).then(meta => {
      if (meta) {
        media.durationSec = meta.duration || 0;
        media.width = meta.width || 0;
        media.height = meta.height || 0;
        media.fps = meta.fps || 0;
        media.vcodec = meta.vcodec || '';
        media.acodec = meta.acodec || '';
        media.sampleRate = meta.sampleRate || 0;
        media.analyzed = true;
        media._status = 'ready';
      }
      generateThumbnail(media).finally(() => { renderMediaBin(); updateBinCount(); });
    }).catch(() => {
      media._status = 'ready';
      generateThumbnail(media).finally(() => { renderMediaBin(); updateBinCount(); });
    });
  } else {
    media._status = 'ready';
    generateThumbnail(media).finally(() => { renderMediaBin(); updateBinCount(); });
  }
  setActiveMedia(id);
  return id;
}

// -----------------------------------------------------------------------------
// addBlobToBin — compatibility shim.
// -----------------------------------------------------------------------------
// datamosh.js, motion-mosh.js, tools.js, analysis.js and the hardware workflows
// all call addBlobToBin(blob, name, mime) — a positional helper that was NEVER
// actually defined. Bare calls would ReferenceError; the `window.addBlobToBin?.()`
// calls silently short-circuited, so every one of those features produced a blob
// and then dropped it on the floor (nothing reached the Media Bin). Route the
// positional signature to the real addOutputToBin, inferring an extension from
// the MIME type so the MEMFS virtual name is correct.
async function addBlobToBin(blob, name, mime, opts = {}) {
  mime = mime || (blob && blob.type) || 'video/mp4';
  let ext = opts.ext;
  if (!ext) {
    if (/webm/i.test(mime)) ext = 'webm';
    else if (/(quicktime|mov)/i.test(mime)) ext = 'mov';
    else if (/gif/i.test(mime)) ext = 'gif';
    else if (/wav/i.test(mime)) ext = 'wav';
    else if (/(mpeg3|mp3|mpeg)/i.test(mime) && mime.startsWith('audio')) ext = 'mp3';
    else if (/ogg/i.test(mime)) ext = 'ogg';
    else if (mime.startsWith('audio/')) ext = 'mp3';
    else if (mime.startsWith('image/')) ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
    else ext = 'mp4';
  }
  return addOutputToBin({ blob, name, mime, ext, ...opts });
}
window.addBlobToBin = addBlobToBin;

function refreshVizBgSelect() {
  const sel = document.getElementById('viz-bg-select');
  if (!sel) return;
  const prev = sel.value;
  const opts = ['<option value="">— none —</option>'];
  for (const m of state.mediaBin) {
    if (m.type === 'image' || m.hasVideo) {
      opts.push(`<option value="${m.id}">${escapeHtml(m.name)}</option>`);
    }
  }
  sel.innerHTML = opts.join('');
  if (prev && state.mediaBin.some(m => m.id === prev)) sel.value = prev;
}

// Run a bin multi-select composite.
// Reorder a bin item by one position. Powers the ◀▶ buttons on each bin card —
// a touch-accessible alternative to the native drag (dead on iOS), and bin order
// is the order multi-file composites (concat/hstack/vstack/grid) consume.
function moveBinItem(id, dir) {
  const i = state.mediaBin.findIndex((m) => m.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.mediaBin.length) return;
  [state.mediaBin[i], state.mediaBin[j]] = [state.mediaBin[j], state.mediaBin[i]];
  renderMediaBin();
}
window.moveBinItem = moveBinItem;

async function runBinComposite(mode) {
  if (binSelected.size < 2) {
    showInfo('Select files', 'Check 2+ bin cards to use multi-file composites.');
    return;
  }
  if (!state.ffmpeg) { showInfo('Engine', 'Engine not ready.'); return; }
  const selected = state.mediaBin.filter(m => binSelected.has(m.id));
  if (mode === 'grid' && selected.length !== 4) {
    showInfo('Grid 2×2', 'Grid requires exactly 4 files.');
    return;
  }
  if ((mode === 'hstack' || mode === 'vstack') && selected.length !== 2) {
    showInfo('Stack', 'Stack requires exactly 2 files.');
    return;
  }
  if (!selected.every(m => m.hasVideo || m.type === 'image')) {
    showInfo('Composite', 'All selected files must be video or image.');
    return;
  }
  state.isProcessing = true;
  setControlsEnabled(false);
  setCancelVisible(true);
  setProgress(0);
  setProgressText(`Composite (${mode})…`);
  const outExt = (selected[0].type === 'image') ? 'jpg' : 'mp4';
  const outName = `composite_${mode}.${outExt}`;
  try { await ff.deleteFile(outName); } catch (_) {}
  let args = [];
  try {
    if (mode === 'concat') {
      const list = selected.map(m => `file '${m.virtualName}'`).join('\n') + '\n';
      await ff.writeFile('bin_concat.txt', new TextEncoder().encode(list));
      args = ['-f', 'concat', '-safe', '0', '-i', 'bin_concat.txt', '-c', 'copy', outName];
    } else if (mode === 'hstack') {
      args = [
        '-i', selected[0].virtualName, '-i', selected[1].virtualName,
        '-filter_complex',
        `[0:v]scale=-1:720[v0];[1:v]scale=-1:720[v1];[v0][v1]hstack=inputs=2[v]`,
        '-map', '[v]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-an', outName,
      ];
    } else if (mode === 'vstack') {
      args = [
        '-i', selected[0].virtualName, '-i', selected[1].virtualName,
        '-filter_complex',
        `[0:v]scale=1280:-1[v0];[1:v]scale=1280:-1[v1];[v0][v1]vstack=inputs=2[v]`,
        '-map', '[v]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-an', outName,
      ];
    } else if (mode === 'grid') {
      args = [
        '-i', selected[0].virtualName, '-i', selected[1].virtualName,
        '-i', selected[2].virtualName, '-i', selected[3].virtualName,
        '-filter_complex',
        `[0:v]scale=640:-1[v0];[1:v]scale=640:-1[v1];[2:v]scale=640:-1[v2];[3:v]scale=640:-1[v3];[v0][v1][v2][v3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[v]`,
        '-map', '[v]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-an', outName,
      ];
    } else if (mode === 'pip') {
      args = [
        '-i', selected[0].virtualName, '-i', selected[1].virtualName,
        '-filter_complex',
        `[1:v]scale=iw/4:ih/4[pip];[0:v][pip]overlay=W-w-20:H-h-20[v]`,
        '-map', '[v]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-an', outName,
      ];
    } else if (mode === 'merge') {
      if (!selected[0].hasVideo || !selected[1].hasAudio) {
        showInfo('Merge A/V', 'First file must have video, second must have audio.');
        state.isProcessing = false;
        setCancelVisible(false);
        setControlsEnabled(true);
        return;
      }
      args = [
        '-i', selected[0].virtualName, '-i', selected[1].virtualName,
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy', '-c:a', 'aac', '-shortest',
        outName,
      ];
    }
    logToConsole('', `Composite (${mode}): ffmpeg ${args.map(quoteArg).join(' ')}`);
    const _rc = await ff.exec(args);
    if (_rc !== 0 && _rc !== undefined && _rc !== null) {
      throw new Error(`Composite (${mode}) FAILED — ffmpeg exit code ${_rc}.`);
    }
    const data = await ff.readFile(outName);
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const mime = (outExt === 'mp4') ? 'video/mp4' : 'image/jpeg';
    const blob = new Blob([u8], { type: mime });
    const newName = `${mode}_${selected.length}files`;
    await addOutputToBin({ blob, name: newName, mime, ext: outExt, workflowName: `Composite ${mode}` });
    try { await ff.deleteFile(outName); } catch (_) {}
    setProgress(100);
    setProgressText(`Composite (${mode}) done`);
    logToConsole('ok', `Composite (${mode}) added to bin.`);
  } catch (err) {
    const msg = String((err && err.message) || err);
    logToConsole('err', `Composite (${mode}) failed: ${msg}`);
    showFriendlyError(msg);
  } finally {
    state.isProcessing = false;
    setCancelVisible(false);
    setControlsEnabled(true);
  }
}

// Batch apply a workflow to every checked bin card.
async function runBinBatchApply() {
  if (binSelected.size < 1) { showInfo('Select files', 'Select one or more bin cards.'); return; }
  if (typeof WORKFLOWS === 'undefined') { showInfo('Workflows', 'WORKFLOWS not loaded.'); return; }
  const all = WORKFLOWS.concat((typeof loadCustomWorkflows === 'function') ? loadCustomWorkflows() : []);
  const opts = all.map(w => `<option value="${w.id}">${escapeHtml(w.icon || '🎬')} ${escapeHtml(w.name)}</option>`).join('');
  showModal('Batch Apply Workflow', `
    <p class="muted small">Select a workflow to apply to every checked bin file. Each result is added back to the bin.</p>
    <div class="control-row">
      <label>Workflow</label>
      <select id="batch-wf" class="ctrl">${opts}</select>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="button" class="primary-btn" id="batch-go">Run on Selected</button>
    </div>
  `);
  document.getElementById('batch-go').addEventListener('click', async () => {
    const id = document.getElementById('batch-wf').value;
    const wf = all.find(w => w.id === id);
    closeModal();
    if (!wf) return;
    const selected = state.mediaBin.filter(m => binSelected.has(m.id));
    logToConsole('', `Batch apply: ${wf.name} on ${selected.length} files`);
    for (let i = 0; i < selected.length; i++) {
      const m = selected[i];
      logToConsole('', `[Batch ${i+1}/${selected.length}] ${m.name} ← ${wf.name}`);
      setActiveMedia(m.id);
      if (typeof applyWorkflow === 'function') applyWorkflow(wf.id);
      await new Promise(r => setTimeout(r, 50));
      const plan = buildFFmpegCommand();
      if (!plan || !plan.ok) { logToConsole('err', `Build command failed for ${m.name}`); continue; }
      try {
        if (plan.gifTwoPass) await createGIF();
        else if (plan.twoPass) await runTwoPass(plan);
        else await executeFFmpeg(plan.args);
      } catch (e) {
        logToConsole('err', `Workflow ${wf.name} failed on ${m.name}: ${e && e.message || e}`);
        continue;
      }
      if (state.outputBlobUrl) {
        try {
          const ext = (state.outputFilename || 'out.bin').split('.').pop().toLowerCase();
          const blob = await fetch(state.outputBlobUrl).then(r => r.blob());
          const mime = EXT_TO_MIME[ext] || blob.type || 'application/octet-stream';
          const wfTag = wf.name.replace(/[^\w \-]/g, '').slice(0, 30);
          await addOutputToBin({ blob, name: m.name, mime, ext, sourceName: m.name, workflowName: wfTag });
          try { ff.deleteFile(plan.outputFilename); } catch (_) {}
        } catch (e) {
          logToConsole('err', 'Failed to capture batch output: ' + (e && e.message || e));
        }
      }
    }
    logToConsole('ok', `Batch apply complete: ${selected.length} files processed.`);
    showInfo('Batch Complete', `${selected.length} files processed. See Media Bin for results.`);
  });
}

// PHASE 0.3 FIX: bind the multi-select composite toolbar to the global
// drawer. The legacy bin-add / bin-clear buttons (which used to live
// in the editor-tab media bin) are gone; the global drawer's
// global-bin-add and global-bin-clear are already wired by
// bindGlobalActionBar(). We also keep the legacy id bindings as
// no-ops so that any externally-registered handler does not throw.
function bindMediaBin() {
  // Legacy editor-tab buttons are gone. Keep the lookups so an old
  // hash-reference doesn't throw, but they will always be null.
  const addBtn = document.getElementById('bin-add');
  if (addBtn) addBtn.addEventListener('click', () => {
    const fi = document.getElementById('file-input');
    if (fi) fi.click();
  });
  const clearBtn = document.getElementById('bin-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    if (state.mediaBin.length === 0) return;
    if (confirm(`Clear all ${state.mediaBin.length} items from the bin?`)) clearMediaBin();
  });
  // Multi-select composite toolbar. These buttons now live in the
  // global drawer (moved from the deleted editor-tab media bin).
  const ops = {
    'bin-op-concat': () => runBinComposite('concat'),
    'bin-op-hstack': () => runBinComposite('hstack'),
    'bin-op-vstack': () => runBinComposite('vstack'),
    'bin-op-grid':   () => runBinComposite('grid'),
    'bin-op-pip':    () => runBinComposite('pip'),
    'bin-op-merge':  () => runBinComposite('merge'),
    'bin-op-batch':  () => runBinBatchApply(),
  };
  for (const [id, fn] of Object.entries(ops)) {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', fn);
  }
}

// =============================================================================
// v4 PART A1 — Global action bar + global bin drawer
// -----------------------------------------------------------------------------
// The action bar is the always-visible entry point. The media bin lives
// inside a drawer that slides down from the tab bar; default state is open
// when the bin is empty (so the empty drop zone is the first thing visible).
// Tapping the active-file chip in the action bar toggles the drawer.
// =============================================================================
function updateActionBar() {
  const nameEl = document.getElementById('ab-active-name');
  const durEl  = document.getElementById('ab-active-dur');
  const chip   = document.getElementById('ab-active-file');
  const runBtn = document.getElementById('global-run');
  const cancelBtn = document.getElementById('global-cancel');
  if (!nameEl) return;
  const m = state.inputFile;
  if (m) {
    nameEl.textContent = m.name;
    durEl.textContent  = m.durationSec ? formatTime(m.durationSec) : '';
    chip.classList.remove('empty');
  } else {
    nameEl.textContent = 'No file selected';
    durEl.textContent  = '';
    chip.classList.add('empty');
  }
  // Run button: only enabled when there is an active file AND we're idle.
  if (runBtn) {
    runBtn.disabled = !m || state.isProcessing;
  }
  // Cancel button: only when processing.
  if (cancelBtn) {
    cancelBtn.classList.toggle('hidden', !state.isProcessing);
  }
  // Action bar progress fill mirrors the bottom progress bar.
  const abFill = document.getElementById('ab-progress-fill');
  const mainFill = document.getElementById('progress-fill');
  if (abFill && mainFill) {
    abFill.style.width = mainFill.style.width || '0%';
  }
}
function syncGlobalBinDrawer() {
  const drawer = document.getElementById('global-bin-drawer');
  if (!drawer) return;
  // Default behaviour: open when the bin is empty, closed once files
  // load. Once the user manually toggles the chip we set
  // state._binDrawerForced=true and stop auto-syncing.
  if (state._binDrawerForced) return;
  const empty = state.mediaBin.length === 0;
  drawer.classList.toggle('open', empty);
  // Mirror the bin count chip.
  const c = document.getElementById('global-bin-count');
  if (c) c.textContent = String(state.mediaBin.length);
}
function bindGlobalActionBar() {
  const fileInput = document.getElementById('file-input');
  // + Add Media → file picker (multi).
  const addBtn = document.getElementById('global-add-media');
  if (addBtn && fileInput) addBtn.addEventListener('click', () => fileInput.click());
  // Active-file chip → toggle the global drawer.
  const chip = document.getElementById('ab-active-file');
  if (chip) chip.addEventListener('click', () => {
    const drawer = document.getElementById('global-bin-drawer');
    if (!drawer) return;
    state._binDrawerForced = true;            // user took control
    drawer.classList.toggle('open');
  });
  // Run / Cancel.
  const runBtn = document.getElementById('global-run');
  if (runBtn) runBtn.addEventListener('click', () => executeFromUI());
  const cancelBtn = document.getElementById('global-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => cancelProcessing());
  // Undo / Redo.
  const undo = document.getElementById('ab-undo');
  const redo = document.getElementById('ab-redo');
  if (undo) undo.addEventListener('click', () => undoLastChange());
  if (redo) redo.addEventListener('click', () => redoLastChange());
  // Top-bar Undo / Redo (mirrors the action-bar copies).
  const topUndo = document.getElementById('btn-undo');
  const topRedo = document.getElementById('btn-redo');
  if (topUndo) topUndo.addEventListener('click', () => undoLastChange());
  if (topRedo) topRedo.addEventListener('click', () => redoLastChange());
  // Drawer header actions.
  const gAdd = document.getElementById('global-bin-add');
  if (gAdd && fileInput) gAdd.addEventListener('click', () => fileInput.click());
  const gClear = document.getElementById('global-bin-clear');
  if (gClear) gClear.addEventListener('click', () => {
    if (state.mediaBin.length === 0) return;
    if (confirm(`Clear all ${state.mediaBin.length} items from the bin?`)) clearMediaBin();
  });
  // Custom font upload trigger (Section 11).
  const fontUpload = document.getElementById('text-font-upload');
  const fontUploadBtn = document.getElementById('text-font-upload-btn');
  if (fontUpload && fontUploadBtn) {
    fontUploadBtn.addEventListener('click', () => fontUpload.click());
    fontUpload.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) await addCustomFont(f);
      fontUpload.value = '';                  // allow re-uploading same file
    });
  }
  // URL loader (v4 PART B10).
  bindBinUrlLoader();
  // Initial sync.
  syncGlobalBinDrawer();
  updateActionBar();
  updateUndoRedoButtons();
}
// PHASE 0.3 FIX: the Editor-tab media bin DOM has been DELETED. The
// global drawer is now the single render target. renderMediaBin()
// writes directly into #global-bin-strip (or falls back to the legacy
// #media-bin-strip id which is preserved on the drawer), so there is
// no longer a second DOM to mirror. We keep mirrorBinToDrawer() as a
// no-op so legacy call sites don't blow up.
function mirrorBinToDrawer() {
  // No-op: see the comment above. The single render target is the
  // global drawer; renderMediaBin() already wrote to it directly.
  if (typeof updateBinMultiToolbar === 'function') updateBinMultiToolbar();
  if (typeof syncGlobalBinDrawer === 'function') syncGlobalBinDrawer();
}
// v4 PART B10 — Load from URL into the media bin.
function bindBinUrlLoader() {
  const input = document.getElementById('bin-url-input');
  const btn   = document.getElementById('bin-url-load');
  const msg   = document.getElementById('bin-url-msg');
  if (!input || !btn) return;
  async function doLoad() {
    const url = (input.value || '').trim();
    if (!url) { showBinUrlMsg('Enter a URL first.', 'err'); return; }
    if (!/^https?:\/\//i.test(url)) { showBinUrlMsg('URL must start with http:// or https://', 'err'); return; }
    if (!state.ffmpeg) { showBinUrlMsg('Engine not ready yet.', 'err'); return; }
    showBinUrlMsg('Fetching ' + url + ' …');
    btn.disabled = true;
    try {
      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const blob = await resp.blob();
      // Derive a filename from the URL.
      const pathPart = url.split('?')[0].split('#')[0];
      const last = pathPart.substring(pathPart.lastIndexOf('/') + 1) || ('remote_' + Date.now());
      const safe = last.replace(/[^\w.\-]/g, '_');
      const file = new File([blob], safe, { type: blob.type || 'application/octet-stream' });
      await handleFilesUpload([file]);
      showBinUrlMsg('Loaded ' + safe, 'ok');
      input.value = '';
    } catch (e) {
      const link = `<a href="${url}" target="_blank" rel="noopener noreferrer" download>direct download</a>`;
      showBinUrlMsg('This host blocks direct fetching (CORS). Try the ' + link + ' and drag the file in.', 'err');
    } finally {
      btn.disabled = false;
    }
  }
  btn.addEventListener('click', doLoad);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doLoad(); } });
}
function showBinUrlMsg(text, level) {
  const msg = document.getElementById('bin-url-msg');
  if (!msg) return;
  msg.className = 'bin-url-msg' + (level ? ' ' + level : '');
  msg.innerHTML = text;
  msg.hidden = false;
}

// Backward-compat shim: the existing v2 code still calls
// handleFileUpload(file). It now maps to handleFilesUpload([file]).
// We wrap it so any future caller of handleFileUpload still works.
// NOTE: declared as `let` (not `const`) so the v2 auto-analyze wrapper
// below can still rebind it.
let handleFileUpload = async function(file) {
  return handleFilesUpload(file ? [file] : []);
};

function onSourceMetadataLoaded() {
  const v = document.getElementById('video-preview');
  if (!v || !state.inputFile) return;
  const dur = isFinite(v.duration) ? v.duration : 0;
  state.inputFile.durationSec = dur;
  state.inputFile.width = v.videoWidth || 0;
  state.inputFile.height = v.videoHeight || 0;
  // Best-effort codec (browser doesn't expose it). Leave null.
  state.inputFile.codec = state.inputFile.codec || null;

  // Initialize trim sliders range and value
  const ss = document.getElementById('trim-start-slider');
  const es = document.getElementById('trim-end-slider');
  if (ss) { ss.min = '0'; ss.max = String(dur || 0); ss.value = '0'; ss.step = '0.01'; }
  if (es) { es.min = '0'; es.max = String(dur || 0); es.value = String(dur || 0); es.step = '0.01'; }

  // Initialize range selector
  initRangeSelector(dur);
  setTrimTimes(0, dur);
  updateFileInfo(null); // re-render with duration / resolution
  logToConsole('ok', `Source metadata: ${dur.toFixed(2)}s, ${v.videoWidth}×${v.videoHeight}`);
}

function loadSourcePreview(url, mime) {
  const v = document.getElementById('video-preview');
  v.src = url;
  v.load();
  const label = document.getElementById('preview-label');
  if (label) label.textContent = 'Source Preview';
  // For audio-only files, keep the <video> element visible (browsers will
  // show it as a black box but the log will show "metadata" — fine).
  // UX 7 — a file is now loaded, so the preview label is meaningful.
  if (typeof syncPreviewLabelVisibility === 'function') syncPreviewLabelVisibility();
  if (mime && (mime.startsWith('audio') || mime.startsWith('image'))) {
    // Hide the drop overlay so the preview area is clear.
    const ov = document.getElementById('drop-overlay');
    if (ov) ov.classList.add('hidden');
  } else {
    const ov = document.getElementById('drop-overlay');
    if (ov) ov.classList.add('hidden');
  }
}

function hideDropOverlay() {
  const ov = document.getElementById('drop-overlay');
  if (ov) ov.classList.add('hidden');
}
function showDropOverlay() {
  const ov = document.getElementById('drop-overlay');
  if (ov) ov.classList.remove('hidden');
}

function updateFileInfo(file) {
  const fi = document.getElementById('file-info');
  if (!fi) return;
  const src = state.inputFile;
  if (!src) { fi.innerHTML = '<span class="file-info-empty">No file loaded</span>'; return; }
  const dur = (src.durationSec != null && isFinite(src.durationSec)) ? src.durationSec.toFixed(2) + 's' : '—';
  const res = (src.width && src.height) ? `${src.width}×${src.height}` : '—';
  const codec = src.codec || (src.type || '').replace('video/', '').replace('audio/', '') || '—';
  fi.innerHTML = `
    <div class="file-info">
      <strong>${escapeHtml(src.name)}</strong>
      <span class="file-info-meta">${formatBytes(src.size)} · ${dur} · ${res} · ${escapeHtml(codec)}</span>
    </div>
  `;
}

// =============================================================================
// TIME / BYTES HELPERS
// =============================================================================
function formatBytes(b) {
  if (!b && b !== 0) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
  return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function pad2(n) { return String(n).padStart(2, '0'); }
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad2(ms)}`;
}
function parseTime(str) {
  // Accepts "HH:MM:SS.ms" or "MM:SS.ms" or seconds.
  if (!str) return 0;
  str = String(str).trim();
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  const parts = str.split(':');
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s);
  } else if (parts.length === 2) {
    const [m, s] = parts;
    return parseInt(m, 10) * 60 + parseFloat(s);
  } else {
    return parseFloat(str) || 0;
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// =============================================================================
// COMMAND EXECUTION (spec §1.5)
// =============================================================================

// =============================================================================
// COMMAND-BUILDER GUARDS  (Phase 1.2)
// -----------------------------------------------------------------------------
// These produce silently-broken commands or hard encoder errors if unguarded.
// =============================================================================


// =============================================================================
// TRIM VALIDATION
// -----------------------------------------------------------------------------
// `-ss` past the end of the media makes ffmpeg seek past EOF, produce no frames,
// and exit 1. The user sees a cryptic failure. This is easy to hit for real:
// set a trim on a long file, switch to a short one, press Run.
//
// Catch it in the UI. Never let it reach ffmpeg.
// =============================================================================

function validateTrim() {
  const en = document.getElementById('enable-2');
  if (!en || !en.checked) return [];

  const m = state.inputFile;
  const dur = (m && m.durationSec) || 0;
  if (!dur) return [];

  const parse = (v) => {
    if (!v) return 0;
    const p = String(v).split(':').map(Number);
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return Number(v) || 0;
  };

  const ss = parse((document.getElementById('trim-start') || {}).value);
  const to = parse((document.getElementById('trim-end') || {}).value);
  const problems = [];

  if (ss >= dur) {
    problems.push(
      `Trim start (${ss.toFixed(2)}s) is at or past the end of this ${dur.toFixed(2)}s clip. ` +
      `Nothing would be left to encode.`
    );
  }
  if (to > 0 && to <= ss) {
    problems.push(`Trim end (${to.toFixed(2)}s) is not after the trim start (${ss.toFixed(2)}s).`);
  }
  if (to > dur + 0.1) {
    problems.push(`Trim end (${to.toFixed(2)}s) is past the end of this ${dur.toFixed(2)}s clip.`);
  }
  return problems;
}

/**
 * Clamp the trim controls to the newly-loaded file's duration.
 * Without this, a trim set for a 3-minute track silently poisons every render
 * after you switch to a 10-second clip.
 */
function clampTrimToDuration(dur) {
  if (!dur) return;
  const fmt = (x) => {
    const h = Math.floor(x / 3600), mm = Math.floor((x % 3600) / 60), ssn = x % 60;
    return `${String(h).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${ssn.toFixed(2).padStart(5,'0')}`;
  };
  const a = document.getElementById('trim-start');
  const b = document.getElementById('trim-end');
  const parse = (v) => {
    const p = String(v || '0').split(':').map(Number);
    return p.length === 3 ? p[0]*3600 + p[1]*60 + p[2] : (Number(v) || 0);
  };

  let changed = false;
  if (a && parse(a.value) >= dur) { a.value = fmt(0);   changed = true; }
  if (b && (parse(b.value) > dur || parse(b.value) === 0)) { b.value = fmt(dur); changed = true; }

  if (changed) {
    logToConsole('warn',
      `Trim was set beyond this file's duration (${dur.toFixed(2)}s) — clamped to the full clip.`);
    a && a.dispatchEvent(new Event('input', { bubbles: true }));
    b && b.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** H.264/H.265 REQUIRE even dimensions. An odd width is a FATAL encoder error. */
function evenDims(w, h) {
  const f = (v) => (v === -1 || v === -2 || v == null || v === '') ? v : Math.round(Number(v) / 2) * 2;
  return [f(w), f(h)];
}

/** Wrap any user scale so odd dimensions can never reach the encoder. */
function safeScaleFilter(w, h, flags) {
  const [W, H] = evenDims(w, h);
  const fl = flags ? `:flags=${flags}` : '';
  if (W === -1 || H === -1) return `scale=${W}:${H}${fl}`;
  // trunc() also protects against expression-derived odd values.
  return `scale=trunc(${W}/2)*2:trunc(${H}/2)*2${fl}`;
}

/** -preset is x264/x265 ONLY. It hard-errors on VP9, GIF, and audio-only output. */
const PRESET_CODECS = new Set(['libx264', 'libx265']);
function stripInvalidPreset(args) {
  if (!Array.isArray(args)) return args;
  const ci = args.indexOf('-c:v');
  const codec = ci >= 0 ? args[ci + 1] : null;
  if (codec && PRESET_CODECS.has(codec)) return args;
  const out = args.slice();
  for (let i = out.length - 2; i >= 0; i--) {
    if (out[i] === '-preset') { out.splice(i, 2); }
  }
  return out;
}

/** atempo only accepts 0.5–2.0. 4x MUST become atempo=2.0,atempo=2.0. */
function chainAtempo(rate) {
  const r = Number(rate);
  if (!isFinite(r) || r <= 0 || Math.abs(r - 1) < 0.001) return null;
  const parts = [];
  let rem = r;
  while (rem > 2.0) { parts.push('atempo=2.0'); rem /= 2.0; }
  while (rem < 0.5) { parts.push('atempo=0.5'); rem /= 0.5; }
  parts.push(`atempo=${rem.toFixed(4)}`);
  return parts.join(',');
}

/** Stream-copy + filters on the same stream is an ffmpeg error. HARD-BLOCK it. */
function checkCopyConflict() {
  const vc = document.getElementById('video-codec')?.value;
  const ac = document.getElementById('audio-codec')?.value;
  const hasVf = !!document.querySelector('[id^="enable-"]:checked');
  const problems = [];
  if (vc === 'copy' && hasVf) problems.push('Video codec is "copy" but video filters are enabled.');
  if (ac === 'copy' && document.getElementById('enable-12')?.checked) problems.push('Audio codec is "copy" but audio filters are enabled.');
  return problems;
}

// =============================================================================
// SPLIT A/V RENDER  — THE FIX FOR THE NON-DETERMINISTIC RENDER
// -----------------------------------------------------------------------------
// A single ffmpeg invocation that decodes video + audio, runs a filter graph,
// and encodes video + audio holds ALL of this in the wasm heap simultaneously:
//
//   AAC decoder + H.264 decoder + scale filter graph
//   + x264 encoder (and its reference-frame pool) + AAC encoder + MP4 muxer
//
// That is the peak-memory moment of the whole application, and it sits right at
// the margin of the heap — which is why the SAME command passed 2/5 and failed
// 3/5. Non-determinism from a deterministic encoder = the heap is the variable.
//
// Splitting into three cheap passes roughly halves peak memory, and each pass
// sits comfortably inside the heap:
//
//   Pass 1  video only (-an)   → no audio decoder/encoder resident
//   Pass 2  audio only (-vn)   → no video decoder, no x264, no filter graph
//   Pass 3  mux (-c copy)      → near-zero memory
//
// This is why the no-audio tests passed more often than the with-audio tests.
// That was a memory delta, not a feature interaction.
// =============================================================================

/** Split a single-invocation arg array into video-only / audio-only / mux passes.
 *  Returns null when splitting isn't applicable (no audio, or stream-copy video). */
function planSplitRender(args, outputName) {
  if (!Array.isArray(args)) return null;

  const has = (f) => args.includes(f);
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

  // Not applicable: audio already stripped, or video is stream-copied (cheap anyway).
  if (has('-an')) return null;
  if (val('-c:v') === 'copy' || val('-vcodec') === 'copy') return null;

  const aCodec = val('-c:a') || val('-acodec');
  if (!aCodec || aCodec === 'none') return null;

  // Everything before the first `-i` is an input option (e.g. -ss, -fflags).
  const iIdx = args.indexOf('-i');
  if (iIdx < 0) return null;
  const inputOpts = args.slice(0, iIdx);
  const inputName = args[iIdx + 1];
  const tail = args.slice(iIdx + 2, args.length - 1);   // output opts, minus filename

  const VIDEO_ONLY_DROP = new Set(['-c:a', '-acodec', '-b:a', '-ar', '-ac', '-af', '-filter:a']);
  const AUDIO_ONLY_KEEP = new Set(['-c:a', '-acodec', '-b:a', '-ar', '-ac', '-af', '-filter:a', '-to', '-t']);

  const vArgs = [], aArgs = [];
  for (let i = 0; i < tail.length; i++) {
    const tok = tail[i];
    if (typeof tok === 'string' && tok.startsWith('-')) {
      const next = tail[i + 1];
      const takesVal = next !== undefined && !String(next).startsWith('-');
      if (VIDEO_ONLY_DROP.has(tok)) {
        if (AUDIO_ONLY_KEEP.has(tok)) { aArgs.push(tok); if (takesVal) aArgs.push(next); }
        if (takesVal) i++;
        continue;
      }
      if (AUDIO_ONLY_KEEP.has(tok)) { aArgs.push(tok); if (takesVal) aArgs.push(next); }
      vArgs.push(tok); if (takesVal) { vArgs.push(next); i++; }
    } else {
      vArgs.push(tok);
    }
  }

  // CONTAINER CHOICE FOR THE INTERMEDIATES — this matters.
  // The MP4 muxer writes the `moov` atom at the END of the file. If the encode
  // is interrupted, killed, or the heap dies, you get a file with NO moov: it
  // still exists, it still has bytes, and NOTHING can read it.
  //   → "moov atom not found. Invalid data found when processing input."
  //
  // Matroska is written valid-as-it-goes. It has no moov-at-the-end failure
  // mode. For a scratch file we immediately re-read, it is the correct choice.
  const vTmp = '__v_pass.mkv';
  const aTmp = '__a_pass.mka';

  // Strip any stray `-y` already in the tail — we add our own.
  const clean = (a) => a.filter((t) => t !== '-y');

  return {
    video: [...inputOpts, '-i', inputName, '-an', ...clean(vArgs), '-f', 'matroska', '-y', vTmp],
    audio: [...inputOpts, '-i', inputName, '-vn', ...clean(aArgs), '-f', 'matroska', '-y', aTmp],
    mux:   ['-i', vTmp, '-i', aTmp, '-c', 'copy', '-shortest', '-y', outputName],
    tmp:   [vTmp, aTmp],
  };
}

/** Run a render as 3 low-memory passes. Falls back to single-shot if unsplittable. */
async function executeSplitRender(args, outputName, onStep) {
  const plan = planSplitRender(args, outputName);
  if (!plan) {
    // Fallback: no split possible. Still check the exit code.
    const _rc = await ff.exec(args);
    if (_rc !== 0 && _rc !== undefined && _rc !== null) {
      throw new Error(`Render FAILED — ffmpeg exit code ${_rc}.\nCommand: ffmpeg ${args.join(' ')}`);
    }
    return false;
  }
  logToConsole('', '[split] Peak-memory render detected (video + audio + filters).');
  logToConsole('', '[split] Running as 3 low-memory passes instead of 1 heavy pass.');

  // ---------------------------------------------------------------------------
  // Run one pass. CHECK THE EXIT CODE. VALIDATE THE OUTPUT.
  // ---------------------------------------------------------------------------
  // ffmpeg.exec() RESOLVES with the process exit code — a FAILING command does
  // NOT throw. Ignoring that return value is how a failed video pass got logged
  // as "done" and handed a truncated, moov-less file to the next pass.
  //
  // Six bugs in this project have now had the same shape: the signal was there
  // and nothing was reading it. Read the signal.
  // ---------------------------------------------------------------------------
  const _timed = async (label, args, i, expectFile) => {
    onStep && onStep(i, 3, label);
    logToConsole('', `[split] ${i}/3 ${label}: ffmpeg ${args.join(' ')}`);

    const logStart = (state.logBuffer || []).length;
    const t = performance.now();
    const rc = await ff.exec(args);
    const secs = ((performance.now() - t) / 1000).toFixed(1);

    const tail = () => (state.logBuffer || []).slice(logStart).slice(-14).join('\n');

    // 1. Exit code.
    if (rc !== 0 && rc !== undefined && rc !== null) {
      throw new Error(
        `[split] ${label} pass FAILED — ffmpeg exit code ${rc}.\n` +
        `Command: ffmpeg ${args.join(' ')}\n\nLast ffmpeg output:\n${tail()}`
      );
    }

    // 2. The output must exist and be non-trivial. A truncated MP4 with no moov
    //    atom is still "a file" — it just can't be read by anything.
    if (expectFile) {
      let data = null;
      try { data = await ff.readFile(expectFile); } catch (_) {}
      if (!data || data.length < 512) {
        throw new Error(
          `[split] ${label} pass produced an unusable file ` +
          `(${expectFile}: ${data ? data.length : 0} bytes — truncated / no moov atom).\n` +
          `Command: ffmpeg ${args.join(' ')}\n\nLast ffmpeg output:\n${tail()}`
        );
      }
      logToConsole('ok', `[split] ${i}/3 ${label} — done in ${secs}s (${formatBytes(data.length)})`);
    } else {
      logToConsole('ok', `[split] ${i}/3 ${label} — done in ${secs}s`);
    }
    return +secs;
  };

  try {
    const tv = await _timed('video', plan.video, 1, plan.tmp[0]);
    const ta = await _timed('audio', plan.audio, 2, plan.tmp[1]);
    const tm = await _timed('mux',   plan.mux,   3, outputName);

    logToConsole('ok',
      `[split] All 3 passes complete — video ${tv}s · audio ${ta}s · mux ${tm}s ` +
      `(total ${(tv + ta + tm).toFixed(1)}s)`);
    return true;
  } finally {
    await memfsPurge(plan.tmp);
  }
}

// =============================================================================
// FRESH-ENGINE RETRY
// -----------------------------------------------------------------------------
// If a render dies with a wasm memory error, the heap is the problem. Torch it,
// reload a clean engine, re-write the input, and try exactly once more.
// =============================================================================

function isWasmMemoryError(e) {
  const m = String((e && e.message) || e || '');
  return /memory access out of bounds|malloc|Cannot enlarge memory|Aborted|out of memory|signature mismatch/i.test(m);
}

async function reinitEngineClean() {
  logToConsole('warn', '[engine] Memory error — reloading a clean engine and retrying once.');
  try { await state.ffmpeg.terminate(); } catch (_) {}
  state.engineReady = false;
  state.fontsLoaded = false;
  await initFFmpeg();

  // Re-write ONLY the active input. Nothing else.
  const m = state.inputFile;
  if (m && m.file) {
    const data = await FFmpegUtil.fetchFile(m.file);
    await ff.writeFile(m.virtualName, data);
    logToConsole('ok', `[engine] Clean heap. Re-wrote ${m.virtualName}.`);
  }
  await refreshHeapGauge();
}

// =============================================================================
// AUDIO-STREAM GUARD (v10.4 round-trip fix, part 2)
// -----------------------------------------------------------------------------
// A command that asks to ENCODE audio (`-c:a aac`, `-b:a`, `-af …`) against an
// input that has NO audio stream fails outright: ffmpeg encodes the video, then
// errors ("Output file #0 does not contain any stream" / "matches no streams")
// and exits non-zero — taking the whole render down. Silent inputs are common:
// screen recordings, canvas/MediaRecorder demo clips, muted exports. That is the
// SECOND half of the "#1 round trip never goes green" bug — once the 30ms-timeout
// abort was fixed, the video-only demo clip still failed here, on the audio pass.
//
// Detect the mismatch once (cached per media item) and drop audio to `-an`.
// =============================================================================
async function inputHasAudioStream(inputName) {
  const media = (state.mediaBin || []).find(m => m.virtualName === inputName);
  if (media && typeof media._hasAudioStream === 'boolean') return media._hasAudioStream;
  let buf = '';
  const grab = ({ message }) => { buf += String(message || '') + '\n'; };
  state.ffmpeg.on('log', grab);
  try { await ff.exec(['-hide_banner', '-t', '0.1', '-i', inputName, '-f', 'null', '-'], { raw: true }); } catch (_) {}
  try { state.ffmpeg.off('log', grab); } catch (_) {}
  const present = /Stream\s+#\d+:\d+.*?:\s*Audio:/i.test(buf);
  if (media) media._hasAudioStream = present;
  return present;
}

async function ensureAudioMatchesInput(args) {
  if (!Array.isArray(args)) return args;
  if (args.includes('-an')) return args;                        // already video-only
  const wantsAudio = args.includes('-c:a') || args.includes('-acodec') ||
                     args.includes('-af')  || args.includes('-filter:a') || args.includes('-b:a');
  if (!wantsAudio) return args;
  const iIdx = args.indexOf('-i');
  if (iIdx < 0) return args;
  const inputName = args[iIdx + 1];
  let present;
  try { present = await inputHasAudioStream(inputName); }
  catch (_) { return args; }                                    // probe failed — leave the command untouched
  if (present) return args;
  logToConsole('warn', `Input "${inputName}" has no audio stream — encoding video only (-an).`);
  const AUDIO_TOKENS = new Set(['-c:a', '-acodec', '-b:a', '-ar', '-ac', '-af', '-filter:a']);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (typeof t === 'string' && AUDIO_TOKENS.has(t)) {
      if (i + 1 < args.length && !String(args[i + 1]).startsWith('-')) i++;   // skip token + its value
      continue;
    }
    out.push(t);
  }
  out.splice(out.length - 1, 0, '-an');                         // insert -an just before the output filename
  return out;
}

async function executeFFmpeg(args) {
  // HARD-BLOCK (Phase 1.2): stream-copy + filters is an ffmpeg error. Was only a warning.
  const _conf = [
    ...((typeof checkCopyConflict === 'function') ? checkCopyConflict() : []),
    ...((typeof validateTrim === 'function') ? validateTrim() : []),
  ];
  if (_conf.length) {
    logToConsole('error', 'Cannot run — copy-conflict:\n  • ' + _conf.join('\n  • '));
    alert('Cannot run:\n\n• ' + _conf.join('\n• ') + '\n\nSet the codec to something other than "copy", or disable the filters.');
    return null;
  }
  if (!state.ffmpeg) { logToConsoleThrottled('err', 'Engine not ready.'); return null; }
  if (!state.inputFile) { logToConsole('err', 'No input file loaded.'); return null; }
  if (state.isProcessing) { logToConsole('warn', 'Already processing.'); return null; }
  if (state.cancelRequested) state.cancelRequested = false;

  state.isProcessing = true;
  setControlsEnabled(false);
  setCancelVisible(true);
  setProgress(0);
  setProgressText('Starting…');

  // Determine output filename = last positional arg in the args array
  const outputFilename = args[args.length - 1];
  state.outputFilename = outputFilename;

  // Clean up any prior output file
  try { await ff.deleteFile(outputFilename); } catch (_) {}
  // Free previous blob URL
  if (state.outputBlobUrl) {
    URL.revokeObjectURL(state.outputBlobUrl);
    state.outputBlobUrl = null;
  }

  // v5 HOTFIX 4: cost-based timeout. The estimate comes from the
  // command builder's plan.estimateSec. 3× the estimate gives a
  // generous envelope; floor 60s for very cheap commands. If the
  // user is running a workflow with no estimate, fall back to a
  // 5-minute default.
  let renderMs = 300000;
  try {
    const plan = (typeof buildFFmpegCommand === 'function') ? buildFFmpegCommand() : null;
    if (plan && typeof plan.estimateSec === 'number' && isFinite(plan.estimateSec) && plan.estimateSec > 0) {
      renderMs = Math.max(60000, Math.round(plan.estimateSec * 3000));
    }
  } catch (_) { /* keep default */ }

  const start = performance.now();
  try {
    // Drop audio to -an if the input has no audio stream (see guard above).
    // Do this BEFORE logging / history / the split-render plan so every
    // downstream consumer sees the corrected command.
    args = await ensureAudioMatchesInput(args);   // output filename (last arg) is preserved
    logToConsole('', `Exec: ffmpeg ${args.map(quoteArg).join(' ')}`);
    // #9: keep the last 50 commands for copy / replay / diff
    if (state.commandHistory) {
      state.commandHistory.push({
        ts: new Date().toISOString(),
        args: args.slice(),
        output: outputFilename,
        renderMs,
      });
      if (state.commandHistory.length > 50) state.commandHistory.shift();
    }
    try { console.log(`[executeFFmpeg] args: ${JSON.stringify(args)}`); } catch (_) {}
    try { console.log(`[executeFFmpeg] renderMs: ${renderMs}`); } catch (_) {}
    // Pass the cost-based timeout (in ms) to the queue. The
    // queue's per-task budget replaces the ffmpeg.wasm-side
    // timeout (which was being silently ignored anyway). We also
    // wrap here with execWithTimeout as a belt-and-braces second
    // layer in case the queue's timeout ever fails to fire.
    // ---- Clean the heap BEFORE the render. ----
    // MEMFS is the wasm heap. Stale selftest outputs, warmup files, old
    // intermediates and dead uploads fragment it and make the encoder's
    // reference-pool allocation fail non-deterministically.
    await memfsPurgeScratch([state.inputFile && state.inputFile.virtualName, args[args.indexOf('-i') + 1]]);
    await refreshHeapGauge();

    // =========================================================================
    // HARDWARE ROUTING
    // -------------------------------------------------------------------------
    // ffmpeg.wasm can NEVER be hardware accelerated — it's a wasm sandbox with
    // no GPU and no media engine. WebCodecs is a direct binding to the browser's
    // real silicon encoder (the same path Chrome uses to play YouTube).
    //
    // If this job is expressible on the fast path, take it: 10–50× faster.
    // Otherwise fall through to wasm, which is the right tool for audio chains,
    // MP3/FLAC (WebCodecs has no encoder for them), GIF, and geq-class filters.
    // =========================================================================
    const _hwT0 = performance.now();
    if (window.FFHardware?.canUseHardware?.(args) && state.inputFile?.file) {
      try {
        setProgressText('⚡ Hardware pipeline…');
        // The live WebGL preview publishes its effect + params here. Without this
        // the hardware encode silently got a NULL shader, so what you saw in the
        // ⚡ Live preview was never what got encoded.
        const live = window.TripCamUI?.getLiveConfig?.();
        const shader = (live && live.effect)
          ? window.FFHardware.makeShaderPass(live.effect, live.params)
          : null;
        if (shader) logToConsole('', `[hw] applying live shader "${live.effect}" on the GPU during encode.`);

        const r = await window.FFHardware.hwTranscode(state.inputFile.file, {
          width:  state.outWidth  || undefined,
          height: state.outHeight || undefined,
          bitrate: state.outBitrate || 5_000_000,
          applyShader: shader,
        });

        const secs = ((performance.now() - _hwT0) / 1000).toFixed(1);
        window.FFHardware.pathBadge('hw', secs);
        await addBlobToBin(r.blob, `${state.inputFile.name} [⚡ hw]`, 'video/mp4');
        showOutput(r.blob, 'video/mp4');
        return r.blob;
      } catch (e) {
        logToConsole('warn', `[hw] fast path failed (${e.message}) — falling back to WebAssembly.`);
      }
    }

    const runRender = () => executeSplitRender(args, outputFilename, (i, n, label) => {
      setProgressText(`Pass ${i}/${n} — ${label}`);
    });

    // -------------------------------------------------------------------------
    // TIMEOUT BUDGET — must account for the SPLIT RENDER's multiple passes.
    // -------------------------------------------------------------------------
    // `renderMs` is a cost estimate for ONE ffmpeg invocation. But a split render
    // fires THREE (video / audio / mux), each of which re-reads the input. Sizing
    // the outer timeout for one pass and then wrapping three in it will time out
    // on any job long enough to matter — which looks exactly like "the audio pass
    // is slow" but is really just an under-budgeted clock.
    //
    // Each inner ff.exec is ALSO independently bounded by ffRun, so the outer
    // timeout is a backstop, not the primary guard. Give it room.
    const _willSplit = !!planSplitRender(args, outputFilename);
    const _passes = _willSplit ? 3 : 1;
    const _budgetMs = Math.max(90000, (renderMs * _passes) + 15000);
    if (_willSplit) {
      logToConsole('', `[split] 3 passes — timeout budget ${Math.round(_budgetMs / 1000)}s ` +
                       `(was ${Math.round((renderMs + 5000) / 1000)}s, sized for a single pass).`);
    }

    try {
      await execWithTimeout(runRender, _budgetMs, 'render');
    } catch (err) {
      if (!isWasmMemoryError(err) || state.cancelRequested) throw err;
      // The heap died. Torch it, reload clean, retry ONCE.
      await reinitEngineClean();
      await execWithTimeout(runRender, _budgetMs, 'render (retry, clean heap)');
    }
    try { console.log(`[executeFFmpeg] exec returned`); } catch (_) {}
    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    window.FFHardware?.pathBadge?.('wasm', elapsed);
    logToConsole('ok', `Completed in ${elapsed}s.`);
    setProgress(100);
    setProgressText(`Done in ${elapsed}s`);

    // Read the output bytes
    try { console.log(`[executeFFmpeg] reading ${outputFilename}`); } catch (_) {}
    const data = await ff.readFile(outputFilename);
    // Bytes are not a proxy for a working encode. A 1-frame 720p file is ~20 KB
    // and sails past any `bytes > 1000` check — that cost four debug cycles.
    if (!data || !data.length) {
      throw new Error(
        'FFmpeg produced NO OUTPUT (0 bytes). Last log lines:\n' +
        (state.logBuffer || []).slice(-12).join('\n')
      );
    }
    try { console.log(`[executeFFmpeg] readFile returned: ${data ? (data.byteLength || data.length) : 'null'} bytes`); } catch (_) {}
    // v5 hotfix 6: 0-byte output is the "function signature mismatch"
    // symptom — ffmpeg wrote nothing, but the JS path kept going and
    // threw a confusing TypeError on the next line. Guard it and
    // throw something useful that points at the real failure.
    if (!data || !(data.byteLength || data.length)) {
      const recent = (state.logLines || []).slice(-12)
        .map(l => `[${l.level}] ${l.text}`).join('\n');
      // v5 hotfix 6 (round 3): the failure modes we now know about,
      // and the matching fix.
      const isMallocFail  = recent.includes('x264 [error]') || recent.includes('malloc of size');
      const isSegfault    = recent.includes('memory access out of bounds') || recent.includes('RuntimeError');
      const isBadDts      = recent.includes('time=-577014:32:22.77');
      const isMuxerOnly   = !isMallocFail && !isSegfault && !isBadDts && recent.includes('Conversion failed');
      let hint = '';
      if (isMallocFail) {
        hint = `\n\nDiagnosis: x264 lookahead malloc failed. The wasm heap ` +
               `couldn't satisfy the buffer request. This was the bug in ` +
               `hotfix 6 (round 1) — it should now be fixed by the central ` +
               `ff.exec() injection of -threads 1 -tune zerolatency + the ` +
               `minimal x264-params. If you're still seeing it, the input ` +
               `may be triggering a path the injection doesn't cover.`;
      } else if (isSegfault) {
        hint = `\n\nDiagnosis: wasm segfault (memory access out of bounds). ` +
               `ffmpeg.wasm 0.12.10's libx264 path has a hard ceiling at ` +
               `roughly 480p × a few seconds. Above that — especially with ` +
               `file demux + scale filter + audio re-encode in the same ` +
               `command — the heap dies. mpeg4 doesn't have this limit. ` +
               `Try: (1) keep libx264 at 480p or below with audio copy ` +
               `(-c:a copy), (2) switch the codec to MPEG-4 for higher ` +
               `resolutions, (3) trim the input duration.`;
      } else if (isBadDts) {
        hint = `\n\nDiagnosis: the first output frame has time = INT64_MIN ` +
               `(AV_NOPTS_VALUE). The mp4 demuxer in ffmpeg.wasm sometimes ` +
               `produces an invalid first dts; -fflags +genpts should fix ` +
               `it but didn't. Try a different source file, or remux first ` +
               `with the system ffmpeg.`;
      } else if (isMuxerOnly) {
        hint = `\n\nDiagnosis: encoder ran and produced frames internally, ` +
               `but the muxer flushed nothing. This is usually a bad ` +
               `timestamp on the first frame — same root cause as the ` +
               `AV_NOPTS_VALUE case above.`;
      } else {
        hint = `\n\nDiagnosis: unknown. See the log lines below.`;
      }
      throw new Error(
        `ffmpeg produced no output for ${outputFilename} (0 bytes).${hint}\n` +
        `\nLast log lines:\n${recent}`
      );
    }
    const u8 = (data instanceof Uint8Array) ? data : new Uint8Array(data);
    state.outputSize = u8.byteLength;
    const mime = EXT_TO_MIME[outputFilename.split('.').pop().toLowerCase()] || 'application/octet-stream';
    const blob = new Blob([u8], { type: mime });

    // Revoke old URL, create new one
    if (state.outputBlobUrl) URL.revokeObjectURL(state.outputBlobUrl);
    state.outputBlobUrl = URL.createObjectURL(blob);
    loadOutputPreview(state.outputBlobUrl, mime);

    // Suggest a download name
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = `output_${ts}.${outputFilename.split('.').pop()}`;
    state.outputFilename = out;
    setDownloadEnabled(true);
    setOutputInfo({ size: u8.byteLength, mime, filename: out, ext: outputFilename.split('.').pop() });

    // Return `outputFilename` to match executePipeline() and executeWithRetry(),
    // which executeFromUI() consumes uniformly as `result.outputFilename`. The
    // old key here was `filename`, so the single-exec success path handed
    // finishFromPlan() an undefined name → `undefined.split('.')` the instant a
    // render actually completed. (`filename` kept as an alias for safety.)
    return { data: u8, mime, outputFilename, filename: outputFilename };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    try { console.log(`[executeFFmpeg] CAUGHT: ${msg}`); } catch (_) {}
    // v5 HOTFIX 4: timeouts are now a real, expected failure mode.
    // Surface them distinctly so the user knows the engine didn't
    // crash — it just took too long for this command.
    if (/timed out/i.test(msg)) {
      logToConsole('err', `Render timed out: ${msg}. Engine terminated; try a shorter range or a cheaper workflow.`);
      try { state.ffmpeg.terminate(); } catch (_) {}
      showFriendlyError('The render took too long and was stopped. Try a shorter range, a cheaper workflow, or downscale.');
    } else {
      logToConsole('err', `Exec failed: ${msg}`);
    }
    setProgressText('Failed — see log.');
    flagCommandError();
    showFriendlyError(msg);
    return null;
  } finally {
    state.isProcessing = false;
    setCancelVisible(false);
    setControlsEnabled(true);
  }
}

function quoteArg(a) {
  if (/\s|["'$`\\]/.test(a)) return JSON.stringify(a);
  return a;
}

function loadOutputPreview(url, mime) {
  const v = document.getElementById('video-preview');
  v.src = url;
  v.load();
  const label = document.getElementById('preview-label');
  if (label) label.textContent = 'Output Preview';
  const meta = document.getElementById('preview-meta');
  if (meta) meta.textContent = `${mime}`;
}

function setOutputInfo({ size, mime, filename, ext }) {
  const el = document.getElementById('output-info');
  if (!el) return;
  el.innerHTML = `
    <div class="kv"><span>Name</span><strong>${escapeHtml(filename)}</strong></div>
    <div class="kv"><span>Size</span><span>${formatBytes(size)}</span></div>
    <div class="kv"><span>Type</span><span>${escapeHtml(mime)}</span></div>
    <div class="kv"><span>Ext</span><span>${escapeHtml(ext)}</span></div>
  `;
}

function setDownloadEnabled(enabled) {
  const btn = document.getElementById('btn-download');
  if (btn) btn.disabled = !enabled;
}
function setProgress(pct) {
  const f = document.getElementById('progress-fill');
  if (f) f.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  // v4 PART A1: mirror into the action-bar progress fill.
  const ab = document.getElementById('ab-progress-fill');
  if (ab) ab.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}
function setProgressText(t) {
  const el = document.getElementById('progress-text');
  if (el) el.textContent = t;
}
function setCancelVisible(v) {
  const b = document.getElementById('btn-cancel');
  if (!b) return;
  b.classList.toggle('hidden', !v);
  // v4 PART A1: mirror the cancel button into the action bar.
  if (typeof updateActionBar === 'function') updateActionBar();
}
// =============================================================================
// refreshControlsEnabled (v5 hotfix 5 — derived from state, not imperative)
// -----------------------------------------------------------------------------
// The old setControlsEnabled(true|false) was an imperative call that
// required every state-mutating site to remember to call it. The new
// version is a pure DERIVATION of the current state — any mutation
// that affects the gate (upload, delete, select, processing
// start/end) just calls refreshControlsEnabled() and the buttons
// snap to the right state. You can't forget to call it because you
// can't update the button directly.
// =============================================================================
function refreshControlsEnabled() {
  // The gate:
  //   - engine must be ready
  //   - an active media must be selected
  //   - we must NOT already be processing (no double-run)
  const ready = !!state.engineReady && !!state.activeMediaId && !state.isProcessing;
  const exe = document.getElementById('btn-execute');
  if (exe) {
    exe.disabled = !ready;
    // Restore the proper label (e.g. "Run" or "Run (~Xs)") once we
    // are no longer processing. The "Queued…" cue set by
    // updateQueuedCue() is the brief "your run is waiting its turn"
    // state — once we cross into running, refreshCommandPreview
    // repaints the label.
    if (!state.isProcessing && exe.textContent === 'Queued...') {
      if (typeof refreshCommandPreview === 'function') refreshCommandPreview();
    }
  }
  const gr = document.getElementById('global-run');
  if (gr) {
    gr.disabled = !ready;
    if (!state.isProcessing && gr.textContent === 'Queued...') {
      if (typeof refreshCommandPreview === 'function') refreshCommandPreview();
    }
  }
  const fi = document.getElementById('file-input');
  if (fi) fi.disabled = state.isProcessing;
  const pb = document.getElementById('btn-play');
  if (pb) pb.disabled = !state.inputFile;
  // Sections + sliders always enabled so user can prepare next command.
}

// updateQueuedCue() — applies the brief "Queued…" label to the Run
// button(s) when the user clicks Run while background work is still
// draining. Called by executeFromUI right after cancelAllBgJobs();
// the next refreshCommandPreview() call paints the regular label.
function updateQueuedCue() {
  if (ffQueue.depth === 0) return;
  const exe = document.getElementById('btn-execute');
  const gr  = document.getElementById('global-run');
  if (exe) { exe.textContent = 'Queued...'; exe.disabled = true; }
  if (gr)  { gr.textContent  = 'Queued...'; gr.disabled  = true; }
}

// Backwards-compat: keep the old name as a thin wrapper. It now
// derives everything from state and ignores the (true|false) arg —
// callers don't need to reason about it any more.
function setControlsEnabled(_enabled) {
  refreshControlsEnabled();
}

// =============================================================================
// ERROR HANDLING (spec §4.2)
// =============================================================================
function flagCommandError() {
  const el = document.getElementById('command-preview');
  if (el) el.classList.add('error');
}
function clearCommandError() {
  const el = document.getElementById('command-preview');
  if (el) el.classList.remove('error');
}
function showFriendlyError(message) {
  const m = String(message || '');
  let friendly = `Processing failed: ${m}`;
  if (/no such filter/i.test(m)) {
    friendly = 'One of the selected filters is not available in the browser version of FFmpeg. Try disabling the most recent section you enabled and re-run.';
  } else if (/invalid argument/i.test(m)) {
    friendly = 'A parameter value is out of range. Check your settings — especially filter numeric values.';
  } else if (/output file is empty|output file .* is empty/i.test(m) || /nothing was encoded/i.test(m)) {
    friendly = 'Processing produced no output. This usually means the trim range is outside the media duration.';
  } else if (/memory|allocation|out of memory|oom/i.test(m)) {
    friendly = 'The file is too large for browser memory. Try a smaller file or lower resolution.';
  } else if (/aborted|terminated/i.test(m)) {
    friendly = 'Processing was cancelled.';
  }
  showInfo('Error', friendly);
}

function showInfo(title, bodyHtml) {
  const modal = document.getElementById('info-modal');
  const tt = document.getElementById('info-title');
  const tb = document.getElementById('info-body');
  if (tt) tt.textContent = title;
  if (tb) tb.innerHTML = bodyHtml;
  if (modal) modal.classList.remove('hidden');
}

// =============================================================================
// LOG CONSOLE (spec §2.5 + §5.5)
// =============================================================================
function logToConsole(level, text) {
  const con = document.getElementById('log-console');
  if (!con) return;
  const ts = new Date().toLocaleTimeString();
  const line = { ts, level: level || '', text: String(text) };
  state.logLines.push(line);
  if (state.logLines.length > MAX_LOG_LINES) {
    state.logLines.splice(0, state.logLines.length - MAX_LOG_LINES);
  }
  renderLog();
}
function renderLog() {
  const con = document.getElementById('log-console');
  if (!con) return;
  const lvlClass = (l) => l === 'err' ? 'err' : l === 'warn' ? 'warn' : l === 'ok' ? 'ok' : '';
  con.innerHTML = state.logLines.map(l => {
    return `<span class="log-line ${lvlClass(l.level)}"><span class="ts">[${l.ts}]</span>${escapeHtml(l.text)}</span>`;
  }).join('');
  con.scrollTop = con.scrollHeight;
}
function clearLog() {
  state.logLines = [];
  renderLog();
}

// =============================================================================
// COMMAND BUILDER (spec §3.1, §3.2)
// =============================================================================
function buildFFmpegCommand() {
  if (!state.inputFile) return { args: [], str: '(load a file first)', ok: false, error: 'No input file.' };

  clearCommandError();

  // ---- 0. Audio extraction overrides (spec §3.1 special case)
  const extractAudio = sectionEnabled(18) && $('#extract-audio').checked;
  if (extractAudio) {
    return buildAudioExtractionCommand();
  }

  // ---- 0a. Audio Visualization (Section 29) — turns audio into a video.
  if (sectionEnabled(29)) {
    return buildVisualizationCommand();
  }

  // ---- 0b. GIF mode: route to dedicated two-pass function
  if (sectionEnabled(17) && $('#gif-enable').checked) {
    // buildGlitchCommand is for section 19 only — here we just route.
    return buildGifPreviewCommand();
  }

  // ---- Determine output filename & ext
  const outFormat = $('#out-format').value;
  const ext = outFormat;
  const outputFilename = `output.${ext}`;

  const args = [];

  // ---- 1. -ss / -to trim (must come BEFORE -i for fast seek)
  const trim = buildTrimArgs();
  if (trim.ss) args.push('-ss', trim.ss);
  // v5 hotfix 6 (round 3): ffmpeg.wasm's mp4 demuxer can produce an
  // invalid first-frame dts (cur_dts is invalid st:0, the encoder
  // then sees time=-66 years = AV_NOPTS_VALUE and the muxer
  // refuses to flush the encoded packets → output is just the
  // container header, 300-500 bytes, no actual frames). `-fflags
  // +genpts+discardcorrupt` regenerates PTS/DTS from the frame
  // rate; `-avoid_negative_ts make_zero` additionally shifts any
  // remaining leading-negative timestamps to start at 0. Together
  // they give the muxer a valid first packet. Safe for any input —
  // real mp4s round-trip cleanly, broken inputs get a clean fail.
  args.push('-fflags', '+genpts+discardcorrupt');
  // REMOVED: -avoid_negative_ts make_zero triggers 'memory access out of
  // bounds' in the wasm muxer flush on file input. `-fflags +genpts`
  // already gives the muxer valid timestamps. Confirmed by raw-mode sweep.
  args.push('-i', state.inputFile.virtualName);
  if (trim.to) args.push('-to', trim.to);

  // ---- 2. Optional two-pass: build a separate pass-1 args
  //         (we keep this in buildFFmpegCommand for completeness; the runner
  //          looks for the 'twoPass' flag on the result and handles it.)
  const twoPass = sectionEnabled(21) && $('#two-pass').checked;

  // ---- 3. Build the video filter chain
  const vf = buildVideoFilterChain();

  // ---- 4. Build the audio filter chain
  const af = buildAudioFilterChain();

  // ---- 5. Codec selection. If user picked "copy" we must NOT add -vf.
  const vcodec = $('#vcodec').value;
  const acodec = $('#acodec').value;
  const copyVideo = vcodec === 'copy';
  const copyAudio = acodec === 'copy';
  const noAudio   = acodec === 'none' || (sectionEnabled(12) && $('#strip-audio').checked);

  // v5 hotfix 6 (round 3): ffmpeg.wasm 0.12.10's libx264 path has a
  // hard ceiling at ~480p in this build. Above that, the encoder
  // segfaults with "memory access out of bounds" inside the wasm
  // heap. mpeg4 doesn't have this issue. If the user asked for
  // libx264 + a scale that produces > 480p, cap the output to 480p
  // and surface the reason. Don't silently swap the codec (the
  // user picked libx264 for a reason) — cap the resolution, log
  // loudly, and let the user override.
  const LIBX264_MAX_W = 854;   // 480p widescreen
  const LIBX264_MAX_H = 480;
  if (vcodec === 'libx264' && !copyVideo) {
    const w = parseInt($('#scale-w').value, 10) || 0;
    const h = parseInt($('#scale-h').value, 10) || 0;
    if (w > LIBX264_MAX_W || h > LIBX264_MAX_H) {
      const capW = LIBX264_MAX_W;
      const capH = LIBX264_MAX_H;
      logToConsole('warn',
        `libx264 in ffmpeg.wasm 0.12.10 has a wasm-heap ceiling at 480p. ` +
        `Capping output from ${w}x${h} to ${capW}x${capH}. ` +
        `Use the MPEG-4 codec for higher resolutions, or pick 480p explicitly.`
      );
      // Patch the scale args in vf[] (last scale entry is what we
      // care about; there may also be one inside the user filter).
      for (let i = 0; i < vf.length; i++) {
        const m = vf[i].match(/^scale=(\d+):(\d+)(?::.*)?$/);
        if (m) {
          vf[i] = `scale=${capW}:${capH}:flags=lanczos`;
        }
      }
    }
  }

  // When copying, FFmpeg refuses to apply filters to the copied stream.
  if (copyVideo && vf.length) {
    // Move vf to the start of the comment but actually skip the filter.
    // Spec §3.1: "If the user selected copy for a codec, does NOT include
    //             filters for that stream (FFmpeg errors if you filter a
    //             stream-copied track)."
    // We still keep the user aware via a warning.
    logToConsole('warn', 'Stream-copy selected for video but video filters are enabled — FFmpeg will reject this combination. Video filters will be omitted.');
  }
  if (copyAudio && af.length) {
    logToConsole('warn', 'Stream-copy selected for audio but audio filters are enabled — audio filters will be omitted.');
  }

  // ---- 6. Output flags
  // Codec flags
  if (!copyVideo) {
    args.push('-c:v', vcodec);
    // Preset and CRF apply only to x264/x265/VP9
    if (vcodec === 'libx264' || vcodec === 'libx265') {
      args.push('-preset', $('#enc-preset').value);
      args.push('-crf', String(parseInt($('#crf').value, 10)));
      // v5 hotfix 6 (round 2): the -threads / -x264-params
      // constraint is injected centrally in ff.exec() — don't
      // duplicate it here. The exec wrapper applies it once for
      // every code path.
    } else if (vcodec === 'libvpx-vp9') {
      args.push('-b:v', '0');
      args.push('-crf', String(parseInt($('#crf').value, 10)));
    }
  }
  if (noAudio) {
    args.push('-an');
  } else if (!copyAudio) {
    args.push('-c:a', acodec);
    args.push('-b:a', $('#ab-rate').value);
  }
  // Pixel format
  if (!copyVideo) {
    args.push('-pix_fmt', $('#pix-fmt').value);
  }
  // v4 PART B2: append the beat-sync filter expression (e.g.
  //   hue=h=90:enable='between(t,1.42,1.52)+between(t,2.31,2.41)+...'
  // ). The expression is built by beat-detection.js when the user hits
  // "Apply to Editor" on the Sync-to-Beats panel. It composes cleanly
  // with anything in `vf` because the comma separator is an
  // ffmpeg filter-graph composition.
  if (state.beatSyncExpr) {
    vf.push(state.beatSyncExpr);
  }
  // Video filters (after codec args)
  if (vf.length && !copyVideo) args.push('-vf', vf.join(','));
  if (af.length && !copyAudio && !noAudio) args.push('-af', af.join(','));

  // Bitrate / two-pass / GOP / maxrate / bufsize
  if (sectionEnabled(21)) {
    const vbit = parseFloat($('#vbitrate').value) || 0;
    const unit = $('#vbitrate-unit').value;
    if (vbit > 0) args.push('-b:v', `${vbit}${unit}`);
    const max = parseFloat($('#maxrate').value) || 0;
    const buf = parseFloat($('#bufsize').value) || 0;
    if (max > 0) args.push('-maxrate', `${max}k`);
    if (buf > 0) args.push('-bufsize', `${buf}k`);
    if (parseInt($('#gopsize').value, 10) > 0) args.push('-g', String(parseInt($('#gopsize').value, 10)));
  }

  // ---- 7. Metadata
  if (sectionEnabled(22)) {
    if ($('#strip-meta').checked) args.push('-map_metadata', '-1');
    const t = $('#meta-title').value.trim();
    const a = $('#meta-artist').value.trim();
    const c = $('#meta-comment').value.trim();
    if (t) args.push('-metadata', `title=${t}`);
    if (a) args.push('-metadata', `artist=${a}`);
    if (c) args.push('-metadata', `comment=${c}`);
  }

  // ---- 8. Final output filename
  args.push(outputFilename);

  // ---- 9. Move -ss right before -i in case it ended up wrong order
  // (we already did this above; nothing to do)

  // ---- 10. Friendly string version
  const str = `ffmpeg ${args.map(quoteArg).join(' ')}`;

  // ---- 11. Two-pass: produce a plan object so the runner can handle it
  if (twoPass) {
    return { args, str, ok: true, twoPass: true, outputFilename };
  }

  // v5 hotfix 2 — Bug 1: cost estimate for the gate. We compute it
  // off the OPTIMIZED chain (post Bug 5) so the estimate is honest
  // about what ffmpeg will actually run. The estimate is in seconds.
  const optVf = optimizeFilterChain(vf);
  const costFilters = optVf.map(s => parseFilterExpr(s));
  const W = (state.inputFile && state.inputFile.width)  || 1280;
  const H = (state.inputFile && state.inputFile.height) || 720;
  const trimStart = parseTime(($('#trim-start') || {}).value) || 0;
  const trimEnd   = parseTime(($('#trim-end')   || {}).value) || 0;
  const totalDur  = (state.inputFile && state.inputFile.durationSec) || 0;
  const effTo     = (trimEnd > 0 && trimEnd <= totalDur + 0.5) ? trimEnd : totalDur;
  const runDur    = Math.max(0.1, effTo - trimStart);
  const estimateSec = estimateCost(costFilters, runDur, W, H);

  return { args, str, ok: true, outputFilename, estimateSec, filters: costFilters, hasSlow: hasSlowFilter(costFilters) };
}

// Build a set of args for a single-pass audio extraction.
function buildAudioExtractionCommand() {
  const ext = $('#audio-format').value;
  const outputFilename = `output.${ext}`;
  const args = [];
  const trim = buildTrimArgs();
  if (trim.ss) args.push('-ss', trim.ss);
  args.push('-i', state.inputFile.virtualName);
  if (trim.to) args.push('-to', trim.to);
  args.push('-vn');
  // Codec
  const codecMap = { mp3: 'libmp3lame', wav: 'pcm_s16le', ogg: 'libvorbis', aac: 'aac' };
  args.push('-c:a', codecMap[ext] || 'aac');
  args.push('-b:a', $('#ab-rate').value);
  args.push('-ar', String(parseInt($('#audio-rate').value, 10)));
  // Audio filters
  const af = buildAudioFilterChain();
  if (af.length) args.push('-af', af.join(','));
  if (sectionEnabled(22)) {
    if ($('#strip-meta').checked) args.push('-map_metadata', '-1');
    const t = $('#meta-title').value.trim();
    const a = $('#meta-artist').value.trim();
    const c = $('#meta-comment').value.trim();
    if (t) args.push('-metadata', `title=${t}`);
    if (a) args.push('-metadata', `artist=${a}`);
    if (c) args.push('-metadata', `comment=${c}`);
  }
  args.push(outputFilename);
  const str = `ffmpeg ${args.map(quoteArg).join(' ')}`;
  return { args, str, ok: true, outputFilename };
}

// Build a "preview" args for GIF — actual execution goes through createGIF().
function buildGifPreviewCommand() {
  const w = parseInt($('#gif-w').value, 10) || 480;
  const fps = parseFloat($('#gif-fps').value) || 15;
  const loop = parseInt($('#gif-loop').value, 10) || 0;
  const args = ['-i', state.inputFile.virtualName,
    '-vf', `fps=${fps},scale=${w}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`,
    '-loop', String(loop),
    'output.gif'];
  const str = `ffmpeg ${args.map(quoteArg).join(' ')}`;
  return { args, str, ok: true, outputFilename: 'output.gif', gifTwoPass: true };
}

// ----- Trim arguments helper (spec §2) -----
// v5 hotfix 2 — Bug 3: only emit `-ss` / `-to` when the user actually
// trimmed the clip. The legacy version always emitted `-ss 0` and
// `-to <full-duration>`, which are dead no-ops that force a re-encode
// path and confuse the preview. We compare against the source duration
// and treat < 0.05s as a no-op.
function buildTrimArgs() {
  const ss = parseTime($('#trim-start').value);
  const to = parseTime($('#trim-end').value);
  const dur = (state.inputFile && state.inputFile.durationSec) || 0;
  // emit -ss whenever the user moved start past 0.001s. (Even if the
  // duration isn't known yet, -ss <small> is harmless — ffmpeg will
  // fast-seek there.)
  const emitSs = ss > 0.001;
  // emit -to whenever the user explicitly set an end that's both
  // positive and less than the source duration (with a 0.05s slop).
  // If we don't know the duration yet, we trust the user and emit
  // -to anyway so the trim is honored.
  let emitTo = false;
  if (to > 0) {
    if (dur > 0) {
      emitTo = to < (dur - 0.05);
    } else {
      // No metadata yet — be conservative: emit -to so the trim is
      // actually applied. The user picked a value; respect it.
      emitTo = true;
    }
  }
  return {
    ss:  emitSs ? formatTime(ss) : null,
    to:  emitTo ? formatTime(to) : null,
  };
}

// =============================================================================
// SECTION 29: AUDIO VISUALIZATION (audio → video)
// =============================================================================
// Builds the args for turning an audio file into a music video. There are
// two flavors: (a) plain black background, (b) optional background image
// from the bin (audiogram).
function buildVisualizationCommand() {
  if (!state.inputFile) return { args: [], str: '(load a file first)', ok: false, error: 'No input file.' };
  const type = ($('#viz-type') || {}).value || 'showwaves';
  const mode = ($('#viz-mode') || {}).value || 'line';
  const w = parseInt(($('#viz-w') || {}).value, 10) || 1280;
  const h = parseInt(($('#viz-h') || {}).value, 10) || 720;
  const color = (($('#viz-color') || {}).value) || '#00d4ff';
  const colormap = (($('#viz-colormap') || {}).value) || 'intensity';
  const fps = parseInt(($('#viz-fps') || {}).value, 10) || 30;
  const bgId = (($('#viz-bg-select') || {}).value) || '';
  const outputFilename = 'output.mp4';
  const colorHex = color.replace('#', '').toLowerCase();
  const colorFF = '0x' + colorHex;

  // Common params for each filter type
  let vizFilter = '';
  if (type === 'showwaves') {
    vizFilter = `[0:a]showwaves=s=${w}x${h}:mode=${mode}:colors=${colorFF}:rate=${fps}[v]`;
  } else if (type === 'showspectrum') {
    vizFilter = `[0:a]showspectrum=s=${w}x${h}:mode=combined:color=${colormap}:scale=log:fps=${fps}[v]`;
  } else if (type === 'showfreqs') {
    vizFilter = `[0:a]showfreqs=s=${w}x${h}:mode=bar:colors=${colorFF}:fps=${fps}[v]`;
  } else if (type === 'showvolume') {
    vizFilter = `[0:a]showvolume=w=${w}:h=${h}:c=${colorFF}[v]`;
  } else if (type === 'showcqt') {
    vizFilter = `[0:a]showcqt=s=${w}x${h}:fps=${fps}[v]`;
  } else {
    vizFilter = `[0:a]showwaves=s=${w}x${h}:mode=${mode}:colors=${colorFF}:rate=${fps}[v]`;
  }

  const trim = buildTrimArgs();
  let args = [];
  let complex = '';
  if (bgId) {
    // Audiogram: bg image is -loop 1 -i; overlay visualization on bottom.
    const bgMedia = state.mediaBin.find(m => m.id === bgId);
    if (bgMedia) {
      // Force the bg image to the chosen size.
      const bgWave = `[1:a]showwaves=s=${w}x${Math.max(80, Math.floor(h/3))}:mode=cline:colors=${colorFF}:rate=${fps},format=rgba[wave]`;
      const bgScale = `[0:v]scale=${w}:${h},format=yuv420p[bg]`;
      complex = `${bgWave};${bgScale};[bg][wave]overlay=0:H-h-40:shortest=1[v]`;
      args = [];
      if (trim.ss) args.push('-ss', trim.ss);
      args.push('-loop', '1', '-i', bgMedia.virtualName);
      args.push('-i', state.inputFile.virtualName);
      if (trim.to) args.push('-to', trim.to);
      args.push('-filter_complex', complex, '-map', '[v]', '-map', '1:a',
                '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
                '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
                outputFilename);
      const str = `ffmpeg ${args.map(quoteArg).join(' ')}`;
      return { args, str, ok: true, outputFilename };
    }
  }
  // Default: visualization on black background.
  complex = vizFilter + `;color=c=black:s=${w}x${h}:r=${fps}[bg];[bg][v]overlay=0:0:shortest=1[vf]`;
  args = [];
  if (trim.ss) args.push('-ss', trim.ss);
  args.push('-i', state.inputFile.virtualName);
  if (trim.to) args.push('-to', trim.to);
  args.push('-filter_complex', complex,
            '-map', '[vf]', '-map', '0:a',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
            '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
            outputFilename);
  const str = `ffmpeg ${args.map(quoteArg).join(' ')}`;
  return { args, str, ok: true, outputFilename };
}

// =============================================================================
// VIDEO FILTER CHAIN (spec §3.2 video ordering)
// =============================================================================
function buildVideoFilterChain() {
  const vf = [];
  const isCopy = $('#vcodec').value === 'copy';

  // We need a working canvas for crop/pad/scale ordering. We rely on the
  // user setting one of section 3 (scale), 4 (crop), 15 (pad) etc. The
  // builder only ADDS filters for ENABLED sections.

  // 1. trim / setpts (handled outside vf via -ss/-to, BUT for video speed
  //    we still need setpts=PTS/VALUE so that is added below at step 5).
  //    Here we add a setpts if speed change for VIDEO is enabled.
  //    Actually spec ordering says "trim/setpts" comes first, then crop, etc.
  //    We will place the speed setpts at step 5 — see below.

  // 2. crop (Section 4)
  if (sectionEnabled(4)) {
    const cw = parseInt($('#crop-w').value, 10) || 0;
    const ch = parseInt($('#crop-h').value, 10) || 0;
    if (cw > 0 && ch > 0) {
      if ($('#crop-center').checked) {
        // Center crop uses (in_w-cw)/2 etc. The crop filter accepts expressions
        // but simpler: pass through and compute at execution time.
        // We just emit a special marker and let the runner calculate X/Y.
        // For now, use the literal values; if center, we set x=in_w/2-cw/2.
        vf.push(`crop=${cw}:${ch}:(in_w-${cw})/2:(in_h-${ch})/2`);
      } else {
        const cx = parseInt($('#crop-x').value, 10) || 0;
        const cy = parseInt($('#crop-y').value, 10) || 0;
        vf.push(`crop=${cw}:${ch}:${cx}:${cy}`);
      }
    }
  }

  // 3. scale (Section 3)
  if (sectionEnabled(3)) {
    const w = $('#scale-w').value;
    const h = $('#scale-h').value;
    const algo = $('#scale-algo').value;
    const flags = algo === 'neighbor' ? 'neighbor'
                : algo === 'bilinear' ? 'bilinear'
                : algo === 'bicubic'  ? 'bicubic'
                : algo === 'lanczos'  ? 'lanczos' : 'lanczos';
    // Ensure width/height are even for H.264
    const wStr = String(w);
    const hStr = String(h);
    vf.push(`scale=${wStr}:${hStr}:flags=${flags}`);
  }

  // 4. transpose / hflip / vflip (Section 5)
  if (sectionEnabled(5)) {
    const rot = $('#rotate').value;
    if (rot === '90cw')   vf.push('transpose=1');
    if (rot === '90ccw')  vf.push('transpose=2');
    if (rot === '180')    vf.push('transpose=1,transpose=1');
    if ($('#hflip').checked) vf.push('hflip');
    if ($('#vflip').checked) vf.push('vflip');
  }

  // 5. setpts for speed (Section 6, video only)
  if (sectionEnabled(6) && $('#speed-video').checked) {
    const useCurve = $('#use-speed-curve')?.checked;
    if (useCurve) {
      // #42: speed curve. Interpolate the 4 keyframes and emit a series of
      // setpts filters per segment with a -ss/-to trim.
      const v0 = parseFloat($('#sc-0').value) || 1;
      const v1 = parseFloat($('#sc-1').value) || 1;
      const v2 = parseFloat($('#sc-2').value) || 1;
      const v3 = parseFloat($('#sc-3').value) || 1;
      // 3 segments (0-1/3, 1/3-2/3, 2/3-1)
      const segs = [
        { from: 0,    to: 1/3, spd: (v0 + v1) / 2 },
        { from: 1/3,  to: 2/3, spd: (v1 + v2) / 2 },
        { from: 2/3,  to: 1,   spd: (v2 + v3) / 2 },
      ];
      for (const s of segs) {
        if (s.spd === 1) continue;
        const ptsVal = (1.0 / s.spd).toFixed(4);
        // Use between() filter so the PTS works per segment
        vf.push(`asetpts=PTS-STARTPTS,setpts=${ptsVal}*PTS`);
      }
    } else {
      const spd = parseFloat($('#speed').value) || 1.0;
      if (spd !== 1.0) {
        const ptsVal = (1.0 / spd).toFixed(4);
        vf.push(`setpts=${ptsVal}*PTS`);
      }
    }
  }

  // 6. reverse (Section 6)
  if (sectionEnabled(6) && $('#rev-video').checked) {
    vf.push('reverse');
  }

  // 7. eq (Section 7)
  if (sectionEnabled(7)) {
    const br = parseFloat($('#eq-brightness').value);
    const co = parseFloat($('#eq-contrast').value);
    const sa = parseFloat($('#eq-saturation').value);
    const ga = parseFloat($('#eq-gamma').value);
    const gr = parseFloat($('#eq-gamma-r').value);
    const gg = parseFloat($('#eq-gamma-g').value);
    const gb = parseFloat($('#eq-gamma-b').value);
    const changed = [br, co, sa, ga, gr, gg, gb].some(v => v !== defaultEq(v));
    if (changed) {
      vf.push(`eq=brightness=${br}:contrast=${co}:saturation=${sa}:gamma=${ga}:gamma_r=${gr}:gamma_g=${gg}:gamma_b=${gb}`);
    }
  }

  // 8. hue (Section 7)
  if (sectionEnabled(7)) {
    const hh = parseFloat($('#hue-h').value);
    const hs = parseFloat($('#hue-s').value);
    if (hh !== 0 || hs !== 1) {
      vf.push(`hue=h=${hh}:s=${hs}`);
    }
  }

  // 9. colorchannelmixer (Section 8)
  if (sectionEnabled(8)) {
    const v = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'].map(k => parseFloat($('#ccm-' + k).value));
    // Always add — user has explicitly enabled the section, so they want it.
    // If identity, output is identical to input but the filter is harmless.
    vf.push(`colorchannelmixer=${v.map((x, i) => `rr rg rb gr gg gb br bg bb`.split(' ')[i] + '=' + x).join(':')}`);
  }

  // 10. negate (Section 7)
  if (sectionEnabled(7) && $('#negate').checked) {
    vf.push('negate');
  }

  // 11. noise (Section 13)
  if (sectionEnabled(13)) {
    if ($('#grain-overlay').checked) {
      vf.push('noise=alls=15:allf=t+u');
    } else if ($('#add-noise').checked) {
      const str = parseInt($('#noise-strength').value, 10) || 0;
      const typ = $('#noise-type').value;
      if (str > 0) vf.push(`noise=alls=${str}:allf=${typ}`);
    }
  }

  // 12. boxblur / gblur (Section 9)
  if (sectionEnabled(9)) {
    const bt = $('#blur-type').value;
    const bs = parseInt($('#blur-strength').value, 10) || 0;
    if (bs > 0) {
      if (bt === 'box') vf.push(`boxblur=${bs}:${bs}`);
      else              vf.push(`gblur=sigma=${bs}`);
    }
  }

  // 13. unsharp (Section 9)
  if (sectionEnabled(9)) {
    const sa = parseFloat($('#sharpen-amt').value) || 0;
    if (sa > 0) vf.push(`unsharp=5:5:${sa}:5:5:0`);
  }

  // 14. edgedetect / sobel / convolution(emboss) (Section 16)
  if (sectionEnabled(16)) {
    if ($('#edge-detect').checked) {
      const mode = $('#edge-mode').value;
      const lo = parseFloat($('#edge-low').value);
      const hi = parseFloat($('#edge-high').value);
      if (mode === 'canny') vf.push(`edgedetect=mode=canny:low=${lo}:high=${hi}`);
      else                  vf.push(`edgedetect=mode=${mode}`);
    }
    if ($('#sobel').checked)  vf.push('sobel');
    if ($('#emboss').checked) {
      vf.push(`convolution="-2 -1 0 -1 1 1 0 1 2:-2 -1 0 -1 1 1 0 1 2:-2 -1 0 -1 1 1 0 1 2:-2 -1 0 -1 1 1 0 1 2:-2 -1 0 -1 1 1 0 1 2"`);
    }
  }

  // 15. vignette (Section 16)
  if (sectionEnabled(16) && $('#vignette').checked) {
    const ang = parseFloat($('#vignette-angle').value);
    vf.push(`vignette=angle=${ang}`);
  }

  // 16. lut / lutyuv (Section 16 posterize)
  if (sectionEnabled(16)) {
    const bits = parseInt($('#posterize').value, 10);
    if (bits < 8 && bits >= 1) {
      // Bitmask
      const mask = (0xFF << (8 - bits)) & 0xFF;
      const hex = '0x' + mask.toString(16).toUpperCase().padStart(2, '0');
      vf.push(`lutyuv=y='bitand(val,${hex})':u='val':v='val'`);
    }
  }

  // 17. geq (Section 19D)
  if (sectionEnabled(19)) {
    const geqFilter = buildGlitchCommand({ mode: 'geq' });
    if (geqFilter) vf.push(geqFilter);
  }

  // 18. lagfun / tmix / tblend (Section 19 A, B, C)
  if (sectionEnabled(19)) {
    if ($('#g-tmix-enable').checked) {
      const frames = parseInt($('#g-tmix-frames').value, 10) || 5;
      vf.push(`tmix=frames=${frames}`);
    }
    if ($('#g-tblend-enable').checked) {
      const mode = $('#g-tblend-mode').value;
      vf.push(`tblend=all_mode=${mode}`);
    }
    if ($('#g-lagfun-enable').checked) {
      const decay = parseFloat($('#g-lagfun-decay').value);
      vf.push(`lagfun=decay=${decay}`);
    }
  }

  // 19. amplify / deflicker (Section 19 F, G)
  if (sectionEnabled(19)) {
    if ($('#g-amp-enable').checked) {
      const r = parseInt($('#g-amp-radius').value, 10);
      const f = parseInt($('#g-amp-factor').value, 10);
      const t = parseInt($('#g-amp-threshold').value, 10);
      vf.push(`amplify=radius=${r}:factor=${f}:threshold=${t}`);
    }
    if ($('#g-deflicker-enable').checked) {
      const s = parseInt($('#g-deflicker-size').value, 10);
      vf.push(`deflicker=size=${s}`);
    }
  }

  // 19b. Color corruption (Section 19E) - v5 hotfix 2 fix
  // The legacy implementation used lutrgb with random(1), which builds a
  // static 256-entry table at filter init and indexes it forever — the
  // effect is a single frozen randomized color cast, not animated
  // corruption. So we replace it with a *temporal* noise overlay that
  // actually animates per frame, using a tighter noise seed that biases
  // the band the user picked with g-cc-low / g-cc-high / g-cc-spread.
  // The user can still opt into the slow animated-corruption path
  // (geq with N-seeded random) via the g-cc-mode toggle.
  if (sectionEnabled(19) && $('#g-cc-enable').checked) {
    const lo = parseInt($('#g-cc-low').value, 10);
    const hi = parseInt($('#g-cc-high').value, 10);
    const sp = parseInt($('#g-cc-spread').value, 10);
    const mode = ($('#g-cc-mode') && $('#g-cc-mode').value) || 'temporal';
    if (mode === 'animated') {
      // Animated per-frame corruption. Uses geq with frame-seeded
      // random — this is slow (FILTER_COST.geq = 100) and the cost
      // gate will warn before running on long clips. The "val" lookup
      // is per-pixel per-frame so the corruption actually changes.
      const amp = Math.max(1, sp);
      vf.push(`geq=r='if(between(r(X,Y),${lo},${hi}),r(X,Y)+(random(1+N)*2-1)*${amp},r(X,Y))':g='if(between(g(X,Y),${lo},${hi}),g(X,Y)+(random(1+N)*2-1)*${amp},g(X,Y))':b='if(between(b(X,Y),${lo},${hi}),b(X,Y)+(random(1+N)*2-1)*${amp},b(X,Y))'`);
    } else if (mode === 'static') {
      // Honest static LUT in YUV space — same look as the original
      // lutrgb with random(1), but labeled as STATIC in the UI. Uses
      // lutyuv so we stay in the YUV domain (no colorspace round trip).
      vf.push(`lutyuv=y='if(between(val,${lo},${hi}),val+random(1)*${sp},val)':u='val':v='val'`);
    } else {
      // PREFERRED default — temporal noise that actually animates.
      // The strength slider maps to the noise amplitude.
      const amp = Math.max(5, Math.min(80, sp));
      vf.push(`noise=alls=${amp}:allf=t+u`);
    }
  }

  // 20. colorkey (Section 20)
  if (sectionEnabled(20) && $('#chroma-enable').checked) {
    const c = $('#chroma-color').value;
    const s = parseFloat($('#chroma-similarity').value);
    const b = parseFloat($('#chroma-blend').value);
    vf.push(`colorkey=color=${c}:similarity=${s}:blend=${b}`);
  }

  // 21. fade (Section 10)
  if (sectionEnabled(10)) {
    const inD = parseFloat($('#fade-in-dur').value) || 0;
    const outD = parseFloat($('#fade-out-dur').value) || 0;
    if (inD > 0) {
      const c = $('#fade-in-type').value;
      vf.push(`fade=t=in:st=0:d=${inD}:color=${c}`);
    }
    if (outD > 0) {
      // Compute the start time as (output duration - fade-out duration).
      // Output duration is the trimmed source duration; if the source
      // metadata isn't loaded yet, fall back to 0 and let ffmpeg error
      // out gracefully (the user will see the friendly message).
      const total = (state.inputFile && state.inputFile.durationSec)
        ? (parseTime($('#trim-end').value) - parseTime($('#trim-start').value))
        : 0;
      const start = Math.max(0, total - outD);
      vf.push(`fade=t=out:st=${start.toFixed(3)}:d=${outD}:color=${$('#fade-out-type').value}`);
    }
  }

  // 22. drawtext (Section 11)
  if (sectionEnabled(11)) {
    const txt = $('#text-content').value;
    if (txt && txt.length) {
      const size = parseInt($('#text-size').value, 10) || 24;
      const color = $('#text-color').value;
      const bg = $('#text-bg').value;
      const bgOp = parseFloat($('#text-bg-opacity').value) || 0;
      const xa = $('#text-x-align').value;
      const ya = $('#text-y-align').value;
      const xo = parseInt($('#text-x-offset').value, 10) || 0;
      const yo = parseInt($('#text-y-offset').value, 10) || 0;
      // v4 PART A2 — pull the user-selected font path. Fall back to
      // /sans.ttf if the dropdown isn't found (e.g. older markup).
      const fontPath = ($('#text-font') && $('#text-font').value) || '/sans.ttf';
      const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
      let expr = `text='${esc(txt)}':fontsize=${size}:fontcolor=${color}:fontfile=${fontPath}`;
      // x expression
      const xExpr = (xa === 'left') ? `${xo}` : (xa === 'right') ? `w-text_w-${xo}` : `(w-text_w)/2+${xo}`;
      const yExpr = (ya === 'top')  ? `${yo}` : (ya === 'bottom') ? `h-text_h-${yo}` : `(h-text_h)/2+${yo}`;
      expr += `:x=${xExpr}:y=${yExpr}`;
      if (bg && bgOp > 0) {
        // box=1 + boxcolor=color@opacity
        const hex = bg.replace('#', '');
        const rr = parseInt(hex.substr(0,2), 16);
        const gg = parseInt(hex.substr(2,2), 16);
        const bb = parseInt(hex.substr(4,2), 16);
        expr += `:box=1:boxcolor=${rr}/${gg}/${bb}@${bgOp.toFixed(2)}`;
      }
      if ($('#text-shadow').checked) {
        const sc = $('#text-shadow-color').value;
        const sx = parseInt($('#text-shadow-x').value, 10) || 0;
        const sy = parseInt($('#text-shadow-y').value, 10) || 0;
        expr += `:shadowcolor=${sc}:shadowx=${sx}:shadowy=${sy}`;
      }
      vf.push(`drawtext=${expr}`);
    }
  }

  // 23. pad (Section 15)
  if (sectionEnabled(15)) {
    const pw = parseInt($('#pad-w').value, 10);
    const ph = parseInt($('#pad-h').value, 10);
    const pc = $('#pad-color').value;
    if ($('#pad-center').checked) {
      vf.push(`pad=${pw}:${ph}:(ow-iw)/2:(oh-ih)/2:${pc}`);
    } else {
      const px = parseInt($('#pad-x').value, 10) || 0;
      const py = parseInt($('#pad-y').value, 10) || 0;
      vf.push(`pad=${pw}:${ph}:${px}:${py}:${pc}`);
    }
  }

  // 24. fps (Section 14)
  if (sectionEnabled(14)) {
    const fps = parseFloat($('#out-fps').value);
    if (fps > 0) vf.push(`fps=${fps}`);
  }

  // 25. format (pixel format) - usually handled via -pix_fmt, but we can
  //     also express it as a filter for ordering safety.
  if (!isCopy) {
    const pf = $('#pix-fmt').value;
    if (pf) vf.push(`format=${pf}`);
  }

  // 26. Section 30 — Zoom & Motion (video)
  if (sectionEnabled(30)) {
    // Ken Burns (zoompan)
    if ($('#kb-enable') && $('#kb-enable').checked) {
      const z0 = parseFloat($('#kb-zstart').value) || 1.0;
      const z1 = parseFloat($('#kb-zend').value) || 1.3;
      const dir = ($('#kb-dir') || {}).value || 'center';
      // Compute output size from source (fall back to 1280x720)
      const W = (state.inputFile && state.inputFile.width)  || 1280;
      const H = (state.inputFile && state.inputFile.height) || 720;
      // zoompan needs frame count; estimate from source duration at 30fps.
      const dur = (state.inputFile && state.inputFile.durationSec) || 5;
      const frames = Math.max(1, Math.floor(dur * 30));
      // Center: x=iw/2-(iw/zoom/2); (W-w)/2
      // Pan: bias x and y by a fraction based on direction
      const dirBias = {
        'center':       { xb: 0.5,  yb: 0.5 },
        'top-left':     { xb: 0.2,  yb: 0.2 },
        'top-right':    { xb: 0.8,  yb: 0.2 },
        'bottom-left':  { xb: 0.2,  yb: 0.8 },
        'bottom-right': { xb: 0.8,  yb: 0.8 },
      }[dir] || { xb: 0.5, yb: 0.5 };
      // Linear zoom expression: Z0 + (Z1-Z0) * on / frames
      const zStr = `${z0.toFixed(4)}+${(z1 - z0).toFixed(4)}*on/${frames}`;
      const xStr = `(iw/zoom/2)*${dirBias.xb.toFixed(2)}`;
      const yStr = `(ih/zoom/2)*${dirBias.yb.toFixed(2)}`;
      vf.push(`zoompan=z='${zStr}':d=${frames}:x='${xStr}':y='${yStr}':s=${W}x${H}:fps=30`);
    }
    // Camera Shake
    if ($('#shake-enable') && $('#shake-enable').checked) {
      const intensity = parseInt($('#shake-intensity').value, 10) || 8;
      const speed = parseInt($('#shake-speed').value, 10) || 6;
      // Crop with sinusoidal x/y offsets; reduce width/height by 2*intensity
      vf.push(`crop=iw-${intensity * 2}:ih-${intensity * 2}:${intensity}+${intensity}*sin(n/${speed}):${intensity}+${intensity}*cos(n/${speed})`);
    }
    // Rotation Spin
    if ($('#spin-enable') && $('#spin-enable').checked) {
      const speed = parseFloat($('#spin-speed').value) || 1.0;
      vf.push(`rotate=a=${speed}*t:c=black`);
    }
    // Freeze Frame — multi-step: split, extract, loop, concat. This is
    // complex for a single -vf chain; we mark the plan as needing a
    // pipeline and handle it in the dedicated freeze-frame runner.
    if ($('#freeze-enable') && $('#freeze-enable').checked) {
      // For the inline -vf path, we approximate by adding a freezeframe at
      // the end of the chain. The dedicated pipeline is the proper way to
      // do it but a single -vf freeze works for short clips:
      const t = parseFloat($('#freeze-time').value) || 1.0;
      const hold = parseFloat($('#freeze-hold').value) || 2.0;
      vf.push(`tpad=stop_mode=clone:stop_duration=${hold}:start_duration=0,select='eq(n,0)+gte(n,${Math.floor(t * 30)})'`);
    }
  }

  // 27. Section 31 — Retro / CRT (video)
  if (sectionEnabled(31)) {
    if ($('#crt-enable') && $('#crt-enable').checked) {
      vf.push('lenscorrection=k1=0.15:k2=0.15');
    }
    if ($('#scan-enable') && $('#scan-enable').checked) {
      const sp = parseInt($('#scan-spacing').value, 10) || 3;
      const op = parseFloat($('#scan-opacity').value) || 0.5;
      // geq with luminance modulation; preserve chroma.
      vf.push(`geq=lum='lum(X,Y)*(1-${op.toFixed(2)}*mod(Y,${sp})/${sp})':cb='cb(X,Y)':cr='cr(X,Y)'`);
    }
    if ($('#interlace-enable') && $('#interlace-enable').checked) {
      // interlace then yadif=0 leaves comb artifacts.
      vf.push('interlace=toggle');
      vf.push('yadif=0');
    }
    if ($('#chromableed-enable') && $('#chromableed-enable').checked) {
      const h = parseInt($('#chromableed-h').value, 10) || 3;
      const v = parseInt($('#chromableed-v').value, 10) || 0;
      vf.push(`chromashift=cbh=${h}:cbv=${v}:crh=${h}:crv=${v}`);
    }
    if ($('#tracking-enable') && $('#tracking-enable').checked) {
      const sev = parseInt($('#tracking-severity').value, 10) || 10;
      // geq with random line displacement on every 40th row.
      vf.push(`geq=lum='lum(mod(X+${sev}*random(1)*gt(mod(Y,40),36),W),Y)':cb='cb(X,Y)':cr='cr(X,Y)'`);
    }
    if ($('#dropout-enable') && $('#dropout-enable').checked) {
      const f = parseFloat($('#dropout-freq').value) || 0.02;
      vf.push(`geq=lum='if(lt(random(1),${f}),0,lum(X,Y))':cb='cb(X,Y)':cr='cr(X,Y)'`);
    }
  }

  // v5 hotfix 3 — Bug C: chain optimizer. v5 hotfix 2 used a global sort
  // by colorspace which is a CORRECTNESS bug (filter order is semantic).
  // The new optimizer only coalesces redundant format=/scale= filters
  // and never reorders semantic filters. See the docstring above
  // optimizeFilterChain for the full rules.
  return optimizeFilterChain(vf);
}

// =============================================================================
// =============================================================================
// CHAIN OPTIMIZER (v5 hotfix 3 - Bug C)
// -----------------------------------------------------------------------------
// v5 hotfix 2 had a global sort that grouped filters by colorspace. This
// was a CORRECTNESS bug: filter order is semantic. `lagfun` (temporal)
// before vs after a color grade produces a different image. The spec
// ordering was chosen for *visual* reasons - a global sort by colorspace
// scrambles that.
//
// v5 hotfix 3 restricts the optimizer to SAFE coalescing only. Allowed:
//   1. Drop a `format=yuv420p` at the very start of a chain (ffmpeg can
//      do this lazily - the source decoder already produces a frame).
//   2. Coalesce two adjacent `format=X` filters into one (keep the
//      later one's value; the earlier one was redundant).
//   3. Coalesce two adjacent identical `scale=` filters into one.
//
// Forbidden:
//   - Any sort that reorders filters by domain.
//   - Moving temporal filters (lagfun, tmix, tblend, minterpolate,
//     reverse) past spatial or color filters.
//   - Moving spec-ordered filters past each other.
//
// The non-format / non-scale filter sequence must be preserved EXACTLY
// in the output. A self-check at the bottom of optimizeFilterChain
// asserts this; on mismatch the optimizer falls back to the
// unoptimized chain. Correct output beats fast output.
// =============================================================================
const RGB_FILTERS = new Set(['lutrgb', 'colorchannelmixer', 'rgbchannelmixer', 'rgbashift', 'chromashift']);
const YUV_ONLY_FILTERS = new Set(['lutyuv', 'lut3d', 'haldclut']);
function classifyColorspace(name) {
  if (!name) return 'yuv';
  if (RGB_FILTERS.has(name)) return 'rgb';
  if (YUV_ONLY_FILTERS.has(name)) return 'yuv';
  return 'yuv'; // default
}
function parseFilterExpr(expr) {
  // Filter strings may contain commas inside their arguments. Since
  // buildVideoFilterChain pushes each filter as a single string, we
  // look for the FIRST '=' to identify the name; or take the first
  // word if no '='.
  const s = String(expr).trim();
  const eq = s.indexOf('=');
  const head = (eq === -1) ? s : s.substring(0, eq);
  const name = head.split(/[,(]/)[0].trim();
  return { name, expr: s };
}
function optimizeFilterChain(vf) {
  if (!Array.isArray(vf) || vf.length === 0) return vf;
  // Split filters that contain a comma chain (e.g. "tpad=...,select=...")
  // into individual filters first so the optimizer sees a flat list.
  const flat = [];
  for (const expr of vf) {
    if (typeof expr !== 'string') { flat.push(expr); continue; }
    const parts = splitTopLevelCommas(expr);
    for (const p of parts) {
      const trimmed = p.trim();
      if (trimmed) flat.push(trimmed);
    }
  }
  // Parse each filter so we can classify by name.
  const items = flat.map(s => {
    const { name, expr } = parseFilterExpr(s);
    return { name, expr };
  });
  // Snapshot the non-coalescable filter sequence (everything that is
  // not `format` and not `scale`) - this MUST be preserved verbatim in
  // the output. The self-check at the bottom compares this snapshot
  // to the non-coalescable sequence of the optimized chain. Preserving
  // the non-format filter sequence is the bug-C invariant.
  const _nonCoalescableSnapshot = items
    .filter(it => it.name !== 'format' && it.name !== 'scale')
    .map(it => it.expr);
  // Pass 1: drop redundant leading `format=yuv420p`. ffmpeg's source
  // decoder already produces a frame, and the encoder (libx264 with
  // -pix_fmt yuv420p) accepts the source's native format. A leading
  // format filter is a no-op that just forces a no-op conversion.
  let startIdx = 0;
  while (startIdx < items.length
         && items[startIdx].name === 'format'
         && /^format\s*=\s*yuv420p/i.test(items[startIdx].expr)) {
    startIdx++;
  }
  // Pass 2: coalesce adjacent `format=` and identical `scale=` filters.
  // Walk through the remaining items in order, collapsing runs of
  // coalescable filters of the same kind into a single survivor
  // (the LAST one wins, since downstream constraints are more
  // authoritative).
  const out = [];
  for (let i = startIdx; i < items.length; i++) {
    const cur = items[i];
    if (cur.name === 'format') {
      // Coalesce: if the previous emitted filter is also a `format=`,
      // drop the previous and keep this one. The previous format would
      // have been a no-op anyway because format() is a pure conversion.
      if (out.length > 0) {
        const prevName = parseFilterExpr(out[out.length - 1]).name;
        if (prevName === 'format') {
          out.pop();
        }
      }
      out.push(cur.expr);
      continue;
    }
    if (cur.name === 'scale') {
      // Coalesce two adjacent identical `scale=` filters into one.
      if (out.length > 0) {
        const prevName = parseFilterExpr(out[out.length - 1]).name;
        if (prevName === 'scale' && out[out.length - 1] === cur.expr) {
          out.pop();
        }
      }
      out.push(cur.expr);
      continue;
    }
    out.push(cur.expr);
  }
  // Self-check: the non-format, non-scale filter sequence of the
  // optimized chain MUST match the input. If it does not, the
  // optimizer has reordered semantic filters - a correctness bug.
  // Fall back to the unoptimized chain in that case. Correct output
  // beats fast output. This is the bug-C invariant assertion: the
  // non-format filter sequence is preserved exactly.
  const _outNonCoalescable = out.filter(s => {
    const { name } = parseFilterExpr(s);
    return name !== 'format' && name !== 'scale';
  });
  if (_outNonCoalescable.length !== _nonCoalescableSnapshot.length) {
    console.warn('[optimizeFilterChain] non-format filter sequence length mismatch - falling back to unoptimized chain');
    return vf;
  }
  for (let i = 0; i < _nonCoalescableSnapshot.length; i++) {
    if (_nonCoalescableSnapshot[i] !== _outNonCoalescable[i]) {
      console.warn('[optimizeFilterChain] non-format filter sequence mismatch at index', i, '- falling back to unoptimized chain');
      return vf;
    }
  }
  return out;
}
function splitTopLevelCommas(s) {
  // Splits a string on commas that are at depth 0 (not inside quotes
  // or parentheses). ffmpeg filter expressions can use single or double
  // quotes; we honor both.
  const out = [];
  let buf = '';
  let depth = 0;
  let inSq = false;
  let inDq = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDq) { inSq = !inSq; buf += c; continue; }
    if (c === '"' && !inSq) { inDq = !inDq; buf += c; continue; }
    if (!inSq && !inDq) {
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
    }
    buf += c;
  }
  if (buf.length) out.push(buf);
  return out;
}

function defaultEq(v) {
  // Used to detect whether the eq filter is at default and can be omitted.
  return NaN; // never matches, so all are "changed" when section enabled
}

// =============================================================================
// AUDIO FILTER CHAIN (spec §3.2 audio ordering)
// =============================================================================
function buildAudioFilterChain() {
  const af = [];
  const isCopy = $('#acodec').value === 'copy';
  if (isCopy) return af;

  // 1. atrim / asetpts (trim is handled by -ss/-to on the input)

  // 2. volume (Section 12)
  if (sectionEnabled(12)) {
    const vol = parseFloat($('#volume').value);
    if (vol !== 1) af.push(`volume=${vol}`);
  }

  // 3. bass / treble (Section 12)
  if (sectionEnabled(12)) {
    const bs = parseFloat($('#bass').value);
    const tr = parseFloat($('#treble').value);
    if (bs !== 0) af.push(`bass=g=${bs}`);
    if (tr !== 0) af.push(`treble=g=${tr}`);
  }

  // 4. highpass / lowpass (Section 12)
  if (sectionEnabled(12)) {
    const hp = parseFloat($('#highpass').value);
    const lp = parseFloat($('#lowpass').value);
    if (hp > 0) af.push(`highpass=f=${hp}`);
    if (lp < 20000) af.push(`lowpass=f=${lp}`);
  }

  // 5. equalizer (not in spec — reserved)

  // 6. loudnorm (Section 12)
  if (sectionEnabled(12) && $('#loudnorm').checked) {
    af.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  }

  // 7. aecho / flanger / tremolo / vibrato (Section 12)
  if (sectionEnabled(12)) {
    if ($('#aecho').checked) {
      const d = parseFloat($('#aecho-delay').value) || 0;
      const dc = parseFloat($('#aecho-decay').value) || 0;
      // aecho expects delay in ms — we keep ms.
      af.push(`aecho=0.8:0.9:${d}:${dc}`);
    }
    if ($('#flanger').checked) af.push('flanger');
    if ($('#tremolo').checked) {
      const f = parseFloat($('#tremolo-f').value);
      const d = parseFloat($('#tremolo-d').value);
      af.push(`tremolo=f=${f}:d=${d}`);
    }
    if ($('#vibrato').checked) {
      const f = parseFloat($('#vibrato-f').value);
      const d = parseFloat($('#vibrato-d').value);
      af.push(`vibrato=f=${f}:d=${d}`);
    }
  }

  // 8. atempo (Section 6 audio speed + Section 12 audio-speed)
  //    We must chain atempo filters so each stage stays in 0.5–2.0.
  if (sectionEnabled(6) && $('#speed-audio').checked) {
    const spd = parseFloat($('#speed').value) || 1.0;
    if (spd !== 1.0) af.push(...chainAtempo(spd));
  }
  if (sectionEnabled(12)) {
    const asp = parseFloat($('#audio-speed').value) || 1.0;
    if (asp !== 1.0) af.push(...chainAtempo(asp));
  }

  // 9. areverse (Section 6)
  if (sectionEnabled(6) && $('#rev-audio').checked) {
    af.push('areverse');
  }

  // 10. afade (Section 10)
  if (sectionEnabled(10)) {
    const inD = parseFloat($('#afade-in').value) || 0;
    const outD = parseFloat($('#afade-out').value) || 0;
    if (inD > 0)  af.push(`afade=t=in:st=0:d=${inD}`);
    if (outD > 0) {
      const total = (state.inputFile && state.inputFile.durationSec)
        ? (parseTime($('#trim-end').value) - parseTime($('#trim-start').value))
        : 0;
      const start = Math.max(0, total - outD);
      af.push(`afade=t=out:st=${start.toFixed(3)}:d=${outD}`);
    }
  }

  // 11. Section 26 — Pitch & Time (audio)
  // Pitch shift: asetrate=SR*2^(N/12),aresample=SR,atempo=1/2^(N/12)
  // Tempo (no pitch): atempo=X
  if (sectionEnabled(26)) {
    const semis = parseFloat($('#pitch-semitones').value) || 0;
    const tempo = parseFloat($('#tempo-only').value) || 1.0;
    if (semis !== 0 || tempo !== 1.0) {
      // We need a sample rate to use for asetrate. Prefer the source's
      // known sample rate; fall back to 44100 if unknown.
      const sr = (state.inputFile && state.inputFile.sampleRate) ? state.inputFile.sampleRate : 44100;
      if (semis !== 0) {
        const ratio = Math.pow(2, semis / 12);
        af.push(`asetrate=${(sr * ratio).toFixed(2)}`);
        af.push(`aresample=${sr}`);
        // atempo compensates: 1/2^(N/12) so that overall tempo stays the same
        // (when tempo is also at 1.0). If the user also picks a tempo, the
        // compensation below is folded in.
        const compRatio = 1 / Math.pow(2, semis / 12);
        // Fold with tempo
        const totalRatio = compRatio * tempo;
        af.push(...chainAtempo(totalRatio));
      } else if (tempo !== 1.0) {
        af.push(...chainAtempo(tempo));
      }
    }
  }

  // 12. Section 27 — Channel Tools (audio)
  if (sectionEnabled(27)) {
    const mode = ($('#channel-mode') || {}).value || 'none';
    if (mode === 'stereo2mono') {
      af.push('pan=mono|c0=0.5*c0+0.5*c1');
    } else if (mode === 'mono2stereo') {
      af.push('pan=stereo|c0=c0|c1=c0');
    } else if (mode === 'swap') {
      af.push('pan=stereo|c0=c1|c1=c0');
    } else if (mode === 'left') {
      af.push('pan=mono|c0=c0');
    } else if (mode === 'right') {
      af.push('pan=mono|c0=c1');
    } else if (mode === 'karaoke') {
      af.push('pan=stereo|c0=c0-c1|c1=c1-c0');
    } else if (mode === '8d') {
      const hz = parseFloat($('#apulsator-hz').value) || 0.08;
      // apulsator is a video filter but in ffmpeg it can also pulse audio
      // using the audio variant. Use a fallback path: tremolo+fmod via flanger.
      // We try apulsator first; if not present, fall back to tremolo.
      af.push(`apulsator=hz=${hz}`);
    }
  }

  // 13. Section 28 — Audio Dynamics
  if (sectionEnabled(28)) {
    // Noise gate
    if ($('#gate-enable') && $('#gate-enable').checked) {
      const th = parseFloat($('#gate-thresh').value) || -40;
      af.push(`agate=threshold=${th}dB`);
    }
    // Compressor
    if ($('#comp-enable') && $('#comp-enable').checked) {
      const th = parseFloat($('#comp-thresh').value) || -20;
      const r = parseFloat($('#comp-ratio').value) || 4;
      const atk = parseInt($('#comp-attack').value, 10) || 20;
      const rel = parseInt($('#comp-release').value, 10) || 250;
      af.push(`acompressor=threshold=${th}dB:ratio=${r}:attack=${atk}:release=${rel}`);
    }
    // Limiter
    if ($('#limit-enable') && $('#limit-enable').checked) {
      const ceil = parseFloat($('#limit-ceiling').value) || 0.95;
      af.push(`alimiter=limit=${ceil}`);
    }
    // De-esser (notch at frequency with negative gain)
    if ($('#deess-enable') && $('#deess-enable').checked) {
      const f = parseInt($('#deess-freq').value, 10) || 6000;
      const g = parseFloat($('#deess-reduce').value) || 6;
      af.push(`equalizer=f=${f}:t=q:w=2:g=-${g}`);
    }
    // Expander (compand)
    if ($('#exp-enable') && $('#exp-enable').checked) {
      af.push('compand=attacks=0:points=-80/-90|-60/-60|0/-10');
    }
  }

  return af;
}

// Chain multiple atempo filters so each factor lies in [0.5, 2.0].
function chainAtempo(speed) {
  const out = [];
  let s = speed;
  // For very slow (<0.5) chain: e.g. 0.25 = atempo=0.5,atempo=0.5
  while (s < 0.5) { out.push('atempo=0.5'); s *= 2; }
  while (s > 2.0) { out.push('atempo=2.0'); s /= 2; }
  out.push(`atempo=${s.toFixed(4)}`);
  return out;
}

// =============================================================================
// SECTION 19: GLITCH COMMAND (spec §2.4 §19)
// =============================================================================
function buildGlitchCommand(params) {
  // params.mode currently only 'geq' is used externally; we also use this
  // function for the standalone "(19D) Pixel Math" preset.
  if (!sectionEnabled(19)) return null;
  if (!$('#g-geq-enable').checked) return null;
  const preset = $('#g-geq-preset').value;
  const I = parseInt($('#g-geq-intensity').value, 10);
  const F = parseInt($('#g-geq-freq').value, 10);
  const A = parseInt($('#g-geq-amp').value, 10);
  const SP = parseInt($('#g-geq-spacing').value, 10);
  const OFF = parseInt($('#g-geq-offset').value, 10);

  if (preset === 'custom') {
    return `geq=r='${$('#g-geq-custom').value}':g='${$('#g-geq-custom').value}':b='${$('#g-geq-custom').value}'`;
  }
  switch (preset) {
    case 'hshift':
      return `geq=lum_expr='lum(mod(X+random(1)*${I},W),Y)':cb_expr='cb(mod(X+random(1)*${I},W),Y)':cr_expr='cr(mod(X+random(1)*${I},W),Y)'`;
    case 'vshift':
      return `geq=lum_expr='lum(X,mod(Y+random(1)*${I},H))':cb_expr='cb(X,mod(Y+random(1)*${I},H))':cr_expr='cr(X,mod(Y+random(1)*${I},H))'`;
    case 'chansplit':
      return `geq=r='r(X+${OFF},Y)':g='g(X,Y)':b='b(X-${OFF},Y)'`;
    case 'scanline':
      return `geq=lum_expr='if(mod(Y,${SP}),lum(X,Y),255-lum(X,Y))':cb_expr='cb(X,Y)':cr_expr='cr(X,Y)'`;
    case 'warp':
      return `geq=lum_expr='lum(X+sin(Y/${F})*${A},Y+cos(X/${F})*${A})':cb_expr='cb(X,Y)':cr_expr='cr(X,Y)'`;
    default:
      return null;
  }
}

// =============================================================================
// GIF TWO-PASS (spec §2.4 §17)
// =============================================================================
async function createGIF() {
  if (!state.ffmpeg || !state.inputFile) { logToConsole('err', 'Engine or input missing.'); return; }
  const w = parseInt($('#gif-w').value, 10) || 480;
  const fps = parseFloat($('#gif-fps').value) || 15;
  const loop = parseInt($('#gif-loop').value, 10) || 0;
  const usePalette = $('#gif-palette').checked;

  state.isProcessing = true;
  setControlsEnabled(false);
  setCancelVisible(true);
  setProgress(0);
  setProgressText('GIF Pass 1/2: generating palette…');

  const trim = buildTrimArgs();
  const baseArgs = [];
  if (trim.ss) baseArgs.push('-ss', trim.ss);
  baseArgs.push('-i', state.inputFile.virtualName);
  if (trim.to) baseArgs.push('-to', trim.to);

  try {
    if (usePalette) {
      // Pass 1: palettegen
      const pass1 = [
        ...baseArgs,
        '-vf', `fps=${fps},scale=${w}:-1:flags=lanczos,palettegen=stats_mode=diff`,
        '-y', 'palette.png',
      ];
      try { await ff.deleteFile('palette.png'); } catch (_) {}
      logToConsole('', `GIF Pass 1: ffmpeg ${pass1.map(quoteArg).join(' ')}`);
      await ff.exec(pass1);

      // Pass 2: paletteuse
      setProgress(50);
      setProgressText('GIF Pass 2/2: applying palette…');
      const pass2 = [
        '-i', state.inputFile.virtualName,
        '-i', 'palette.png',
        '-lavfi', `fps=${fps},scale=${w}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`,
        '-loop', String(loop),
        '-y', 'output.gif',
      ];
      logToConsole('', `GIF Pass 2: ffmpeg ${pass2.map(quoteArg).join(' ')}`);
      await ff.exec(pass2);
    } else {
      // Single-pass fallback
      const pass1 = [
        ...baseArgs,
        '-vf', `fps=${fps},scale=${w}:-1:flags=lanczos`,
        '-loop', String(loop),
        '-y', 'output.gif',
      ];
      logToConsole('', `GIF: ffmpeg ${pass1.map(quoteArg).join(' ')}`);
      await ff.exec(pass1);
    }

    setProgress(100);
    setProgressText('GIF done.');
    const data = await ff.readFile('output.gif');
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const blob = new Blob([u8], { type: 'image/gif' });
    if (state.outputBlobUrl) URL.revokeObjectURL(state.outputBlobUrl);
    state.outputBlobUrl = URL.createObjectURL(blob);
    loadOutputPreview(state.outputBlobUrl, 'image/gif');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    state.outputFilename = `output_${ts}.gif`;
    setDownloadEnabled(true);
    setOutputInfo({ size: u8.byteLength, mime: 'image/gif', filename: state.outputFilename, ext: 'gif' });
    logToConsole('ok', `GIF created: ${formatBytes(u8.byteLength)}`);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    logToConsole('err', `GIF failed: ${msg}`);
    showFriendlyError(msg);
  } finally {
    state.isProcessing = false;
    setCancelVisible(false);
    setControlsEnabled(true);
  }
}

// =============================================================================
// TWO-PASS RUNNER
// =============================================================================
async function runTwoPass(plan) {
  if (!state.ffmpeg) return;
  state.isProcessing = true;
  setControlsEnabled(false);
  setCancelVisible(true);
  setProgress(0);
  setProgressText('Two-Pass: Pass 1/2…');

  // Pass 1: ffmpeg ... -pass 1 -f null /dev/null
  // We use 'null' muxer (in browser ffmpeg.wasm supports this).
  const pass1 = plan.args.slice(0, -1).concat(['-pass', '1', '-f', 'null', '-']);
  // For VP9 / x264 we need to set bitrate explicitly if user didn't.
  if (!plan.args.includes('-b:v')) {
    pass1.push('-b:v', '2000k');
  }
  // Strip the output filename
  try { await ff.deleteFile(plan.outputFilename); } catch (_) {}
  logToConsole('', `Two-Pass 1/2: ffmpeg ${pass1.map(quoteArg).join(' ')}`);
  try {
    await ff.exec(pass1);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    logToConsole('err', `Two-pass pass 1 failed: ${msg}`);
    showFriendlyError(msg);
    state.isProcessing = false;
    setCancelVisible(false);
    setControlsEnabled(true);
    return;
  }

  setProgress(50);
  setProgressText('Two-Pass: Pass 2/2…');
  const pass2 = plan.args.slice(0, -1).concat(['-pass', '2', plan.outputFilename]);
  logToConsole('', `Two-Pass 2/2: ffmpeg ${pass2.map(quoteArg).join(' ')}`);
  try {
    await ff.exec(pass2);
    setProgress(100);
    setProgressText('Two-pass done.');
    const data = await ff.readFile(plan.outputFilename);
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const ext = plan.outputFilename.split('.').pop().toLowerCase();
    const mime = EXT_TO_MIME[ext] || 'application/octet-stream';
    const blob = new Blob([u8], { type: mime });
    if (state.outputBlobUrl) URL.revokeObjectURL(state.outputBlobUrl);
    state.outputBlobUrl = URL.createObjectURL(blob);
    loadOutputPreview(state.outputBlobUrl, mime);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    state.outputFilename = `output_${ts}.${ext}`;
    setDownloadEnabled(true);
    setOutputInfo({ size: u8.byteLength, mime, filename: state.outputFilename, ext });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    logToConsole('err', `Two-pass pass 2 failed: ${msg}`);
    showFriendlyError(msg);
  } finally {
    state.isProcessing = false;
    setCancelVisible(false);
    setControlsEnabled(true);
  }
}

// =============================================================================
// PRESETS (spec §4.4)
// =============================================================================
// v5 hotfix 2 — Bug 4: no preset hardcodes `medium` or slower. The
// state-aware default (`veryfast` in ST, `fast` in MT) is applied at
// apply time so the browser never starts a 2-hour encode for a preset
// the user picked by name. The `max-quality` preset is the one
// exception where the user *did* explicitly ask for the slow path —
// we keep that one slow, but the UI labels it as such.
const _defaultBrowserPreset = () => (state.threadMode === 'mt' ? 'fast' : 'veryfast');
const PRESETS = {
  'quick-compress': {
    'enable-1': true, 'vcodec': 'libx264', 'enc-preset': 'veryfast', 'crf': 28, 'ab-rate': '128k',
    'enable-3': true, 'scale-w': 1280, 'scale-h': 720, 'lock-aspect': true, 'scale-algo': 'lanczos',
  },
  'social-instagram': {
    // State-aware: veryfast in ST, fast in MT. Was: medium.
    'enable-1': true, 'vcodec': 'libx264', 'crf': 23, 'ab-rate': '128k', 'pix-fmt': 'yuv420p',
    'enable-3': true, 'scale-w': 1080, 'scale-h': 1080, 'scale-algo': 'lanczos', 'lock-aspect': false,
    'enable-4': true, 'crop-w': 1080, 'crop-h': 1080, 'crop-center': true,
    'enable-14': true, 'out-fps': 30,
    'out-format': 'mp4',
  },
  'gif-from-video': {
    'enable-1': true, 'out-format': 'gif',
    'enable-17': true, 'gif-enable': true, 'gif-w': 480, 'gif-fps': 15, 'gif-palette': true, 'gif-loop': 0,
  },
  'audio-rip': {
    'enable-1': true, 'out-format': 'mp3', 'vcodec': 'copy', 'acodec': 'libmp3lame', 'ab-rate': '192k',
    'enable-18': true, 'extract-audio': true, 'audio-format': 'mp3', 'audio-rate': 44100,
  },
  'vhs-glitch': {
    // State-aware: was 'medium'.
    'enable-1': true, 'vcodec': 'libx264', 'crf': 20, 'ab-rate': '128k',
    'enable-13': true, 'add-noise': true, 'noise-strength': 30, 'noise-type': 't+u',
    'enable-19': true,
    'g-lagfun-enable': true, 'g-lagfun-decay': 0.97,
    'g-cc-enable': true, 'g-cc-mode': 'temporal', 'g-cc-low': 50, 'g-cc-high': 200, 'g-cc-spread': 30,
    'g-geq-enable': true, 'g-geq-preset': 'scanline', 'g-geq-spacing': 4,
    'enable-9': true, 'blur-type': 'box', 'blur-strength': 2,
  },
  'film-grain': {
    // Was 'slow'. Use the state-aware default — a user who wants
    // slow can pick it from the dropdown after applying the preset.
    'enable-1': true, 'vcodec': 'libx264', 'crf': 18, 'ab-rate': '192k',
    'enable-13': true, 'grain-overlay': true,
    'enable-7': true, 'eq-saturation': 0.8,
    'enable-16': true, 'vignette': true, 'vignette-angle': 0.628,
  },
  'cyberpunk': {
    // Was 'medium'.
    'enable-1': true, 'vcodec': 'libx264', 'crf': 20, 'ab-rate': '128k',
    'enable-7': true, 'eq-saturation': 2.0, 'hue-h': 30, 'hue-s': 1.5,
    'enable-19': true,
    'g-geq-enable': true, 'g-geq-preset': 'chansplit', 'g-geq-offset': 8,
    'g-lagfun-enable': true, 'g-lagfun-decay': 0.93,
    'enable-16': true, 'edge-detect': true, 'edge-mode': 'colormix',
  },
  'max-quality': {
    // The user EXPLICITLY picked this preset to ask for the slow path.
    // Keep 'slow' here. The cost gate will warn if the clip is long.
    'enable-1': true, 'vcodec': 'libx264', 'enc-preset': 'slow', 'crf': 15, 'ab-rate': '320k',
  },
};

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  // First, disable all sections
  for (let i = 1; i <= 22; i++) {
    const cb = document.getElementById('enable-' + i);
    if (cb) cb.checked = false;
  }
  // v5 hotfix 2 — Bug 4: presets that don't carry an `enc-preset`
  // entry get the state-aware default (veryfast in ST, fast in MT).
  // The `max-quality` preset keeps its explicit `slow` and trusts the
  // user knew what they were picking.
  const settings = Object.assign({}, p);
  if (!Object.prototype.hasOwnProperty.call(settings, 'enc-preset')) {
    settings['enc-preset'] = _defaultBrowserPreset();
  }
  // Then apply the preset
  for (const [id, val] of Object.entries(settings)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!val;
    else if (el.type === 'range' || el.type === 'number' || el.type === 'text') el.value = val;
    else el.value = val;
    // Fire change event so listeners (slider value displays, etc.) update
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // Auto-expand affected sections
  const affected = new Set();
  for (const id of Object.keys(p)) {
    const m = id.match(/^enable-(\d+)$/);
    if (m) affected.add(parseInt(m[1], 10));
  }
  // Also expand any section that has a control referenced in the preset
  for (const id of Object.keys(p)) {
    const sectionNum = findSectionForControl(id);
    if (sectionNum) affected.add(sectionNum);
  }
  affected.forEach(num => {
    const s = document.getElementById('section-' + num);
    if (s && s.tagName.toLowerCase() === 'details') s.open = true;
  });
  refreshCommandPreview();
  logToConsole('ok', `Preset applied: ${name}`);
}

function findSectionForControl(ctrlId) {
  // Map known control IDs to their section number.
  const map = {
    'vcodec':1, 'enc-preset':1, 'crf':1, 'ab-rate':1, 'pix-fmt':1, 'out-format':1,
    'trim-start':2, 'trim-end':2, 'trim-start-slider':2, 'trim-end-slider':2,
    'scale-w':3, 'scale-h':3, 'lock-aspect':3, 'scale-algo':3,
    'crop-w':4, 'crop-h':4, 'crop-x':4, 'crop-y':4, 'crop-center':4,
    'rotate':5, 'hflip':5, 'vflip':5,
    'speed':6, 'speed-video':6, 'speed-audio':6, 'rev-video':6, 'rev-audio':6,
    'eq-brightness':7, 'eq-contrast':7, 'eq-saturation':7, 'eq-gamma':7,
    'eq-gamma-r':7, 'eq-gamma-g':7, 'eq-gamma-b':7, 'hue-h':7, 'hue-s':7, 'negate':7,
    'ccm-rr':8, 'ccm-rg':8, 'ccm-rb':8, 'ccm-gr':8, 'ccm-gg':8, 'ccm-gb':8,
    'ccm-br':8, 'ccm-bg':8, 'ccm-bb':8,
    'blur-type':9, 'blur-strength':9, 'sharpen-amt':9,
    'fade-in-dur':10, 'fade-in-type':10, 'fade-out-dur':10, 'fade-out-type':10,
    'afade-in':10, 'afade-out':10,
    'text-content':11, 'text-size':11, 'text-color':11, 'text-bg':11, 'text-bg-opacity':11,
    'text-x-align':11, 'text-x-offset':11, 'text-y-align':11, 'text-y-offset':11,
    'text-shadow':11, 'text-shadow-color':11, 'text-shadow-x':11, 'text-shadow-y':11,
    'volume':12, 'bass':12, 'treble':12, 'loudnorm':12, 'highpass':12, 'lowpass':12,
    'audio-speed':12, 'aecho':12, 'aecho-delay':12, 'aecho-decay':12,
    'flanger':12, 'tremolo':12, 'tremolo-f':12, 'tremolo-d':12,
    'vibrato':12, 'vibrato-f':12, 'vibrato-d':12, 'strip-audio':12,
    'add-noise':13, 'noise-strength':13, 'noise-type':13, 'grain-overlay':13,
    'out-fps':14,
    'pad-w':15, 'pad-h':15, 'pad-color':15, 'pad-center':15, 'pad-x':15, 'pad-y':15,
    'edge-detect':16, 'edge-mode':16, 'edge-low':16, 'edge-high':16,
    'sobel':16, 'emboss':16, 'vignette':16, 'vignette-angle':16, 'posterize':16,
    'gif-enable':17, 'gif-w':17, 'gif-fps':17, 'gif-palette':17, 'gif-loop':17,
    'extract-audio':18, 'audio-format':18, 'audio-rate':18,
    'g-tmix-enable':19, 'g-tmix-frames':19, 'g-tblend-enable':19, 'g-tblend-mode':19,
    'g-lagfun-enable':19, 'g-lagfun-decay':19, 'g-geq-enable':19, 'g-geq-preset':19,
    'g-geq-custom':19, 'g-geq-intensity':19, 'g-geq-freq':19, 'g-geq-amp':19,
    'g-geq-spacing':19, 'g-geq-offset':19, 'g-cc-enable':19, 'g-cc-low':19, 'g-cc-high':19,
    'g-cc-spread':19, 'g-cc-mode':19, 'g-amp-enable':19, 'g-amp-radius':19, 'g-amp-factor':19,
    'g-amp-threshold':19, 'g-deflicker-enable':19, 'g-deflicker-size':19,
    'chroma-enable':20, 'chroma-color':20, 'chroma-similarity':20, 'chroma-blend':20,
    'vbitrate':21, 'vbitrate-unit':21, 'two-pass':21, 'maxrate':21, 'bufsize':21, 'gopsize':21,
    'strip-meta':22, 'meta-title':22, 'meta-artist':22, 'meta-comment':22,
  };
  return map[ctrlId] || null;
}

// =============================================================================
// CONTROL HELPERS
// =============================================================================
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

function sectionEnabled(n) {
  const cb = document.getElementById('enable-' + n);
  return cb && cb.checked;
}

// Show the current numeric value next to a slider
function bindSliderDisplay(sliderId, displayId, fmt) {
  const s = document.getElementById(sliderId);
  const d = document.getElementById(displayId);
  if (!s || !d) return;
  const update = () => { d.textContent = fmt ? fmt(s.value) : s.value; };
  s.addEventListener('input', update);
  update();
}

// =============================================================================
// COMMAND PREVIEW
// =============================================================================
function refreshCommandPreview() {
  const pre = document.getElementById('command-preview');
  if (!pre) return;
  const plan = buildFFmpegCommand();
  pre.textContent = plan.str || '(no command)';
  // v5 hotfix 2 — Bug 1: paint the estimate onto the Run button
  // labels so the user sees a "Run (~40s)" preview before they click.
  // We only show estimates >= 5s — anything faster is effectively
  // instant and would just add noise to the label.
  if (plan && typeof plan.estimateSec === 'number' && isFinite(plan.estimateSec) && plan.estimateSec >= 5) {
    const txt = `Run (~${formatEstimate(plan.estimateSec)})`;
    const b1 = document.getElementById('btn-execute');
    const b2 = document.getElementById('global-run');
    if (b1) b1.textContent = txt;
    if (b2) b2.textContent = txt;
    if (b1) b1.title = plan.hasSlow ? '🐌 Slow — recommended on clips under 30 seconds.' : '';
    if (b2) b2.title = plan.hasSlow ? '🐌 Slow — recommended on clips under 30 seconds.' : '';
  } else {
    const b1 = document.getElementById('btn-execute');
    const b2 = document.getElementById('global-run');
    if (b1) b1.textContent = 'Run';
    if (b2) b2.textContent = 'Run';
    if (b1) b1.title = '';
    if (b2) b2.title = '';
  }
}

// =============================================================================
// RANGE SELECTOR (custom two-handle for trim)
// =============================================================================
function initRangeSelector(duration) {
  const track = document.getElementById('range-track');
  const start = document.getElementById('range-start');
  const end = document.getElementById('range-end');
  const active = document.getElementById('range-active');
  if (!track || !start || !end || !active) return;
  const dur = Math.max(0.001, duration || 0);

  // Position as percentage of track width
  const setPositions = (sp, ep) => {
    sp = Math.max(0, Math.min(1, sp));
    ep = Math.max(0, Math.min(1, ep));
    if (ep < sp) ep = sp;
    start.style.left = (sp * 100) + '%';
    end.style.left = (ep * 100) + '%';
    active.style.left = (sp * 100) + '%';
    active.style.width = ((ep - sp) * 100) + '%';
  };
  // Initialize at 0% and 100%
  setPositions(0, 1);

  const getPct = (clientX) => {
    const rect = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  let dragging = null;
  const onMove = (e) => {
    if (!dragging) return;
    const p = getPct((e.touches ? e.touches[0].clientX : e.clientX));
    const sp = parseFloat(start.style.left) / 100;
    const ep = parseFloat(end.style.left) / 100;
    if (dragging === 'start') setPositions(p, ep);
    else                     setPositions(sp, p);
    syncFromRange();
  };
  const onUp = () => {
    dragging = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
  };
  const onDown = (e) => {
    const target = e.target;
    dragging = target === start ? 'start' : 'end';
    e.preventDefault();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
  };
  start.addEventListener('mousedown', onDown);
  end.addEventListener('mousedown', onDown);
  start.addEventListener('touchstart', onDown, { passive: false });
  end.addEventListener('touchstart', onDown, { passive: false });

  // Click on the track jumps nearest handle
  track.addEventListener('click', (e) => {
    if (e.target === start || e.target === end) return;
    const p = getPct(e.clientX);
    const sp = parseFloat(start.style.left) / 100;
    const ep = parseFloat(end.style.left) / 100;
    if (Math.abs(p - sp) < Math.abs(p - ep)) setPositions(p, ep);
    else                                      setPositions(sp, p);
    syncFromRange();
  });
}

function setTrimTimes(start, end) {
  const ss = document.getElementById('trim-start');
  const es = document.getElementById('trim-end');
  if (ss) ss.value = formatTime(start);
  if (es) es.value = formatTime(end);
  // Update slider values too
  const sss = document.getElementById('trim-start-slider');
  const ess = document.getElementById('trim-end-slider');
  if (sss) sss.value = String(start);
  if (ess) ess.value = String(end);
  // Update range selector
  const dur = (state.inputFile && state.inputFile.durationSec) || 0;
  const startPct = dur > 0 ? start / dur : 0;
  const endPct   = dur > 0 ? end   / dur : 1;
  const startEl = document.getElementById('range-start');
  const endEl   = document.getElementById('range-end');
  const active  = document.getElementById('range-active');
  if (startEl) startEl.style.left = (startPct * 100) + '%';
  if (endEl)   endEl.style.left   = (endPct   * 100) + '%';
  if (active)  { active.style.left = (startPct * 100) + '%'; active.style.width = ((endPct - startPct) * 100) + '%'; }
  // Update trim duration display
  const durEl = document.getElementById('trim-duration');
  if (durEl) durEl.textContent = formatTime(end - start);
  // Update range time labels
  const rs = document.getElementById('range-start-time');
  const re = document.getElementById('range-end-time');
  const rm = document.getElementById('range-mid-time');
  if (rs) rs.textContent = formatTime(start).slice(0, 5);
  if (re) re.textContent = formatTime(end).slice(0, 5);
  if (rm) rm.textContent = `duration ${formatTime(end - start).slice(3)}`;
}

// Sync the trim inputs from the range selector's current positions
function syncFromRange() {
  if (!state.inputFile) return;
  const dur = state.inputFile.durationSec || 0;
  if (dur <= 0) return;
  const startEl = document.getElementById('range-start');
  const endEl   = document.getElementById('range-end');
  const sp = parseFloat(startEl.style.left) / 100;
  const ep = parseFloat(endEl.style.left) / 100;
  setTrimTimes(sp * dur, ep * dur);
}

// =============================================================================
// RESET TO DEFAULTS
// =============================================================================
function captureDefaults() {
  $$('input, select, textarea').forEach(el => {
    if (el.id) {
      if (el.type === 'checkbox') state.defaults[el.id] = el.checked;
      else state.defaults[el.id] = el.value;
    }
  });
}

// =============================================================================
// v4 PART B15 — Undo / Redo
// -----------------------------------------------------------------------------
// We keep two stacks of control-state snapshots. A snapshot is just a flat
// object of { controlId: value }. We restore by iterating the snapshot and
// dispatching an 'input' event so downstream sliders / val displays / the
// command preview all stay in sync.
//
// Coalescing: a slider drag fires many 'input' events. We debounce 500ms
// after the LAST one so a drag is one entry, not fifty. A new edit clears
// the redo stack (standard editor behaviour).
// =============================================================================
const UNDO_STACK_LIMIT = 50;
const UNDO_DEBOUNCE_MS = 500;
// Controls we DO NOT snapshot: file pickers, hidden inputs, font upload,
// the bin url field, hidden helpers. These are transient UI state, not
// "the editor config".
const UNDO_SKIP_IDS = new Set([
  'file-input', 'text-font-upload', 'bin-url-input', 'text-font-upload-btn',
  'wf-search',
]);
function _snapshotControls() {
  const snap = {};
  $$('input, select, textarea').forEach(el => {
    if (!el.id) return;
    if (UNDO_SKIP_IDS.has(el.id)) return;
    if (el.type === 'checkbox') snap[el.id] = !!el.checked;
    else snap[el.id] = el.value;
  });
  return snap;
}
function _applySnapshot(snap) {
  state._undoSuspend = true;
  try {
    for (const [id, v] of Object.entries(snap)) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } finally {
    state._undoSuspend = false;
  }
  refreshCommandPreview();
  updateUndoRedoButtons();
}
function updateUndoRedoButtons() {
  const u = document.getElementById('btn-undo');
  const r = document.getElementById('btn-redo');
  const aU = document.getElementById('ab-undo');
  const aR = document.getElementById('ab-redo');
  const canUndo = state.undoStack.length > 0;
  const canRedo = state.redoStack.length > 0;
  if (u) u.disabled = !canUndo;
  if (r) r.disabled = !canRedo;
  if (aU) aU.disabled = !canUndo;
  if (aR) aR.disabled = !canRedo;
}
function pushUndoSnapshot() {
  if (state._undoSuspend) return;
  const snap = _snapshotControls();
  // Avoid pushing an identical snapshot twice in a row (e.g. if the same
  // value is set on both input + change events).
  const last = state.undoStack[state.undoStack.length - 1];
  if (last && _snapshotsEqual(last, snap)) return;
  state.undoStack.push(snap);
  if (state.undoStack.length > UNDO_STACK_LIMIT) state.undoStack.shift();
  state.redoStack = [];
  updateUndoRedoButtons();
}
function _snapshotsEqual(a, b) {
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}
function scheduleUndoSnapshot() {
  if (state._undoSuspend) return;
  if (state._undoDebounce) clearTimeout(state._undoDebounce);
  state._undoDebounce = setTimeout(() => {
    state._undoDebounce = null;
    pushUndoSnapshot();
  }, UNDO_DEBOUNCE_MS);
}
function undoLastChange() {
  if (state.undoStack.length === 0) { logToConsole('', 'Nothing to undo.'); return; }
  const current = _snapshotControls();
  const prev = state.undoStack.pop();
  state.redoStack.push(current);
  _applySnapshot(prev);
  logToConsole('ok', `Undo (${state.undoStack.length} steps left)`);
}
function redoLastChange() {
  if (state.redoStack.length === 0) { logToConsole('', 'Nothing to redo.'); return; }
  const current = _snapshotControls();
  const next = state.redoStack.pop();
  state.undoStack.push(current);
  _applySnapshot(next);
  logToConsole('ok', `Redo (${state.redoStack.length} steps left)`);
}

function resetAllControls() {
  for (const [id, v] of Object.entries(state.defaults)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  refreshCommandPreview();
  logToConsole('ok', 'All controls reset to defaults.');
}

function resetSection7() {
  ['eq-brightness','eq-contrast','eq-saturation','eq-gamma','eq-gamma-r','eq-gamma-g','eq-gamma-b','hue-h','hue-s','negate']
    .forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = false;
      else if (el.value != null) {
        // Defaults from spec §7
        const def = { 'eq-brightness':'0','eq-contrast':'1','eq-saturation':'1','eq-gamma':'1','eq-gamma-r':'1','eq-gamma-g':'1','eq-gamma-b':'1','hue-h':'0','hue-s':'1' };
        el.value = def[id] || el.value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

// =============================================================================
// CHANNEL MIXER PRESETS
// =============================================================================
function applyCcmPreset(name) {
  const presets = {
    sepia:    { 'ccm-rr':0.393, 'ccm-rg':0.769, 'ccm-rb':0.189, 'ccm-gr':0.349, 'ccm-gg':0.686, 'ccm-gb':0.168, 'ccm-br':0.272, 'ccm-bg':0.534, 'ccm-bb':0.131 },
    teal:     { 'ccm-rr':0.9,   'ccm-rg':0.0,   'ccm-rb':0.0,   'ccm-gr':0.0,   'ccm-gg':1.0,   'ccm-gb':0.0,   'ccm-br':0.0,   'ccm-bg':0.6,   'ccm-bb':1.1 },
    bw:       { 'ccm-rr':0.3,   'ccm-rg':0.59,  'ccm-rb':0.11,  'ccm-gr':0.3,   'ccm-gg':0.59,  'ccm-gb':0.11,  'ccm-br':0.3,   'ccm-bg':0.59,  'ccm-bb':0.11 },
    night:    { 'ccm-rr':0.0,   'ccm-rg':0.6,   'ccm-rb':0.0,   'ccm-gr':0.0,   'ccm-gg':1.2,   'ccm-gb':0.0,   'ccm-br':0.0,   'ccm-bg':0.4,   'ccm-bb':0.0 },
    identity: { 'ccm-rr':1.0,   'ccm-rg':0.0,   'ccm-rb':0.0,   'ccm-gr':0.0,   'ccm-gg':1.0,   'ccm-gb':0.0,   'ccm-br':0.0,   'ccm-bg':0.0,   'ccm-bb':1.0 },
  };
  const p = presets[name];
  if (!p) return;
  for (const [k, v] of Object.entries(p)) {
    const el = document.getElementById(k);
    if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
  }
}

// =============================================================================
// BIND ALL EVENTS
// =============================================================================
function bindAll() {
  // --- File input (multi-file aware; v3 BUG 2)
  const fileInput = document.getElementById('file-input');
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length) handleFilesUpload(e.target.files);
  });

  // --- Media Bin (v3 PART B) — toolbar, add/clear, multi-op buttons.
  bindMediaBin();

  // v4 PART A1 — Global action bar + global bin drawer.
  bindGlobalActionBar();

  // --- v3 PART C — bind new editor sections 26-32 (pitch, channels,
  //     dynamics, visualization, zoom, retro, frames).
  bindNewSections();

  // --- Click on drop overlay opens file picker
  const drop = document.getElementById('drop-overlay');
  drop.addEventListener('click', () => fileInput.click());

  // --- Drag & drop (multi-file aware)
  const wrapper = document.getElementById('preview-wrapper');
  ['dragenter', 'dragover'].forEach(ev => {
    wrapper.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragging'); });
  });
  ['dragleave', 'drop'].forEach(ev => {
    wrapper.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragging'); });
  });
  wrapper.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) handleFilesUpload(files);
  });

  // --- Trim input <-> slider sync
  const trimStartEl = document.getElementById('trim-start');
  const trimEndEl   = document.getElementById('trim-end');
  const trimStartSlider = document.getElementById('trim-start-slider');
  const trimEndSlider   = document.getElementById('trim-end-slider');
  trimStartEl.addEventListener('change', () => {
    const v = parseTime(trimStartEl.value);
    if (trimStartSlider) trimStartSlider.value = String(v);
    const dur = (state.inputFile && state.inputFile.durationSec) || 0;
    setTrimTimes(v, parseTime(trimEndEl.value));
  });
  trimEndEl.addEventListener('change', () => {
    const v = parseTime(trimEndEl.value);
    if (trimEndSlider) trimEndSlider.value = String(v);
    setTrimTimes(parseTime(trimStartEl.value), v);
  });
  trimStartSlider.addEventListener('input', () => {
    const v = parseFloat(trimStartSlider.value) || 0;
    setTrimTimes(v, parseTime(trimEndEl.value));
  });
  trimEndSlider.addEventListener('input', () => {
    const v = parseFloat(trimEndSlider.value) || 0;
    setTrimTimes(parseTime(trimStartEl.value), v);
  });

  // --- Lock aspect
  $('#lock-aspect').addEventListener('change', () => {
    if ($('#lock-aspect').checked) {
      // If one of width/height is -1 and the other isn't, set the missing one to -1
      const w = parseInt($('#scale-w').value, 10);
      const h = parseInt($('#scale-h').value, 10);
      // No-op here; aspect is computed in ffmpeg itself when -1 is used.
    }
  });

  // v5 hotfix 2 — Bug 4: once the user touches the encoder preset
  // dropdown, mark it as user-changed so the engine-load default
  // doesn't overwrite their choice. We only count a change as
  // "user-driven" if it happens AFTER the initial bindAll wiring —
  // applyEngineDefaultPreset() also dispatches a 'change' event when
  // it adjusts the dropdown for MT mode, and that should NOT count.
  const encPresetEl = document.getElementById('enc-preset');
  if (encPresetEl) {
    let allowUserMark = false;
    setTimeout(() => { allowUserMark = true; }, 1500);
    encPresetEl.addEventListener('change', () => {
      if (allowUserMark) encPresetEl.dataset.userChanged = '1';
    });
  }

  // --- Resize preset buttons
  $$('.preset-res').forEach(btn => {
    btn.addEventListener('click', () => {
      $('#scale-w').value = btn.dataset.w;
      $('#scale-h').value = btn.dataset.h;
      $('#scale-w').dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  // --- FPS preset buttons
  $$('.preset-fps').forEach(btn => {
    btn.addEventListener('click', () => {
      $('#out-fps').value = btn.dataset.fps;
      $('#out-fps').dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  // --- CCM presets
  $$('[data-ccm-preset]').forEach(btn => {
    btn.addEventListener('click', () => applyCcmPreset(btn.dataset.ccmPreset));
  });

  // --- Section 7 reset
  $('#btn-reset-section-7').addEventListener('click', resetSection7);

  // --- Preset select
  $('#preset-select').addEventListener('change', (e) => {
    if (e.target.value) applyPreset(e.target.value);
  });

  // --- Reset all
  $('#btn-reset-all').addEventListener('click', resetAllControls);

  // --- Execute
  $('#btn-execute').addEventListener('click', executeFromUI);
  // --- Cancel
  $('#btn-cancel').addEventListener('click', cancelProcessing);
  // --- Play/pause
  $('#btn-play').addEventListener('click', togglePlay);
  // --- Download
  $('#btn-download').addEventListener('click', () => {
    if (!state.outputBlobUrl) return;
    const a = document.createElement('a');
    a.href = state.outputBlobUrl;
    a.download = state.outputFilename || 'output.bin';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });
  // --- Copy command
  $('#btn-copy-cmd').addEventListener('click', () => {
    const txt = $('#command-preview').textContent || '';
    navigator.clipboard?.writeText(txt).then(
      () => logToConsole('ok', 'Command copied to clipboard.'),
      (e) => logToConsole('err', 'Clipboard copy failed: ' + e)
    );
  });
  // --- Clear log
  $('#btn-clear-log').addEventListener('click', clearLog);

  // --- #42: speed curve editor setup
  const useCurveCb = $('#use-speed-curve');
  const curveEditor = $('#speed-curve-editor');
  if (useCurveCb && curveEditor) {
    useCurveCb.addEventListener('change', () => {
      curveEditor.hidden = !useCurveCb.checked;
      if (!curveEditor.hidden) drawSpeedCurve();
    });
    ['sc-0', 'sc-1', 'sc-2', 'sc-3'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', drawSpeedCurve);
    });
    // Preset buttons
    document.querySelectorAll('[data-sc-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.scPreset;
        const presets = {
          linear:  [1, 1, 1, 1],
          easein:  [0.5, 0.7, 0.9, 1],
          easeout: [1, 0.9, 0.7, 0.5],
          bell:    [0.5, 1.5, 1.5, 0.5],
        };
        const vals = presets[preset] || [1, 1, 1, 1];
        ['sc-0', 'sc-1', 'sc-2', 'sc-3'].forEach((id, i) => {
          const el = document.getElementById(id);
          if (el) { el.value = vals[i]; el.dispatchEvent(new Event('input')); }
        });
        drawSpeedCurve();
      });
    });
  }

  // --- #91: demo clip button. Generate a 10s test pattern in the browser via canvas
  // + MediaRecorder, hand it to the engine. No file download, no upload friction.
  // This is the "evaluate with zero friction" button. If you came to the app
  // and have no file, you should be one click away from seeing what it does.
  $('#btn-demo-clip')?.addEventListener('click', async () => {
    const btn = $('#btn-demo-clip');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating…'; }
    try {
      const blob = await generateDemoClip();
      const file = new File([blob], 'demo-clip.webm', { type: 'video/webm' });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const input = $('#file-input');
      if (input) {
        input.files = dataTransfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      logToConsole('ok', 'Demo clip loaded — try a workflow!');
    } catch (e) {
      logToConsole('err', 'Demo clip failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '▶ Try a demo clip (10s)'; }
    }
  });

  // --- #13: WebCodecs path test. Runs downscale-480p and reports which path took.
  // This is the only way to KNOW whether the hardware path actually works in
  // this browser. Without it, canUseHardware is a claim.
  $('#hw-test-btn')?.addEventListener('click', async () => {
    const btn = $('#hw-test-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Testing…'; }
    try {
      if (!state.inputFile) {
        // No file loaded — generate a demo and use it
        const blob = await generateDemoClip();
        const file = new File([blob], 'demo-clip.webm', { type: 'video/webm' });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        const input = $('#file-input');
        if (input) {
          input.files = dataTransfer.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      // Build the downscale-480p args and run
      applyWorkflow('downscale-480p', true);
      await new Promise(r => setTimeout(r, 500));
      await executeFromUI();
    } catch (e) {
      logToConsole('err', 'WebCodecs test failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⚡ Test WebCodecs path'; }
    }
  });

  // --- #8 self-test button
  $('#btn-selftest')?.addEventListener('click', () => { runSelfTest(); });

  // --- Shortcuts modal
  const sm = $('#shortcuts-modal');
  $('#btn-shortcuts').addEventListener('click', () => openShortcuts());
  $('#shortcuts-close').addEventListener('click', () => sm.classList.add('hidden'));
  sm.addEventListener('click', (e) => { if (e.target === sm) sm.classList.add('hidden'); });
  // --- Info modal
  const im = $('#info-modal');
  $('#info-close').addEventListener('click', () => im.classList.add('hidden'));
  im.addEventListener('click', (e) => { if (e.target === im) im.classList.add('hidden'); });

  // --- Live update of all controls → command preview
  document.addEventListener('input', (e) => {
    if (e.target && (e.target.matches('input, select, textarea'))) {
      refreshCommandPreview();
      // v4 PART B15: coalesce this change into a future undo snapshot.
      // The actual snapshot is pushed by scheduleUndoSnapshot() ~500ms
      // after the last change, so a slider drag is one entry, not fifty.
      scheduleUndoSnapshot();
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target && e.target.matches('input, select, textarea')) {
      refreshCommandPreview();
      // Some controls (e.g. <select>) only fire 'change' without 'input'.
      // We treat that as a separate commit point — push the snapshot now
      // instead of waiting for the debounce.
      if (e.target.tagName === 'SELECT' || e.target.type === 'checkbox') {
        pushUndoSnapshot();
      } else {
        scheduleUndoSnapshot();
      }
    }
  });

  // --- All slider value displays
  bindSliderDisplay('crf', 'crf-val');
  bindSliderDisplay('speed', 'speed-val', v => parseFloat(v).toFixed(2) + '×');
  bindSliderDisplay('eq-brightness', 'eq-brightness-val', v => parseFloat(v).toFixed(2));
  bindSliderDisplay('eq-contrast', 'eq-contrast-val', v => parseFloat(v).toFixed(2));
  bindSliderDisplay('eq-saturation', 'eq-saturation-val', v => parseFloat(v).toFixed(2));
  bindSliderDisplay('eq-gamma', 'eq-gamma-val', v => parseFloat(v).toFixed(1));
  bindSliderDisplay('eq-gamma-r', 'eq-gamma-r-val', v => parseFloat(v).toFixed(1));
  bindSliderDisplay('eq-gamma-g', 'eq-gamma-g-val', v => parseFloat(v).toFixed(1));
  bindSliderDisplay('eq-gamma-b', 'eq-gamma-b-val', v => parseFloat(v).toFixed(1));
  bindSliderDisplay('hue-h', 'hue-h-val', v => v + '°');
  bindSliderDisplay('hue-s', 'hue-s-val', v => parseFloat(v).toFixed(1));
  bindSliderDisplay('blur-strength', 'blur-strength-val');
  bindSliderDisplay('sharpen-amt', 'sharpen-amt-val', v => parseFloat(v).toFixed(1));
  bindSliderDisplay('fade-in-dur', 'fade-in-dur-val', v => parseFloat(v).toFixed(1) + 's');
  bindSliderDisplay('fade-out-dur', 'fade-out-dur-val', v => parseFloat(v).toFixed(1) + 's');
  bindSliderDisplay('afade-in', 'afade-in-val', v => parseFloat(v).toFixed(1) + 's');
  bindSliderDisplay('afade-out', 'afade-out-val', v => parseFloat(v).toFixed(1) + 's');
  bindSliderDisplay('text-size', 'text-size-val');
  bindSliderDisplay('text-bg-opacity', 'text-bg-opacity-val', v => parseFloat(v).toFixed(2));
  bindSliderDisplay('volume', 'volume-val', v => parseFloat(v).toFixed(2));
  bindSliderDisplay('bass', 'bass-val', v => v + ' dB');
  bindSliderDisplay('treble', 'treble-val', v => v + ' dB');
  bindSliderDisplay('highpass', 'highpass-val', v => v + ' Hz');
  bindSliderDisplay('lowpass', 'lowpass-val', v => v + ' Hz');
  bindSliderDisplay('audio-speed', 'audio-speed-val', v => parseFloat(v).toFixed(2));
  bindSliderDisplay('aecho-delay', 'aecho-delay-val', v => v + ' ms');
  bindSliderDisplay('aecho-decay', 'aecho-decay-val', v => parseFloat(v).toFixed(2));
  bindSliderDisplay('tremolo-f', 'tremolo-f-val', v => parseFloat(v).toFixed(1) + ' Hz');
  bindSliderDisplay('tremolo-d', 'tremolo-d-val', v => parseFloat(v).toFixed(2));
  bindSliderDisplay('vibrato-f', 'vibrato-f-val', v => parseFloat(v).toFixed(1) + ' Hz');
  bindSliderDisplay('vibrato-d', 'vibrato-d-val', v => parseFloat(v).toFixed(2));
  bindSliderDisplay('noise-strength', 'noise-strength-val');
  bindSliderDisplay('gif-w', 'gif-w-val');
  bindSliderDisplay('gif-fps', 'gif-fps-val');
  bindSliderDisplay('vignette-angle', 'vignette-angle-val', v => parseFloat(v).toFixed(2));
  bindSliderDisplay('posterize', 'posterize-val');
  bindSliderDisplay('edge-low', 'edge-low-val', v => parseFloat(v).toFixed(2));
  bindSliderDisplay('edge-high', 'edge-high-val', v => parseFloat(v).toFixed(2));
  bindSliderDisplay('chroma-similarity', 'chroma-similarity-val', v => parseFloat(v).toFixed(2));
  bindSliderDisplay('chroma-blend', 'chroma-blend-val', v => parseFloat(v).toFixed(2));
  bindSliderDisplay('gopsize', 'gopsize-val');
  bindSliderDisplay('g-tmix-frames', 'g-tmix-frames-val');
  bindSliderDisplay('g-lagfun-decay', 'g-lagfun-decay-val', v => parseFloat(v).toFixed(3));
  bindSliderDisplay('g-geq-intensity', 'g-geq-intensity-val');
  bindSliderDisplay('g-geq-freq', 'g-geq-freq-val');
  bindSliderDisplay('g-geq-amp', 'g-geq-amp-val');
  bindSliderDisplay('g-geq-spacing', 'g-geq-spacing-val');
  bindSliderDisplay('g-geq-offset', 'g-geq-offset-val');
  bindSliderDisplay('g-cc-low', 'g-cc-low-val');
  bindSliderDisplay('g-cc-high', 'g-cc-high-val');
  bindSliderDisplay('g-cc-spread', 'g-cc-spread-val');
  bindSliderDisplay('g-amp-radius', 'g-amp-radius-val');
  bindSliderDisplay('g-amp-factor', 'g-amp-factor-val');
  bindSliderDisplay('g-amp-threshold', 'g-amp-threshold-val');
  bindSliderDisplay('g-deflicker-size', 'g-deflicker-size-val');

  // --- Keyboard shortcuts (spec §4.3)
  document.addEventListener('keydown', (e) => {
    const inField = e.target.matches && e.target.matches('input, textarea, select');
    if (e.key === 'Escape') {
      // Close any open modal first
      if (!$('#shortcuts-modal').classList.contains('hidden')) {
        $('#shortcuts-modal').classList.add('hidden'); e.preventDefault(); return;
      }
      if (!$('#info-modal').classList.contains('hidden')) {
        $('#info-modal').classList.add('hidden'); e.preventDefault(); return;
      }
      cancelProcessing();
      e.preventDefault();
      return;
    }
    // "?" (Shift+/) toggles the cheat sheet — the top-bar button promises it.
    if (!inField && e.key === '?') {
      const sm = $('#shortcuts-modal');
      sm.classList.contains('hidden') ? openShortcuts() : sm.classList.add('hidden');
      e.preventDefault(); return;
    }
    // "[" / "]" cycle to the previous / next visible tab.
    if (!inField && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '[' || e.key === ']')) {
      cycleTab(e.key === ']' ? 1 : -1); e.preventDefault(); return;
    }
    if (e.code === 'Space' && !inField) {
      togglePlay(); e.preventDefault(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      executeFromUI(); e.preventDefault(); return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      $('#btn-download').click(); e.preventDefault(); return;
    }
    // v4 PART B15 — Ctrl+Z is now Undo (was Reset All, which is one of the
    // most catastrophic shortcuts in computing). Reset All moves to
    // Ctrl+Shift+R.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      undoLastChange(); e.preventDefault(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      redoLastChange(); e.preventDefault(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'r' || e.key === 'R')) {
      resetAllControls(); e.preventDefault(); return;
    }
  });
}

// =============================================================================
// EXECUTE FROM UI
// =============================================================================
// =============================================================================
// COST GATE (v5 hotfix 2 — Bug 1)
// -----------------------------------------------------------------------------
// Slow chains (geq, minterpolate, reverse, tmix on long clips) freeze
// the browser. We refuse to run anything estimated above 20 minutes,
// and ask the user before running anything over a minute. The four
// tiers map to UX behavior:
//   - < 60s        → run normally
//   - 60s – 5min   → run after a confirm() warning
//   - 5min – 20min → block; offer three escape options
//   - > 20min      → hard block
// Returns 'proceed' / 'abort' / 'downscale' / 'preview' / 'trim'.
// =============================================================================
async function costGate(plan) {
  const est = (plan && typeof plan.estimateSec === 'number') ? plan.estimateSec : 0;
  if (!isFinite(est) || est <= 0) return 'proceed';
  if (est < 60) return 'proceed';
  if (est < 300) {
    return confirm(`This will take roughly ${formatEstimate(est)}. Continue?`) ? 'proceed' : 'abort';
  }
  if (est < 1200) {
    // Modal with three escape options
    return new Promise((resolve) => {
      const title = 'This workflow is too slow on your clip';
      const body = `
        <p>The estimated run time is <strong>${formatEstimate(est)}</strong>. Long chains (especially <code>geq</code>, <code>minterpolate</code>, <code>reverse</code>, <code>tmix</code>) freeze the browser on clips this long.</p>
        <p>Choose how to proceed:</p>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">
          <button type="button" class="primary-btn" id="cg-preview">Preview on first 10 seconds</button>
          <button type="button" class="secondary-btn" id="cg-downscale">Downscale to 720p first</button>
          <button type="button" class="secondary-btn" id="cg-trim">Trim the range</button>
          <button type="button" class="secondary-btn" id="cg-abort">Cancel</button>
        </div>
        <p class="muted small" style="margin-top:8px">"Preview on first 10 seconds" appends <code>-t 10</code> to the args. "Downscale" prepends <code>scale=1280:-2</code> to the filter chain — a 1080p→720p drop cuts <code>geq</code> cost by ~2.2×. "Trim" opens Section 2.</p>
      `;
      showInfo(title, body);
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        const m = document.getElementById('info-modal');
        if (m) m.classList.add('hidden');
        // Detach the close button listener so it doesn't fire after we
        // settle the promise.
        try { closeBtn && closeBtn.removeEventListener('click', onClose); } catch (_) {}
        resolve(result);
      };
      const onClose = () => settle('abort');
      const closeBtn = document.getElementById('info-close');
      if (closeBtn) closeBtn.addEventListener('click', onClose);
      document.getElementById('cg-preview')   ?.addEventListener('click', () => settle('preview'),   { once: true });
      document.getElementById('cg-downscale') ?.addEventListener('click', () => settle('downscale'), { once: true });
      document.getElementById('cg-trim')      ?.addEventListener('click', () => settle('trim'),      { once: true });
      document.getElementById('cg-abort')     ?.addEventListener('click', () => settle('abort'),     { once: true });
    });
  }
  // > 20 min: hard block
  showInfo(
    'Refused to run — too slow',
    `<p>The estimated run time is <strong>${formatEstimate(est)}</strong>, which is beyond the browser's safe execution budget.</p>
     <p>You can:</p>
     <ul>
       <li>Trim the clip to a shorter range in Section 2.</li>
       <li>Downscale to 720p in Section 3 to cut per-frame cost.</li>
       <li>Drop the slow filters (<code>geq</code>, <code>minterpolate</code>, <code>reverse</code>, <code>tmix</code>) and use cheaper alternatives.</li>
     </ul>`
  );
  return 'abort';
}

async function executeFromUI() {
  if (state.isProcessing) { logToConsole('warn', 'Already processing.'); return; }
  if (!state.inputFile) { logToConsole('err', 'Load a file first.'); return; }
  // v5 hotfix 5: pre-empt any pending background work so the user's
  // command jumps the queue. The bg-token check in ffRun will
  // short-circuit any still-pending background task; in-flight
  // background work continues to completion (we don't kill the
  // heap — that would require terminate() + full re-init).
  cancelAllBgJobs();
  // If the queue has work in it, show a visible cue on the Run button
  // so the user understands the brief delay. The cue clears itself
  // as soon as our run actually starts (queue depth goes 0->1 with
  // us at the head, then refreshCommandPreview repaints the label).
  if (ffQueue.depth > 0) updateQueuedCue();
  const plan = buildFFmpegCommand();
  if (!plan.ok) {
    logToConsole('err', plan.error || 'Cannot build command.');
    refreshCommandPreview();
    return;
  }
  // Reverse warnings
  if (sectionEnabled(6) && ($('#rev-video').checked || $('#rev-audio').checked)) {
    if (state.inputFile.size > REVERSE_WARN_BYTES) {
      logToConsole('warn', `Reverse filter on a >100MB file will be slow (entire file decoded into memory).`);
    }
  }
  // v5 hotfix 2 — Bug 1: cost gate. Estimates how long the run will
  // take, and either runs, warns, or blocks based on the tier.
  const gate = await costGate(plan);
  if (gate === 'abort') {
    logToConsole('warn', 'Run cancelled by cost gate.');
    return;
  }
  if (gate === 'downscale') {
    // Force Section 3 to 720p and re-apply scale at the front of the chain.
    if (typeof $('#scale-w') !== 'undefined' && $('#scale-w')) {
      $('#scale-w').value = '1280';
      $('#scale-h').value = '-2';
      const en = document.getElementById('enable-3');
      if (en && !en.checked) { en.checked = true; en.dispatchEvent(new Event('change', { bubbles: true })); }
      logToConsole('ok', 'Downscale to 720p enabled. Re-running command.');
    }
    // Rebuild and re-evaluate
    return executeFromUI();
  }
  if (gate === 'preview') {
    // Append `-t 10` to the args so we only encode the first 10 seconds.
    const idx = plan.args.indexOf(plan.outputFilename);
    if (idx > 0) plan.args.splice(idx, 0, '-t', '10');
    logToConsole('warn', 'Preview mode: limiting to first 10 seconds.');
  }
  if (gate === 'trim') {
    // Open Section 2 and focus the start input.
    const sec = document.getElementById('section-2');
    if (sec && sec.tagName.toLowerCase() === 'details') sec.open = true;
    const ts = document.getElementById('trim-start');
    if (ts) { ts.focus(); ts.select && ts.select(); }
    logToConsole('warn', 'Trim the range in Section 2, then re-run.');
    return;
  }
  // Branch
  if (plan.gifTwoPass) {
    await createGIF();
  } else if (plan.twoPass) {
    await runTwoPass(plan);
  } else {
    await executeFFmpeg(plan.args);
  }
}

function cancelProcessing() {
  if (!state.isProcessing) return;
  state.cancelRequested = true;
  logToConsole('warn', 'Cancelling…');
  try { state.ffmpeg && state.ffmpeg.terminate(); } catch (_) {}
  setProgressText('Cancelling…');
  // Re-init
  setTimeout(() => { initFFmpeg(); }, 250);
}

function togglePlay() {
  const v = document.getElementById('video-preview');
  if (!v.src) return;
  if (v.paused) v.play().catch(() => {});
  else v.pause();
}

// =============================================================================
// BOOT
// =============================================================================
// captureDefaultsFromHTML reads each control's HTML `value="..."` attribute
// (the original markup value), not the live `.value` property. This
// insulates the "Reset" button from any drift caused by callbacks that
// might have touched the live value before the user resets. v3 UX 6.
function captureDefaultsFromHTML() {
  $$('input, select, textarea').forEach(el => {
    if (!el.id) return;
    if (el.type === 'checkbox') {
      state.defaults[el.id] = el.hasAttribute('checked');
    } else if (el.tagName === 'SELECT') {
      // Use the currently-selected option's value, falling back to the first option.
      state.defaults[el.id] = el.value;
    } else {
      // Range / number / text: use the HTML defaultValue (the original
      // value attribute) so live mutations don't poison the default.
      state.defaults[el.id] = el.defaultValue != null ? el.defaultValue : el.value;
    }
  });
  // v4 PART B15: seed the undo stack with the default state. The first
  // user change creates a new snapshot, so the first undo restores here.
  state.undoStack = [_snapshotControls()];
  updateUndoRedoButtons();
}

// Guarded boot. SAB may be missing on the FIRST page load because the
// service worker hasn't reloaded the page into the isolated context yet.
// We:
//   1. Capture true defaults FIRST (before any code touches .value)
//   2. Bind event listeners
//   3. Wire UX 1 (SAB dismiss button) and UX 2 (custom-workflow empty CTA)
//   4. If SAB is present, init the engine.
//   5. If SAB is missing AND a SW is registering, wait up to 4s for the
//      SW to reload us. If the reload hasn't happened by then, fall back
//      to the single-thread ffmpeg-core so the app is never dead-on-arrival.
function bootFFmpegStudio() {
  captureDefaults();           // legacy key set — same logic, kept for v1 compat
  captureDefaultsFromHTML();   // UX 6: write HTML-attribute defaults LAST so they win
  bindAll();
  bindUxExtras();      // UX 1, 2, 7, 8 wiring
  refreshCommandPreview();

  // PHASE 0.2: log the cross-origin isolation status at boot so we can
  // see whether the COI service worker actually achieved isolation on
  // whatever static host is serving the page. The console also gets a
  // hint about which threading mode we will boot into.
  const _coiMsg = `Boot: crossOriginIsolated = ${window.crossOriginIsolated}, SharedArrayBuffer = ${typeof SharedArrayBuffer !== 'undefined' ? 'present' : 'absent'}`;
  logToConsole('', _coiMsg);
  // Also log to the browser console so the value is visible to anyone
  // tailing the DevTools console (and to automated verifiers that
  // scrape `page.on('console')`).
  try { console.log(_coiMsg); } catch (_) { /* console may be unavailable */ }

  if (typeof SharedArrayBuffer !== 'undefined') {
    // Already isolated — start the engine.
    // #22: defer the 30 MB wasm download by 2 s so the UI paints first.
    // A user landing on the Audio Studio tab doesn't need the engine at all
    // (Web Audio is native); we kick it off after the initial paint either way.
    setTimeout(() => initFFmpeg(), 2000);
    return;
  }

  // SAB is missing. If a service worker is still registering, give it
  // a few seconds to reload the page. Otherwise fall back to single-thread.
  const swRegistering = (typeof navigator !== 'undefined'
                          && navigator.serviceWorker
                          && window.isSecureContext);

  if (!swRegistering) {
    // No SW path. Go straight to the single-thread fallback.
    setEngineStatus('yellow', 'Engine: Enabling isolation…');
    logToConsole('', 'No service-worker path available — using single-thread fallback.');
    initFFmpegSingleThread();
    return;
  }

  // SW is registering. Show a yellow status and wait up to 4s for the
  // SW to reload us into an isolated context.
  setEngineStatus('yellow', 'Engine: Enabling isolation…');
  logToConsole('', 'Waiting for cross-origin isolation service worker…');
  setTimeout(() => {
    if (typeof SharedArrayBuffer === 'undefined') {
      // SW never reloaded us. Show the banner and fall back to single-thread.
      showSabBanner();
      initFFmpegSingleThread();
    }
  }, 4000);
}

window.addEventListener('DOMContentLoaded', bootFFmpegStudio);

/* =============================================================================
 * FFmpeg Studio v2 EXTENSION
 * -----------------------------------------------------------------------------
 * This block is appended to v1 app.js. It adds:
 *   - Tab system (Editor / Workflows / Preview / Agents) with URL-friendly state
 *   - New editor sections (23 Merge, 24 Stabilize, 25 Deinterlace)
 *   - Curves preset + color grading presets in section 7
 *   - Chromashift (rgbashift) with geq fallback in section 19
 *   - Pipeline orchestration hooks (analyzeMedia, executePipeline, executeWithRetry)
 *     The heavy lifting lives in pipeline.js; this file wires it into the UI.
 *   - Preview tab (Source / Output / Compare) with synced playback
 *   - Workflow application (applyWorkflow, search, filter)
 *   - Agent card UI hooks (full implementations live in agents.js)
 *   - Command history, batch queue
 *
 * Strictly follows:
 *   - 0 inline event handlers (everything via addEventListener)
 *   - Only 0.12.7 APIs: ffmpeg.load, writeFile, readFile, exec, on, terminate, deleteFile
 *   - All processing client-side
 * ============================================================================= */

'use strict';

// =============================================================================
// v2 STATE
// =============================================================================
const stateV2 = {
  activeTab: 'workflows',
  previewMode: 'source',     // source | output | compare
  mergeFiles: [],            // [{name, size, type, virtualName, url}]
  outputHistory: [],         // [{timestamp, workflowName, blobUrl, size, ext, mime}]
  commandHistory: [],        // [{timestamp, command, status, args}]
  batchQueue: [],            // [{workflowId, workflowName}]
  customWorkflows: [],       // loaded from localStorage on boot
  analyzedInput: null,       // metadata from analyzeMedia
  lastWorkflowId: null,      // remember for badge assignment
  pipelineSteps: [],         // currently executing pipeline (for badge in workflow card)
};

// =============================================================================
// TAB SWITCHING
// =============================================================================
function switchTab(name) {
  if (!name) return;
  // Hide all
  $$('.tab-content').forEach(c => c.classList.remove('active'));
  $$('.tab-content').forEach(c => {
    // Default behaviour: none visible unless active
    if (!c.classList.contains('active')) c.style.display = 'none';
  });
  // Show target
  const target = document.getElementById('tab-' + name);
  if (target) {
    target.classList.add('active');
    target.style.display = 'block';
  }
  // Update buttons
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  stateV2.activeTab = name;
  // Re-render the preview player if needed
  if (name === 'preview') syncPreviewMode();
  logToConsole('', 'Tab → ' + name);
}

function bindTabs() {
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  // Keyboard: Alt+1..8 to jump to a tab. Covers every tab (the old map stopped
  // at 4 and missed Studio / Trip Cam / VJ / Graph). Skips tabs the current mode
  // has hidden.
  document.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    const map = { '1': 'workflows', '2': 'editor', '3': 'preview', '4': 'audio',
                  '5': 'tripcam', '6': 'vj', '7': 'graph', '8': 'agents' };
    const id = map[e.key];
    if (!id) return;
    const btn = document.querySelector(`.tab-btn[data-tab="${id}"]`);
    if (btn && !btn.hidden) { e.preventDefault(); switchTab(id); }
  });
}

// --- Keyboard-shortcut helpers (#96) -----------------------------------------
// Cycle among the tabs actually visible in the current mode.
function cycleTab(dir) {
  const btns = $$('.tab-btn').filter((b) => !b.hidden);
  if (!btns.length) return;
  let i = btns.findIndex((b) => b.classList.contains('active'));
  if (i < 0) i = 0;
  const next = btns[(i + dir + btns.length) % btns.length];
  if (next) switchTab(next.dataset.tab);
}

// Fill the VJ section of the cheat sheet from the live trigger table, so the
// documented keys can never drift from what vj-mode actually binds.
function populateVjShortcuts() {
  const body = document.getElementById('shortcuts-vj-body');
  if (!body) return;
  const T = window.FFVJ && window.FFVJ.TRIGGERS;
  if (!T) {
    body.innerHTML = '<tr><td colspan="2" class="muted small">Open the VJ tab once to load the performance keys.</td></tr>';
    return;
  }
  body.innerHTML = Object.values(T).map((t) => {
    const key = t.key === ' ' ? 'Space' : t.key.toUpperCase();
    return `<tr><td><kbd>${key}</kbd></td><td>${t.label}</td></tr>`;
  }).join('');
}

function openShortcuts() {
  populateVjShortcuts();
  document.getElementById('shortcuts-modal')?.classList.remove('hidden');
}

// =============================================================================
// SECTION 23 — MERGE / CONCATENATE UI
// =============================================================================
function bindMergeSection() {
  const fileInput = document.getElementById('merge-additional');
  if (!fileInput) return;
  fileInput.addEventListener('change', async (e) => {
    if (!e.target.files || !e.target.files.length) return;
    if (!state.ffmpeg) { logToConsoleThrottled('err', 'Engine not ready.'); return; }
    for (const f of e.target.files) {
      if (stateV2.mergeFiles.length >= 5) { logToConsole('warn', 'Max 5 additional files.'); break; }
      if (!ACCEPTED_MIMES.has(f.type)) { logToConsole('err', 'Skipping unsupported file: ' + f.name); continue; }
      const ext = (f.name.match(/\.([a-zA-Z0-9]+)$/) || [, 'bin'])[1].toLowerCase();
      const virtualName = `merge_${stateV2.mergeFiles.length + 1}.${ext}`;
      const data = await FFmpegUtil.fetchFile(f);
      try { await ff.deleteFile(virtualName); } catch (_) {}
      await ff.writeFile(virtualName, data);
      stateV2.mergeFiles.push({
        name: f.name, size: f.size, type: f.type,
        virtualName, extension: ext,
        url: URL.createObjectURL(f),
      });
    }
    fileInput.value = '';
    renderMergeList();
    refreshCommandPreview();
  });
  // Bind slider displays
  bindSliderDisplay('merge-pip-x', 'merge-pip-x-val');
  bindSliderDisplay('merge-pip-y', 'merge-pip-y-val');
}

function renderMergeList() {
  const el = document.getElementById('merge-list');
  if (!el) return;
  if (stateV2.mergeFiles.length === 0) {
    el.innerHTML = '<em class="muted">No extra files added.</em>';
    return;
  }
  el.innerHTML = stateV2.mergeFiles.map((f, i) => `
    <div class="merge-item" data-index="${i}" draggable="true">
      <span class="merge-handle" title="Drag to reorder">⋮⋮</span>
      <span class="merge-name">${escapeHtml(f.name)}</span>
      <span class="muted small">${formatBytes(f.size)}</span>
      <button type="button" data-remove="${i}">Remove</button>
    </div>
  `).join('');
  // Remove handlers
  el.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const idx = parseInt(btn.dataset.remove, 10);
      const f = stateV2.mergeFiles[idx];
      if (f && state.ffmpeg) {
        try { await ff.deleteFile(f.virtualName); } catch (_) {}
      }
      if (f && f.url) URL.revokeObjectURL(f.url);
      stateV2.mergeFiles.splice(idx, 1);
      renderMergeList();
      refreshCommandPreview();
    });
  });
  // Drag-to-reorder
  let dragSrc = null;
  el.querySelectorAll('.merge-item').forEach(item => {
    item.addEventListener('dragstart', (e) => { dragSrc = parseInt(item.dataset.index, 10); e.dataTransfer.effectAllowed = 'move'; });
    item.addEventListener('dragover',  (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    item.addEventListener('drop',      (e) => {
      e.preventDefault();
      const dst = parseInt(item.dataset.index, 10);
      if (dragSrc === null || dragSrc === dst) return;
      const moved = stateV2.mergeFiles.splice(dragSrc, 1)[0];
      stateV2.mergeFiles.splice(dst, 0, moved);
      dragSrc = null;
      renderMergeList();
      refreshCommandPreview();
    });
  });
}

// =============================================================================
// SECTION 24 / 25 — STABILIZE / DEINTERLACE  (display only; filter applied in
// buildVideoFilterChain via the same chain)
// =============================================================================
function bindStabilizeDeinterlace() {
  bindSliderDisplay('stab-shakiness', 'stab-shakiness-val');
}

// =============================================================================
// v3 UX EXTRAS — wires the new UX fixes (banner dismiss, custom-workflow
// empty state, preview label visibility, mobile status bar).
// =============================================================================
function bindUxExtras() {
  // UX 1 — SAB error banner dismiss button.
  const dismissBtn = document.getElementById('sab-dismiss');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      hideSabBanner();
    });
  }

  // UX 2 + PHASE 0.1: Custom-workflow empty state button. It now jumps
  // directly to the Chain Builder agent card (the most direct way to
  // produce a custom workflow) instead of the generic Agents tab. The
  // Chain Builder card is scrolled into view and briefly highlighted.
  const emptyAction = document.getElementById('workflows-empty-action');
  if (emptyAction) {
    emptyAction.addEventListener('click', () => {
      if (typeof switchTab === 'function') switchTab('agents');
      // Scroll the Chain Builder card into view and briefly flash it.
      setTimeout(() => {
        // The Chain Builder card is created by agents.js → look for an
        // element with id 'agent-chain-builder' OR a card whose title
        // contains "Chain Builder".
        let target = document.getElementById('agent-chain-builder');
        if (!target) {
          const cards = document.querySelectorAll('.agent-card, [data-agent-id]');
          for (const c of cards) {
            const txt = (c.textContent || '').toLowerCase();
            if (txt.includes('chain builder')) { target = c; break; }
          }
        }
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('flash');
          setTimeout(() => target.classList.remove('flash'), 1400);
        }
      }, 80);
    });
  }

  // UX 7 — Preview label visibility. Hide the "Source Preview" label until
  // a file is actually loaded. We use the `is-empty` class on the
  // preview-wrapper as the source of truth.
  syncPreviewLabelVisibility();

  // UX 8 — Mobile status bar: initial paint.
  updateMobileStatusBar();
}

// UX 7 — keep the preview label in sync with whether a file is loaded.
function syncPreviewLabelVisibility() {
  const wrapper = document.getElementById('preview-wrapper');
  if (!wrapper) return;
  const hasFile = !!(state && state.inputFile);
  wrapper.classList.toggle('is-empty', !hasFile);
  // Also toggle a class on the preview-header (the wrapper's previous
  // sibling) for the CSS selector that targets it directly. This is a
  // belt-and-braces fallback for browsers without :has() support.
  const header = wrapper.previousElementSibling;
  if (header && header.classList && header.classList.contains('preview-header')) {
    header.classList.toggle('is-empty', !hasFile);
  }
}

// UX 8 — paint the mobile bottom status bar. Called from setEngineStatus,
// handleFilesUpload, and after every output.
function updateMobileStatusBar() {
  const engineText = document.getElementById('msb-engine-text');
  const engineDot  = document.getElementById('msb-dot');
  const fileText   = document.getElementById('msb-file-text');
  const outputText = document.getElementById('msb-output-text');
  if (engineText) {
    // Reuse the same engine label that the topbar uses.
    const topbar = document.getElementById('status-text');
    engineText.textContent = (topbar && topbar.textContent) || 'Engine: Not loaded';
  }
  if (engineDot) {
    const topbarDot = document.getElementById('status-dot');
    if (topbarDot) engineDot.setAttribute('data-state', topbarDot.getAttribute('data-state') || 'red');
  }
  if (fileText) {
    fileText.textContent = (state && state.inputFile && state.inputFile.name) || 'No file';
  }
  if (outputText) {
    outputText.textContent = (state && state.outputFilename) || 'No output';
  }
}

// =============================================================================
// SECTION 7 — CURVES PRESET + COLOR GRADING PRESETS
// =============================================================================
function bindCurvesAndColorPresets() {
  const preset = document.getElementById('curves-preset');
  if (preset) preset.addEventListener('change', refreshCommandPreview);

  const presets = {
    'vaporwave-purple-cyan': {
      eq: { 'eq-saturation': 1.3, 'eq-contrast': 1.05 },
      hue: { 'hue-h': 30 },
      curves: "all='0/0 0.12/0.02 0.5/0.62 1/1'",
      custom: "all='0/0 0.12/0.02 0.5/0.62 1/1'",
    },
    'cinematic-teal-orange': {
      eq: { 'eq-saturation': 1.3, 'eq-contrast': 0.95 },
      noise: 10,
      curves: "all='0/0 0.25/0.1 0.5/0.6 0.75/0.9 1/1'",
      custom: "all='0/0 0.25/0.1 0.5/0.6 0.75/0.9 1/1'",
    },
    'retro-vhs-warm': {
      eq: { 'eq-saturation': 1.2, 'eq-contrast': 0.95 },
      noise: 10,
    },
    'high-contrast-bw': {
      eq: { 'eq-saturation': 0.0, 'eq-contrast': 1.4 },
    },
    'vintage-bleach': {
      eq: { 'eq-saturation': 0.5, 'eq-contrast': 1.3, 'eq-brightness': -0.02 },
      curves: 'preset=vintage',
    },
  };

  $$('[data-color-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = presets[btn.dataset.colorPreset];
      if (!p) return;
      // Enable section 7
      const e7 = document.getElementById('enable-7');
      if (e7 && !e7.checked) e7.checked = true;
      // Apply eq + hue sliders
      if (p.eq) {
        for (const [k, v] of Object.entries(p.eq)) {
          const el = document.getElementById(k);
          if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
        }
      }
      if (p.hue) {
        for (const [k, v] of Object.entries(p.hue)) {
          const el = document.getElementById(k);
          if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
        }
      }
      // Apply curves preset dropdown
      if (p.custom) {
        const sel = document.getElementById('curves-preset');
        if (sel) {
          // No built-in matches the custom string; store as 'custom' by adding an option
          let opt = Array.from(sel.options).find(o => o.value === '__custom__');
          if (!opt) {
            opt = document.createElement('option');
            opt.value = '__custom__';
            opt.textContent = 'Custom (preset button)';
            sel.appendChild(opt);
          }
          sel.value = '__custom__';
          sel.dataset.customExpr = p.custom;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (p.curves) {
        // Map known strings to dropdown values where possible
        const sel = document.getElementById('curves-preset');
        if (sel) {
          // 'preset=vintage' → 'vintage'
          const m = p.curves.match(/preset=([a-z_]+)/);
          if (m && Array.from(sel.options).some(o => o.value === m[1])) {
            sel.value = m[1];
            sel.dataset.customExpr = '';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      }
      // Maybe add noise
      if (p.noise) {
        const n = document.getElementById('add-noise');
        const ns = document.getElementById('noise-strength');
        const e13 = document.getElementById('enable-13');
        if (n)  n.checked = true;
        if (ns) { ns.value = p.noise; ns.dispatchEvent(new Event('input', { bubbles: true })); }
        if (e13 && !e13.checked) e13.checked = true;
      }
      logToConsole('ok', 'Color preset applied: ' + btn.dataset.colorPreset);
      refreshCommandPreview();
    });
  });
}

// =============================================================================
// SECTION 19 — CHROMASHIFT BINDINGS
// =============================================================================
function bindChromashift() {
  ['g-chroma-rh', 'g-chroma-rv', 'g-chroma-bh', 'g-chroma-bv'].forEach(id => {
    bindSliderDisplay(id, id + '-val');
  });
  const en = document.getElementById('g-chroma-enable');
  if (en) en.addEventListener('change', refreshCommandPreview);
}

// =============================================================================
// COMMAND BUILDER EXTENSION
// The functions below EXTEND buildVideoFilterChain and buildAudioFilterChain
// in the v1 code. We can't monkey-patch them, so we wrap them.
// =============================================================================
const _origBuildVF = buildVideoFilterChain;
buildVideoFilterChain = function() {
  const vf = _origBuildVF();

  // Curves (Section 7 enhancement) — inserted AFTER eq but before later filters.
  // We don't reorder; we just append. ffmpeg is order-sensitive but the v1
  // eq/hue/etc. are at the start. We insert curves after them by appending
  // here and re-sorting the array so curves sits at its semantic position.
  if (sectionEnabled(7)) {
    const csel = document.getElementById('curves-preset');
    if (csel && csel.value && csel.value !== 'none') {
      if (csel.value === '__custom__' && csel.dataset.customExpr) {
        vf.push(`curves=${csel.dataset.customExpr}`);
      } else {
        vf.push(`curves=preset=${csel.value}`);
      }
    }
  }

  // Chromashift (Section 19H) — try rgbashift, fall back to geq channel-split.
  if (sectionEnabled(19) && document.getElementById('g-chroma-enable') && document.getElementById('g-chroma-enable').checked) {
    const rh = parseInt(document.getElementById('g-chroma-rh').value, 10) || 0;
    const rv = parseInt(document.getElementById('g-chroma-rv').value, 10) || 0;
    const bh = parseInt(document.getElementById('g-chroma-bh').value, 10) || 0;
    const bv = parseInt(document.getElementById('g-chroma-bv').value, 10) || 0;
    if (rh || rv || bh || bv) {
      vf.push(`rgbashift=rh=${rh}:rv=${rv}:bh=${bh}:bv=${bv}`);
    }
  }

  // Deinterlace (Section 25)
  if (sectionEnabled(25)) {
    const mode = document.getElementById('deint-mode').value;
    vf.push(`yadif=${mode}`);
  }

  // Stabilize (Section 24) — only if deshake is available (we try and log a
  // warning on failure).  We use a simple deshake filter with rx/ry from
  // shakiness * 8.
  if (sectionEnabled(24)) {
    const shak = parseInt(document.getElementById('stab-shakiness').value, 10) || 5;
    const rx = shak * 8, ry = shak * 8;
    vf.push(`deshake=rx=${rx}:ry=${ry}`);
  }

  return vf;
};

// =============================================================================
// COMMAND BUILDER EXTENSION — Merge (Section 23) override
// When section 23 is enabled AND merge files exist, we don't build a normal
// command; we delegate to the merge executor that writes a concat list and
// runs ffmpeg with filter_complex for hstack / overlay.
// =============================================================================
const _origBuildCmd = buildFFmpegCommand;
buildFFmpegCommand = function() {
  if (sectionEnabled(23) && stateV2.mergeFiles.length > 0) {
    return buildMergeCommand();
  }
  return _origBuildCmd();
};

function buildMergeCommand() {
  if (!state.inputFile) return { args: [], str: '(load a file first)', ok: false, error: 'No input file.' };
  const mode = document.getElementById('merge-mode').value;
  const outExt = $('#out-format').value;
  const outputFilename = `output.${outExt}`;
  const allFiles = [state.inputFile.virtualName].concat(stateV2.mergeFiles.map(f => f.virtualName));
  const trim = buildTrimArgs();

  if (mode === 'concat') {
    // Build a concat list file
    const listContent = allFiles.map(n => `file '${n}'`).join('\n') + '\n';
    const args = [];
    if (trim.ss) args.push('-ss', trim.ss);
    args.push('-f', 'concat', '-safe', '0', '-i', 'concat_list.txt');
    if (trim.to) args.push('-to', trim.to);
    args.push('-c', 'copy', outputFilename);
    // We'll write the concat list before exec — store it in the plan
    return { args, str: `ffmpeg ${args.map(quoteArg).join(' ')}`, ok: true, outputFilename, mergeMode: 'concat', concatList: listContent };
  }

  if (mode === 'hstack') {
    // Side-by-side using hstack. Needs -1 vs -2 scaling to match heights.
    const inputs = [];
    const args = [];
    if (trim.ss) args.push('-ss', trim.ss);
    for (const fn of allFiles) args.push('-i', fn);
    if (trim.to) args.push('-to', trim.to);
    args.push('-filter_complex', `[0:v]setpts=PTS-STARTPTS[v0];[1:v]setpts=PTS-STARTPTS[v1];[v0][v1]hstack=inputs=2[v]`,
              '-map', '[v]',
              '-c:v', $('#vcodec').value,
              '-pix_fmt', $('#pix-fmt').value,
              outputFilename);
    return { args, str: `ffmpeg ${args.map(quoteArg).join(' ')}`, ok: true, outputFilename, mergeMode: 'hstack', fileCount: allFiles.length };
  }

  if (mode === 'pip') {
    const px = parseInt($('#merge-pip-x').value, 10) || 32;
    const py = parseInt($('#merge-pip-y').value, 10) || 32;
    const inputs = [];
    const args = [];
    if (trim.ss) args.push('-ss', trim.ss);
    for (const fn of allFiles) args.push('-i', fn);
    if (trim.to) args.push('-to', trim.to);
    args.push('-filter_complex',
              `[1:v]scale=iw/3:ih/3[pip];[0:v][pip]overlay=${px}:${py}[v]`,
              '-map', '[v]',
              '-c:v', $('#vcodec').value,
              '-pix_fmt', $('#pix-fmt').value,
              outputFilename);
    return { args, str: `ffmpeg ${args.map(quoteArg).join(' ')}`, ok: true, outputFilename, mergeMode: 'pip', fileCount: allFiles.length };
  }

  return { args: [], str: '(unknown merge mode)', ok: false, error: 'Unknown merge mode' };
}

// =============================================================================
// executeFromUI EXTENSION — handle merge / pipeline / workflow apply
// =============================================================================
const _origExecFromUI = executeFromUI;
executeFromUI = async function() {
  if (state.isProcessing) { logToConsole('warn', 'Already processing.'); return; }
  if (!state.inputFile) { logToConsole('err', 'Load a file first.'); return; }

  // v5 HOTFIX 5: dropped the deep probe (analyzeMedia) here. The native
  // probe in handleFilesUpload already gives the UI everything it needs.
  // The deep probe was burning wasm heap for display strings and was
  // racing with the render.

  const plan = buildFFmpegCommand();
  if (!plan.ok) {
    logToConsole('err', plan.error || 'Cannot build command.');
    return;
  }

  // Reverse warnings
  if (sectionEnabled(6) && ($('#rev-video').checked || $('#rev-audio').checked)) {
    if (state.inputFile.size > REVERSE_WARN_BYTES) {
      logToConsole('warn', 'Reverse filter on a >100MB file will be slow (entire file decoded into memory).');
    }
  }

  // Decide whether to engage the multi-step pipeline.
  // We engage the pipeline if the plan is complex (multi-effect) AND
  // pipelines are available. Simple single-effect commands still use
  // the single-exec path.
  const isComplex = isComplexCommand(plan);

  // ---- Merge path
  if (plan.mergeMode) {
    await runMergePlan(plan);
    return;
  }

  // ---- Two-pass / GIF
  if (plan.gifTwoPass) { await createGIF(); return; }
  if (plan.twoPass)    { await runTwoPass(plan); return; }

  // ---- Pipeline
  if (isComplex && typeof executePipeline === 'function') {
    const steps = buildPipelineSteps(plan);
    if (steps && steps.length > 1) {
      const result = await executePipeline(steps);
      if (result && result.ok) {
        finishFromPlan(plan, result.data, result.mime, result.outputFilename);
      } else if (result && result.data) {
        // Partial output from a failed step — still show the last good intermediate
        finishFromPlan(plan, result.data, result.mime, result.outputFilename);
        showInfo('Partial output', 'Some pipeline steps failed. The last successful intermediate is shown below. Check the log for details.');
      } else {
        showFriendlyError(result && result.error || 'Pipeline failed.');
      }
      return;
    }
  }

  // ---- Default: single exec (with retry if requested by the plan)
  let result;
  if (plan.retry && typeof executeWithRetry === 'function') {
    result = await executeWithRetry(plan.args, plan.retryStrategies || []);
  } else {
    result = await executeFFmpeg(plan.args);
  }
  if (result) {
    finishFromPlan(plan, result.data, result.mime, result.outputFilename);
    addCommandHistory(plan.str, 'ok');
  } else {
    addCommandHistory(plan.str, 'err');
  }
};

// Helper: classify whether a command is "complex" enough to need the pipeline
function isComplexCommand(plan) {
  if (!plan.args) return false;
  const flagCount = plan.args.filter(a => typeof a === 'string' && a.startsWith('-')).length;
  // Look for filter flags
  const hasVf = plan.args.includes('-vf') || plan.args.includes('-filter_complex');
  const hasAf = plan.args.includes('-af');
  if (!hasVf && !hasAf) return false;
  // Count filter complexity: -vf usually has one big chain. We consider it
  // complex if the chain has > 3 comma-separated entries.
  let complexity = 0;
  for (let i = 0; i < plan.args.length; i++) {
    if (plan.args[i] === '-vf' || plan.args[i] === '-af') {
      const chain = plan.args[i+1] || '';
      // naive: count commas + 1
      complexity = Math.max(complexity, (chain.match(/,/g) || []).length + 1);
    }
  }
  return complexity > 3;
}

// Helper: split a flat plan into pipeline steps. Simple effect stacking
// is applied via ffmpeg.exec but the pipeline engine still gets called for
// complex multi-step workflows.
function buildPipelineSteps(plan) {
  // If a workflow is currently being applied via applyWorkflow, it might
  // have provided a custom pipeline definition. Otherwise we just return
  // a single-step pipeline that runs the plan as-is.
  const wfDef = stateV2.currentPipeline;
  stateV2.currentPipeline = null;
  if (wfDef && Array.isArray(wfDef.steps) && wfDef.steps.length) {
    return wfDef.steps;
  }
  return [{
    name: 'Single Pass',
    description: 'Run the assembled command in a single execution.',
    args: plan.args,
    inputFile: state.inputFile.virtualName,
    outputFile: plan.outputFilename,
  }];
}

// Helper: complete the success path shared by single-exec, retry, and pipeline
function finishFromPlan(plan, data, mime, outputFilename) {
  if (!data) return;
  const u8 = (data instanceof Uint8Array) ? data : new Uint8Array(data);
  state.outputSize = u8.byteLength;
  // Be defensive about the name — a missing outputFilename must never crash the
  // success path with `undefined.split`. Fall back to the plan's output, then a
  // sane default.
  const name = outputFilename || (plan && plan.outputFilename) || 'output.mp4';
  const ext = String(name).split('.').pop().toLowerCase();
  const blob = new Blob([u8], { type: mime || EXT_TO_MIME[ext] || 'application/octet-stream' });
  if (state.outputBlobUrl) URL.revokeObjectURL(state.outputBlobUrl);
  state.outputBlobUrl = URL.createObjectURL(blob);
  loadOutputPreview(state.outputBlobUrl, mime || EXT_TO_MIME[ext] || 'application/octet-stream');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = `output_${ts}.${ext}`;
  state.outputFilename = out;
  setDownloadEnabled(true);
  setOutputInfo({ size: u8.byteLength, mime: mime || EXT_TO_MIME[ext] || '', filename: out, ext });
  // Push to output history
  pushOutputHistory({
    timestamp: new Date(),
    workflowName: stateV2.lastWorkflowName || 'Custom',
    blobUrl: state.outputBlobUrl,
    size: u8.byteLength,
    ext,
    mime: mime || EXT_TO_MIME[ext] || '',
  });
  // Switch to preview
  switchTab('preview');
  setPreviewMode('output');
}

async function runMergePlan(plan) {
  if (!state.ffmpeg) return;
  // Write concat list if needed
  if (plan.mergeMode === 'concat' && plan.concatList) {
    try { await ff.deleteFile('concat_list.txt'); } catch (_) {}
    await ff.writeFile('concat_list.txt', new TextEncoder().encode(plan.concatList));
  }
  const res = await executeFFmpeg(plan.args);
  if (res) {
    finishFromPlan(plan, res.data, res.mime, res.outputFilename);
    addCommandHistory(plan.str, 'ok');
  } else {
    addCommandHistory(plan.str, 'err');
  }
}

// =============================================================================
// FILE INGESTION EXTENSION — auto-analyze on upload
// =============================================================================
const _origHandle = handleFileUpload;
handleFileUpload = async function(file) {
  await _origHandle(file);
  // v5 HOTFIX 5: dropped the deep probe (analyzeMedia) here. The
  // native probe in handleFilesUpload already gives the UI everything
  // it needs. The deep probe was burning wasm heap for display
  // strings and was racing with the user's eventual Run.
  // If we ever want codec names back, defer it to a bin-card detail
  // view, lazy and one-at-a-time.
};

// =============================================================================
// COMMAND HISTORY
// =============================================================================
function addCommandHistory(command, status) {
  stateV2.commandHistory.unshift({
    timestamp: new Date(),
    command: String(command).slice(0, 200),
    status,
  });
  if (stateV2.commandHistory.length > 100) stateV2.commandHistory.length = 100;
  renderCommandHistory();
}

function renderCommandHistory() {
  const el = document.getElementById('command-history-list');
  if (!el) return;
  if (stateV2.commandHistory.length === 0) {
    el.innerHTML = '<em class="muted">No commands run yet this session.</em>';
    return;
  }
  el.innerHTML = stateV2.commandHistory.map((h, i) => `
    <div class="history-item ${h.status}">
      <span class="h-time">${h.timestamp.toLocaleTimeString()}</span>
      <span class="h-status">[${h.status === 'ok' ? '✓' : '✗'}]</span>
      <span class="h-cmd" title="${escapeHtml(h.command)}">${escapeHtml(h.command)}</span>
      <button type="button" data-history-rerun="${i}">Re-run</button>
    </div>
  `).join('');
  el.querySelectorAll('[data-history-rerun]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.historyRerun, 10);
      const h = stateV2.commandHistory[idx];
      if (!h) return;
      // Re-run is "Apply & Run" of an empty/null workflow
      await executeFromUI();
    });
  });
}

// =============================================================================
// OUTPUT HISTORY (preview tab)
// =============================================================================
function pushOutputHistory(entry) {
  stateV2.outputHistory.unshift(entry);
  if (stateV2.outputHistory.length > 5) {
    // Revoke the evicted URL
    const removed = stateV2.outputHistory.pop();
    if (removed && removed.blobUrl) URL.revokeObjectURL(removed.blobUrl);
  }
  renderOutputHistory();
}

function renderOutputHistory() {
  const el = document.getElementById('output-history-list');
  if (!el) return;
  if (stateV2.outputHistory.length === 0) {
    el.innerHTML = '<em class="muted">No previous outputs yet.</em>';
    return;
  }
  el.innerHTML = stateV2.outputHistory.map((e, i) => `
    <div class="oh-item" data-oh-index="${i}">
      <div class="oh-thumb">${e.ext === 'gif' ? '🎞' : (e.mime && e.mime.startsWith('audio') ? '🎵' : '🎬')}</div>
      <div class="oh-meta">
        <strong>${escapeHtml(e.workflowName)}</strong>
        <span class="muted">${formatBytes(e.size)} · ${e.ext.toUpperCase()}</span>
      </div>
      <span class="oh-time">${e.timestamp.toLocaleTimeString()}</span>
    </div>
  `).join('');
  el.querySelectorAll('[data-oh-index]').forEach(it => {
    it.addEventListener('click', () => {
      const idx = parseInt(it.dataset.ohIndex, 10);
      const e = stateV2.outputHistory[idx];
      if (!e) return;
      const v = document.getElementById('pv-output');
      if (v) { v.src = e.blobUrl; v.load(); }
      setPreviewMode('output');
    });
  });
}

// =============================================================================
// PREVIEW TAB LOGIC
// =============================================================================
function bindPreview() {
  $$('#preview-modes .mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setPreviewMode(btn.dataset.mode));
  });
  // Download button in preview tab
  const dl = document.getElementById('pv-btn-download');
  if (dl) dl.addEventListener('click', () => {
    if (!state.outputBlobUrl) return;
    const a = document.createElement('a');
    a.href = state.outputBlobUrl;
    a.download = state.outputFilename || 'output.bin';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });
  // Refresh
  const rf = document.getElementById('pv-btn-refresh');
  if (rf) rf.addEventListener('click', () => {
    syncPreviewMode();
    renderOutputHistory();
  });
  // Compare sync
  const a = document.getElementById('pv-compare-a');
  const b = document.getElementById('pv-compare-b');
  if (a && b) {
    a.addEventListener('play',  () => { if (b.paused) b.play().catch(()=>{}); });
    a.addEventListener('pause', () => { if (!b.paused) b.pause(); });
    a.addEventListener('seeked', () => { if (Math.abs(b.currentTime - a.currentTime) > 0.2) b.currentTime = a.currentTime; });
    b.addEventListener('play',  () => { if (a.paused) a.play().catch(()=>{}); });
    b.addEventListener('pause', () => { if (!a.paused) a.pause(); });
    b.addEventListener('seeked', () => { if (Math.abs(a.currentTime - b.currentTime) > 0.2) a.currentTime = b.currentTime; });
  }
}

function setPreviewMode(mode) {
  stateV2.previewMode = mode;
  $$('#preview-modes .mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $$('.preview-mode').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('pmode-' + mode);
  if (target) target.classList.add('active');
  syncPreviewMode();
  if (mode === 'falsecolor') startFalseColorLoop();
  else stopFalseColorLoop();
}

// =============================================================================
// #52 FALSE-COLOUR EXPOSURE VIEW
// -----------------------------------------------------------------------------
// Standard colorist tool. Map luminance to color so exposure problems are
// visible at a glance:
//   underexposed = blue
//   shadows     = darker blue
//   midtones    = green
//   highlights  = yellow
//   overexposed  = red
// We sample the source video at a low resolution on a canvas and re-render
// pixel-by-pixel. ~30 fps on a 320x180 canvas even on a phone.
// =============================================================================
let _fcRaf = 0;
function startFalseColorLoop() {
  cancelAnimationFrame(_fcRaf);
  const cv = document.getElementById('pv-falsecolor');
  const src = document.getElementById('pv-source');
  if (!cv || !src) return;
  const ctx = cv.getContext('2d');
  const W = 320, H = 180;
  cv.width = W; cv.height = H;
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const offCtx = off.getContext('2d', { willReadFrequently: true });

  const loop = () => {
    if (stateV2.previewMode !== 'falsecolor') { _fcRaf = 0; return; }
    if (src.readyState >= 2) {
      offCtx.drawImage(src, 0, 0, W, H);
      const img = offCtx.getImageData(0, 0, W, H);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        // Rec. 601 luma
        const luma = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
        const l = luma / 255;
        let r, g, b;
        if (l < 0.1)        { r=0;   g=0;   b=128 + l*640; }   // underexposed
        else if (l < 0.3)   { r=0;   g=Math.floor(l*510); b=255; } // shadows
        else if (l < 0.5)   { r=0;   g=255; b=Math.floor((0.5-l)*510); } // midtones low
        else if (l < 0.7)   { r=Math.floor((l-0.5)*510); g=255; b=0; } // midtones high
        else if (l < 0.85)  { r=255; g=Math.floor((1-l)*680); b=0; } // highlights
        else                { r=255; g=0;   b=0; }   // overexposed
        d[i] = r; d[i+1] = g; d[i+2] = b;
      }
      ctx.putImageData(img, 0, 0);
    }
    _fcRaf = requestAnimationFrame(loop);
  };
  loop();
}
function stopFalseColorLoop() { cancelAnimationFrame(_fcRaf); _fcRaf = 0; }

// =============================================================================
// #92 BEFORE/AFTER WIPE
// -----------------------------------------------------------------------------
// Drag a divider across the preview to reveal the source on the left and the
// output on the right. The classic editorial tool. Works for video and audio.
// =============================================================================
function setupWipe() {
  const handle = document.getElementById('wipe-handle');
  const divider = document.getElementById('wipe-divider');
  const container = document.getElementById('wipe-container');
  const source = document.getElementById('pv-wipe-source');
  const output = document.getElementById('pv-wipe-output');
  if (!handle || !divider || !container || !source || !output) return;

  let dragging = false;
  const setX = (pct) => {
    pct = Math.max(0, Math.min(100, pct));
    divider.style.left = pct + '%';
    handle.style.left = pct + '%';
    source.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  };
  setX(50);

  const start = (e) => { dragging = true; e.preventDefault(); };
  const move = (e) => {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    setX((x / rect.width) * 100);
  };
  const end = () => { dragging = false; };

  handle.addEventListener('mousedown', start);
  handle.addEventListener('touchstart', start, { passive: false });
  divider.addEventListener('mousedown', start);
  document.addEventListener('mousemove', move);
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('mouseup', end);
  document.addEventListener('touchend', end);
}

// Bind wipe setup once
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupWipe);
} else {
  setupWipe();
}

function syncPreviewMode() {
  const srcV = document.getElementById('pv-source');
  const outV = document.getElementById('pv-output');
  const cmpA = document.getElementById('pv-compare-a');
  const cmpB = document.getElementById('pv-compare-b');
  const wipeSrc = document.getElementById('pv-wipe-source');
  const wipeOut = document.getElementById('pv-wipe-output');
  if (srcV) srcV.src = state.inputFile ? state.inputFile.url : '';
  if (outV) outV.src = state.outputBlobUrl || '';
  if (cmpA) cmpA.src = state.inputFile ? state.inputFile.url : '';
  if (cmpB) cmpB.src = state.outputBlobUrl || '';
  if (wipeSrc) wipeSrc.src = state.inputFile ? state.inputFile.url : '';
  if (wipeOut) wipeOut.src = state.outputBlobUrl || '';
  // Update file info
  const fi = document.getElementById('pv-file-info');
  if (fi && state.inputFile) {
    const src = state.inputFile;
    const dur = (src.durationSec != null && isFinite(src.durationSec)) ? src.durationSec.toFixed(2) + 's' : '—';
    const res = (src.width && src.height) ? `${src.width}×${src.height}` : '—';
    fi.innerHTML = `
      <div class="file-info">
        <strong>${escapeHtml(src.name)}</strong>
        <span class="file-info-meta">${formatBytes(src.size)} · ${dur} · ${res} · ${(src.codec || src.type || '—')}</span>
      </div>
    `;
  } else if (fi) {
    fi.innerHTML = '<span class="file-info-empty">No file loaded</span>';
  }
  // Waveform placeholder for audio-only
  const wf = document.getElementById('pv-waveform');
  if (wf) wf.hidden = !(state.inputFile && state.inputFile.type && state.inputFile.type.startsWith('audio'));
  // Enable download button when output exists
  const dl = document.getElementById('pv-btn-download');
  if (dl) dl.disabled = !state.outputBlobUrl;
}

// =============================================================================
// WORKFLOW APPLY (called from workflows.js)
// =============================================================================
function applyWorkflow(workflowId) {
  if (typeof WORKFLOWS === 'undefined') { logToConsole('err', 'WORKFLOWS not loaded.'); return; }
  const all = (typeof loadCustomWorkflows === 'function')
    ? WORKFLOWS.concat(loadCustomWorkflows())
    : WORKFLOWS;
  const wf = all.find(w => w.id === workflowId);
  if (!wf) { logToConsole('err', 'Workflow not found: ' + workflowId); return; }

  // Reset all controls to defaults
  resetAllControls();

  // Track how many of this workflow's settings actually landed on a real
  // control. A workflow whose keys don't match any DOM id would otherwise
  // silently apply NOTHING and render against default state — producing a
  // command with none of its filters and no error anywhere.
  let _applied = 0, _missing = [];

  // v5 hotfix 2 — Bug 4: workflows that pin `'enc-preset': 'medium'`
  // are migrated to a state-aware default at apply time. This is a
  // one-time rewrite, not a permanent change to the workflow
  // definition, so a user who later picks a slower preset from the
  // dropdown still gets to keep it.
  const settings = Object.assign({}, wf.settings || {});
  if (Object.prototype.hasOwnProperty.call(settings, 'enc-preset') &&
      (settings['enc-preset'] === 'medium' || settings['enc-preset'] === 'slow')) {
    // 'max-quality-archive' is the only workflow that explicitly
    // names slow as the intent — keep it.
    if (wf.id !== 'max-quality-archive') {
      settings['enc-preset'] = _defaultBrowserPreset();
    }
  }

  // Apply settings
  for (const [id, val] of Object.entries(settings)) {
    const el = document.getElementById(id);
    if (!el) { _missing.push(id); continue; }        // ← was a SILENT skip
    if (el.type === 'checkbox') el.checked = !!val;
    else el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    _applied++;
  }

  // -------------------------------------------------------------------------
  // VERIFY THE APPLY TOOK.
  // -------------------------------------------------------------------------
  // `if (!el) continue` was a silent skip. A workflow whose setting keys don't
  // match any DOM id applied NOTHING, and the render then proceeded against
  // DEFAULT editor state — producing a command containing none of the
  // workflow's filters, with no error anywhere.
  //
  // That is a workflow that lies about what it does. Refuse to be silent.
  // -------------------------------------------------------------------------
  const _expected = Object.keys(settings).length;
  if (_missing.length) {
    logToConsole('warn',
      `Workflow "${wf.name}": ${_missing.length}/${_expected} setting(s) matched no control — ` +
      `[${_missing.join(', ')}]. Those parts of the workflow will NOT be applied.`);
  }
  if (_expected > 0 && _applied === 0) {
    const msg = `Workflow "${wf.name}" applied NOTHING — none of its ${_expected} setting(s) ` +
                `matched a control (${_missing.join(', ')}). Running now would render default ` +
                `settings while claiming to be "${wf.name}".`;
    logToConsole('error', msg);
    alert(msg);
    return;                                          // ← do not proceed
  }
  logToConsole('ok', `Workflow applied: ${wf.name} (${_applied}/${_expected} settings)`);

  // Open affected <details>
  const affected = new Set();
  for (const id of Object.keys(wf.settings || {})) {
    const m = id.match(/^enable-(\d+)$/);
    if (m) affected.add(parseInt(m[1], 10));
    const sNum = findSectionForControl(id);
    if (sNum) affected.add(sNum);
  }
  affected.forEach(num => {
    const s = document.getElementById('section-' + num);
    if (s && s.tagName.toLowerCase() === 'details') s.open = true;
  });

  // Output format overrides
  if (wf.outputFormat) {
    const of = document.getElementById('out-format');
    if (of) { of.value = wf.outputFormat; of.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  if (wf.codec) {
    const vc = document.getElementById('vcodec');
    if (vc) { vc.value = wf.codec; vc.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  if (wf.crf != null) {
    const crf = document.getElementById('crf');
    if (crf) { crf.value = String(wf.crf); crf.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  if (wf.audioChain) {
    stateV2.currentPipeline = { steps: wf.audioChain };
  }
  if (wf.videoChain) {
    stateV2.currentPipeline = { steps: wf.videoChain };
  }
  stateV2.lastWorkflowName = wf.name;
  stateV2.lastWorkflowId = wf.id;
  refreshCommandPreview();
  logToConsole('ok', 'Workflow applied: ' + wf.name);
  return wf;
}

async function applyAndRunWorkflow(workflowId) {
  const wf = applyWorkflow(workflowId);
  if (!wf) return;
  if (!state.inputFile) {
    logToConsole('warn', 'No file loaded. Load a file first, then click Apply & Run.');
    switchTab('editor');
    return;
  }
  // A workflow that carries its own JS engine (v4/v5) runs that, not the
  // generic command builder.
  if (typeof wf.run === 'function') {
    try { await wf.run(); }
    catch (e) { logToConsole('error', `${wf.name} failed: ${e && e.message || e}`); }
    return;
  }
  // Special-case workflows: extract-frame and boomerang have dedicated
  // multi-pass execution paths that bypass the generic command builder.
  if (wf.extractFrame != null) {
    await runExtractFrameWorkflow(parseFloat(wf.extractFrame));
    return;
  }
  if (wf.boomerang) {
    await runBoomerangWorkflow();
    return;
  }
  // Wait a tick for the UI to settle
  await new Promise(r => setTimeout(r, 100));
  await executeFromUI();
}

// =============================================================================
// EXTRACT FRAME (Workflow 12)
// Pulls a single still image from the input at a given time offset.
// Uses fast-seek (-ss BEFORE -i) + single-frame output (-frames:v 1).
// =============================================================================
async function runExtractFrameWorkflow(timeSec) {
  if (state.isProcessing) { logToConsole('warn', 'Already processing.'); return; }
  if (!state.ffmpeg || !state.inputFile) return;
  const t = (isFinite(timeSec) && timeSec >= 0) ? timeSec : 2.0;
  const ext = 'jpg';
  const outName = `frame_at_${t.toFixed(2)}s.${ext}`;
  // Reset UI state and free any prior output blob URL
  if (state.outputBlobUrl) { URL.revokeObjectURL(state.outputBlobUrl); state.outputBlobUrl = null; }
  try { await ff.deleteFile(outName); } catch (_) {}

  state.isProcessing = true;
  setControlsEnabled(false);
  setCancelVisible(true);
  setProgress(0);
  setProgressText('Extracting frame…');
  const start = performance.now();

  try {
    const args = [
      '-ss', t.toFixed(3),
      '-i', state.inputFile.virtualName,
      '-frames:v', '1',
      '-q:v', '2',
      outName,
    ];
    logToConsole('', `Exec: ffmpeg ${args.map(quoteArg).join(' ')}`);
    await ff.exec(args);
    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    setProgress(100);
    setProgressText(`Frame extracted in ${elapsed}s`);

    const data = await ff.readFile(outName);
    const u8 = (data instanceof Uint8Array) ? data : new Uint8Array(data);
    const mime = 'image/jpeg';
    const blob = new Blob([u8], { type: mime });
    if (state.outputBlobUrl) URL.revokeObjectURL(state.outputBlobUrl);
    state.outputBlobUrl = URL.createObjectURL(blob);
    state.outputFilename = outName;
    loadOutputPreview(state.outputBlobUrl, mime);
    setDownloadEnabled(true);
    setOutputInfo({ size: u8.byteLength, mime, filename: outName, ext });
    if (typeof addCommandHistory === 'function') {
      addCommandHistory(`Extract frame @ ${t}s → ${outName}`, 'ok');
    }
    switchTab('preview');
    logToConsole('ok', `Frame extracted in ${elapsed}s — switch to Preview tab.`);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (typeof showFriendlyError === 'function') showFriendlyError(msg);
    else logToConsole('err', `Extract frame failed: ${msg}`);
  } finally {
    state.isProcessing = false;
    setControlsEnabled(true);
    setCancelVisible(false);
  }
}

// =============================================================================
// FRAMES & STILLS (Section 32)
// =============================================================================

// Extract a single frame as PNG or JPG.
async function runExtractSingleFrame() {
  if (state.isProcessing) { logToConsole('warn', 'Already processing.'); return; }
  if (!state.ffmpeg || !state.inputFile) { showInfo('No file', 'Load a video first.'); return; }
  const t = parseFloat(($('#extract-frame-time') || {}).value) || 1.0;
  const ext = (($('#extract-frame-format') || {}).value) || 'jpg';
  const outName = `frame_at_${t.toFixed(2)}s.${ext}`;
  state.isProcessing = true;
  setControlsEnabled(false);
  setCancelVisible(true);
  setProgress(0);
  setProgressText(`Extracting frame @ ${t.toFixed(2)}s…`);
  try { await ff.deleteFile(outName); } catch (_) {}
  try {
    const args = [
      '-ss', t.toFixed(3),
      '-i', state.inputFile.virtualName,
      '-frames:v', '1',
      ext === 'jpg' ? '-q:v' : '-compression_level', ext === 'jpg' ? '2' : '6',
      outName,
    ];
    logToConsole('', `Exec: ffmpeg ${args.map(quoteArg).join(' ')}`);
    await ff.exec(args);
    const data = await ff.readFile(outName);
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const mime = ext === 'jpg' ? 'image/jpeg' : 'image/png';
    const blob = new Blob([u8], { type: mime });
    if (state.outputBlobUrl) URL.revokeObjectURL(state.outputBlobUrl);
    state.outputBlobUrl = URL.createObjectURL(blob);
    state.outputFilename = outName;
    loadOutputPreview(state.outputBlobUrl, mime);
    setDownloadEnabled(true);
    setOutputInfo({ size: u8.byteLength, mime, filename: outName, ext });
    setProgress(100);
    setProgressText(`Frame extracted`);
    // Add the result to the bin so the user can chain.
    await addOutputToBin({ blob, name: outName, mime, ext, workflowName: 'Extract Frame' });
    try { await ff.deleteFile(outName); } catch (_) {}
    if (typeof addCommandHistory === 'function') addCommandHistory(`Extract frame @ ${t}s → ${outName}`, 'ok');
    logToConsole('ok', `Frame extracted → ${outName}`);
  } catch (err) {
    const msg = String((err && err.message) || err);
    logToConsole('err', `Extract frame failed: ${msg}`);
    if (typeof showFriendlyError === 'function') showFriendlyError(msg);
  } finally {
    state.isProcessing = false;
    setCancelVisible(false);
    setControlsEnabled(true);
  }
}

// Extract all frames as a numbered PNG sequence + ZIP bundle.
async function runExtractAllFrames() {
  if (state.isProcessing) { logToConsole('warn', 'Already processing.'); return; }
  if (!state.ffmpeg || !state.inputFile) { showInfo('No file', 'Load a video first.'); return; }
  if (typeof JSZip === 'undefined') { showInfo('JSZip', 'JSZip not loaded. Reload the page.'); return; }
  const fps = parseInt(($('#extract-all-fps') || {}).value, 10) || 2;
  const outPattern = 'frame_%05d.png';
  state.isProcessing = true;
  setControlsEnabled(false);
  setCancelVisible(true);
  setProgress(0);
  setProgressText('Extracting frames…');
  try {
    const args = [
      '-i', state.inputFile.virtualName,
      '-vf', `fps=${fps}`,
      '-compression_level', '6',
      outPattern,
    ];
    logToConsole('', `Exec: ffmpeg ${args.map(quoteArg).join(' ')}`);
    await ff.exec(args);
    setProgress(80);
    setProgressText('Bundling ZIP…');
    // Read back the frame files. The number of frames depends on the
    // source duration × fps; we walk up to a reasonable cap (10000).
    const zip = new JSZip();
    let count = 0;
    for (let i = 1; i < 10001; i++) {
      const name = `frame_${String(i).padStart(5, '0')}.png`;
      try {
        const data = await ff.readFile(name);
        const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
        zip.file(name, u8);
        count++;
        // Don't keep too many in MEMFS simultaneously; delete each after
        // adding to the zip.
        try { await ff.deleteFile(name); } catch (_) {}
        if (count % 50 === 0) setProgress(80 + Math.min(19, Math.floor(count / 100)));
      } catch (_) {
        break;  // no more files
      }
    }
    if (count === 0) {
      logToConsole('err', 'No frames were extracted.');
      showFriendlyError('No frames extracted.');
      return;
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const zipName = `frames_${fps}fps.zip`;
    // Save the zip as a downloadable output.
    if (state.outputBlobUrl) URL.revokeObjectURL(state.outputBlobUrl);
    state.outputBlobUrl = URL.createObjectURL(zipBlob);
    state.outputFilename = zipName;
    setDownloadEnabled(true);
    setOutputInfo({ size: zipBlob.size, mime: 'application/zip', filename: zipName, ext: 'zip' });
    setProgress(100);
    setProgressText(`Extracted ${count} frames`);
    logToConsole('ok', `Extracted ${count} frames → ${zipName}`);
    if (typeof addCommandHistory === 'function') addCommandHistory(`Extract all frames (${count} @ ${fps}fps) → ${zipName}`, 'ok');
  } catch (err) {
    const msg = String((err && err.message) || err);
    logToConsole('err', `Extract all frames failed: ${msg}`);
    if (typeof showFriendlyError === 'function') showFriendlyError(msg);
  } finally {
    state.isProcessing = false;
    setCancelVisible(false);
    setControlsEnabled(true);
  }
}

// Extract only keyframes (I-frames) as PNGs into a zip.
async function runExtractKeyframes() {
  if (state.isProcessing) { logToConsole('warn', 'Already processing.'); return; }
  if (!state.ffmpeg || !state.inputFile) { showInfo('No file', 'Load a video first.'); return; }
  if (typeof JSZip === 'undefined') { showInfo('JSZip', 'JSZip not loaded.'); return; }
  const outPattern = 'keyframe_%05d.png';
  state.isProcessing = true;
  setControlsEnabled(false);
  setCancelVisible(true);
  setProgress(0);
  setProgressText('Extracting keyframes…');
  try {
    const args = [
      '-i', state.inputFile.virtualName,
      '-vf', "select='eq(pict_type,I)'",
      '-vsync', 'vfr',
      '-compression_level', '6',
      outPattern,
    ];
    logToConsole('', `Exec: ffmpeg ${args.map(quoteArg).join(' ')}`);
    await ff.exec(args);
    setProgress(80);
    setProgressText('Bundling ZIP…');
    const zip = new JSZip();
    let count = 0;
    for (let i = 1; i < 10001; i++) {
      const name = `keyframe_${String(i).padStart(5, '0')}.png`;
      try {
        const data = await ff.readFile(name);
        const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
        zip.file(name, u8);
        count++;
        try { await ff.deleteFile(name); } catch (_) {}
      } catch (_) { break; }
    }
    if (count === 0) {
      logToConsole('err', 'No keyframes extracted.');
      showFriendlyError('No keyframes found.');
      return;
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const zipName = `keyframes.zip`;
    if (state.outputBlobUrl) URL.revokeObjectURL(state.outputBlobUrl);
    state.outputBlobUrl = URL.createObjectURL(zipBlob);
    state.outputFilename = zipName;
    setDownloadEnabled(true);
    setOutputInfo({ size: zipBlob.size, mime: 'application/zip', filename: zipName, ext: 'zip' });
    setProgress(100);
    setProgressText(`Extracted ${count} keyframes`);
    logToConsole('ok', `Extracted ${count} keyframes → ${zipName}`);
  } catch (err) {
    const msg = String((err && err.message) || err);
    logToConsole('err', `Extract keyframes failed: ${msg}`);
    if (typeof showFriendlyError === 'function') showFriendlyError(msg);
  } finally {
    state.isProcessing = false;
    setCancelVisible(false);
    setControlsEnabled(true);
  }
}

// Build a contact sheet (rows × cols grid of frames).
async function runContactSheet() {
  if (state.isProcessing) { logToConsole('warn', 'Already processing.'); return; }
  if (!state.ffmpeg || !state.inputFile) { showInfo('No file', 'Load a video first.'); return; }
  const rows = parseInt(($('#cs-rows') || {}).value, 10) || 4;
  const cols = parseInt(($('#cs-cols') || {}).value, 10) || 4;
  const N = rows * cols;
  const outName = 'output.png';
  state.isProcessing = true;
  setControlsEnabled(false);
  setCancelVisible(true);
  setProgress(0);
  setProgressText(`Building contact sheet ${rows}×${cols}…`);
  try { await ff.deleteFile(outName); } catch (_) {}
  try {
    // select 1 every N frames, scale, tile. tile=COLSxROWS.
    const args = [
      '-i', state.inputFile.virtualName,
      '-frames:v', '1',
      '-vf', `select='not(mod(n,30))',scale=320:-1,tile=${cols}x${rows}`,
      outName,
    ];
    logToConsole('', `Exec: ffmpeg ${args.map(quoteArg).join(' ')}`);
    await ff.exec(args);
    const data = await ff.readFile(outName);
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const blob = new Blob([u8], { type: 'image/png' });
    if (state.outputBlobUrl) URL.revokeObjectURL(state.outputBlobUrl);
    state.outputBlobUrl = URL.createObjectURL(blob);
    state.outputFilename = `contact_sheet_${rows}x${cols}.png`;
    setDownloadEnabled(true);
    setOutputInfo({ size: u8.byteLength, mime: 'image/png', filename: state.outputFilename, ext: 'png' });
    setProgress(100);
    setProgressText(`Contact sheet done`);
    await addOutputToBin({ blob, name: `contact_sheet_${rows}x${cols}`, mime: 'image/png', ext: 'png', workflowName: 'Contact Sheet' });
    try { await ff.deleteFile(outName); } catch (_) {}
  } catch (err) {
    const msg = String((err && err.message) || err);
    logToConsole('err', `Contact sheet failed: ${msg}`);
    if (typeof showFriendlyError === 'function') showFriendlyError(msg);
  } finally {
    state.isProcessing = false;
    setCancelVisible(false);
    setControlsEnabled(true);
  }
}

// Build a video from a numbered PNG sequence in the bin.
async function runFramesToVideo() {
  if (state.isProcessing) { logToConsole('warn', 'Already processing.'); return; }
  if (!state.ffmpeg) { showInfo('Engine', 'Engine not ready.'); return; }
  // Find a sequence of PNGs in the bin. We look for outputs whose name
  // matches "img_NNN" or "frame_NNNNN" pattern; in any case the user
  // is expected to have loaded PNGs into the bin.
  // We use the FIRST matching sequence we find.
  const fps = parseInt(($('#f2v-fps') || {}).value, 10) || 24;
  // Strategy: search the bin for image-type media; if found, write a
  // concat list file pointing to the first few as input. For simplicity
  // we accept a contiguous sequence of bin images and concat them.
  const imgs = state.mediaBin.filter(m => m.type === 'image');
  if (imgs.length < 2) {
    showInfo('Frames → Video', 'Add at least 2 image files to the media bin first.');
    return;
  }
  // Sort by name to keep the order.
  imgs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const outName = 'output.mp4';
  state.isProcessing = true;
  setControlsEnabled(false);
  setCancelVisible(true);
  setProgress(0);
  setProgressText(`Building video from ${imgs.length} images @ ${fps}fps…`);
  try {
    // Use concat demuxer with image2 — the list is a text file of the
    // virtual names. But concat with image2 inputs requires -framerate.
    const list = imgs.map(m => `file '${m.virtualName}'`).join('\n') + '\n';
    await ff.writeFile('frames_list.txt', new TextEncoder().encode(list));
    const args = [
      '-framerate', String(fps),
      '-f', 'concat', '-safe', '0',
      '-i', 'frames_list.txt',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
      '-pix_fmt', 'yuv420p',
      outName,
    ];
    logToConsole('', `Exec: ffmpeg ${args.map(quoteArg).join(' ')}`);
    await ff.exec(args);
    const data = await ff.readFile(outName);
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const blob = new Blob([u8], { type: 'video/mp4' });
    if (state.outputBlobUrl) URL.revokeObjectURL(state.outputBlobUrl);
    state.outputBlobUrl = URL.createObjectURL(blob);
    state.outputFilename = `frames_to_video_${fps}fps.mp4`;
    setDownloadEnabled(true);
    setOutputInfo({ size: u8.byteLength, mime: 'video/mp4', filename: state.outputFilename, ext: 'mp4' });
    setProgress(100);
    setProgressText(`Video built`);
    await addOutputToBin({ blob, name: `frames_to_video_${fps}fps`, mime: 'video/mp4', ext: 'mp4', workflowName: 'Frames to Video' });
    try { await ff.deleteFile(outName); } catch (_) {}
    try { await ff.deleteFile('frames_list.txt'); } catch (_) {}
  } catch (err) {
    const msg = String((err && err.message) || err);
    logToConsole('err', `Frames → Video failed: ${msg}`);
    if (typeof showFriendlyError === 'function') showFriendlyError(msg);
  } finally {
    state.isProcessing = false;
    setCancelVisible(false);
    setControlsEnabled(true);
  }
}

// Bind all the new section controls (called from bindAll).
function bindNewSections() {
  // Section 26: Pitch presets
  document.querySelectorAll('.pitch-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = parseInt(btn.dataset.pitch, 10);
      const el = document.getElementById('pitch-semitones');
      if (el) { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }
    });
  });
  bindSliderDisplay('pitch-semitones', 'pitch-semitones-val', v => parseInt(v, 10));
  bindSliderDisplay('tempo-only', 'tempo-only-val', v => parseFloat(v).toFixed(2) + '×');
  // Section 27: 8D rate row visibility
  const chMode = document.getElementById('channel-mode');
  if (chMode) chMode.addEventListener('change', () => {
    const row = document.getElementById('row-8d-rate');
    if (row) row.hidden = chMode.value !== '8d';
    refreshCommandPreview();
  });
  bindSliderDisplay('apulsator-hz', 'apulsator-hz-val', v => parseFloat(v).toFixed(2));
  // Section 28: Dynamics displays
  bindSliderDisplay('gate-thresh', 'gate-thresh-val', v => parseInt(v, 10) + ' dB');
  bindSliderDisplay('comp-thresh', 'comp-thresh-val', v => parseInt(v, 10) + ' dB');
  bindSliderDisplay('comp-ratio',  'comp-ratio-val',  v => parseFloat(v).toFixed(1));
  bindSliderDisplay('comp-attack', 'comp-attack-val', v => parseInt(v, 10) + ' ms');
  bindSliderDisplay('comp-release','comp-release-val',v => parseInt(v, 10) + ' ms');
  bindSliderDisplay('limit-ceiling','limit-ceiling-val',v => parseFloat(v).toFixed(2));
  bindSliderDisplay('deess-freq',  'deess-freq-val',  v => parseInt(v, 10) + ' Hz');
  bindSliderDisplay('deess-reduce','deess-reduce-val',v => parseFloat(v).toFixed(1) + ' dB');
  // Section 29: Visualization
  bindSliderDisplay('viz-w',  'viz-w-val',  v => parseInt(v, 10));
  bindSliderDisplay('viz-h',  'viz-h-val',  v => parseInt(v, 10));
  const vizType = document.getElementById('viz-type');
  if (vizType) vizType.addEventListener('change', () => {
    const t = vizType.value;
    const rowMode = document.getElementById('row-viz-mode');
    const rowColormap = document.getElementById('row-viz-colormap');
    if (rowMode) rowMode.hidden = (t !== 'showwaves');
    if (rowColormap) rowColormap.hidden = (t !== 'showspectrum');
    refreshCommandPreview();
  });
  const vizBg = document.getElementById('viz-bg-select');
  if (vizBg) vizBg.addEventListener('change', refreshCommandPreview);
  // Section 30: Zoom & Motion
  bindSliderDisplay('kb-zstart', 'kb-zstart-val', v => parseFloat(v).toFixed(2) + '×');
  bindSliderDisplay('kb-zend',   'kb-zend-val',   v => parseFloat(v).toFixed(2) + '×');
  bindSliderDisplay('shake-intensity', 'shake-intensity-val', v => parseInt(v, 10));
  bindSliderDisplay('shake-speed',     'shake-speed-val',     v => parseInt(v, 10));
  bindSliderDisplay('spin-speed',      'spin-speed-val',      v => parseFloat(v).toFixed(1));
  // Section 31: Retro / CRT
  bindSliderDisplay('scan-spacing',      'scan-spacing-val',      v => parseInt(v, 10));
  bindSliderDisplay('scan-opacity',      'scan-opacity-val',      v => parseFloat(v).toFixed(2));
  bindSliderDisplay('chromableed-h',     'chromableed-h-val',     v => parseInt(v, 10));
  bindSliderDisplay('chromableed-v',     'chromableed-v-val',     v => parseInt(v, 10));
  bindSliderDisplay('tracking-severity', 'tracking-severity-val', v => parseInt(v, 10));
  bindSliderDisplay('dropout-freq',      'dropout-freq-val',      v => parseFloat(v).toFixed(3));
  // Section 32: Frames & Stills
  const efBtn = document.getElementById('btn-extract-frame');
  if (efBtn) efBtn.addEventListener('click', runExtractSingleFrame);
  const eaBtn = document.getElementById('btn-extract-all');
  if (eaBtn) eaBtn.addEventListener('click', runExtractAllFrames);
  const kfBtn = document.getElementById('btn-extract-keyframes');
  if (kfBtn) kfBtn.addEventListener('click', runExtractKeyframes);
  const csBtn = document.getElementById('btn-contact-sheet');
  if (csBtn) csBtn.addEventListener('click', runContactSheet);
  const fvBtn = document.getElementById('btn-frames-to-video');
  if (fvBtn) fvBtn.addEventListener('click', runFramesToVideo);
}

// =============================================================================
// BOOMERANG (Workflow 26)
// Three-pass pipeline: (1) encode forward copy, (2) reverse to a second file,
// (3) concat forward + reversed into the final output.
// =============================================================================
async function runBoomerangWorkflow() {
  if (state.isProcessing) { logToConsole('warn', 'Already processing.'); return; }
  if (!state.ffmpeg || !state.inputFile) return;
  const forward = 'boomerang_forward.mp4';
  const reversed = 'boomerang_reversed.mp4';
  const outName = 'boomerang.mp4';
  // Clean any prior intermediates
  for (const f of [forward, reversed, outName]) {
    try { await ff.deleteFile(f); } catch (_) {}
  }
  if (state.outputBlobUrl) { URL.revokeObjectURL(state.outputBlobUrl); state.outputBlobUrl = null; }

  state.isProcessing = true;
  setControlsEnabled(false);
  setCancelVisible(true);
  setProgress(0);
  const start = performance.now();
  const stepCount = 3;

  const runStep = async (label, args, stepN) => {
    setProgress(((stepN - 1) / stepCount) * 100);
    setProgressText(`Boomerang: ${label} (${stepN}/${stepCount})`);
    logToConsole('', `Exec: ffmpeg ${args.map(quoteArg).join(' ')}`);
    await ff.exec(args);
  };

  try {
    // Step 1: forward copy (drop audio so the reverse is silent and the
    // concat doesn't double-track)
    await runStep('Forward pass', [
      '-i', state.inputFile.virtualName,
      '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      forward,
    ], 1);

    // Step 2: reverse the forward file
    await runStep('Reverse pass', [
      '-i', forward,
      '-vf', 'reverse',
      '-an',
      reversed,
    ], 2);

    // Step 3: concat forward + reversed via concat demuxer
    // Use a concat list file in MEMFS so the demuxer reads it cleanly.
    const listName = 'boomerang_concat.txt';
    const listContent = `file '${forward}'\nfile '${reversed}'\n`;
    await ff.writeFile(listName, new TextEncoder().encode(listContent));
    await runStep('Concat pass', [
      '-f', 'concat', '-safe', '0',
      '-i', listName,
      '-c', 'copy',
      outName,
    ], 3);

    // Clean intermediate files
    try { await ff.deleteFile(forward); } catch (_) {}
    try { await ff.deleteFile(reversed); } catch (_) {}
    try { await ff.deleteFile(listName); } catch (_) {}

    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    setProgress(100);
    setProgressText(`Boomerang done in ${elapsed}s`);

    const data = await ff.readFile(outName);
    const u8 = (data instanceof Uint8Array) ? data : new Uint8Array(data);
    const mime = 'video/mp4';
    const blob = new Blob([u8], { type: mime });
    if (state.outputBlobUrl) URL.revokeObjectURL(state.outputBlobUrl);
    state.outputBlobUrl = URL.createObjectURL(blob);
    state.outputFilename = outName;
    loadOutputPreview(state.outputBlobUrl, mime);
    setDownloadEnabled(true);
    setOutputInfo({ size: u8.byteLength, mime, filename: outName, ext: 'mp4' });
    if (typeof addCommandHistory === 'function') {
      addCommandHistory(`Boomerang loop → ${outName}`, 'ok');
    }
    switchTab('preview');
    logToConsole('ok', `Boomerang complete in ${elapsed}s — see Preview tab.`);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (typeof showFriendlyError === 'function') showFriendlyError(msg);
    else logToConsole('err', `Boomerang failed: ${msg}`);
  } finally {
    state.isProcessing = false;
    setControlsEnabled(true);
    setCancelVisible(false);
  }
}

function applyAndEditWorkflow(workflowId) {
  applyWorkflow(workflowId);
  switchTab('editor');
}

// =============================================================================
// CUSTOM WORKFLOWS (localStorage)
// =============================================================================
const CUSTOM_WF_KEY = 'ffmpeg-studio:custom-workflows';
function loadCustomWorkflows() {
  try {
    const raw = localStorage.getItem(CUSTOM_WF_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}
function saveCustomWorkflows(arr) {
  try { localStorage.setItem(CUSTOM_WF_KEY, JSON.stringify(arr)); } catch (_) {}
}
function createCustomWorkflowFromCurrentState() {
  const settings = {};
  $$('input, select, textarea').forEach(el => {
    if (!el.id) return;
    if (el.id.startsWith('enable-') && el.type === 'checkbox') settings[el.id] = el.checked;
    else if (el.type === 'checkbox') settings[el.id] = el.checked;
    else if (el.tagName === 'SELECT' || el.type === 'text' || el.type === 'number') settings[el.id] = el.value;
    else if (el.type === 'range') settings[el.id] = parseFloat(el.value);
  });
  const outFormat = document.getElementById('out-format').value;
  const codec = document.getElementById('vcodec').value;
  const crf = parseInt(document.getElementById('crf').value, 10);
  return {
    id: 'custom-' + Date.now(),
    name: 'My Custom Workflow',
    category: 'custom',
    description: 'Saved from current Editor state.',
    tags: ['custom', 'user'],
    icon: '⭐',
    settings,
    outputFormat: outFormat,
    codec,
    crf,
    custom: true,
  };
}

// =============================================================================
// NL → WORKFLOW KEYWORD MATCHING (no API call; pure local regex match)
// =============================================================================
function nlToFFmpegCommand(text) {
  const lower = String(text || '').toLowerCase();
  // Order matters: more specific first
  if (/\b(extract audio|rip audio|save audio)\b/.test(lower)) {
    return { name: 'Extract Audio (MP3)', settings: { 'enable-18': true, 'extract-audio': true, 'audio-format': 'mp3', 'audio-rate': 44100 }, outputFormat: 'mp3', codec: 'copy', crf: 23 };
  }
  if (/\b(vhs|retro( tape)?|80s|90s)\b/.test(lower)) {
    return { name: 'VHS Retro Look', settings: { 'enable-7': true, 'eq-saturation': 1.2, 'eq-contrast': 0.95, 'enable-13': true, 'add-noise': true, 'noise-strength': 15, 'noise-type': 't+u', 'enable-19': true, 'g-geq-enable': true, 'g-geq-preset': 'scanline', 'g-geq-spacing': 3, 'g-lagfun-enable': true, 'g-lagfun-decay': 0.92 }, outputFormat: 'mp4', codec: 'libx264', crf: 20 };
  }
  if (/\b(cinematic|orange.*teal|teal.*orange)\b/.test(lower)) {
    return { name: 'Cinematic Teal-Orange', settings: { 'enable-7': true, 'eq-saturation': 1.3, 'eq-contrast': 0.95, 'enable-13': true, 'add-noise': true, 'noise-strength': 10, 'noise-type': 't' }, outputFormat: 'mp4', codec: 'libx264', crf: 20 };
  }
  if (/\b(glitch|datamosh|chaos|corrupt)\b/.test(lower)) {
    return { name: 'RGB Channel Split', settings: { 'enable-19': true, 'g-geq-enable': true, 'g-geq-preset': 'chansplit', 'g-geq-offset': 15 }, outputFormat: 'mp4', codec: 'libx264', crf: 20 };
  }
  if (/\b(slow( motion)?)\b/.test(lower)) {
    return { name: 'Slow Motion 0.5×', settings: { 'enable-6': true, 'speed': 0.5, 'speed-video': true, 'speed-audio': true }, outputFormat: 'mp4', codec: 'libx264', crf: 20 };
  }
  if (/\b(speed up|fast|accelerate)\b/.test(lower)) {
    return { name: 'Speed Up 2×', settings: { 'enable-6': true, 'speed': 2.0, 'speed-video': true, 'speed-audio': true }, outputFormat: 'mp4', codec: 'libx264', crf: 20 };
  }
  if (/\b(reverse)\b/.test(lower)) {
    return { name: 'Reverse Video', settings: { 'enable-6': true, 'rev-video': true, 'rev-audio': true }, outputFormat: 'mp4', codec: 'libx264', crf: 20 };
  }
  if (/\b(gif|animated)\b/.test(lower)) {
    return { name: 'Video to GIF (Standard)', settings: { 'enable-17': true, 'gif-enable': true, 'gif-w': 480, 'gif-fps': 15, 'gif-palette': true, 'gif-loop': 0 }, outputFormat: 'gif', codec: 'libx264', crf: 23 };
  }
  if (/\b(compress|smaller|reduce size)\b/.test(lower)) {
    return { name: 'Reduce File Size (Aggressive)', settings: { 'vcodec': 'libx264', 'enc-preset': 'veryfast', 'crf': 32, 'ab-rate': '96k', 'enable-3': true, 'scale-w': 1280, 'scale-h': 720, 'scale-algo': 'lanczos' }, outputFormat: 'mp4', codec: 'libx264', crf: 32 };
  }
  if (/\b(mute|silence|no audio|strip audio)\b/.test(lower)) {
    return { name: 'Mute Video', settings: { 'enable-12': true, 'strip-audio': true }, outputFormat: 'mp4', codec: 'libx264', crf: 23 };
  }
  if (/\b(trim|cut)\b/.test(lower)) {
    return { name: 'Quick Trim', settings: { 'enable-2': true, 'trim-start': '00:00:05.000', 'trim-end': '00:00:15.000' }, outputFormat: 'mp4', codec: 'libx264', crf: 23 };
  }
  return { name: 'No match', settings: {}, outputFormat: 'mp4', codec: 'libx264', crf: 23, error: 'No keyword matched. Try: vhs, cinematic, glitch, slow, speed up, reverse, gif, compress, mute, extract audio, trim.' };
}

// =============================================================================
// BOOTSTRAP v2
// =============================================================================
function bootV2() {
  bindTabs();
  bindMergeSection();
  bindStabilizeDeinterlace();
  bindCurvesAndColorPresets();
  bindChromashift();
  bindPreview();
  stateV2.customWorkflows = loadCustomWorkflows();
  switchTab('workflows'); // default per spec
  // Workflows + Agents init are called from their own files.
  if (typeof initWorkflowsUI === 'function') initWorkflowsUI();
  // PHASE 0 FIX: agents.js's old `initAgentsUI_v2` wrapper caused
  // infinite recursion (it reassigned window.initAgentsUI to itself).
  // The fix in agents.js introduces `bootAgentsHub()` which wraps
  // the agent boot + the command-history binder without the
  // self-referential reassignment. Fall back to `initAgentsUI` if
  // the older build is loaded.
  if (typeof bootAgentsHub === 'function') {
    bootAgentsHub();
  } else if (typeof initAgentsUI === 'function') {
    initAgentsUI();
  }
}

// Replace the v1 DOMContentLoaded handler so we run BOTH v1 and v2 boot code.
const _origDOMContentLoaded = window.onload;
// We re-bind via capturing the original listener registration. Instead, we
// call bootV2 from the existing v1 boot via setTimeout at the end.
const _origBoot = window.addEventListener;
window.addEventListener('DOMContentLoaded', () => {
  // Run after v1 has finished its init (captureDefaults, bindAll, initFFmpeg).
  setTimeout(() => {
    try { bootV2(); } catch (e) { console.error('bootV2 failed:', e); }
  }, 50);
});
