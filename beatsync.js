/* =============================================================================
   beatsync.js — AUTO-SYNC AN EDIT TO THE BEAT GRID (#83)
   -----------------------------------------------------------------------------
   The app already detects beats (audio-intel). This is the other half: an
   assembler that cuts an edit ON those beats. Pure functions over a beat grid,
   so they're unit-tested directly.

     • snapToBeats(cutTimes, beatTimes)  — nudge each cut to the nearest beat
     • beatSegments(beatTimes, perCut)   — a boundary every `perCut` beats
     • assembleOnBeats(clips, beatTimes, perCut) — lay clips into beat-length
       segments, so every cut lands on the downbeat
   ========================================================================== */
(function () {
  'use strict';

  function snapToBeats(cutTimes, beatTimes) {
    if (!beatTimes || !beatTimes.length) return cutTimes.slice();
    return cutTimes.map((t) => {
      let best = beatTimes[0], bd = Infinity;
      for (const b of beatTimes) { const d = Math.abs(b - t); if (d < bd) { bd = d; best = b; } }
      return best;
    });
  }

  function beatSegments(beatTimes, perCut = 4) {
    const p = Math.max(1, perCut | 0), segs = [];
    for (let i = 0; i < beatTimes.length; i += p) segs.push(beatTimes[i]);
    return segs;
  }

  /** Lay `clips` into consecutive beat-length segments. Each entry says which
   *  clip plays, the timeline position, and how long the segment is (a clip
   *  shorter than its segment is used whole; longer, it's trimmed to fit). */
  function assembleOnBeats(clips, beatTimes, perCut = 4) {
    const bounds = beatSegments(beatTimes, perCut);
    const out = [];
    for (let i = 0; i < clips.length && i < bounds.length - 1; i++) {
      const segDur = bounds[i + 1] - bounds[i];
      const clipDur = clips[i] && clips[i].duration != null ? clips[i].duration : segDur;
      out.push({ clip: clips[i], at: bounds[i], segment: segDur, take: Math.min(clipDur, segDur) });
    }
    return out;
  }

  window.FFBeatSync = { snapToBeats, beatSegments, assembleOnBeats };
})();
