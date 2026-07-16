/* =============================================================================
 * v4 PART B2 — Beat Detection
 * -----------------------------------------------------------------------------
 * Decodes the active audio with Web Audio's AudioContext.decodeAudioData,
 * runs onset detection via spectral flux on ~1024-sample windows, applies
 * a moving-average threshold, picks peaks, and estimates BPM from the
 * median inter-onset interval.
 *
 * Output: state.beats (array of onset times in seconds) + state.bpm.
 *
 * Also exposes:
 *   detectBeatsForActive()                  — high-level entry point
 *   buildBeatSyncEnableExpr(filter, ...)    — generate ffmpeg enable=
 *                                             expressions from state.beats
 *   drawBeatTicks(canvas, beats, duration)  — render tick marks on the
 *                                             timeline canvas
 * ============================================================================= */

'use strict';

const BEAT = {
  ctx: null,                  // AudioContext (created on first use)
  audioBuffer: null,          // decoded audio of the current source
  sourceName: '',             // for cache invalidation
  peaks: [],                  // onset times in seconds
  bpm: 0,
  // Tuning knobs.
  frameSize: 1024,
  hopSize: 512,
  // Moving-average window length (in frames) for the adaptive threshold.
  avgWindow: 16,
  // Minimum spacing between two adjacent peaks.
  minPeakDistance: 0.18,      // seconds
  // Peak must be at least this much above the moving average.
  thresholdMul: 1.35,
};

// =============================================================================
// AUDIO CONTEXT (lazy)
// =============================================================================
function getAudioContext() {
  if (BEAT.ctx) return BEAT.ctx;
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) { logToConsole('err', 'Web Audio API not available.'); return null; }
  BEAT.ctx = new C();
  return BEAT.ctx;
}

// =============================================================================
// DECODE THE ACTIVE FILE
// =============================================================================
async function ensureDecodedAudio() {
  if (!state.inputFile) { logToConsole('err', 'No active file.'); return null; }
  const ac = getAudioContext();
  if (!ac) return null;
  if (ac.state === 'suspended') {
    try { await ac.resume(); } catch (_) {}
  }
  if (BEAT.audioBuffer && BEAT.sourceName === state.inputFile.virtualName) {
    return BEAT.audioBuffer;
  }
  if (!state.ffmpeg) return null;
  const vname = state.inputFile.virtualName;
  let data;
  try { data = await state.ffmpeg.readFile(vname); } catch (e) {
    logToConsole('err', 'Could not read MEMFS file for beat detection: ' + (e && e.message || e));
    return null;
  }
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  // AudioContext.decodeAudioData accepts an ArrayBuffer; some browsers
  // reject Uint8Array directly, so copy into a true ArrayBuffer first.
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  try {
    BEAT.audioBuffer = await ac.decodeAudioData(ab);
    BEAT.sourceName = vname;
    return BEAT.audioBuffer;
  } catch (e) {
    logToConsole('err', 'Audio decode failed (file may have no audio or be unsupported): ' + (e && e.message || e));
    return null;
  }
}

