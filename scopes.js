/* =============================================================================
   scopes.js — VECTORSCOPE + WAVEFORM MONITOR (#51)
   -----------------------------------------------------------------------------
   Real colour scopes, computed from a frame's pixels. Both are pure functions
   ImageData → ImageData, so they're deterministic and headless-verifiable (no
   GPU, no video decode needed to test them).

     • vectorscope: plots each pixel's chroma (Cb,Cr) as a scatter. Saturated
       colours push out to the rim in their hue's direction; neutral greys sit
       at the centre. The classic "is my colour balanced / where's the skin
       line" tool.
     • waveform: for each column of the source, plots the distribution of luma
       up the Y axis (bright at top). Reads exposure per-column like a colourist
       scope — a WFM, not a histogram.
   ========================================================================== */
(function () {
  'use strict';

  // Rec.601 luma / chroma. Cb,Cr come out in roughly [-128,128].
  function ycbcr(r, g, b) {
    return {
      y: 0.299 * r + 0.587 * g + 0.114 * b,
      cb: -0.168736 * r - 0.331264 * g + 0.5 * b,
      cr: 0.5 * r - 0.418688 * g - 0.081312 * b,
    };
  }

  // A faint round graticule so an empty scope still reads as a scope.
  function _graticule(out, size, ringEvery) {
    const c = size / 2;
    for (let i = 0; i < out.length; i += 4) { out[i] = out[i + 1] = out[i + 2] = 8; out[i + 3] = 255; }
    for (let a = 0; a < 360; a += 2) {
      for (let r = ringEvery; r < c; r += ringEvery) {
        const x = Math.round(c + r * Math.cos(a * Math.PI / 180));
        const y = Math.round(c + r * Math.sin(a * Math.PI / 180));
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const o = (y * size + x) * 4; out[o] = out[o + 1] = out[o + 2] = 26;
      }
    }
  }

  /** Vectorscope: chroma scatter. +Cb → right, +Cr → up. size×size ImageData. */
  function vectorscope(src, size = 256, opts = {}) {
    const gain = opts.gain ?? 1;
    const out = new Uint8ClampedArray(size * size * 4);
    _graticule(out, size, size / 8);
    const d = src.data;
    const half = size / 2 - 2;
    for (let p = 0; p < d.length; p += 4) {
      if (d[p + 3] === 0) continue;
      const { cb, cr } = ycbcr(d[p], d[p + 1], d[p + 2]);
      const x = Math.round(size / 2 + (cb / 128) * half * gain);
      const y = Math.round(size / 2 - (cr / 128) * half * gain);   // +Cr points UP
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      const o = (y * size + x) * 4;
      out[o] = Math.min(255, out[o] + 34);
      out[o + 1] = Math.min(255, out[o + 1] + 58);
      out[o + 2] = Math.min(255, out[o + 2] + 34);
    }
    return new ImageData(out, size, size);
  }

  /** Waveform monitor: per-column luma distribution. Bright at top. W×H ImageData. */
  function waveform(src, W = 256, H = 256, opts = {}) {
    const out = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < out.length; i += 4) { out[i] = out[i + 1] = out[i + 2] = 8; out[i + 3] = 255; }
    // faint 25/50/75 % IRE lines
    for (const frac of [0.25, 0.5, 0.75]) {
      const y = Math.round((1 - frac) * (H - 1));
      for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; out[o] = out[o + 1] = out[o + 2] = 24; }
    }
    const d = src.data, sw = src.width, sh = src.height;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(sw - 1, Math.floor(x / W * sw));
      for (let sy = 0; sy < sh; sy++) {
        const p = (sy * sw + sx) * 4;
        if (d[p + 3] === 0) continue;
        const { y: luma } = ycbcr(d[p], d[p + 1], d[p + 2]);
        const yy = (H - 1) - Math.round(luma / 255 * (H - 1));   // bright → top
        const o = (yy * W + x) * 4;
        out[o] = Math.min(255, out[o] + 12);
        out[o + 1] = Math.min(255, out[o + 1] + 30);
        out[o + 2] = Math.min(255, out[o + 2] + 12);
      }
    }
    return new ImageData(out, W, H);
  }

  window.FFScopes = { vectorscope, waveform, ycbcr };
})();
