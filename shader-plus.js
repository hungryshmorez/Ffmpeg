/* =============================================================================
   shader-plus.js — WHAT I MISSED
   (from Trippy Cam 2.0 + Trippy Effects)
   -----------------------------------------------------------------------------
   I skimmed these two on the first pass and wrongly wrote them off. Reading them
   properly, there are four things in here that are better than what I shipped:

   1. THREE-BAND AUDIO REACTIVITY.
      My port averaged the whole spectrum into ONE number and pushed it at
      u_intensity. That is musically useless — a kick drum and a hi-hat move the
      same slider by the same amount.

      Trippy Cam 2.0 splits the spectrum into BASS / MID / TREBLE, each with its
      own threshold, and drives different uniforms from each. Now the kick can
      punch the zoom while the hats shimmer the chroma. That is the difference
      between "reacts to audio" and "reacts to the music".

   2. u_cameraRotation ON EVERY SHADER.
      Every v2.0 shader rotates its texture coordinates by a uniform before doing
      anything else. That gives you: device-tilt control on mobile (turn the
      phone, the kaleidoscope turns), a fix for upside-down feeds, and rotation
      as a performable parameter. My port had none of it.

   3. AUTO-GLITCH / CHAOS MODE.
      Trippy Effects fires random glitches on a random schedule — each glitch
      type has its own probability, and there's a small chance of a "heavy" one.
      The app misbehaves on its own. For a VJ set or an unattended capture this
      is the single most useful feature in the whole file.

   4. PER-EFFECT DEFAULTS.
      One global default patch is wrong. Feedback wants a different starting
      point than Kaleidoscope. v2.0 keeps a defaults block per effect.
   ========================================================================== */

