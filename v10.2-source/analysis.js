/* =============================================================================
   analysis.js — LUFS METER · TWO-PASS LOUDNORM · SILENCE · SCENE DETECT
   -----------------------------------------------------------------------------
   All three of these work the same way: run ffmpeg with `-f null -`, capture the
   log, and parse it. Nothing is written to MEMFS, so they add no heap pressure.

   THE LOUDNORM FIX MATTERS. All 19 mastering chains currently do SINGLE-PASS
   loudnorm and *claim* to hit −14 LUFS. Single-pass loudnorm is meaningfully
   worse than two-pass — it's a live estimator, not a measurement. Two-pass
   measures the file, then applies the correction with the measured values. Now
   the chains can actually PROVE they hit the target, because the meter reads it
   back.
   ========================================================================== */

(function () {
  'use strict';

  const TARGETS = [
    { id: 'stream',    label: 'Spotify / Apple / YouTube', lufs: -14, tp: -1.0 },
    { id: 'broadcast', label: 'Broadcast (EBU R128)',      lufs: -23, tp: -1.0 },
    { id: 'club',      label: 'Club / DJ',                 lufs: -8,  tp: -0.3 },
    { id: 'film',      label: 'Film (−27 LUFS)',           lufs: -27, tp: -2.0 },
  ];

  /** Run an ffmpeg command purely to capture its log. Writes nothing. */
  async function captureLog(args) {
    let buf = '';
    const grab = ({ message }) => { buf += message + '\n'; };
    window.state.ffmpeg.on('log', grab);
    try {
      await window.ff.exec(args, { raw: true, timeoutMs: 120000 });
    } catch (_) {
      // A probe-style command exits non-zero by design. That is NOT an error.
    } finally {
      try { window.state.ffmpeg.off('log', grab); } catch (_) {}
    }
    return buf;
  }

  // ===========================================================================
  // LUFS / ebur128
  // ===========================================================================

  async function measureLoudness(virtualName) {
    const log = await captureLog(['-hide_banner', '-i', virtualName,
      '-af', 'ebur128=peak=true', '-f', 'null', '-']);

    const num = (re) => { const m = log.match(re); return m ? parseFloat(m[1]) : null; };

    return {
      integrated: num(/I:\s*(-?[\d.]+)\s*LUFS/),
      range:      num(/LRA:\s*(-?[\d.]+)\s*LU/),
      truePeak:   num(/Peak:\s*(-?[\d.]+)\s*dBFS/),
      threshold:  num(/Threshold:\s*(-?[\d.]+)\s*LUFS/),
      raw: log,
    };
  }

  /** loudnorm's own measurement pass. Returns the JSON it prints on stderr. */
  async function measureLoudnorm(virtualName, target) {
    const t = target || TARGETS[0];
    const log = await captureLog(['-hide_banner', '-i', virtualName,
      '-af', `loudnorm=I=${t.lufs}:TP=${t.tp}:LRA=11:print_format=json`,
      '-f', 'null', '-']);

    const m = log.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (_) { return null; }
  }

  /**
   * TWO-PASS LOUDNORM — build the corrected -af string.
   * Pass 1 measures. Pass 2 applies the correction using the MEASURED values.
   * This is what a real mastering chain does; single-pass is a live estimator.
   */
  async function buildTwoPassLoudnorm(virtualName, targetId = 'stream') {
    const t = TARGETS.find((x) => x.id === targetId) || TARGETS[0];
    const m = await measureLoudnorm(virtualName, t);
    if (!m) {
      window.logToConsole?.('warn', 'loudnorm measurement failed — falling back to single-pass.');
      return `loudnorm=I=${t.lufs}:TP=${t.tp}:LRA=11`;
    }
    window.logToConsole?.('', `[loudnorm] measured I=${m.input_i} TP=${m.input_tp} LRA=${m.input_lra}`);
    return `loudnorm=I=${t.lufs}:TP=${t.tp}:LRA=11` +
           `:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
           `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}` +
           `:offset=${m.target_offset}:linear=true:print_format=summary`;
  }

  function renderMeter(r, targetId = 'stream') {
    const el = document.getElementById('lufs-meter');
    if (!el) return;
    if (r.integrated == null) { el.innerHTML = '<span class="dim">No audio to measure.</span>'; return; }

    const t = TARGETS.find((x) => x.id === targetId) || TARGETS[0];
    const delta = r.integrated - t.lufs;
    const ok = Math.abs(delta) <= 1.0;
    const tpOk = r.truePeak == null || r.truePeak <= t.tp + 0.1;

    // −40..0 LUFS mapped to 0..100%
    const pct = Math.max(0, Math.min(100, ((r.integrated + 40) / 40) * 100));
    const tgt = Math.max(0, Math.min(100, ((t.lufs + 40) / 40) * 100));

    el.innerHTML = `
      <div class="lufs-row">
        <span class="lufs-big ${ok ? 'ok' : 'off'}">${r.integrated.toFixed(1)} <small>LUFS</small></span>
        <span class="lufs-delta ${ok ? 'ok' : 'off'}">${delta >= 0 ? '+' : ''}${delta.toFixed(1)} vs ${t.lufs}</span>
      </div>
      <div class="lufs-bar">
        <div class="lufs-fill ${ok ? 'ok' : 'off'}" style="width:${pct}%"></div>
        <div class="lufs-target" style="left:${tgt}%" title="${t.label}: ${t.lufs} LUFS"></div>
      </div>
      <div class="lufs-meta">
        <span>True Peak: <b class="${tpOk ? 'ok' : 'off'}">${r.truePeak != null ? r.truePeak.toFixed(1) + ' dBFS' : '—'}</b></span>
        <span>Range: <b>${r.range != null ? r.range.toFixed(1) + ' LU' : '—'}</b></span>
        <span class="dim">${t.label}</span>
      </div>`;
  }

  async function analyzeLoudness(targetId = 'stream') {
    const m = window.state?.inputFile;
    if (!m) { window.logToConsole?.('warn', 'No file selected.'); return null; }
    window.logToConsole?.('', '[lufs] measuring…');
    const r = await measureLoudness(m.virtualName);
    renderMeter(r, targetId);
    if (r.integrated != null) {
      window.logToConsole?.('ok',
        `[lufs] I=${r.integrated.toFixed(1)} LUFS · TP=${r.truePeak?.toFixed(1) ?? '—'} dBFS · LRA=${r.range?.toFixed(1) ?? '—'} LU`);
    }
    return r;
  }

  // ===========================================================================
  // SILENCE DETECTION → AUTO-TRIM
  // ===========================================================================

  async function detectSilence(virtualName, { thresholdDb = -30, minDur = 0.5 } = {}) {
    const log = await captureLog(['-hide_banner', '-i', virtualName,
      '-af', `silencedetect=noise=${thresholdDb}dB:d=${minDur}`, '-f', 'null', '-']);

    const regions = [];
    let open = null;
    for (const line of log.split('\n')) {
      const s = line.match(/silence_start:\s*(-?[\d.]+)/);
      const e = line.match(/silence_end:\s*([\d.]+)/);
      if (s) open = parseFloat(s[1]);
      if (e && open != null) { regions.push({ start: Math.max(0, open), end: parseFloat(e[1]) }); open = null; }
    }
    return regions;
  }

  /** Build a select/aselect chain that keeps ONLY the non-silent segments. */
  function buildSilenceRemoval(regions, duration, padMs = 100) {
    const pad = padMs / 1000;
    const keep = [];
    let cursor = 0;
    for (const r of regions) {
      const a = Math.max(cursor, r.start - pad);        // pad = leave a little air
      if (a - cursor > 0.05) keep.push([cursor, a]);
      cursor = Math.min(duration, r.end + pad);
    }
    if (duration - cursor > 0.05) keep.push([cursor, duration]);
    if (!keep.length) return null;

    const expr = keep.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join('+');
    return {
      vf: `select='${expr}',setpts=N/FRAME_RATE/TB`,
      af: `aselect='${expr}',asetpts=N/SR/TB`,
      keptSec: keep.reduce((s, [a, b]) => s + (b - a), 0),
      segments: keep.length,
    };
  }

  async function analyzeSilence(opts) {
    const m = window.state?.inputFile;
    if (!m) return null;
    window.logToConsole?.('', '[silence] scanning…');
    const regions = await detectSilence(m.virtualName, opts);
    window.FFWaveform?.setSilences(regions);

    const total = regions.reduce((s, r) => s + (r.end - r.start), 0);
    const dur = m.durationSec || 0;
    window.logToConsole?.('ok',
      `[silence] ${regions.length} region(s), ${total.toFixed(1)}s silent. ` +
      `Removing them: ${fmt(dur)} → ${fmt(dur - total)}`);
    return { regions, totalSilent: total };
  }

  // ===========================================================================
  // SCENE DETECTION → AUTO-SPLIT
  // ===========================================================================

  async function detectScenes(virtualName, threshold = 0.4) {
    const log = await captureLog(['-hide_banner', '-i', virtualName,
      '-vf', `select='gt(scene,${threshold})',metadata=print`,
      '-an', '-f', 'null', '-']);

    const cuts = [];
    for (const line of log.split('\n')) {
      const m = line.match(/pts_time:([\d.]+)/);
      if (m) cuts.push(parseFloat(m[1]));
    }
    return cuts;
  }

  async function analyzeScenes(threshold = 0.4) {
    const m = window.state?.inputFile;
    if (!m) return null;
    window.logToConsole?.('', '[scene] scanning…');
    const cuts = await detectScenes(m.virtualName, threshold);
    window.FFWaveform?.setScenes(cuts);
    window.logToConsole?.('ok', `[scene] ${cuts.length} cut(s) detected.`);
    return cuts;
  }

  /** Split each detected scene into its own media-bin item. */
  async function splitScenes(cuts) {
    const m = window.state?.inputFile;
    if (!m || !cuts?.length) return;
    const dur = m.durationSec || 0;
    const bounds = [0, ...cuts, dur];

    for (let i = 0; i < bounds.length - 1; i++) {
      const a = bounds[i], b = bounds[i + 1];
      if (b - a < 0.3) continue;                       // skip micro-cuts
      const out = `scene_${String(i + 1).padStart(3, '0')}.mp4`;
      await window.ff.exec([
        '-ss', a.toFixed(3), '-i', m.virtualName, '-t', (b - a).toFixed(3),
        '-c', 'copy', '-avoid_negative_ts', '1', '-y', out,
      ]);
      const data = await window.ff.readFile(out);
      const blob = new Blob([data.buffer], { type: 'video/mp4' });
      await window.addBlobToBin?.(blob, `${m.name} — scene ${i + 1}`, 'video/mp4');
      await window.ff.deleteFile(out).catch(() => {});
    }
    window.logToConsole?.('ok', `[scene] Split into ${bounds.length - 1} clip(s) — all added to the bin.`);
  }

  const fmt = (s) => `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;

  window.FFAnalysis = {
    TARGETS,
    measureLoudness, measureLoudnorm, buildTwoPassLoudnorm, analyzeLoudness, renderMeter,
    detectSilence, buildSilenceRemoval, analyzeSilence,
    detectScenes, analyzeScenes, splitScenes,
  };
})();