// =============================================================================
// SPECTRAL FLUX + PEAK PICKING
// =============================================================================
function computeOnsets(audioBuffer) {
  // Mix down to mono for the onset detection pass. The audio buffer
  // might be 1 or 2 channels.
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
  const N = ch0.length;
  const sr = audioBuffer.sampleRate;
  const F = BEAT.frameSize;
  const H = BEAT.hopSize;
  const numFrames = Math.max(1, Math.floor((N - F) / H) + 1);
  // Magnitude spectrum (one frame at a time). We keep only the lower
  // half (F/2 + 1 bins) since the rest is mirror.
  const re = new Float32Array(F);
  const im = new Float32Array(F);
  const win = hannWindow(F);
  const flux = new Float32Array(numFrames);
  const prevMag = new Float32Array(F / 2 + 1);

  for (let f = 0; f < numFrames; f++) {
    const start = f * H;
    // Fill the working frame. Mix to mono.
    for (let i = 0; i < F; i++) {
      const s = (start + i < N) ? ch0[start + i] : 0;
      const t = ch1 ? (start + i < N ? ch1[start + i] : 0) : s;
      re[i] = ((s + t) * 0.5) * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    // Compute flux = sum of positive differences in magnitude spectrum
    // vs the previous frame. We ignore the DC bin.
    let sum = 0;
    for (let k = 1; k <= F / 2; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const diff = mag - prevMag[k];
      if (diff > 0) sum += diff;
      prevMag[k] = mag;
    }
    flux[f] = sum;
  }
  // Normalize flux by the global max so subsequent thresholds are
  // intuitive.
  let maxF = 0;
  for (let i = 0; i < flux.length; i++) if (flux[i] > maxF) maxF = flux[i];
  if (maxF > 0) for (let i = 0; i < flux.length; i++) flux[i] /= maxF;

  // Peak picking: for each frame, if flux[i] is a local max within a
  // small window AND exceeds the moving average * thresholdMul AND
  // enough time has passed since the last peak, record it.
  const peaks = [];              // array of { frame, time, strength }
  const W = BEAT.avgWindow;
  const localWin = 3;            // +/- frames
  const minFrames = Math.max(1, Math.round(BEAT.minPeakDistance * sr / H));
  let lastPeakFrame = -minFrames - 1;
  for (let i = W; i < flux.length - W; i++) {
    // local maximum
    let isMax = true;
    for (let j = -localWin; j <= localWin; j++) {
      if (j === 0) continue;
      if (flux[i + j] > flux[i]) { isMax = false; break; }
    }
    if (!isMax) continue;
    // moving average over a window centered on i
    let avg = 0;
    for (let j = -W; j <= W; j++) avg += flux[i + j];
    avg /= (2 * W + 1);
    if (flux[i] < avg * BEAT.thresholdMul) continue;
    // spacing
    if (i - lastPeakFrame < minFrames) continue;
    lastPeakFrame = i;
    peaks.push({ frame: i, time: (i * H) / sr, strength: flux[i] });
  }
  return peaks;
}

// Estimate BPM from the median of the inter-onset intervals. Real
// music BPM lives in [60, 200] for the vast majority of cases; we
// also fold the double/half tempo ambiguities by trying a couple of
// multipliers and picking the one that lands in the canonical range.
function estimateBPM(peaks) {
  if (peaks.length < 4) return 0;
  const intervals = [];
  for (let i = 1; i < peaks.length; i++) {
    const dt = peaks[i].time - peaks[i - 1].time;
    if (dt > 0.2 && dt < 2.0) intervals.push(dt);
  }
  if (intervals.length < 3) return 0;
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  let bpm = 60 / median;
  // Fold: if the candidate is too slow, double it; if too fast, halve.
  while (bpm < 60) bpm *= 2;
  while (bpm > 200) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}

// =============================================================================
// FFT (radix-2 in-place, real + imag buffers)
// =============================================================================
function fftInPlace(re, im) {
  const n = re.length;
  // Bit-reversal permutation.
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tr = re[i]; re[i] = re[j]; re[j] = tr;
      let ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angle = -2 * Math.PI / size;
    const wReStep = Math.cos(angle);
    const wImStep = Math.sin(angle);
    for (let off = 0; off < n; off += size) {
      let wRe = 1, wIm = 0;
      for (let k = 0; k < half; k++) {
        const aRe = re[off + k];
        const aIm = im[off + k];
        const bRe = re[off + k + half] * wRe - im[off + k + half] * wIm;
        const bIm = re[off + k + half] * wIm + im[off + k + half] * wRe;
        re[off + k]         = aRe + bRe;
        im[off + k]         = aIm + bIm;
        re[off + k + half]  = aRe - bRe;
        im[off + k + half]  = aIm - bIm;
        const nwRe = wRe * wReStep - wIm * wImStep;
        const nwIm = wRe * wImStep + wIm * wReStep;
        wRe = nwRe; wIm = nwIm;
      }
    }
  }
}

function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
  }
  return w;
}

