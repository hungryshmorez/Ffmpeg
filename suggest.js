/* =============================================================================
   suggest.js — SUGGEST A WORKFLOW FROM CONTENT (#88)
   -----------------------------------------------------------------------------
   Pure heuristics over the probe metadata — no model. Given what ffprobe already
   tells us (has audio? how long? what shape? how big?), rank the workflows that
   actually make sense for this clip. "Talking head → Silence Trim + Loudnorm",
   "landscape → auto-reframe for social", "4K → downscale", and so on.

   suggest(meta) → [{ id, label, reason, score }] sorted best-first. Deterministic
   and side-effect free, so it's unit-tested directly.
   ========================================================================== */
(function () {
  'use strict';

  function suggest(meta = {}) {
    const hasAudio = !!meta.hasAudio;
    const hasVideo = meta.hasVideo !== false;
    const duration = +meta.duration || 0;
    const width = +meta.width || 0, height = +meta.height || 0;
    const aspect = width && height ? width / height : 16 / 9;
    const out = [];
    const add = (id, label, reason, score) => out.push({ id, label, reason, score });

    if (hasAudio) {
      add('loudnorm', 'Normalise Loudness', 'Has an audio track → level it to a broadcast target (−14 LUFS).', 8);
      if (duration > 30) add('silence-trim', 'Trim Silence', 'Longer clip with audio → cut the dead air between phrases.', 7);
    } else if (hasVideo) {
      add('add-music', 'Add a Soundtrack', 'No audio track → drop music or a bed under the video.', 5);
    }

    if (hasVideo) {
      if (aspect < 0.9) add('social-vertical', 'Ready for Reels/Shorts', 'Already vertical → export straight to social sizes.', 6);
      else if (aspect > 1.5) add('auto-reframe', 'Auto-Reframe → Vertical', 'Landscape → track the subject and crop to 9:16 for social.', 6);

      if (height > 1080) add('downscale-1080', 'Downscale to 1080p', `${height}p source → downscale to 1080p to shrink the file.`, 5);
      if (duration > 0 && duration < 8) add('loop-gif', 'Loop / GIF', 'Short clip → loop it seamlessly or export a GIF.', 4);
      if (duration > 600) add('compress-target', 'Compress to Target', 'Long clip → compress to a target file size for sharing.', 5);
    }

    return out.sort((a, b) => b.score - a.score);
  }

  window.FFSuggest = { suggest };
})();
