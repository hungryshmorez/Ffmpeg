// =============================================================================
// preview-fx.js  —  Live FX in the Preview tab
// =============================================================================
// Answers the standing question "can the preview screen do the same things —
// run the source through effects live?". Adds a "✨ Live FX" mode to the
// Preview tab that pipes the loaded source video, frame by frame, through the
// SHARED effect engine (the FFHoverPreview look ops + real FFShaderPlus shader
// passes — pixelSort / halation / film grain, the same library Trip Cam builds
// on) onto a live canvas, and records that canvas straight into the Media Bin
// via TripCam.startRec — so you can then stack more with ffmpeg on top.
//
// It follows the exact rAF pattern the false-colour / scopes preview modes use:
// read #pv-source → offscreen canvas → process pixels → draw to #pv-fx.
// =============================================================================

(function (global) {
  'use strict';

  const HP = () => global.FFHoverPreview;
  const SP = () => global.FFShaderPlus;

  // ---- Effect registry -------------------------------------------------------
  // Each effect: { id, name, apply(imageData, amt) -> imageData (mutated) }.
  // Look-engine effects derive ops from `amt`; shader effects call FFShaderPlus.
  function lookEffect(id, name, ops) {
    return { id, name, apply: (img, amt) => { const o = ops(amt); if (HP()) HP().applyLook(img, o); return img; } };
  }

  const EFFECTS = [
    { id: 'none', name: 'None (bypass)', apply: (img) => img },
    lookEffect('grayscale', 'Grayscale', () => [{ type: 'grayscale' }]),
    lookEffect('invert', 'Invert', () => [{ type: 'invert' }]),
    lookEffect('vibrant', 'Vibrant', (a) => [{ type: 'saturate', amount: 1 + a }]),
    lookEffect('desaturate', 'Desaturate', (a) => [{ type: 'saturate', amount: Math.max(0, 1 - a) }]),
    lookEffect('warm', 'Warm', (a) => [{ type: 'channelGain', rgb: [1 + 0.22 * a, 1, 1 - 0.22 * a] }]),
    lookEffect('cool', 'Cool', (a) => [{ type: 'channelGain', rgb: [1 - 0.22 * a, 1, 1 + 0.22 * a] }]),
    lookEffect('bleach', 'Bleach Bypass', (a) => [{ type: 'saturate', amount: Math.max(0, 1 - 0.6 * a) }, { type: 'contrast', amount: 1 + 0.4 * a }]),
    lookEffect('contrast', 'Punch (contrast)', (a) => [{ type: 'contrast', amount: 1 + 0.5 * a }]),
    lookEffect('posterize', 'Posterize', (a) => [{ type: 'posterize', levels: Math.max(2, Math.round(8 - 5 * Math.min(1, a))) }]),
    lookEffect('vignette', 'Vignette', (a) => [{ type: 'vignette', amount: Math.min(0.95, 0.6 * a) }]),
    lookEffect('blur', 'Dreamy blur', (a) => [{ type: 'blur', radius: Math.max(1, Math.round(3 * a)) }]),
    lookEffect('sepia', 'Sepia', () => [{ type: 'sepia' }]),
    lookEffect('vhs', 'VHS', (a) => [{ type: 'noise', amount: 22 * a, seed: 9 }, { type: 'channelGain', rgb: [1 + 0.05 * a, 1, 1 + 0.05 * a] }, { type: 'saturate', amount: 1 + 0.25 * a }]),
    // --- real FFShaderPlus shader passes (shared with Trip Cam / glitch WFs) ---
    { id: 'pixelsort', name: 'Pixel Sort ✦', apply: (img, amt) => { const s = SP(); if (s && s.pixelSort) return s.pixelSort(img, { threshold: Math.max(0.05, 0.7 - 0.5 * Math.min(1, amt)) }) || img; return img; } },
    { id: 'halation', name: 'Halation ✦', apply: (img, amt) => { const s = SP(); if (s && s.halation) { s.halation(img, { strength: Math.min(1, amt) }); } return img; } },
    { id: 'filmgrain', name: 'Film Grain ✦', apply: (img, amt) => { const s = SP(); if (s && s.filmGrain) { s.filmGrain(img, { amount: 20 * amt, seed: 5 }); } return img; } },
  ];
  const byId = (id) => EFFECTS.find((e) => e.id === id) || EFFECTS[0];

  // Pure entry point (used by tests + the loop): apply an effect to an ImageData.
  function applyEffect(img, id, amt) {
    try { return byId(id).apply(img, amt == null ? 1 : amt); }
    catch (_) { return img; }
  }

  // ---- Live render loop ------------------------------------------------------
  const W = 480, H = 270;
  let _raf = 0, _off = null, _offCtx = null, _running = false;
  let _curId = 'none', _amt = 1;

  function _ensureOff() {
    if (_off) return;
    _off = document.createElement('canvas'); _off.width = W; _off.height = H;
    _offCtx = _off.getContext('2d', { willReadFrequently: true });
  }

  // Draw one processed frame from `src` (a <video>/<canvas>/<img>) to `dst`.
  function renderFrameFrom(src, dst) {
    _ensureOff();
    const ctx = dst.getContext('2d');
    try {
      if (src && (src.videoWidth || src.naturalWidth || src.width)) _offCtx.drawImage(src, 0, 0, W, H);
      else if (HP() && HP().testFrame) { const tf = HP().testFrame(W, H); _offCtx.putImageData(tf, 0, 0); }
    } catch (_) {
      if (HP() && HP().testFrame) { const tf = HP().testFrame(W, H); _offCtx.putImageData(tf, 0, 0); }
    }
    let img = _offCtx.getImageData(0, 0, W, H);
    // #73 — if an effect chain is stacked, apply the whole chain in order;
    // otherwise fall back to the single picked effect.
    const chain = global.FFFxChain && global.FFFxChain.preview;
    if (chain && chain.hasActive()) img = chain.apply(img);
    else img = applyEffect(img, _curId, _amt);
    if (dst.width !== W) dst.width = W;
    if (dst.height !== H) dst.height = H;
    ctx.putImageData(img, 0, 0);
    return img;
  }

  function start() {
    if (typeof document === 'undefined') return;
    const dst = document.getElementById('pv-fx');
    const src = document.getElementById('pv-source');
    if (!dst) return;
    _running = true;
    cancelAnimationFrame(_raf);
    const loop = () => {
      if (!_running) { _raf = 0; return; }
      renderFrameFrom(src, dst);
      _raf = (global.requestAnimationFrame || ((f) => setTimeout(f, 33)))(loop);
    };
    loop();
  }

  function stop() { _running = false; cancelAnimationFrame(_raf); _raf = 0; }
  function isRunning() { return _running; }
  function setEffect(id) { _curId = id; }
  function setAmount(a) { _amt = +a; }
  function currentEffect() { return _curId; }

  // ---- Record the FX canvas straight into the Media Bin ----------------------
  let _recording = false;
  function record() {
    const tc = global.TripCam;
    const dst = document.getElementById('pv-fx');
    if (!tc || !tc.startRec || !dst) return false;
    if (_recording) { try { tc.stopRec(); } catch (_) {} _recording = false; return false; }
    // make sure frames are flowing so the captureStream isn't blank
    if (!_running) start();
    try { tc.startRec(dst, 30); _recording = true; return true; } catch (_) { return false; }
  }
  function isRecording() { return _recording; }

  // ---- UI wiring -------------------------------------------------------------
  function populate() {
    const sel = document.getElementById('pv-fx-effect');
    if (!sel || sel._filled) return;
    sel.innerHTML = EFFECTS.map((e) => `<option value="${e.id}">${e.name}</option>`).join('');
    sel._filled = true;
  }

  function bind() {
    if (typeof document === 'undefined') return;
    populate();
    const sel = document.getElementById('pv-fx-effect');
    if (sel && !sel._bound) { sel._bound = true; sel.addEventListener('change', (e) => setEffect(e.target.value)); }
    const amt = document.getElementById('pv-fx-amt');
    if (amt && !amt._bound) { amt._bound = true; amt.addEventListener('input', (e) => setAmount(e.target.value)); }
    const rec = document.getElementById('pv-fx-rec');
    if (rec && !rec._bound) {
      rec._bound = true;
      rec.addEventListener('click', () => {
        const on = record();
        rec.textContent = on ? '⏹ Stop & Save' : '🔴 Record → Bin';
        rec.classList.toggle('recording', on);
      });
    }
    // Start/stop with the Live FX preview mode. setPreviewMode toggles the
    // active class on #pmode-fx; we react to the mode buttons directly so we
    // don't depend on app.js internals.
    document.querySelectorAll('#preview-modes .mode-btn').forEach((b) => {
      if (b._fxBound) return; b._fxBound = true;
      b.addEventListener('click', () => { if (b.dataset.mode === 'fx') { bind(); start(); } else stop(); });
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
  }

  const API = { EFFECTS, applyEffect, renderFrameFrom, start, stop, isRunning, setEffect, setAmount,
    currentEffect, record, isRecording, populate, bind, W, H };
  global.FFPreviewFX = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