// =============================================================================
// PUBLIC: detectBeatsForActive()
// =============================================================================
async function detectBeatsForActive() {
  const status = document.getElementById('beat-strip-status');
  const bpmEl  = document.getElementById('beat-bpm');
  if (status) status.textContent = 'Decoding audio…';
  if (bpmEl) bpmEl.textContent = '—';
  const buf = await ensureDecodedAudio();
  if (!buf) { if (status) status.textContent = 'No audio in active file.'; return; }
  if (status) status.textContent = 'Detecting onsets…';
  // Let the UI repaint before we lock the main thread on a potentially
  // multi-second FFT loop.
  await new Promise(r => setTimeout(r, 10));
  const peaks = computeOnsets(buf);
  const times = peaks.map(p => p.time);
  state.beats = times;
  state.bpm   = estimateBPM(peaks);
  BEAT.peaks  = peaks;
  BEAT.bpm    = state.bpm;
  if (bpmEl) bpmEl.textContent = state.bpm ? state.bpm.toFixed(1) : '—';
  if (status) status.textContent = `Detected ${times.length} beats over ${buf.duration.toFixed(1)}s.`;
  // Reveal the strip + render tick marks.
  const strip = document.getElementById('beat-strip');
  if (strip) strip.hidden = false;
  const canvas = document.getElementById('beat-ticks-canvas');
  if (canvas) {
    drawBeatTicks(canvas, state.beats, buf.duration);
  }
  // Unlock the "Apply to Editor" button.
  const apply = document.getElementById('bs-apply');
  if (apply) apply.disabled = false;
  const bsStatus = document.getElementById('bs-status');
  if (bsStatus) bsStatus.textContent = state.bpm
    ? `${times.length} beats @ ${state.bpm.toFixed(1)} BPM. Pick an effect and hit Apply.`
    : `Detected ${times.length} onsets (BPM unclear). Pick an effect and hit Apply.`;
  return { beats: state.beats, bpm: state.bpm };
}

