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

  /**
   * The matching HALF of injectRotation. injectRotation renames the FRAGMENT
   * varying to `v_texCoord_in` (so it can shadow it with a rotated local named
   * `v_texCoord`). The vertex shader that feeds these fragments must OUTPUT the
   * varying under the same name — the GLSL spec requires vertex/fragment
   * varyings to match by name, and strict drivers (SwiftShader, many mobile
   * GLES) FAIL THE LINK otherwise (lenient desktop drivers silently tolerate the
   * mismatch, which is why this hid for so long). Apply this to the shared
   * vertex shader whenever the fragments are injectRotation-patched.
   */
  function patchVertex(vsrc) {
    return vsrc.replace(/v_texCoord\b/g, 'v_texCoord_in');
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
  // 5c. FEEDBACK WITH GEOMETRIC TRANSFORMS (#67) — the infinite tunnel. A
  //     persistent buffer is re-drawn each frame ZOOMED + ROTATED and faded by
  //     `decay`, then the new frame is composited on top. Because last frame's
  //     picture is scaled a little every step, any detail spirals outward (or
  //     inward) forever — the classic video-feedback tunnel, done offline on a
  //     2-D canvas so it's deterministic and headless-verifiable.
  // ===========================================================================

  class FeedbackTunnel {
    constructor(w, h, opts = {}) {
      this.w = w; this.h = h;
      this.p = Object.assign({ zoom: 1.04, rotate: 0.02, decay: 0.9, mix: 0.7, hueShift: 0, blend: 'lighter' }, opts);
      const mk = () => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
      this.buf = mk(); this.bctx = this.buf.getContext('2d', { willReadFrequently: true });
      this.tmp = mk(); this.tctx = this.tmp.getContext('2d', { willReadFrequently: true });
    }
    /** Feed one drawable frame (canvas / video / image); returns the buffer canvas. */
    push(frame) {
      const { zoom, rotate, decay, mix, hueShift, blend } = this.p;
      const t = this.tctx, w = this.w, h = this.h;
      // Opaque black background so `decay` fades the picture toward black in RGB
      // (fading via alpha alone leaves RGB at full and never darkens).
      t.globalCompositeOperation = 'source-over'; t.globalAlpha = 1; t.filter = 'none';
      t.fillStyle = '#000'; t.fillRect(0, 0, w, h);
      // last frame, decayed + transformed about the centre
      t.save();
      t.globalAlpha = Math.max(0, Math.min(1, decay));
      if (hueShift) t.filter = `hue-rotate(${hueShift}deg)`;
      t.translate(w / 2, h / 2); t.rotate(rotate); t.scale(zoom, zoom); t.translate(-w / 2, -h / 2);
      t.drawImage(this.buf, 0, 0, w, h);
      t.restore();
      // the new frame, added on top
      if (frame) {
        t.save();
        t.globalAlpha = Math.max(0, Math.min(1, mix));
        t.globalCompositeOperation = blend;
        t.drawImage(frame, 0, 0, w, h);
        t.restore();
      }
      this.bctx.clearRect(0, 0, w, h);
      this.bctx.drawImage(this.tmp, 0, 0);
      return this.buf;
    }
    read() { return this.bctx.getImageData(0, 0, this.w, this.h); }
  }

  /** Offline render: run a clip through the feedback tunnel → Media Bin. */
  async function renderFeedback(media, opts = {}, onProgress) {
    const v = document.createElement('video'); v.src = media.blobUrl; v.muted = true; v.playsInline = true;
    await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 5000); });
    const w = Math.min(960, v.videoWidth || 640);
    const h = Math.round(w * ((v.videoHeight || 360) / (v.videoWidth || 640) / 2)) * 2;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const tunnel = new FeedbackTunnel(w, h, opts);
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
        const out = tunnel.push(v);
        ctx.drawImage(out, 0, 0, w, h);
        onProgress?.(v.currentTime / (v.duration || v.currentTime || 1), 0);
        v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
      };
      v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    });
    rec.stop(); await done;
    const type = (rec.mimeType || 'video/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    await window.addBlobToBin?.(blob, `${media.name} [FEEDBACK].${ext}`, type);
    window.logToConsole?.('ok', `[feedback] tunnel → Media Bin (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    return blob;
  }

  // ===========================================================================
  // 5d. HALATION & BLOOM (#48) — a PHYSICAL light-bleed pass, not procedural
  //     noise. Threshold the bright parts of the frame, blur that bright layer,
  //     tint it (real halation is reddish — the film's anti-halation backing
  //     fails around the brightest highlights), and SCREEN it back over the
  //     original. Highlights bloom and bleed into their surroundings.
  // ===========================================================================

  // Separable box blur of one RGB buffer (alpha left at 255). `r` px radius,
  // `passes` box passes ≈ a Gaussian. Operates on a fresh Float32 accumulator.
  function _boxBlur(data, w, h, r, passes) {
    if (r < 1) return data;
    let src = Float32Array.from(data);
    const tmp = new Float32Array(src.length);
    const win = r * 2 + 1;
    for (let pass = 0; pass < passes; pass++) {
      // horizontal
      for (let y = 0; y < h; y++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let x = -r; x <= r; x++) { const xx = x < 0 ? 0 : x >= w ? w - 1 : x; sum += src[(y * w + xx) * 4 + c]; }
          for (let x = 0; x < w; x++) {
            tmp[(y * w + x) * 4 + c] = sum / win;
            const xo = x - r < 0 ? 0 : x - r, xi = x + r + 1 >= w ? w - 1 : x + r + 1;
            sum += src[(y * w + xi) * 4 + c] - src[(y * w + xo) * 4 + c];
          }
        }
      }
      // vertical
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let y = -r; y <= r; y++) { const yy = y < 0 ? 0 : y >= h ? h - 1 : y; sum += tmp[(yy * w + x) * 4 + c]; }
          for (let y = 0; y < h; y++) {
            src[(y * w + x) * 4 + c] = sum / win;
            const yo = y - r < 0 ? 0 : y - r, yi = y + r + 1 >= h ? h - 1 : y + r + 1;
            sum += tmp[(yi * w + x) * 4 + c] - tmp[(yo * w + x) * 4 + c];
          }
        }
      }
    }
    return src;
  }

  /** Halation / bloom over one frame, in place. Returns the same ImageData. */
  function halation(imgData, opts = {}) {
    const { threshold = 0.72, radius = 8, intensity = 0.9, passes = 3, tint = [1.0, 0.55, 0.35] } = opts;
    const { data, width: w, height: h } = imgData;
    // 1. bright-pass: keep only what's above the threshold, black elsewhere
    const bright = new Uint8ClampedArray(data.length);
    const th = threshold * 255;
    for (let i = 0; i < data.length; i += 4) {
      const luma = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      const k = luma > th ? (luma - th) / (255 - th) : 0;   // soft knee above threshold
      bright[i] = data[i] * k; bright[i + 1] = data[i + 1] * k; bright[i + 2] = data[i + 2] * k; bright[i + 3] = 255;
    }
    // 2. blur the bright layer
    const blurred = _boxBlur(bright, w, h, radius, passes);
    // 3. tint + SCREEN back over the original: screen(a,b)=1-(1-a)(1-b)
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const base = data[i + c] / 255;
        const glow = Math.min(1, (blurred[i + c] / 255) * intensity * tint[c]);
        data[i + c] = Math.round((1 - (1 - base) * (1 - glow)) * 255);
      }
    }
    return imgData;
  }

  /** Offline render: halation over every frame of a clip → Media Bin. */
  async function renderHalation(media, opts = {}, onProgress) {
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
        halation(img, opts);
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
    await window.addBlobToBin?.(blob, `${media.name} [HALATION].${ext}`, type);
    window.logToConsole?.('ok', `[halation] bloom → Media Bin (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    return blob;
  }

  // ===========================================================================
  // 5e. REAL FILM GRAIN (#47) — plate-based, not per-pixel procedural noise.
  //     Film grain is silver-halide CLUMPS: it has spatial structure and stays
  //     consistent frame to frame (it's a physical plate). So we build a grain
  //     PLATE once (white noise blurred into clumps), and each frame overlay it
  //     shifted a little — luma-weighted so it shows in the mids and fades in the
  //     deep blacks and blown highlights, the way real grain does. Procedural
  //     white noise looks digital; this looks like film because it is a plate.
  // ===========================================================================

  // separable box blur of a scalar Float32 field → gives the noise its clumping
  function _blurScalar(src, w, h, r, passes) {
    if (r < 1) return src;
    let a = Float32Array.from(src); const tmp = new Float32Array(a.length); const win = r * 2 + 1;
    for (let p = 0; p < passes; p++) {
      for (let y = 0; y < h; y++) {
        let sum = 0; for (let x = -r; x <= r; x++) sum += a[y * w + (x < 0 ? 0 : x >= w ? w - 1 : x)];
        for (let x = 0; x < w; x++) { tmp[y * w + x] = sum / win; const xo = x - r < 0 ? 0 : x - r, xi = x + r + 1 >= w ? w - 1 : x + r + 1; sum += a[y * w + xi] - a[y * w + xo]; }
      }
      for (let x = 0; x < w; x++) {
        let sum = 0; for (let y = -r; y <= r; y++) sum += tmp[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + x];
        for (let y = 0; y < h; y++) { a[y * w + x] = sum / win; const yo = y - r < 0 ? 0 : y - r, yi = y + r + 1 >= h ? h - 1 : y + r + 1; sum += tmp[yi * w + x] - tmp[yo * w + x]; }
      }
    }
    return a;
  }

  class FilmGrain {
    constructor(w, h, opts = {}) {
      this.w = w; this.h = h;
      this.p = Object.assign({ intensity: 0.14, size: 1.5, seed: 1337 }, opts);
      // white noise, then blur by `size` so the grains CLUMP (that's what makes
      // it plate-like instead of hissy per-pixel noise).
      let s = this.p.seed >>> 0;
      const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
      const n = new Float32Array(w * h);
      for (let i = 0; i < n.length; i++) n[i] = rnd();
      const clumped = _blurScalar(n, w, h, Math.max(1, Math.round(this.p.size)), 2);
      // normalise to zero-mean, unit-ish spread so intensity is predictable
      let mean = 0; for (let i = 0; i < clumped.length; i++) mean += clumped[i]; mean /= clumped.length;
      let sd = 0; for (let i = 0; i < clumped.length; i++) sd += (clumped[i] - mean) ** 2; sd = Math.sqrt(sd / clumped.length) || 1;
      this.plate = new Float32Array(clumped.length);
      for (let i = 0; i < clumped.length; i++) this.plate[i] = (clumped[i] - mean) / sd;
    }
    /** Overlay the plate (shifted by ox,oy) onto imgData, luma-weighted. */
    apply(imgData, ox = 0, oy = 0) {
      const { data, width: w, height: h } = imgData;
      const amt = this.p.intensity * 255;
      for (let y = 0; y < h; y++) {
        const py = ((y + oy) % h + h) % h;
        for (let x = 0; x < w; x++) {
          const px = ((x + ox) % w + w) % w;
          const g = this.plate[py * w + px];
          const i = (y * w + x) * 4;
          const luma = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
          const wgt = 1 - Math.abs(luma - 0.5) * 1.3;         // grain shows in the mids
          const d = g * amt * (wgt > 0 ? wgt : 0);
          data[i] += d; data[i + 1] += d; data[i + 2] += d;
        }
      }
      return imgData;
    }
  }

  /** Grain one frame in place (builds a plate each call — for the offline render
   *  use a FilmGrain instance so the plate is shared and only shifted). */
  function filmGrain(imgData, opts = {}) {
    const g = new FilmGrain(imgData.width, imgData.height, opts);
    g.apply(imgData, opts.offX || 0, opts.offY || 0);
    return imgData;
  }

  /** Offline render: overlay a shared, shifting grain plate on every frame. */
  async function renderFilmGrain(media, opts = {}, onProgress) {
    const v = document.createElement('video'); v.src = media.blobUrl; v.muted = true; v.playsInline = true;
    await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 5000); });
    const w = Math.min(960, v.videoWidth || 640);
    const h = Math.round(w * ((v.videoHeight || 360) / (v.videoWidth || 640) / 2)) * 2;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const grain = new FilmGrain(w, h, opts);
    const stream = cv.captureStream(30);
    const mime = (window.pickRecorderMime || (() => 'video/webm'))('video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=h264', 'video/mp4');
    const chunks = [];
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 10_000_000 } : { videoBitsPerSecond: 10_000_000 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });
    rec.start(200); await v.play().catch(() => {});
    let frame = 0;
    await new Promise((res) => {
      let fin = false; const finish = () => { if (fin) return; fin = true; clearInterval(wd); res(); };
      let last = -1, stalls = 0;
      const wd = setInterval(() => { if (v.ended || v.paused) return finish(); if (v.currentTime === last) { if (++stalls >= 8) finish(); } else { last = v.currentTime; stalls = 0; } }, 100);
      const step = () => {
        if (fin) return; if (v.ended || v.paused) return finish();
        ctx.drawImage(v, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        grain.apply(img, (frame * 37) % w, (frame * 53) % h);   // shift the plate each frame
        ctx.putImageData(img, 0, 0); frame++;
        onProgress?.(v.currentTime / (v.duration || v.currentTime || 1), 0);
        v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
      };
      v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    });
    rec.stop(); await done;
    const type = (rec.mimeType || 'video/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    await window.addBlobToBin?.(blob, `${media.name} [FILM GRAIN].${ext}`, type);
    window.logToConsole?.('ok', `[grain] film grain → Media Bin (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    return blob;
  }

  // ===========================================================================
  // 5i. DEFLICKER (#50) — timelapses shot on aperture-priority flicker as the
  //     exposure hunts frame to frame. We track a SMOOTHED running mean of the
  //     frame brightness and scale each frame's gain so its mean sits on that
  //     smooth curve — the fast exposure jitter is cancelled, the slow day/night
  //     brightness change is kept.
  // ===========================================================================

  class Deflicker {
    constructor(opts = {}) {
      this.smooth = opts.smooth ?? 0.1;       // running-mean update rate (lower = smoother target)
      this.strength = opts.strength ?? 1;     // 0..1 how fully to correct
      this.running = null;
    }
    _mean(data) { let s = 0; const n = data.length / 4; for (let i = 0; i < data.length; i += 4) s += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114; return s / n; }
    /** Correct one frame toward the smoothed running mean. In place. */
    process(imgData) {
      const d = imgData.data, mean = this._mean(d);
      if (this.running == null) this.running = mean;
      else this.running = this.running * (1 - this.smooth) + mean * this.smooth;
      const gain = 1 + (this.running / (mean + 1e-6) - 1) * this.strength;
      for (let i = 0; i < d.length; i += 4) { d[i] *= gain; d[i + 1] *= gain; d[i + 2] *= gain; }
      return imgData;
    }
  }

  /** Offline render: deflicker every frame of a clip → Media Bin. */
  async function renderDeflicker(media, opts = {}, onProgress) {
    const v = document.createElement('video'); v.src = media.blobUrl; v.muted = true; v.playsInline = true;
    await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 5000); });
    const w = Math.min(1280, v.videoWidth || 640);
    const h = Math.round(w * ((v.videoHeight || 360) / (v.videoWidth || 640) / 2)) * 2;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const df = new Deflicker(opts);
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
        df.process(img);
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
    await window.addBlobToBin?.(blob, `${media.name} [DEFLICKER].${ext}`, type);
    window.logToConsole?.('ok', `[deflicker] → Media Bin (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    return blob;
  }

  // ===========================================================================
  // 5m. AUTO COLOUR-MATCH ACROSS CLIPS (#85) — make clip B look like clip A. A
  //     direct Reinhard statistical transfer: shift each channel to zero-mean,
  //     rescale by the std ratio, shift to the reference's mean, so the target's
  //     per-channel mean and spread land on the reference's. Runs frame-by-frame
  //     off a single reference frame grabbed from the other clip.
  // ===========================================================================

  function _rgbStats(imgData) {
    const d = imgData.data, n = d.length / 4;
    const sum = [0, 0, 0], sum2 = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) { sum[c] += d[i + c]; sum2[c] += d[i + c] * d[i + c]; }
    const mean = sum.map((s) => s / n);
    const std = sum2.map((s2, i) => Math.sqrt(Math.max(1e-6, s2 / n - mean[i] * mean[i])));
    return { mean, std };
  }

  /** Match `target`'s per-channel mean/std to `reference` (in place). Pass a
   *  precomputed refStats to reuse across frames. `strength` blends 0..1. */
  function matchColorStats(target, reference, opts = {}) {
    const rs = reference.mean ? reference : _rgbStats(reference);
    const ts = _rgbStats(target);
    const strength = opts.strength ?? 1;
    const gain = [0, 1, 2].map((c) => rs.std[c] / Math.max(1e-4, ts.std[c]));
    const d = target.data;
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const matched = (d[i + c] - ts.mean[c]) * gain[c] + rs.mean[c];
        d[i + c] = d[i + c] + (matched - d[i + c]) * strength;
      }
    }
    return target;
  }

  /** Offline: match `media`'s colour to a reference frame from `refMedia` → Bin. */
  async function renderColorMatch(media, refMedia, opts = {}, onProgress) {
    // grab one reference frame
    const rv = document.createElement('video'); rv.src = (refMedia || media).blobUrl; rv.muted = true; rv.playsInline = true;
    await new Promise((r) => { rv.onloadedmetadata = r; setTimeout(r, 5000); });
    try { rv.currentTime = Math.min(0.5, (rv.duration || 1) / 3); } catch (_) {}
    await new Promise((r) => { rv.onseeked = r; setTimeout(r, 1500); });
    const rw = Math.min(320, rv.videoWidth || 320), rh = Math.round(rw * ((rv.videoHeight || 180) / (rv.videoWidth || 320)));
    const rc = document.createElement('canvas'); rc.width = rw; rc.height = rh;
    const rctx = rc.getContext('2d', { willReadFrequently: true });
    rctx.drawImage(rv, 0, 0, rw, rh);
    const refStats = _rgbStats(rctx.getImageData(0, 0, rw, rh));

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
        matchColorStats(img, refStats, { strength: opts.strength ?? 1 });
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
    await window.addBlobToBin?.(blob, `${media.name} [COLOUR MATCH].${ext}`, type);
    window.logToConsole?.('ok', `[match] colour matched → Media Bin (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    return blob;
  }

  // ===========================================================================
  // 5l. CURVES (#53) — the colourist's tone curve. The speed panel already has a
  //     draggable-spline widget; this is the colour half: build a 256-entry LUT
  //     from control points (piecewise-linear through them) and map each channel
  //     through it. Master (RGB) or per-channel R/G/B for split-tone grades.
  // ===========================================================================

  /** Control points [[x,y],…] in 0..255 → a 256-entry LUT (endpoints filled). */
  function buildCurveLUT(points, size = 256) {
    const pts = points.slice().sort((a, b) => a[0] - b[0]);
    if (!pts.length) { const id = new Uint8ClampedArray(size); for (let i = 0; i < size; i++) id[i] = i; return id; }
    if (pts[0][0] > 0) pts.unshift([0, pts[0][1]]);
    if (pts[pts.length - 1][0] < size - 1) pts.push([size - 1, pts[pts.length - 1][1]]);
    const lut = new Uint8ClampedArray(size);
    let seg = 0;
    for (let x = 0; x < size; x++) {
      while (seg < pts.length - 2 && x > pts[seg + 1][0]) seg++;
      const [x0, y0] = pts[seg], [x1, y1] = pts[seg + 1];
      const t = x1 > x0 ? (x - x0) / (x1 - x0) : 0;
      lut[x] = y0 + (y1 - y0) * t;
    }
    return lut;
  }

  /** Map channels through LUTs. opts: {rgb} master, or {r,g,b} per-channel. */
  function applyCurve(imgData, opts = {}) {
    const lr = opts.r || opts.rgb, lg = opts.g || opts.rgb, lb = opts.b || opts.rgb;
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      if (lr) d[i] = lr[d[i]];
      if (lg) d[i + 1] = lg[d[i + 1]];
      if (lb) d[i + 2] = lb[d[i + 2]];
    }
    return imgData;
  }

  /** Offline render: a tone curve over every frame → Media Bin. */
  async function renderCurve(media, points, onProgress) {
    const lut = buildCurveLUT(points);
    const v = document.createElement('video'); v.src = media.blobUrl; v.muted = true; v.playsInline = true;
    await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 5000); });
    const w = Math.min(1280, v.videoWidth || 640);
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
        applyCurve(img, { rgb: lut });
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
    await window.addBlobToBin?.(blob, `${media.name} [CURVE].${ext}`, type);
    window.logToConsole?.('ok', `[curve] tone curve → Media Bin (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    return blob;
  }

  // ===========================================================================
  // 5k. HSL SECONDARY QUALIFIERS (#54) — grade just SKIN, or just SKY. Key a
  //     hue / saturation / luma range (with soft edges), build a mask from it,
  //     and apply a hue-shift / sat / luma adjustment only where the key matches.
  //     The colourist's secondary — a colour-selective grade, not a global one.
  // ===========================================================================

  function _rgb2hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h * 360, s, l];
  }
  function _hue2rgb(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
  function _hsl2rgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    if (s === 0) { const v = l * 255; return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [_hue2rgb(p, q, h + 1 / 3) * 255, _hue2rgb(p, q, h) * 255, _hue2rgb(p, q, h - 1 / 3) * 255];
  }

  /** HSL secondary qualifier + grade (in place). key: {hueCenter,hueWidth,satMin,
   *  satMax,lumMin,lumMax,softness}; adjust: {hueShift,satMul,lumAdd}. */
  function hslQualify(imgData, opts = {}) {
    const hueCenter = opts.hueCenter ?? 20, hueWidth = opts.hueWidth ?? 30, soft = opts.softness ?? 0.4;
    const satMin = opts.satMin ?? 0.1, satMax = opts.satMax ?? 1, lumMin = opts.lumMin ?? 0.1, lumMax = opts.lumMax ?? 0.95;
    const hueShift = opts.hueShift ?? 0, satMul = opts.satMul ?? 1, lumAdd = opts.lumAdd ?? 0;
    const { data } = imgData;
    const angDiff = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
    const softBand = (v, lo, hi) => { const f = (hi - lo) * soft + 1e-6; if (v < lo - f || v > hi + f) return 0; if (v < lo) return (v - (lo - f)) / f; if (v > hi) return ((hi + f) - v) / f; return 1; };
    for (let i = 0; i < data.length; i += 4) {
      const [h, s, l] = _rgb2hsl(data[i], data[i + 1], data[i + 2]);
      const hd = angDiff(h, hueCenter);
      let mask = hd <= hueWidth ? 1 : (hd >= hueWidth * (1 + soft) ? 0 : 1 - (hd - hueWidth) / (hueWidth * soft + 1e-6));
      mask *= softBand(s, satMin, satMax) * softBand(l, lumMin, lumMax);
      if (mask <= 0.0001) continue;
      const [r2, g2, b2] = _hsl2rgb(h + hueShift, Math.max(0, Math.min(1, s * satMul)), Math.max(0, Math.min(1, l + lumAdd)));
      data[i] = data[i] * (1 - mask) + r2 * mask;
      data[i + 1] = data[i + 1] * (1 - mask) + g2 * mask;
      data[i + 2] = data[i + 2] * (1 - mask) + b2 * mask;
    }
    return imgData;
  }

  /** Offline render: an HSL secondary over every frame → Media Bin. */
  async function renderHslQualify(media, opts = {}, onProgress) {
    const v = document.createElement('video'); v.src = media.blobUrl; v.muted = true; v.playsInline = true;
    await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 5000); });
    const w = Math.min(1280, v.videoWidth || 640);
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
        hslQualify(img, opts);
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
    await window.addBlobToBin?.(blob, `${media.name} [SECONDARY].${ext}`, type);
    window.logToConsole?.('ok', `[hsl] secondary grade → Media Bin (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    return blob;
  }

  // ===========================================================================
  // 5j. POWER WINDOWS / MASKS (#55) — grade PART of the frame. A shape mask
  //     (ellipse or rectangle, with a feathered edge) limits a brightness /
  //     contrast / saturation adjustment to a region, blended by the mask so the
  //     grade falls off smoothly. The colourist's vignette / spotlight tool.
  // ===========================================================================

  function powerWindow(imgData, opts = {}) {
    const { shape = 'ellipse', cx = 0.5, cy = 0.5, rx = 0.3, ry = 0.3, feather = 0.15, invert = false } = opts;
    const brightness = opts.brightness ?? 0, contrast = opts.contrast ?? 1, saturation = opts.saturation ?? 1;
    const { data, width: w, height: h } = imgData;
    const bAdd = brightness * 255;
    for (let y = 0; y < h; y++) {
      const ny = y / h;
      for (let x = 0; x < w; x++) {
        const nx = x / w;
        let d;
        if (shape === 'rect') d = Math.max(Math.abs(nx - cx) / rx, Math.abs(ny - cy) / ry);
        else d = Math.hypot((nx - cx) / rx, (ny - cy) / ry);
        let mask = d <= 1 ? 1 : (feather <= 0 || d >= 1 + feather ? 0 : 1 - (d - 1) / feather);
        if (invert) mask = 1 - mask;
        if (mask <= 0.0001) continue;
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          let v = data[i + c];
          v = (v - 128) * contrast + 128 + bAdd;              // contrast + brightness
          data[i + c] = data[i + c] * (1 - mask) + v * mask;  // blend by the window
        }
        if (saturation !== 1) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const lum = r * 0.299 + g * 0.587 + b * 0.114;
          const s = 1 + (saturation - 1) * mask;
          data[i] = lum + (r - lum) * s; data[i + 1] = lum + (g - lum) * s; data[i + 2] = lum + (b - lum) * s;
        }
      }
    }
    return imgData;
  }

  /** Offline render: a power window over every frame → Media Bin. */
  async function renderPowerWindow(media, opts = {}, onProgress) {
    const v = document.createElement('video'); v.src = media.blobUrl; v.muted = true; v.playsInline = true;
    await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 5000); });
    const w = Math.min(1280, v.videoWidth || 640);
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
        powerWindow(img, opts);
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
    await window.addBlobToBin?.(blob, `${media.name} [WINDOW].${ext}`, type);
    window.logToConsole?.('ok', `[window] power window → Media Bin (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    return blob;
  }

  // ===========================================================================
  // 5g. LENS DISTORTION + CHROMATIC ABERRATION (#49) — named-lens profiles. A
  //     radial remap bends straight lines (barrel k1<0 bows them out, pincushion
  //     k1>0 pulls them in), and sampling R/G/B at slightly different radii gives
  //     real chromatic aberration — the coloured fringing that grows toward the
  //     edges of a fast wide lens. Both are physical, radial, edge-weighted.
  // ===========================================================================

  const LENS_PROFILES = {
    'none':        { k1: 0, k2: 0, ca: 0 },
    'vintage-wide':{ k1: -0.28, k2: -0.05, ca: 0.004 },   // barrel + fringe
    'anamorphic':  { k1: -0.12, k2: 0, ca: 0.006 },
    'cctv':        { k1: -0.5, k2: -0.12, ca: 0.002 },    // heavy fishbowl
    'tele-pincushion': { k1: 0.22, k2: 0.04, ca: 0.0025 },
  };

  function _sampleBilinear(data, w, h, fx, fy, ch) {
    if (fx < 0) fx = 0; else if (fx > w - 1) fx = w - 1;
    if (fy < 0) fy = 0; else if (fy > h - 1) fy = h - 1;
    const x0 = fx | 0, y0 = fy | 0, x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
    const tx = fx - x0, ty = fy - y0;
    const i00 = (y0 * w + x0) * 4 + ch, i10 = (y0 * w + x1) * 4 + ch, i01 = (y1 * w + x0) * 4 + ch, i11 = (y1 * w + x1) * 4 + ch;
    return (data[i00] * (1 - tx) + data[i10] * tx) * (1 - ty) + (data[i01] * (1 - tx) + data[i11] * tx) * ty;
  }

  /** Lens distortion + CA over one frame (in place). k1/k2 radial, ca fringe. */
  function lensDistort(imgData, opts = {}) {
    const prof = typeof opts.profile === 'string' ? (LENS_PROFILES[opts.profile] || LENS_PROFILES.none) : {};
    const k1 = opts.k1 ?? prof.k1 ?? -0.25, k2 = opts.k2 ?? prof.k2 ?? 0, ca = opts.ca ?? prof.ca ?? 0.003;
    const { data, width: w, height: h } = imgData;
    const src = new Uint8ClampedArray(data);                 // read from a copy
    const cx = (w - 1) / 2, cy = (h - 1) / 2, maxR = Math.hypot(cx, cy);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x - cx) / maxR, dy = (y - cy) / maxR;    // normalised offset
        const r2 = dx * dx + dy * dy;
        const f = 1 + k1 * r2 + k2 * r2 * r2;                // radial distortion
        const i = (y * w + x) * 4;
        // per-channel radius for chromatic aberration (edge-weighted by r2)
        const fR = f * (1 + ca * r2 * 40), fB = f * (1 - ca * r2 * 40);
        data[i]     = _sampleBilinear(src, w, h, cx + dx * maxR * fR, cy + dy * maxR * fR, 0);
        data[i + 1] = _sampleBilinear(src, w, h, cx + dx * maxR * f,  cy + dy * maxR * f,  1);
        data[i + 2] = _sampleBilinear(src, w, h, cx + dx * maxR * fB, cy + dy * maxR * fB, 2);
        data[i + 3] = 255;
      }
    }
    return imgData;
  }

  /** Offline render: lens profile over every frame → Media Bin. */
  async function renderLens(media, opts = {}, onProgress) {
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
        lensDistort(img, opts);
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
    await window.addBlobToBin?.(blob, `${media.name} [LENS].${ext}`, type);
    window.logToConsole?.('ok', `[lens] distortion → Media Bin (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    return blob;
  }

  // ===========================================================================
  // 5h. ROLLING SHUTTER / JELLO (#46) — sim AND correct. A CMOS sensor reads one
  //     row at a time, so during fast horizontal motion each row is captured a
  //     hair later than the one above → the frame SKEWS (a vertical edge leans),
  //     and vibration makes it WOBBLE (the jello). We model it as a per-row
  //     horizontal shift: a linear shear (the skew) plus an optional sinusoid
  //     (the wobble). Correcting is the same model with the opposite shear.
  // ===========================================================================

  /** Per-row horizontal shift: shear·(y−mid) + wobble·sin. In place. */
  function rollingShutter(imgData, opts = {}) {
    const shear = opts.shear ?? 0.25, wobble = opts.wobble ?? 0, wobbleFreq = opts.wobbleFreq ?? 2;
    const { data, width: w, height: h } = imgData;
    const src = new Uint8ClampedArray(data);
    const mid = (h - 1) / 2;
    for (let y = 0; y < h; y++) {
      const off = Math.round(shear * (y - mid) + wobble * Math.sin(2 * Math.PI * wobbleFreq * y / h) * w * 0.05);
      for (let x = 0; x < w; x++) {
        let sx = x - off; if (sx < 0) sx = 0; else if (sx > w - 1) sx = w - 1;
        const di = (y * w + x) * 4, si = (y * w + sx) * 4;
        data[di] = src[si]; data[di + 1] = src[si + 1]; data[di + 2] = src[si + 2]; data[di + 3] = 255;
      }
    }
    return imgData;
  }

  /** Offline render: rolling-shutter sim or correction over a clip → Media Bin. */
  async function renderRollingShutter(media, opts = {}, onProgress) {
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
    let frame = 0;
    await new Promise((res) => {
      let fin = false; const finish = () => { if (fin) return; fin = true; clearInterval(wd); res(); };
      let last = -1, stalls = 0;
      const wd = setInterval(() => { if (v.ended || v.paused) return finish(); if (v.currentTime === last) { if (++stalls >= 8) finish(); } else { last = v.currentTime; stalls = 0; } }, 100);
      const step = () => {
        if (fin) return; if (v.ended || v.paused) return finish();
        ctx.drawImage(v, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        // animate the wobble phase per frame so the jello lives
        rollingShutter(img, { ...opts, wobbleFreq: (opts.wobbleFreq ?? 2) + Math.sin(frame * 0.3) * 0.5 });
        ctx.putImageData(img, 0, 0); frame++;
        onProgress?.(v.currentTime / (v.duration || v.currentTime || 1), 0);
        v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
      };
      v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    });
    rec.stop(); await done;
    const type = (rec.mimeType || 'video/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    await window.addBlobToBin?.(blob, `${media.name} [JELLO].${ext}`, type);
    window.logToConsole?.('ok', `[jello] rolling shutter → Media Bin (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    return blob;
  }

  // ===========================================================================
  // 5f. MOTION BLUR ON SPEED-UP (#43) — a 4× timelapse that DROPS frames strobes;
  //     a 4× timelapse that BLENDS the frames it would have dropped smears the
  //     motion smoothly, the way a long exposure does. frameBlend averages a
  //     group of frames into one; renderSpeedBlur plays the source fast and, for
  //     each output frame, blends the frames that fell in that step.
  // ===========================================================================

  /** Average an array of same-size ImageData into one (the long-exposure blend). */
  function frameBlend(frames) {
    const w = frames[0].width, h = frames[0].height, len = w * h * 4;
    const acc = new Float32Array(len);
    for (const f of frames) for (let i = 0; i < len; i++) acc[i] += f.data[i];
    const out = new Uint8ClampedArray(len);
    const n = frames.length;
    for (let i = 0; i < len; i++) out[i] = i % 4 === 3 ? 255 : acc[i] / n;
    return new ImageData(out, w, h);
  }

  /** Offline: speed a clip up by `factor`, blending the skipped frames as motion
   *  blur (a rolling buffer of the last `factor` decoded frames per output). */
  async function renderSpeedBlur(media, opts = {}, onProgress) {
    const factor = Math.max(2, Math.round(opts.factor || 4));
    const v = document.createElement('video'); v.src = media.blobUrl; v.muted = true; v.playsInline = true;
    await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 5000); });
    const w = Math.min(960, v.videoWidth || 640);
    const h = Math.round(w * ((v.videoHeight || 360) / (v.videoWidth || 640) / 2)) * 2;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const grab = document.createElement('canvas'); grab.width = w; grab.height = h;
    const gctx = grab.getContext('2d', { willReadFrequently: true });
    const stream = cv.captureStream(30);
    const mime = (window.pickRecorderMime || (() => 'video/webm'))('video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=h264', 'video/mp4');
    const chunks = [];
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 10_000_000 } : { videoBitsPerSecond: 10_000_000 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });
    v.playbackRate = Math.min(4, factor);
    rec.start(200); await v.play().catch(() => {});
    let buf = [], n = 0;
    await new Promise((res) => {
      let fin = false; const finish = () => { if (fin) return; fin = true; clearInterval(wd); res(); };
      let last = -1, stalls = 0;
      const wd = setInterval(() => { if (v.ended || v.paused) return finish(); if (v.currentTime === last) { if (++stalls >= 8) finish(); } else { last = v.currentTime; stalls = 0; } }, 100);
      const step = () => {
        if (fin) return; if (v.ended || v.paused) return finish();
        gctx.drawImage(v, 0, 0, w, h);
        buf.push(gctx.getImageData(0, 0, w, h));
        if (buf.length >= factor) { ctx.putImageData(frameBlend(buf), 0, 0); buf = []; }
        n++;
        onProgress?.(v.currentTime / (v.duration || v.currentTime || 1), 0);
        v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
      };
      v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    });
    rec.stop(); await done;
    const type = (rec.mimeType || 'video/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    await window.addBlobToBin?.(blob, `${media.name} [${factor}x BLUR].${ext}`, type);
    window.logToConsole?.('ok', `[speedblur] ${factor}× with motion blur → Media Bin (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
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
    Rotation, injectRotation, patchVertex,
    ChaosEngine, CHAOS_DEFAULTS, GLITCH,
    EFFECT_DEFAULTS, applyEffectDefaults,
    pixelSort, pixelSortMasked, sortBands, renderPixelSort,
    FeedbackTunnel, renderFeedback, halation, renderHalation,
    FilmGrain, filmGrain, renderFilmGrain, frameBlend, renderSpeedBlur,
    lensDistort, renderLens, LENS_PROFILES,
    rollingShutter, renderRollingShutter,
    Deflicker, renderDeflicker, powerWindow, renderPowerWindow,
    hslQualify, renderHslQualify, buildCurveLUT, applyCurve, renderCurve,
    matchColorStats, renderColorMatch, Sparkles,
  };
})();