(function () {
  'use strict';

  // ===========================================================================
  // 1. THREE-BAND AUDIO REACTIVITY
  // ===========================================================================

  const AUDIO_CFG = {
    fftSize: 256,
    smoothing: 0.8,
    bass:   [0.00, 0.10],     // fraction of the spectrum
    mid:    [0.10, 0.50],
    treble: [0.50, 1.00],
    thresholds: { bass: 0.30, mid: 0.25, treble: 0.20 },
    scale: 2.5,
  };

  class BandAnalyser {
    constructor() {
      this.ctx = null; this.an = null; this.data = null;
      this.bands = { bass: 0, mid: 0, treble: 0, level: 0 };
      this.peak  = { bass: 0, mid: 0, treble: 0 };   // for transient/onset detection
      this.enabled = false;
    }

    async fromMic() {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      return this._attach((ac) => ac.createMediaStreamSource(s));
    }

    fromElement(el) {
      return this._attach((ac) => ac.createMediaElementSource(el), true);
    }

    _attach(makeSource, connectOut) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      const src = makeSource(this.ctx);
      this.an = this.ctx.createAnalyser();
      this.an.fftSize = AUDIO_CFG.fftSize;
      this.an.smoothingTimeConstant = AUDIO_CFG.smoothing;
      src.connect(this.an);
      if (connectOut) this.an.connect(this.ctx.destination);
      this.data = new Uint8Array(this.an.frequencyBinCount);
      this.enabled = true;
      return true;
    }

    /** Read the three bands. Call this once per frame. */
    read() {
      if (!this.enabled || !this.an) return this.bands;
      this.an.getByteFrequencyData(this.data);
      const n = this.data.length;

      const band = ([lo, hi]) => {
        const a = Math.floor(lo * n), b = Math.floor(hi * n);
        let s = 0;
        for (let i = a; i < b; i++) s += this.data[i];
        return (b > a) ? (s / (b - a)) / 255 : 0;
      };

      const raw = {
        bass:   band(AUDIO_CFG.bass),
        mid:    band(AUDIO_CFG.mid),
        treble: band(AUDIO_CFG.treble),
      };

      // Gate below the per-band threshold, then scale. Without the gate, room
      // tone drives the effects and everything wobbles constantly.
      for (const k of ['bass', 'mid', 'treble']) {
        const t = AUDIO_CFG.thresholds[k];
        const v = raw[k] > t ? (raw[k] - t) / (1 - t) : 0;
        // Fast attack, slow release — this is what makes it feel like it's
        // hitting on the beat rather than sloshing around.
        this.bands[k] = v > this.bands[k]
          ? v
          : this.bands[k] * 0.85 + v * 0.15;
        this.peak[k] = Math.max(this.peak[k] * 0.94, v);
      }
      this.bands.level = (this.bands.bass + this.bands.mid + this.bands.treble) / 3;
      return this.bands;
    }

    /** Was there a transient in this band on this frame? (kick / snare / hat) */
    hit(band, sens = 0.55) {
      return this.bands[band] > sens && this.bands[band] >= this.peak[band] * 0.92;
    }

    close() { try { this.ctx?.close(); } catch (_) {} this.enabled = false; }
  }

  // ---------------------------------------------------------------------------
  // The routing table. THIS is the part that matters — which band drives what.
  // ---------------------------------------------------------------------------
  const ROUTES = {
    'off':      {},
    'balanced': {
      bass:   { intensity: 0.7, fisheyeStrength: 0.35 },
      mid:    { glitchStrength: 0.6, waveAmplitude: 0.04 },
      treble: { phosphorOffset: 0.008, scanlineIntensity: 0.35 },
    },
    'kick-punch': {                    // bass drives a zoom punch. Very physical.
      bass:   { fisheyeStrength: 1.0, intensity: 1.1, brightness: 0.18 },
      treble: { phosphorOffset: 0.006 },
    },
    'hats-shimmer': {                  // treble does the fine work
      treble: { phosphorOffset: 0.016, glitchStrength: 0.8, scanlineIntensity: 0.6 },
      bass:   { trailPersistence: 0.35 },
    },
    'full-chaos': {
      bass:   { intensity: 1.4, fisheyeStrength: 0.9, kaleidoSegments: 10 },
      mid:    { glitchStrength: 1.6, waveAmplitude: 0.10, hueShiftSpeed: 0.4 },
      treble: { phosphorOffset: 0.02, scanlineIntensity: 0.9, saturation: 1.2 },
    },
    'melt':     {                      // slow, heavy, low-end driven
      bass:   { trailPersistence: 0.55, waveAmplitude: 0.06, intensity: 0.8 },
      mid:    { displacement: 0.03 },
    },
  };

  /** Apply the routed audio energy on top of the base patch. */
  function routeAudio(engine, bands, routeName, amount = 1) {
    const route = ROUTES[routeName];
    if (!engine || !route) return;
    const base = window.TripCam?.DEFAULTS || {};

    for (const [band, targets] of Object.entries(route)) {
      const e = (bands[band] || 0) * amount;
      if (e <= 0.001) continue;
      for (const [param, gain] of Object.entries(targets)) {
        const b = base[param] ?? 0;
        engine.setParam(param, b + e * gain);
      }
    }
  }

  // ===========================================================================
  // 2. CAMERA ROTATION — device orientation, upside-down feeds, and as a
  //    performable parameter in its own right.
  // ===========================================================================

  const Rotation = {
    angle: Math.PI,          // v2.0 defaults to 180° — most webcam feeds want it
    followDevice: false,
    _handler: null,

    set(rad) { this.angle = rad; },
    setDegrees(deg) { this.angle = (deg * Math.PI) / 180; },

    /** Tilt the phone, the effect turns with it. */
    followOrientation(on) {
      this.followDevice = on;
      if (!on) {
        window.removeEventListener('deviceorientation', this._handler);
        return;
      }
      this._handler = (e) => {
        if (e.gamma == null) return;
        // gamma = left/right tilt, -90..90
        this.angle = Math.PI + (e.gamma / 90) * (Math.PI / 2);
      };
      // iOS 13+ needs an explicit permission grant, and only from a user gesture.
      if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
          .then((r) => { if (r === 'granted') window.addEventListener('deviceorientation', this._handler); })
          .catch(() => {});
      } else {
        window.addEventListener('deviceorientation', this._handler);
      }
    },
  };

  /**
   * Patch the rotation uniform into a shader that doesn't declare it, and rotate
   * its texture coordinates before anything else runs.
   * This retrofits u_cameraRotation onto the 11 shaders I ported without it.
   */
  function injectRotation(src) {
    if (src.includes('u_cameraRotation')) return src;

    const helper = `
uniform float u_cameraRotation;
vec2 _rotTC(vec2 tc, float a) {
  vec2 c = vec2(0.5);
  vec2 t = tc - c;
  float s = sin(a), k = cos(a);
  return vec2(t.x * k - t.y * s, t.x * s + t.y * k) + c;
}
`;
    // Insert after the last uniform declaration.
    const lastUniform = src.lastIndexOf('uniform ');
    const eol = src.indexOf('\n', lastUniform);
    let out = src.slice(0, eol + 1) + helper + src.slice(eol + 1);

    // Rotate v_texCoord at the top of main().
    out = out.replace(/void\s+main\s*\(\s*\)\s*\{/,
      'void main() {\n  vec2 v_texCoord = _rotTC(v_texCoord_in, u_cameraRotation);');
    out = out.replace(/varying\s+vec2\s+v_texCoord\s*;/, 'varying vec2 v_texCoord_in;');
    return out;
  }

  // ===========================================================================
  // 3. AUTO-GLITCH / CHAOS MODE
  // ---------------------------------------------------------------------------
  // The app misbehaves on its own, on a random schedule. For a VJ set or an
  // unattended capture this is the most useful thing in the whole pile.
  // ===========================================================================

  const CHAOS_DEFAULTS = {
    enabled: false,
    intervalMs: [2000, 5000],     // random gap between glitches
    durationMs: [100, 500],       // random length of each glitch
    heavyProb: 0.10,              // chance of a much bigger one
    probs: {
      rgbSplit:    0.30,
      blockMove:   0.40,
      pixelSort:   0.20,
      noise:       0.30,
      compression: 0.20,
      invert:      0.08,
      freeze:      0.06,
      mosh:        0.12,
    },
    beatSync: false,              // fire on detected beats instead of at random
  };

  const GLITCH = {
    rgbSplit:    (e, h) => e.setParams({ phosphorOffset: h ? 0.03 : 0.012 }),
    blockMove:   (e, h) => e.setParams({ displacement: h ? 0.08 : 0.03, glitchStrength: h ? 1.8 : 0.8 }),
    pixelSort:   (e, h) => { e.setEffect('pixelsort'); e.setParams({ intensity: h ? 1.8 : 1.1 }); },
    noise:       (e, h) => e.setParams({ glitchStrength: h ? 2.0 : 0.9 }),
    compression: (e, h) => e.setParams({ scanlineIntensity: h ? 0.9 : 0.5, contrast: h ? 1.8 : 1.3 }),
    invert:      (e)    => e.setParams({ saturation: -1, brightness: 0.4 }),
    freeze:      (e)    => e.freeze(true),
    mosh:        ()     => window.dispatchEvent(new CustomEvent('vj:mosh', { detail: { on: true } })),
  };

  class ChaosEngine {
    constructor(engine) {
      this.engine = engine;
      this.cfg = JSON.parse(JSON.stringify(CHAOS_DEFAULTS));
      this.timer = null;
      this.active = [];
    }

    setConfig(patch) { Object.assign(this.cfg, patch); }

    start() {
      if (this.timer) return;
      this.cfg.enabled = true;
      this._schedule();
      window.logToConsole?.('ok', '[chaos] auto-glitch armed — it will misbehave on its own.');
    }

    stop() {
      clearTimeout(this.timer);
      this.timer = null;
      this.cfg.enabled = false;
      this._restore();
    }

    _schedule() {
      const [lo, hi] = this.cfg.intervalMs;
      const wait = lo + Math.random() * (hi - lo);
      this.timer = setTimeout(() => { this.fire(); this._schedule(); }, wait);
    }

    /** Fire one glitch burst. Public — the VJ pads and beat-sync both call it. */
    fire(forceHeavy) {
      if (!this.engine) return;
      const heavy = forceHeavy ?? (Math.random() < this.cfg.heavyProb);
      const [dLo, dHi] = this.cfg.durationMs;
      const dur = (dLo + Math.random() * (dHi - dLo)) * (heavy ? 2.2 : 1);

      const fired = [];
      for (const [name, p] of Object.entries(this.cfg.probs)) {
        if (Math.random() < p * (heavy ? 1.8 : 1)) {
          GLITCH[name]?.(this.engine, heavy);
          fired.push(name);
        }
      }
      if (!fired.length) return;

      window.dispatchEvent(new CustomEvent('chaos:fire', { detail: { fired, heavy, dur } }));
      setTimeout(() => this._restore(), dur);
    }

    _restore() {
      if (!this.engine) return;
      this.engine.setParams({ ...(window.TripCam?.DEFAULTS || {}) });
      this.engine.freeze(false);
      window.dispatchEvent(new CustomEvent('vj:mosh', { detail: { on: false } }));
    }
  }

  // ===========================================================================
  // 4. PER-EFFECT DEFAULTS
  // ---------------------------------------------------------------------------
  // One global default patch is wrong: Feedback wants a very different starting
  // point from Kaleidoscope. Switching effects should land you somewhere that
  // already looks good.
  // ===========================================================================

  const EFFECT_DEFAULTS = {
    datamosh:         { motionThreshold: 0.10, trailPersistence: 0.80, motionExtrapolation: 0.0, intensity: 0.6 },
    feedback:         { feedback: 0.50, displacement: 0.04, trailPersistence: 0.92, intensity: 0.7 },
    feedbackDisplace: { feedback: 0.55, displacement: 0.06, displacementStrength: 0.05, trailPersistence: 0.9 },
    kaleidoscope:     { kaleidoSegments: 6, intensity: 0.8, saturation: 1.3 },
    mirror:           { intensity: 0.5 },
    pixelsort:        { threshold: 0.45, intensity: 1.0, glitchStrength: 0.5 },
    colorshift:       { phosphorOffset: 0.006, hueShiftSpeed: 0.05, saturation: 1.4 },
    crt:              { scanlineDensity: 500, scanlineIntensity: 0.35, curvatureAmount: 0.14, phosphorOffset: 0.003 },
    wavewarp:         { waveAmplitude: 0.035, waveDensity: 12, waveSpeed: 1.2 },
    fisheye:          { fisheyeStrength: 0.55, intensity: 0.6 },
    noiseGlitch:      { glitchStrength: 0.8, threshold: 0.5, intensity: 0.9 },
  };

  /** Call this when the effect changes — land on a patch that already looks good. */
  function applyEffectDefaults(engine, effectId) {
    const d = EFFECT_DEFAULTS[effectId];
    if (!engine || !d) return;
    engine.setParams({ ...(window.TripCam?.DEFAULTS || {}), ...d });
    return d;
  }

  // ===========================================================================
  // 5. CPU PIXEL SORT — a real one. The shader version approximates; this
  //    actually sorts, which is a visibly different (and more correct) look.
  // ===========================================================================

  function pixelSort(imgData, { threshold = 0.5, vertical = false, mode = 'brightness' } = {}) {
    const { data, width: w, height: h } = imgData;
    const lum = (i) => (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
    const key = mode === 'hue'
      ? (i) => Math.atan2(1.732 * (data[i + 1] - data[i + 2]), 2 * data[i] - data[i + 1] - data[i + 2])
      : lum;

    const lines = vertical ? w : h;
    const len   = vertical ? h : w;

    for (let l = 0; l < lines; l++) {
      let start = -1;
      for (let p = 0; p <= len; p++) {
        const i = vertical ? ((p * w + l) * 4) : ((l * w + p) * 4);
        const bright = p < len && lum(i) > threshold;

        if (bright && start < 0) start = p;
        else if ((!bright || p === len) && start >= 0) {
          // Sort this contiguous run of bright pixels.
          const run = [];
          for (let q = start; q < p; q++) {
            const j = vertical ? ((q * w + l) * 4) : ((l * w + q) * 4);
            run.push([key(j), data[j], data[j + 1], data[j + 2]]);
          }
          run.sort((a, b) => a[0] - b[0]);
          for (let q = start, k = 0; q < p; q++, k++) {
            const j = vertical ? ((q * w + l) * 4) : ((l * w + q) * 4);
            data[j] = run[k][1]; data[j + 1] = run[k][2]; data[j + 2] = run[k][3];
          }
          start = -1;
        }
      }
    }
    return imgData;
  }

  // ===========================================================================
  // 5b. MASKED / ANGLED PIXEL SORT (#64) — sort only pixels whose luma (or hue)
  //     falls inside a [lo,hi] BAND, along an arbitrary ANGLE. The band mask is
  //     what makes it selective; the angle is done by rotating the frame,
  //     sorting horizontal runs, and rotating back.
  // ===========================================================================

  /** Sort contiguous horizontal runs whose key is inside [lo,hi]. In place. */
  function sortBands(data, w, h, lo, hi, mode, order) {
    const lum = (i) => (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
    const hue = (i) => (Math.atan2(1.732 * (data[i + 1] - data[i + 2]), 2 * data[i] - data[i + 1] - data[i + 2]) / (2 * Math.PI)) + 0.5;
    const val = mode === 'hue' ? hue : lum;
    const sign = order === 'desc' ? -1 : 1;
    for (let y = 0; y < h; y++) {
      let start = -1;
      for (let x = 0; x <= w; x++) {
        const i = (y * w + x) * 4;
        // a pixel joins a run when opaque and inside the band
        const inBand = x < w && data[i + 3] > 8 && (() => { const v = val(i); return v >= lo && v <= hi; })();
        if (inBand && start < 0) start = x;
        else if ((!inBand || x === w) && start >= 0) {
          const run = [];
          for (let q = start; q < x; q++) { const j = (y * w + q) * 4; run.push([val(j), data[j], data[j + 1], data[j + 2]]); }
          run.sort((a, b) => sign * (a[0] - b[0]));
          for (let q = start, k = 0; q < x; q++, k++) { const j = (y * w + q) * 4; data[j] = run[k][1]; data[j + 1] = run[k][2]; data[j + 2] = run[k][3]; }
          start = -1;
        }
      }
    }
  }

  function pixelSortMasked(imgData, { lo = 0.25, hi = 0.85, mode = 'brightness', angle = 0, order = 'asc' } = {}) {
    const w = imgData.width, h = imgData.height;
    if (Math.abs(angle % 180) < 1) { sortBands(imgData.data, w, h, lo, hi, mode, order); return imgData; }
    const rad = -angle * Math.PI / 180;
    const src = document.createElement('canvas'); src.width = w; src.height = h;
    src.getContext('2d').putImageData(imgData, 0, 0);
    const D = Math.ceil(Math.hypot(w, h));
    const rot = document.createElement('canvas'); rot.width = D; rot.height = D;
    const rc = rot.getContext('2d', { willReadFrequently: true });
    rc.translate(D / 2, D / 2); rc.rotate(rad); rc.drawImage(src, -w / 2, -h / 2); rc.setTransform(1, 0, 0, 1, 0, 0);
    const rd = rc.getImageData(0, 0, D, D);
    sortBands(rd.data, D, D, lo, hi, mode, order);
    rc.putImageData(rd, 0, 0);
    const oc = src.getContext('2d');
    oc.clearRect(0, 0, w, h);
    oc.translate(w / 2, h / 2); oc.rotate(-rad); oc.drawImage(rot, -D / 2, -D / 2); oc.setTransform(1, 0, 0, 1, 0, 0);
    const od = oc.getImageData(0, 0, w, h);
    imgData.data.set(od.data);
    return imgData;
  }

  /** Offline render: masked pixel-sort every frame of a clip → Media Bin. */
  async function renderPixelSort(media, opts = {}, onProgress) {
    const v = document.createElement('video'); v.src = media.blobUrl; v.muted = true; v.playsInline = true;
    await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 5000); });
    const w = Math.min(960, v.videoWidth || 640);
    const h = Math.round(w * ((v.videoHeight || 360) / (v.videoWidth || 640) / 2)) * 2;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const stream = cv.captureStream(30);
    const mime = (window.pickRecorderMime || (() => 'video/webm'))('video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=h264', 'video/mp4');
    const chunks = [];
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 10_000_000 } : { videoBitsPerSecond: 10_000_000 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });
    rec.start(200); await v.play().catch(() => {});
    await new Promise((res) => {
      let fin = false; const finish = () => { if (fin) return; fin = true; clearInterval(wd); res(); };
      let last = -1, stalls = 0;
      const wd = setInterval(() => { if (v.ended || v.paused) return finish(); if (v.currentTime === last) { if (++stalls >= 8) finish(); } else { last = v.currentTime; stalls = 0; } }, 100);
      const step = () => {
        if (fin) return; if (v.ended || v.paused) return finish();
        ctx.drawImage(v, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        pixelSortMasked(img, opts);
        ctx.putImageData(img, 0, 0);
        onProgress?.(v.currentTime / (v.duration || v.currentTime || 1), 0);
        v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
      };
      v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    });
    rec.stop(); await done;
    const type = (rec.mimeType || 'video/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    await window.addBlobToBin?.(blob, `${media.name} [PIXEL SORT].${ext}`, type);
    window.logToConsole?.('ok', `[sort] pixel-sorted → Media Bin (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    return blob;
  }

  // ===========================================================================
  // 6. SPARKLE / PARTICLE OVERLAY — with gravity. Drawn on top of the shader.
  // ===========================================================================

  class Sparkles {
    constructor(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.parts = [];
      this.cfg = { rate: 3, gravity: 0.06, life: 70, size: 3, spread: 1.6, hue: 190, hueRange: 120 };
    }

    emit(n, x, y) {
      for (let i = 0; i < n; i++) {
        this.parts.push({
          x: x ?? Math.random() * this.cv.width,
          y: y ?? Math.random() * this.cv.height,
          vx: (Math.random() - 0.5) * this.cfg.spread * 4,
          vy: (Math.random() - 0.5) * this.cfg.spread * 4 - 1,
          life: this.cfg.life * (0.6 + Math.random() * 0.8),
          age: 0,
          s: this.cfg.size * (0.5 + Math.random()),
          h: this.cfg.hue + (Math.random() - 0.5) * this.cfg.hueRange,
        });
      }
    }

    /** Drive the emission rate from an audio band — sparks on the beat. */
    step(audioBands) {
      const boost = audioBands ? 1 + audioBands.treble * 14 : 1;
      this.emit(Math.round(this.cfg.rate * boost));

      const c = this.ctx;
      c.save();
      c.globalCompositeOperation = 'lighter';
      for (let i = this.parts.length - 1; i >= 0; i--) {
        const p = this.parts[i];
        p.age++;
        if (p.age > p.life) { this.parts.splice(i, 1); continue; }
        p.vy += this.cfg.gravity;
        p.x += p.vx; p.y += p.vy;
        const a = 1 - p.age / p.life;
        c.fillStyle = `hsla(${p.h}, 100%, 70%, ${a})`;
        c.beginPath();
        c.arc(p.x, p.y, p.s * a, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    }

    clear() { this.parts = []; }
  }

  window.FFShaderPlus = {
    BandAnalyser, ROUTES, routeAudio, AUDIO_CFG,
    Rotation, injectRotation,
    ChaosEngine, CHAOS_DEFAULTS, GLITCH,
    EFFECT_DEFAULTS, applyEffectDefaults,
    pixelSort, pixelSortMasked, sortBands, renderPixelSort, Sparkles,
  };
})();
