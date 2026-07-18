/* =============================================================================
   audio-dsp.js — STEREO WIDTH + PHASE CORRELATION (#31)
   -----------------------------------------------------------------------------
   Pure PCM maths, no Web Audio, so it's deterministic and headless-testable.
   The live engine builds the equivalent as a node matrix; the correlation METER
   calls straight into correlation() here, so the tested code IS the shipped code.

     • widthSample(l, r, w): mid/side width on one L/R sample pair.
         mid = (l+r)/2, side = (l-r)/2 → outL = mid + w·side, outR = mid − w·side.
         w=1 is neutral, w=0 collapses to mono, w>1 widens (exaggerates side).
     • correlation(L, R): phase correlation coefficient in [−1,+1]. +1 = mono/in
       phase, 0 = uncorrelated (wide), −1 = fully out of phase (mono-cancelling).
   ========================================================================== */
(function () {
  'use strict';

  function widthSample(l, r, w) {
    const mid = (l + r) * 0.5, side = (l - r) * 0.5;
    return [mid + w * side, mid - w * side];
  }

  /** Apply mid/side width to interleaved-by-channel Float32 arrays, in place. */
  function widthChannels(L, R, w) {
    const n = Math.min(L.length, R.length);
    for (let i = 0; i < n; i++) {
      const mid = (L[i] + R[i]) * 0.5, side = (L[i] - R[i]) * 0.5;
      L[i] = mid + w * side; R[i] = mid - w * side;
    }
    return [L, R];
  }

  /** Phase correlation in [-1,1]. 0 for silence. */
  function correlation(L, R) {
    const n = Math.min(L.length, R.length);
    let sll = 0, srr = 0, slr = 0;
    for (let i = 0; i < n; i++) { const a = L[i], b = R[i]; sll += a * a; srr += b * b; slr += a * b; }
    const denom = Math.sqrt(sll * srr);
    return denom < 1e-12 ? 0 : Math.max(-1, Math.min(1, slr / denom));
  }

  /** RMS side/mid ratio — a scalar "how wide is this" read, ≥0. */
  function widthAmount(L, R) {
    const n = Math.min(L.length, R.length);
    let mid = 0, side = 0;
    for (let i = 0; i < n; i++) { const m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5; mid += m * m; side += s * s; }
    return mid < 1e-12 ? 0 : Math.sqrt(side / mid);
  }

  window.FFAudioDSP = { widthSample, widthChannels, correlation, widthAmount };
})();
