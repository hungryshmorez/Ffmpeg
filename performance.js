/* =============================================================================
   performance.js — ADAPTIVE QUALITY + GLOBAL MASTER + LAYER COMPOSITOR
   (from Trippy Effects Manager + SauceLab Layer Manager)
   -----------------------------------------------------------------------------
   Three things I missed on the first two passes, and all three matter more than
   most of what I did ship.

   1. ADAPTIVE QUALITY.
      A GPU-heavy app on unknown hardware WILL drop frames. Trippy Effects
      monitors FPS and, when it falls, automatically sheds load — resolution
      first, then the expensive effects. It doesn't ask. It doesn't stutter and
      hope. It degrades gracefully and tells you it did.

      We are running an 11-shader pipeline, a motion mosher, a particle system
      and a WebGL preview simultaneously. This is not optional.

   2. GLOBAL INTENSITY.
      One master knob over everything. When the whole thing is too much, you want
      ONE control, not twenty-three.

   3. LAYER COMPOSITOR.
      SauceLab stacks sources with blend modes, opacity, solo and mute — and
      HOT CUES: stored jump points you can trigger. That's a deck, not a preview.
   ========================================================================== */

(function () {
  'use strict';

  // ===========================================================================
  // 1. ADAPTIVE QUALITY
  // ===========================================================================

  const TIERS = [
    { name: 'ultra',  scale: 1.00, particles: 1.0, mosh: true,  fx: 'all',      label: 'Ultra' },
    { name: 'high',   scale: 1.00, particles: 0.7, mosh: true,  fx: 'all',      label: 'High' },
    { name: 'medium', scale: 0.75, particles: 0.4, mosh: true,  fx: 'cheap',    label: 'Medium' },
    { name: 'low',    scale: 0.55, particles: 0.0, mosh: false, fx: 'cheap',    label: 'Low' },
    { name: 'potato', scale: 0.40, particles: 0.0, mosh: false, fx: 'minimal',  label: 'Minimum' },
  ];

  // The shaders that are genuinely expensive. These are the ones that get shed.
  const EXPENSIVE = ['pixelsort', 'feedbackDisplace', 'kaleidoscope', 'noiseGlitch', 'datamosh'];

  const Perf = {
    fps: 60,
    frames: 0,
    last: performance.now(),
    tier: 0,                    // index into TIERS
    auto: true,
    lastChange: 0,
    history: [],
    mem: 0,
    running: false,

    targets: { good: 50, bad: 28, awful: 18 },

    start() {
      if (this.running) return;
      this.running = true;
      const loop = () => {
        if (!this.running) return;
        this.frames++;
        const now = performance.now();
        const dt = now - this.last;

        if (dt >= 500) {
          this.fps = (this.frames * 1000) / dt;
          this.frames = 0;
          this.last = now;

          this.history.push(this.fps);
          if (this.history.length > 8) this.history.shift();

          if (performance.memory) {
            this.mem = performance.memory.usedJSHeapSize / 1048576;
          }

          if (this.auto) this._adapt();
          this._render();
        }
        requestAnimationFrame(loop);
      };
      loop();
    },

    stop() { this.running = false; },

    /** The whole point: shed load BEFORE the user notices, and say so. */
    _adapt() {
      const now = performance.now();
      if (now - this.lastChange < 2500) return;              // don't oscillate

      const avg = this.history.reduce((a, b) => a + b, 0) / (this.history.length || 1);
      if (this.history.length < 4) return;

      if (avg < this.targets.awful && this.tier < TIERS.length - 1) {
        this._setTier(this.tier + 2, avg);                    // two steps — it's bad
      } else if (avg < this.targets.bad && this.tier < TIERS.length - 1) {
        this._setTier(this.tier + 1, avg);
      } else if (avg > this.targets.good + 8 && this.tier > 0) {
        this._setTier(this.tier - 1, avg);                    // headroom — climb back
      }
    },

    _setTier(i, avg) {
      i = Math.max(0, Math.min(TIERS.length - 1, i));
      if (i === this.tier) return;
      const up = i < this.tier;
      this.tier = i;
      this.lastChange = performance.now();
      this.apply();

      window.logToConsole?.(up ? 'ok' : 'warn',
        `[perf] ${avg.toFixed(0)} fps → quality ${up ? 'raised' : 'reduced'} to ` +
        `${TIERS[i].label}. ${up ? '' : 'Turn off Auto Quality to override.'}`);
      window.dispatchEvent(new CustomEvent('perf:tier', { detail: TIERS[i] }));
    },

    apply() {
      const t = TIERS[this.tier];

      // Render at a lower internal resolution and let CSS scale it up. This is
      // by far the biggest single lever — cost is O(pixels).
      document.querySelectorAll('#trip-canvas, #vj-canvas, #live-canvas').forEach((cv) => {
        cv.dataset.qScale = String(t.scale);
      });

      window.FFPerf.scale = t.scale;
      window.FFPerf.particleScale = t.particles;
      window.FFPerf.allowMosh = t.mosh;
      window.FFPerf.fxLevel = t.fx;
      return t;
    },

    setTier(name) {
      const i = TIERS.findIndex((t) => t.name === name);
      if (i >= 0) { this.auto = false; this.tier = i; this.apply(); }
    },

    isAllowed(effectId) {
      const t = TIERS[this.tier];
      if (t.fx === 'all') return true;
      if (t.fx === 'minimal') return !EXPENSIVE.includes(effectId) && effectId !== 'feedback';
      return !EXPENSIVE.includes(effectId);
    },

    _render() {
      const el = document.getElementById('perf-hud');
      if (!el) return;
      // Only surface the HUD when a live GPU canvas is actually on screen — an
      // fps counter on the plain editor page would just be noise. (This is why
      // the monitor previously "ran blind": there was no #perf-hud at all, and
      // nothing ever decided when to show it.)
      const live = [...document.querySelectorAll('#trip-canvas, #vj-canvas, #live-canvas')]
        .some((cv) => cv && cv.offsetParent !== null);
      if (!live) { el.hidden = true; return; }
      el.hidden = false;
      const f = Math.round(this.fps);
      const t = TIERS[this.tier];
      el.innerHTML =
        `<span class="perf-fps ${f >= 50 ? 'good' : f >= 30 ? 'ok' : 'bad'}">${f} fps</span>` +
        `<span class="perf-tier">${t.label}</span>` +
        (this.mem ? `<span class="perf-mem">${Math.round(this.mem)} MB</span>` : '') +
        (this.auto ? '<span class="perf-auto">AUTO</span>' : '');
    },
  };

  // ===========================================================================
  // 2. GLOBAL INTENSITY — one knob over everything.
  // ===========================================================================

  const Master = {
    intensity: 1.0,
    _base: null,

    /** Scale every effect parameter toward its neutral value. 0 = bypass. */
    set(v, engine) {
      this.intensity = v;
      if (!engine) return;
      const base = window.TripCam?.DEFAULTS || {};
      if (!this._base) this._base = { ...engine.params };

      const out = {};
      for (const [k, val] of Object.entries(this._base)) {
        const n = base[k] ?? 0;
        out[k] = n + (val - n) * v;                   // lerp toward neutral
      }
      engine.setParams(out);
    },

    capture(engine) { this._base = engine ? { ...engine.params } : null; },
    release() { this._base = null; },
  };

  // ===========================================================================
  // 3. LAYER COMPOSITOR — stack sources, blend, solo, mute, HOT CUES.
  // ===========================================================================

  const BLEND_MODES = [
    'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
    'color-dodge', 'color-burn', 'hard-light', 'soft-light',
    'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
  ];

  class Layer {
    constructor(id) {
      this.id = id;
      this.video = null;
      this.name = `Layer ${id + 1}`;
      this.opacity = id === 0 ? 1 : 0;
      this.blendMode = 'normal';
      this.solo = false;
      this.mute = false;
      this.speed = 1;
      this.hotCues = [];              // ← jump points. This is the DJ feature.
      this.effect = null;             // an optional per-layer shader
      this.syncToSequencer = false;
    }

    async load(fileOrUrl, name) {
      const v = document.createElement('video');
      v.src = typeof fileOrUrl === 'string' ? fileOrUrl : URL.createObjectURL(fileOrUrl);
      v.loop = true; v.muted = true; v.playsInline = true;
      await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 5000); });
      await v.play().catch(() => {});
      this.video = v;
      this.name = name || 'clip';
      return this;
    }

    /** Store the current position as a hot cue. */
    setCue(slot) {
      if (!this.video) return;
      this.hotCues[slot] = this.video.currentTime;
      window.logToConsole?.('ok',
        `[layer ${this.id + 1}] cue ${slot + 1} = ${this.video.currentTime.toFixed(2)}s`);
    }

    /** Jump to a cue. Instant. This is what makes it playable. */
    jumpCue(slot) {
      if (!this.video || this.hotCues[slot] == null) return;
      this.video.currentTime = this.hotCues[slot];
      this.video.play().catch(() => {});
    }

    clearCue(slot) { this.hotCues[slot] = null; }
  }

  class Compositor {
    constructor(canvas, count = 4) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.layers = Array.from({ length: count }, (_, i) => new Layer(i));
      this.raf = 0;
      this.masterOpacity = 1;
    }

    get anySolo() { return this.layers.some((l) => l.solo); }

    /** Draw the stack, bottom to top, with blend modes. */
    draw() {
      const { width: w, height: h } = this.cv;
      const c = this.ctx;

      c.globalCompositeOperation = 'source-over';
      c.globalAlpha = 1;
      c.fillStyle = '#000';
      c.fillRect(0, 0, w, h);

      const solo = this.anySolo;

      for (const l of this.layers) {
        if (!l.video || l.video.readyState < 2) continue;
        if (l.mute) continue;
        if (solo && !l.solo) continue;

        const a = l.opacity * this.masterOpacity;
        if (a <= 0.001) continue;

        c.globalAlpha = a;
        c.globalCompositeOperation = l.blendMode === 'normal' ? 'source-over' : l.blendMode;

        // Cover-fit, so mismatched aspect ratios don't letterbox.
        const vr = l.video.videoWidth / l.video.videoHeight;
        const cr = w / h;
        let dw = w, dh = h, dx = 0, dy = 0;
        if (vr > cr) { dw = h * vr; dx = (w - dw) / 2; }
        else         { dh = w / vr; dy = (h - dh) / 2; }

        c.drawImage(l.video, dx, dy, dw, dh);
      }

      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
    }

    start() {
      const loop = () => { this.draw(); this.raf = requestAnimationFrame(loop); };
      if (!this.raf) loop();
    }
    stop() { cancelAnimationFrame(this.raf); this.raf = 0; }

    /** Crossfade between two layers with one value. The classic VJ move. */
    crossfade(a, b, x) {
      this.layers[a].opacity = 1 - x;
      this.layers[b].opacity = x;
    }
  }

  window.FFPerf = {
    Perf, TIERS, EXPENSIVE, Master,
    Layer, Compositor, BLEND_MODES,
    scale: 1, particleScale: 1, allowMosh: true, fxLevel: 'all',
  };

  document.addEventListener('DOMContentLoaded', () => Perf.start());
})();
