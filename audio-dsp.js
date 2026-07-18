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

  // ---------------------------------------------------------------------------
  // LOOKAHEAD LIMITER (#29) — a real one. A plain limiter reacts AFTER a peak
  // has already passed, so the transient overshoots. This looks AHEAD by
  // `lookaheadMs`: it computes the gain reduction each peak will need and starts
  // pulling the gain down BEFORE the peak arrives, so nothing crosses the
  // ceiling. Gain is shared across channels to preserve the stereo image, and
  // released smoothly so it breathes instead of pumping.
  // ---------------------------------------------------------------------------
  function limiter(channels, sr, opts = {}) {
    const ceiling = opts.ceiling ?? 0.9;          // linear (e.g. 10^(-1/20))
    const lookaheadMs = opts.lookaheadMs ?? 5;
    const releaseMs = opts.releaseMs ?? 60;
    const n = channels[0] ? channels[0].length : 0;
    if (!n) return channels;
    const w = Math.max(1, Math.round(lookaheadMs * sr / 1000));
    const relCoef = Math.exp(-1 / Math.max(1, releaseMs * sr / 1000));

    // per-sample peak across all channels, then the gain each sample demands
    const target = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let p = 0;
      for (let c = 0; c < channels.length; c++) { const a = Math.abs(channels[c][i]); if (a > p) p = a; }
      target[i] = p > ceiling ? ceiling / p : 1;
    }
    // sliding-window MIN of the demanded gain over [i, i+w] (O(n) deque) so the
    // reduction is in place `w` samples early — that's the lookahead.
    const tmin = new Float32Array(n);
    const dq = new Int32Array(n); let head = 0, tail = 0;
    for (let j = 0; j < n; j++) {
      while (tail > head && target[dq[tail - 1]] >= target[j]) tail--;
      dq[tail++] = j;
      while (dq[head] < j - w) head++;
      tmin[j] = target[dq[head]];
    }
    // apply: instant attack down to the (pre-empted) target, smooth release up
    let g = 1;
    for (let i = 0; i < n; i++) {
      const want = tmin[Math.min(n - 1, i + w)];
      g = want < g ? want : want + (g - want) * relCoef;
      for (let c = 0; c < channels.length; c++) channels[c][i] *= g;
    }
    return channels;
  }

  // ---------------------------------------------------------------------------
  // TRANSIENT SHAPER (#39) — attack / sustain, envelope-based. Two magnitude
  // followers run off a shared control signal: a FAST one that snaps onto
  // onsets and a SLOW one that lags. Their difference is >0 during the attack
  // (fast leads) and <0 during the sustain/tail (fast falls away first). The
  // `attack` knob scales the gain in the first region, `sustain` in the second —
  // so you can put the punch back into an over-compressed drum, or tame it.
  // ---------------------------------------------------------------------------
  function transientShaper(channels, sr, opts = {}) {
    const attack = opts.attack ?? 0;    // -1 … +1
    const sustain = opts.sustain ?? 0;  // -1 … +1
    if (attack === 0 && sustain === 0) return channels;
    const n = channels[0] ? channels[0].length : 0;
    if (!n) return channels;
    const coef = (ms) => Math.exp(-1 / Math.max(1, ms * sr / 1000));
    const aLag = coef(6), rel = coef(50);           // lagged attack, medium release
    let ei = 0, el = 0;                              // instant + lagged envelopes
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (let c = 0; c < channels.length; c++) { const a = Math.abs(channels[c][i]); if (a > x) x = a; }
      ei = x > ei ? x : rel * ei + (1 - rel) * x;                       // instant attack → hugs the onset peak
      el = x > el ? aLag * el + (1 - aLag) * x : rel * el + (1 - rel) * x;   // lagged attack
      const eps = el + 1e-4;
      const att = ei > el ? (ei - el) / eps : 0;     // >0 only on the leading edge (aligned to the peak)
      const sus = el > x ? (el - x) / eps : 0;        // >0 in the decaying tail
      let g = 1 + attack * Math.min(2, att) + sustain * Math.min(2, sus);
      if (g < 0) g = 0; else if (g > 4) g = 4;
      for (let c = 0; c < channels.length; c++) channels[c][i] *= g;
    }
    return channels;
  }

  // ---------------------------------------------------------------------------
  // SIDECHAIN DUCK TO THE KICK (#27) — the pump. There's no separate kick track
  // in a single bounce, so the kick is DETECTED from the low end: a 2-pole
  // low-pass isolates the sub band, and each time its envelope crosses the
  // threshold (a kick lands) the whole mix ducks to (1-amount) and recovers over
  // `releaseMs`. That rhythmic dip under every kick is the sidechain sound.
  // ---------------------------------------------------------------------------
  function sidechainDuck(channels, sr, opts = {}) {
    const amount = opts.amount ?? 0.5;      // 0 … 1 depth of the duck
    const releaseMs = opts.releaseMs ?? 220;
    const detectHz = opts.detectHz ?? 120;
    const threshold = opts.threshold ?? 0.12;
    if (amount <= 0) return channels;
    const n = channels[0] ? channels[0].length : 0;
    if (!n) return channels;
    // 2-pole (cascaded one-pole) low-pass on the channel sum → sub-band signal.
    const lpCoef = Math.exp(-2 * Math.PI * detectHz / sr);
    let lp1 = 0, lp2 = 0, env = 0;
    const relCoef = Math.exp(-1 / Math.max(1, releaseMs * sr / 1000));
    const envAtt = Math.exp(-1 / Math.max(1, 2 * sr / 1000));   // 2 ms env attack
    const envRel = Math.exp(-1 / Math.max(1, 25 * sr / 1000));  // 25 ms env release
    let gain = 1, armed = true;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let c = 0; c < channels.length; c++) sum += channels[c][i];
      sum /= channels.length;
      lp1 = lpCoef * lp1 + (1 - lpCoef) * sum;
      lp2 = lpCoef * lp2 + (1 - lpCoef) * lp1;             // steeper roll-off
      const rect = Math.abs(lp2);
      env = rect > env ? envAtt * env + (1 - envAtt) * rect : envRel * env + (1 - envRel) * rect;
      // rising edge across the threshold = a kick → duck (re-arm on the way down)
      if (env > threshold && armed) { gain = 1 - amount; armed = false; }
      else if (env < threshold * 0.6) { armed = true; }
      gain = gain + (1 - gain) * (1 - relCoef);            // release back toward 1
      for (let c = 0; c < channels.length; c++) channels[c][i] *= gain;
    }
    return channels;
  }

  window.FFAudioDSP = { widthSample, widthChannels, correlation, widthAmount, limiter, transientShaper, sidechainDuck };
})();
