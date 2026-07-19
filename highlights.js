/* =============================================================================
   highlights.js — AUTO-DETECT INTERESTING MOMENTS (#82)
   -----------------------------------------------------------------------------
   The signals already exist (audio energy, motion from the mosher, scene cuts
   from analysis). This is the missing half: the SCORING + REEL ASSEMBLER that
   turns those per-window signals into a ranked list of moments and a spaced-out
   highlight reel. Pure functions, unit-tested directly.

     • scoreWindows(windows, weights) — normalise energy/motion across the clip,
       combine with a scene-cut bonus into a 0-ish..N score per window
     • pickHighlights(windows, {count, minGap}) — the top moments, kept `minGap`
       seconds apart so the reel isn't all one burst, returned in time order
   ========================================================================== */
(function () {
  'use strict';

  function scoreWindows(windows, weights = {}) {
    const wE = weights.energy ?? 1, wM = weights.motion ?? 1, wS = weights.sceneCut ?? 0.5;
    let maxE = 1e-9, maxM = 1e-9;
    for (const w of windows) { if ((w.energy || 0) > maxE) maxE = w.energy; if ((w.motion || 0) > maxM) maxM = w.motion; }
    return windows.map((w) => ({
      ...w,
      score: (w.energy || 0) / maxE * wE + (w.motion || 0) / maxM * wM + (w.sceneCut ? wS : 0),
    }));
  }

  function pickHighlights(windows, opts = {}) {
    const count = opts.count ?? 5, minGap = opts.minGap ?? 2;
    const scored = scoreWindows(windows, opts.weights).sort((a, b) => b.score - a.score);
    const picked = [];
    for (const w of scored) {
      if (picked.length >= count) break;
      if (picked.every((p) => Math.abs((p.t ?? 0) - (w.t ?? 0)) >= minGap)) picked.push(w);
    }
    return picked.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));   // chronological for the reel
  }

  window.FFHighlights = { scoreWindows, pickHighlights };
})();