// =============================================================================
// RENDER TICK MARKS
// =============================================================================
function drawBeatTicks(canvas, beats, duration) {
  if (!canvas) return;
  // Match the canvas backing store to its CSS size * devicePixelRatio
  // for sharp lines on high-DPI displays.
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth  || 800;
  const cssH = canvas.clientHeight || 36;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  // Background gradient.
  const grad = ctx.createLinearGradient(0, 0, 0, cssH);
  grad.addColorStop(0, 'rgba(0, 212, 255, 0.05)');
  grad.addColorStop(1, 'rgba(0, 212, 255, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, cssW, cssH);
  // Tick marks.
  if (!beats || !beats.length || !duration) return;
  ctx.fillStyle = '#00d4ff';
  ctx.strokeStyle = 'rgba(0, 212, 255, 0.4)';
  ctx.lineWidth = 1;
  for (let i = 0; i < beats.length; i++) {
    const x = (beats[i] / duration) * cssW;
    if (i % 4 === 0) {
      // Downbeat: taller tick.
      ctx.fillRect(Math.round(x) - 1, 4, 2, cssH - 8);
    } else {
      ctx.fillRect(Math.round(x), 8, 1, cssH - 16);
    }
  }
  // Time labels every 5s.
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '10px "SF Mono", Menlo, Consolas, monospace';
  for (let t = 0; t < duration; t += 5) {
    const x = (t / duration) * cssW;
    ctx.fillText(formatTimeShort(t), x + 2, cssH - 2);
  }
}
function formatTimeShort(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// Redraw ticks when the window resizes.
window.addEventListener('resize', () => {
  const canvas = document.getElementById('beat-ticks-canvas');
  if (canvas && state.beats && state.beats.length) {
    const dur = state.inputFile && state.inputFile.durationSec;
    if (dur) drawBeatTicks(canvas, state.beats, dur);
  }
});

// =============================================================================
// GENERATE enable= EXPRESSIONS
// =============================================================================
// The ffmpeg "enable=" expression takes a per-frame boolean. We build
//   hue=h=180:enable='between(t,1.42,1.52)+between(t,2.31,2.41)+...'
// from the state.beats list. ffmpeg's expression parser has a limit on
// the number of operators; we cap at ~40 between() terms per filter and
// warn the user if we exceed.
//
// `kind` selects which filter and how to construct the expression:
//   'hue'      hue=h=<strength*180>:enable=...
//   'eq'       eq=brightness=<s>:enable=...
//   'negate'   negate:enable=...
//   'rgbashift' rgbashift=<s>:enable=...
//   'chromashift' chromashift=<s>:enable=...
//   'vignette' vignette=<s>:enable=...
//   'zoom'     scale=...:enable=...   (we delegate to the existing zoom section)
//   'shake'    <no ffmpeg primitive — emit a comment>
function buildBetweenList(beats, trigger, duration, hitDur) {
  // trigger: '1' | '2' | '4' | 'drops'
  if (!beats || !beats.length) return [];
  const out = [];
  if (trigger === 'drops') {
    // Top 25% by strength — but we only kept times, so use BPM-derived
    // heuristic: assume onsets near integer multiples of (60/bpm) are
    // strong. Cheaper: just use every 4th onset as a "drop" surrogate.
    for (let i = 0; i < beats.length; i += 4) {
      const t0 = beats[i];
      const t1 = Math.min(duration, t0 + hitDur);
      if (t1 > t0) out.push([t0, t1]);
    }
  } else {
    const step = Math.max(1, parseInt(trigger, 10) || 1);
    for (let i = 0; i < beats.length; i += step) {
      const t0 = beats[i];
      const t1 = Math.min(duration, t0 + hitDur);
      if (t1 > t0) out.push([t0, t1]);
    }
  }
  return out;
}

function buildBeatSyncEnableExpr(kind, opts) {
  const trigger = (opts && opts.trigger) || '1';
  const hitDur  = (opts && opts.hitDurSec) || 0.12;
  const strength= (opts && opts.strength != null) ? opts.strength : 0.5;
  const dur = (state.inputFile && state.inputFile.durationSec) || 0;
  const beats = state.beats || [];
  const list = buildBetweenList(beats, trigger, dur, hitDur);
  if (!list.length) return null;
  // Cap at ~40 between() terms. ffmpeg's expression parser has a
  // practical limit; beyond that it errors out with "Expression too
  // complex". For now we cap and let the user shorten hit duration.
  const MAX = 40;
  const used = list.slice(0, MAX);
  const enableExpr = used.map(([a, b]) => `between(t,${a.toFixed(2)},${b.toFixed(2)})`).join('+');
  switch (kind) {
    case 'hue': {
      const deg = Math.round(strength * 180);
      return `hue=h=${deg}:enable='${enableExpr}'`;
    }
    case 'eq': {
      // Brightness punch, with strength controlling amount.
      const b = (strength * 0.5).toFixed(2);
      const c = (1 + strength * 0.6).toFixed(2);
      const s = (1 + strength * 0.6).toFixed(2);
      return `eq=brightness=${b}:contrast=${c}:saturation=${s}:enable='${enableExpr}'`;
    }
    case 'negate': {
      return `negate:enable='${enableExpr}'`;
    }
    case 'rgbashift': {
      const amt = (strength * 8).toFixed(2);
      return `rgbashift=rs=${amt}:bs=-${amt}:enable='${enableExpr}'`;
    }
    case 'chromashift': {
      const amt = (strength * 8).toFixed(2);
      return `chromashift=cbh=${amt}:crh=-${amt}:enable='${enableExpr}'`;
    }
    case 'vignette': {
      const ang = (strength * 0.6).toFixed(2);
      return `vignette=angle=${ang}:enable='${enableExpr}'`;
    }
    case 'zoom': {
      // Zoom punch: scale up briefly. We emit a simple zoompan.
      const z = (1 + strength * 0.3).toFixed(2);
      return `scale=iw*${z}:ih*${z}:enable='${enableExpr}'`;
    }
    case 'shake': {
      // Camera shake: use a rotation micro-jitter via rotate. ffmpeg
      // doesn't have a perfect single-filter equivalent to "shake", so
      // we emit a rotate expression instead — visually similar.
      const ang = (strength * 3).toFixed(2);
      return `rotate=${ang}*sin(50*t):enable='${enableExpr}':fillcolor=black`;
    }
    default:
      return null;
  }
  // (unused but documents the soft cap)
  // eslint-disable-next-line no-unreachable
  // return list.length > MAX ? 'capped' : null;
}

// =============================================================================
// APPLY (writes the generated expression into the matching Editor
// section by setting the appropriate control value and enabling it).
// =============================================================================
function applyBeatSyncToEditor() {
  if (!state.beats || !state.beats.length) {
    logToConsole('err', 'No beats detected. Run "Detect beats" first.');
    return;
  }
  const kind    = (document.getElementById('bs-effect')   || {}).value || 'hue';
  const trigger = (document.getElementById('bs-trigger')  || {}).value || '1';
  const durMs   = parseInt((document.getElementById('bs-duration') || {}).value || '120', 10) || 120;
  const strength= parseFloat((document.getElementById('bs-strength') || {}).value || '0.5') || 0.5;
  const hitDurSec = Math.max(0.05, durMs / 1000);
  const expr = buildBeatSyncEnableExpr(kind, { trigger, hitDurSec, strength });
  if (!expr) { logToConsole('err', 'Could not build expression.'); return; }
  // Map kind to a target Editor section + control. We use the existing
  // 'user-eq' / 'user-hue' etc. hidden text fields if they exist;
  // otherwise we synthesize a one-off text field under the beatsync
  // section that the user can copy from. The standard pattern: append
  // the filter to a "user-vf" hidden input.
  const userVf = document.getElementById('user-vf') || document.getElementById('user-filters');
  // Different filters live in different sections. We map by enabling
  // the relevant section and writing the expression into the existing
  // "hue-h" / "eq-brightness" / "negate" controls, OR we fall back to
  // writing into #user-vf if it's there. The Command Builder then
  // concatenates these.
  // For now, the simplest path: stash the expression on state and the
  // buildFFmpegCommand() function in app.js will merge it via the
  // 'beat-sync-expr' field we add.
  state.beatSyncExpr = expr;
  // Flip the matching section's enable checkbox.
  const enableMap = { hue: 7, eq: 7, negate: 7, rgbashift: 19, chromashift: 19, vignette: 7, zoom: 30, shake: 30 };
  const targetSec = enableMap[kind] || 7;
  const enableBox = document.getElementById('enable-' + targetSec);
  if (enableBox) enableBox.checked = true;
  // Echo in the log so the user can see what got generated.
  logToConsole('ok', `Beat-sync: ${kind} → ${expr}`);
  const status = document.getElementById('bs-status');
  if (status) status.textContent = 'Applied. Switch to the Editor tab, tweak the strength slider, then hit Run.';
  refreshCommandPreview();
}

function clearBeatSync() {
  state.beatSyncExpr = null;
  refreshCommandPreview();
  const status = document.getElementById('bs-status');
  if (status) status.textContent = 'Cleared.';
  logToConsole('', 'Beat-sync expression cleared.');
}

// =============================================================================
// WIRE UI
// =============================================================================
function bindBeatDetectionUI() {
  const detectBtn = document.getElementById('beat-detect-btn');
  if (detectBtn) detectBtn.addEventListener('click', () => detectBeatsForActive());
  const applyBtn = document.getElementById('bs-apply');
  if (applyBtn) applyBtn.addEventListener('click', () => applyBeatSyncToEditor());
  const clearBtn = document.getElementById('bs-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => clearBeatSync());
  // Live-update the duration label.
  const dur = document.getElementById('bs-duration');
  const durVal = document.getElementById('bs-duration-val');
  if (dur && durVal) dur.addEventListener('input', () => { durVal.textContent = dur.value + 'ms'; });
  const str = document.getElementById('bs-strength');
  const strVal = document.getElementById('bs-strength-val');
  if (str && strVal) str.addEventListener('input', () => { strVal.textContent = parseFloat(str.value).toFixed(2); });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindBeatDetectionUI);
} else {
  bindBeatDetectionUI();
}
