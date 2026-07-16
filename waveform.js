/* =============================================================================
   waveform.js — WAVEFORM · FILMSTRIP · BEAT TICKS · REGION SELECT
   -----------------------------------------------------------------------------
   You cannot edit what you cannot see. Until now the trim handles floated over
   nothing, and beat detection had no canvas to draw on.

   Renders, bottom to top:
     • peak-envelope waveform (Web Audio decode — no ffmpeg, cannot hang)
     • silent regions (red bands, from analysis.js)
     • scene cuts (vertical markers, from analysis.js)
     • beat ticks (from beat-detection.js)
     • trim in/out handles, draggable, synced to §2
     • playhead
     • filmstrip of thumbnails above (video only, canvas-decoded, no ffmpeg)
   ========================================================================== */

(function () {
  'use strict';

  const H_WAVE  = 96;
  const H_STRIP = 54;
  const COL = {
    bg:      '#141414',
    wave:    '#00d4ff',
    waveDim: '#1b6d80',
    silent:  'rgba(255,68,68,0.20)',
    scene:   '#ffcc00',
    beat:    'rgba(255,255,255,0.42)',
    trimMask:'rgba(0,0,0,0.62)',
    handle:  '#00d4ff',
    playhead:'#ffffff',
    loop:    'rgba(0,212,255,0.14)',
  };

  const S = {
    peaks: null,        // Float32Array of |peak| per pixel column
    duration: 0,
    mediaId: null,
    beats: [],          // seconds
    silences: [],       // [{start,end}]
    scenes: [],         // seconds
    trimIn: 0,
    trimOut: 0,
    playhead: 0,
    loop: null,         // {start,end} | null
    drag: null,         // 'in' | 'out' | 'seek' | 'loop'
    thumbs: [],         // {t, img}
  };

  let cv, ctx, strip, sctx, wrap;

  // ---------------------------------------------------------------------------
  // DECODE — Web Audio. Native, instant, cannot touch the wasm heap.
  // ---------------------------------------------------------------------------

  async function computePeaks(file, columns) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ac = new AC();
    try {
      const buf = await ac.decodeAudioData(await file.arrayBuffer());
      const ch  = buf.getChannelData(0);
      const per = Math.max(1, Math.floor(ch.length / columns));
      const peaks = new Float32Array(columns);
      for (let i = 0; i < columns; i++) {
        let max = 0;
        const start = i * per, end = Math.min(start + per, ch.length);
        for (let j = start; j < end; j++) {
          const v = ch[j] < 0 ? -ch[j] : ch[j];
          if (v > max) max = v;
        }
        peaks[i] = max;
      }
      return { peaks, duration: buf.duration };
    } catch (_) {
      return null;                 // no audio track, or an undecodable codec
    } finally {
      try { ac.close(); } catch (_) {}
    }
  }

  // ---------------------------------------------------------------------------
  // FILMSTRIP — <video> + canvas. Zero ffmpeg. Cannot deadlock the queue.
  // ---------------------------------------------------------------------------

  async function buildFilmstrip(file, count = 12) {
    if (!file.type.startsWith('video/')) return [];
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true; v.playsInline = true;
    v.src = url;

    const meta = await new Promise((res) => {
      v.onloadedmetadata = () => res(true);
      v.onerror = () => res(false);
      setTimeout(() => res(false), 5000);
    });
    if (!meta || !isFinite(v.duration)) { URL.revokeObjectURL(url); return []; }

    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    const out = [];

    for (let i = 0; i < count; i++) {
      const t = (v.duration * (i + 0.5)) / count;
      const ok = await new Promise((res) => {
        const done = () => { v.onseeked = null; res(true); };
        v.onseeked = done;
        v.currentTime = t;
        setTimeout(() => res(false), 2500);
      });
      if (!ok) break;
      const scale = H_STRIP / (v.videoHeight || H_STRIP);
      c.width  = Math.max(1, Math.round((v.videoWidth || 96) * scale));
      c.height = H_STRIP;
      g.drawImage(v, 0, 0, c.width, c.height);
      const img = new Image();
      img.src = c.toDataURL('image/jpeg', 0.6);
      out.push({ t, img });
    }
    URL.revokeObjectURL(url);
    return out;
  }

  // ---------------------------------------------------------------------------
  // DRAW
  // ---------------------------------------------------------------------------

  const x2t = (x) => (x / cv.clientWidth) * S.duration;
  const t2x = (t) => (t / (S.duration || 1)) * cv.clientWidth;

  function draw() {
    if (!ctx || !cv) return;
    const w = cv.clientWidth, h = H_WAVE;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, w, h);

    // Loop region
    if (S.loop) {
      ctx.fillStyle = COL.loop;
      ctx.fillRect(t2x(S.loop.start), 0, t2x(S.loop.end) - t2x(S.loop.start), h);
    }

    // Silent regions
    ctx.fillStyle = COL.silent;
    for (const s of S.silences) ctx.fillRect(t2x(s.start), 0, Math.max(1, t2x(s.end) - t2x(s.start)), h);

    // Waveform
    if (S.peaks) {
      const mid = h / 2;
      const n = S.peaks.length;
      for (let x = 0; x < w; x++) {
        const p = S.peaks[Math.min(n - 1, Math.floor((x / w) * n))] || 0;
        const amp = Math.max(1, p * (h * 0.46));
        const t = x2t(x);
        const inTrim = t >= S.trimIn && t <= (S.trimOut || S.duration);
        ctx.fillStyle = inTrim ? COL.wave : COL.waveDim;
        ctx.fillRect(x, mid - amp, 1, amp * 2);
      }
    } else {
      ctx.fillStyle = '#333';
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText('No audio track', 10, h / 2 + 4);
    }

    // Scene cuts
    ctx.strokeStyle = COL.scene; ctx.lineWidth = 1;
    for (const t of S.scenes) {
      const x = t2x(t);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }

    // Beat ticks — the detector has existed for versions with nowhere to draw.
    ctx.strokeStyle = COL.beat;
    for (const t of S.beats) {
      const x = t2x(t);
      ctx.beginPath(); ctx.moveTo(x, h - 14); ctx.lineTo(x, h); ctx.stroke();
    }

    // Trim masks
    const inX = t2x(S.trimIn);
    const outX = t2x(S.trimOut || S.duration);
    ctx.fillStyle = COL.trimMask;
    if (inX > 0) ctx.fillRect(0, 0, inX, h);
    if (outX < w) ctx.fillRect(outX, 0, w - outX, h);

    // Handles
    ctx.fillStyle = COL.handle;
    ctx.fillRect(inX - 1, 0, 3, h);
    ctx.fillRect(outX - 1, 0, 3, h);
    ctx.fillRect(inX - 1, 0, 9, 9);
    ctx.fillRect(outX - 7, 0, 9, 9);

    // Playhead
    if (S.playhead > 0) {
      ctx.strokeStyle = COL.playhead; ctx.lineWidth = 1;
      const x = t2x(S.playhead);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }

    drawStrip();
  }

  function drawStrip() {
    if (!sctx || !strip || !S.thumbs.length) return;
    const w = strip.clientWidth, h = H_STRIP;
    const dpr = window.devicePixelRatio || 1;
    if (strip.width !== w * dpr) { strip.width = w * dpr; strip.height = h * dpr; }
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.fillStyle = COL.bg;
    sctx.fillRect(0, 0, w, h);
    const tw = w / S.thumbs.length;
    S.thumbs.forEach((th, i) => {
      if (th.img.complete) sctx.drawImage(th.img, i * tw, 0, tw, h);
    });
  }

  // ---------------------------------------------------------------------------
  // INTERACTION
  // ---------------------------------------------------------------------------

  function syncTrimToEditor() {
    const fmt = (s) => {
      const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = (s % 60);
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${ss.toFixed(2).padStart(5, '0')}`;
    };
    const a = document.getElementById('trim-start');
    const b = document.getElementById('trim-end');
    const en = document.getElementById('enable-2');
    if (a) { a.value = fmt(S.trimIn);  a.dispatchEvent(new Event('input', { bubbles: true })); }
    if (b) { b.value = fmt(S.trimOut || S.duration); b.dispatchEvent(new Event('input', { bubbles: true })); }
    if (en && !en.checked && (S.trimIn > 0.01 || (S.trimOut && S.trimOut < S.duration - 0.05))) {
      en.checked = true;
      en.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function bindPointer() {
    const near = (x, t) => Math.abs(x - t2x(t)) < 10;

    cv.addEventListener('pointerdown', (e) => {
      const x = e.offsetX;
      if (e.shiftKey) {
        S.drag = 'loop';
        S.loop = { start: x2t(x), end: x2t(x) };
      } else if (near(x, S.trimIn))                 S.drag = 'in';
      else if (near(x, S.trimOut || S.duration))    S.drag = 'out';
      else { S.drag = 'seek'; seekTo(x2t(x)); }
      cv.setPointerCapture(e.pointerId);
    });

    cv.addEventListener('pointermove', (e) => {
      if (!S.drag) {
        const x = e.offsetX;
        cv.style.cursor = (near(x, S.trimIn) || near(x, S.trimOut || S.duration)) ? 'ew-resize' : 'text';
        return;
      }
      const t = Math.max(0, Math.min(S.duration, x2t(e.offsetX)));
      if (S.drag === 'in')        S.trimIn  = Math.min(t, (S.trimOut || S.duration) - 0.05);
      else if (S.drag === 'out')  S.trimOut = Math.max(t, S.trimIn + 0.05);
      else if (S.drag === 'seek') seekTo(t);
      else if (S.drag === 'loop') S.loop.end = t;
      draw();
    });

    cv.addEventListener('pointerup', () => {
      if (S.drag === 'in' || S.drag === 'out') syncTrimToEditor();
      if (S.drag === 'loop' && S.loop) {
        if (S.loop.end < S.loop.start) { const t = S.loop.start; S.loop.start = S.loop.end; S.loop.end = t; }
        if (S.loop.end - S.loop.start < 0.1) S.loop = null;
        else window.logToConsole?.('', `Loop region: ${S.loop.start.toFixed(2)}s – ${S.loop.end.toFixed(2)}s (shift-drag to change, click to clear)`);
      }
      S.drag = null;
      draw();
    });
  }

  function seekTo(t) {
    S.playhead = t;
    const v = document.getElementById('preview-video') || document.querySelector('#preview-wrapper video');
    if (v && isFinite(t)) v.currentTime = t;
  }

  function bindPlayhead() {
    const v = document.getElementById('preview-video') || document.querySelector('#preview-wrapper video');
    if (!v) return;
    v.addEventListener('timeupdate', () => {
      S.playhead = v.currentTime;
      // Loop-region playback
      if (S.loop && v.currentTime >= S.loop.end) v.currentTime = S.loop.start;
      draw();
    });
  }

  // ---------------------------------------------------------------------------
  // PUBLIC
  // ---------------------------------------------------------------------------

  async function loadMedia(media) {
    if (!media || !media.file) return;
    S.mediaId = media.id;
    S.duration = media.durationSec || 0;
    S.trimIn = 0;
    S.trimOut = S.duration;
    S.beats = []; S.silences = []; S.scenes = []; S.loop = null;
    S.peaks = null; S.thumbs = [];
    draw();

    const cols = Math.max(400, cv?.clientWidth || 800);
    const [pk, thumbs] = await Promise.all([
      computePeaks(media.file, cols),
      buildFilmstrip(media.file, 12),
    ]);
    if (S.mediaId !== media.id) return;         // a newer file was selected

    if (pk) {
      S.peaks = pk.peaks;
      if (!S.duration) { S.duration = pk.duration; S.trimOut = pk.duration; }
    }
    S.thumbs = thumbs;
    thumbs.forEach((t) => { t.img.onload = draw; });
    draw();
  }

  function setBeats(beats)       { S.beats = beats || [];       draw(); }
  function setSilences(regions)  { S.silences = regions || [];  draw(); }
  function setScenes(cuts)       { S.scenes = cuts || [];       draw(); }
  function getTrim()             { return { in: S.trimIn, out: S.trimOut, duration: S.duration }; }
  function getLoop()             { return S.loop; }

  function mount(container) {
    wrap = container || document.getElementById('waveform-wrap');
    if (!wrap) return;
    wrap.innerHTML = `
      <canvas id="filmstrip-canvas" height="${H_STRIP}"></canvas>
      <canvas id="waveform-canvas"  height="${H_WAVE}"></canvas>
      <div class="wave-hint">Drag the handles to trim · click to seek · <kbd>Shift</kbd>+drag to loop a region</div>`;
    strip = wrap.querySelector('#filmstrip-canvas');
    cv    = wrap.querySelector('#waveform-canvas');
    sctx  = strip.getContext('2d');
    ctx   = cv.getContext('2d');
    bindPointer();
    bindPlayhead();
    window.addEventListener('resize', draw);
    draw();
  }

  window.FFWaveform = { mount, loadMedia, setBeats, setSilences, setScenes, getTrim, getLoop, draw };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mount());
  else mount();
})();
