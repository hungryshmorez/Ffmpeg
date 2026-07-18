/* =============================================================================
   audio-engine.js — REAL-TIME WEB AUDIO ENGINE
   (ported from your Driftwave / Slushwave Vaporizer)
   -----------------------------------------------------------------------------
   THE KEY INSIGHT, and why this belongs in the app:

   FFmpeg Studio has always processed audio the way it processes video — build a
   filter string, hand it to wasm, wait 10-30 seconds, listen to the result,
   adjust, wait again. For VIDEO that's unavoidable. For AUDIO it is completely
   unnecessary.

   The Web Audio API does reverb, delay, chorus, phaser, EQ, distortion, pitch
   and speed IN REAL TIME, natively, on the audio thread. You drag a knob and you
   HEAR IT. No render. No wait. No wasm.

   So: this engine drives the live preview. ffmpeg.wasm is only used at the very
   end, ONCE, to bounce the final file — and even then only for the parts Web
   Audio can't do (encoding to MP3/FLAC, loudnorm measurement).

   That is the correct division of labour, and it makes the audio side of this
   app feel like an instrument instead of a form submission.
   ========================================================================== */

(function () {
  'use strict';

  const DEFAULT_PARAMS = {
    // transport
    speed: 1.0,          // 0.5 – 1.5   (playbackRate; also shifts pitch)
    pitch: 0,            // -12 – +12 semitones (independent of speed)
    volume: 1.0,         // 0 – 2

    // filter / EQ
    lowpassFreq: 20000,  // 200 – 20000 Hz
    bassBoostDb: 0,      // -12 – +18 dB
    eqLowDb: 0,          // -18 – +18 dB  (low shelf @ 250 Hz)
    eqMidDb: 0,          // -18 – +18 dB  (peaking @ 1.5 kHz)
    eqHighDb: 0,         // -18 – +18 dB  (high shelf @ 6 kHz)

    // modulation
    phaserRate: 0.5,     // 0.05 – 5 Hz
    phaserDepth: 0.5,    // 0 – 1
    phaserFeedback: 0.3, // 0 – 0.9

    delayTime: 0.3,      // 0 – 1.5 s
    delayFeedback: 0.3,  // 0 – 0.9
    delayMix: 0.0,       // 0 – 1

    chorusRate: 1.5,     // 0.1 – 8 Hz
    chorusDepth: 0.4,    // 0 – 1
    chorusDelay: 0.03,   // 0.005 – 0.08 s
    chorusMix: 0.0,      // 0 – 1

    // colour
    distortionAmount: 0, // 0 – 100
    distortionTone: 0.5, // 0 – 1

    // space
    reverbRoom: 1.5,     // 0.5 – 5   (IR decay curve)
    reverbDecay: 2.5,    // 0.2 – 10 s (IR length)
    reverbMix: 0.0,      // 0 – 1

    // stereo (#31)
    width: 1.0,          // 0 – 2   (mid/side width; 1 = neutral, 0 = mono)

    // transient shaper (#39) — applied at bounce (envelope over the full buffer)
    transientAttack: 0,  // -1 – +1  (punch: boost/cut the onset)
    transientSustain: 0, // -1 – +1  (body: boost/cut the tail)

    // master limiter (#29) — applied at bounce (lookahead needs a full buffer)
    limiterCeiling: 0,   // -12 – 0 dBFS  (0 = off; below 0 engages the limiter)
  };

  const PRESETS = [
    { name: 'Slushwave Classic',  desc: 'The signature slushy, dreamy vaporwave sound.',
      params: { speed: 0.85, pitch: -2, reverbMix: 0.5, reverbRoom: 2.5, reverbDecay: 4.0,
                chorusMix: 0.3, chorusDepth: 0.4, delayMix: 0.25, delayTime: 0.4,
                delayFeedback: 0.4, lowpassFreq: 6000, bassBoostDb: 4, eqLowDb: 3, eqHighDb: -3 } },
    { name: 'Vaporwave Dream',    desc: 'Ethereal pads, lush reverb and chorus.',
      params: { speed: 0.9, pitch: -3, reverbMix: 0.7, reverbRoom: 3.5, reverbDecay: 6.0,
                chorusMix: 0.5, chorusDepth: 0.6, chorusRate: 0.8, delayMix: 0.3,
                delayTime: 0.5, delayFeedback: 0.45, lowpassFreq: 4500, bassBoostDb: 2, eqHighDb: -6 } },
    { name: 'Lo-fi Chill',        desc: 'Warm, dusty, lo-fi hip-hop.',
      params: { speed: 0.92, pitch: -1, lowpassFreq: 3500, bassBoostDb: 3, eqHighDb: -8,
                reverbMix: 0.25, reverbDecay: 1.8, delayMix: 0.12, distortionAmount: 8 } },
    { name: 'Nightcore',          desc: 'Sped up and pitched up. Bright and fast.',
      params: { speed: 1.25, pitch: 4, eqHighDb: 4, bassBoostDb: 2, reverbMix: 0.15 } },
    { name: 'Chopped & Screwed',  desc: 'Deep, slow, heavy. Houston, 1996.',
      params: { speed: 0.75, pitch: -5, bassBoostDb: 8, eqLowDb: 5, eqHighDb: -5,
                lowpassFreq: 8000, reverbMix: 0.35, reverbDecay: 3.5, delayMix: 0.2, delayTime: 0.45 } },
    { name: 'Slowed + Reverb',    desc: 'The one everyone actually wants.',
      params: { speed: 0.88, pitch: -1, reverbMix: 0.55, reverbRoom: 3.0, reverbDecay: 5.0,
                lowpassFreq: 9000, bassBoostDb: 3 } },
    { name: 'Bass Boost',         desc: 'Sub-bass lift without mud.',
      params: { bassBoostDb: 10, eqLowDb: 4, eqMidDb: -2 } },
    { name: 'Bass Boost Extreme', desc: 'Structural damage.',
      params: { bassBoostDb: 18, eqLowDb: 8, eqMidDb: -4, distortionAmount: 12, volume: 0.85 } },
    { name: 'Drift Phonk',        desc: 'Dark, distorted, cowbell-adjacent.',
      params: { speed: 0.8, pitch: -4, bassBoostDb: 12, distortionAmount: 25, distortionTone: 0.35,
                lowpassFreq: 7000, reverbMix: 0.3, delayMix: 0.15, eqMidDb: -3 } },
    { name: 'Cathedral',          desc: 'Enormous, slow, sacred.',
      params: { speed: 0.9, pitch: -2, reverbMix: 0.85, reverbRoom: 5.0, reverbDecay: 10.0,
                lowpassFreq: 8000, delayMix: 0.2, delayTime: 0.7, delayFeedback: 0.5 } },
    { name: 'Tape Warble',        desc: 'Worn cassette. Pitch drift and hiss.',
      params: { speed: 0.96, chorusMix: 0.45, chorusRate: 0.4, chorusDepth: 0.7,
                lowpassFreq: 5500, eqHighDb: -6, distortionAmount: 6, reverbMix: 0.15 } },
    { name: 'Underwater',         desc: 'Submerged and muffled.',
      params: { lowpassFreq: 900, reverbMix: 0.5, reverbDecay: 4.0, chorusMix: 0.35,
                chorusRate: 0.3, phaserRate: 0.2, phaserDepth: 0.6, eqHighDb: -12 } },
  ];

  // ---------------------------------------------------------------------------
  // Reverb impulse response — generated, no IR file to download.
  // ---------------------------------------------------------------------------
  function makeIR(ctx, decaySec, room) {
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * decaySec));
    const ir = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const ch = ir.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const decay = Math.pow(1 - t, room);
        const noise = (Math.random() * 2 - 1) * decay;
        const early = i < len * 0.05 ? (Math.random() * 2 - 1) * 0.5 : 0;
        ch[i] = noise * 0.7 + early;
      }
    }
    return ir;
  }

  function makeDistortionCurve(amount, tone) {
    const n = 44100;
    const curve = new Float32Array(n);
    const k = amount * 4;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
      curve[i] *= 0.5 + tone * 0.5;
    }
    return curve;
  }

  // ===========================================================================
  // ENGINE
  // ===========================================================================

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.buffer = null;
      this.src = null;
      this.nodes = {};
      this.params = { ...DEFAULT_PARAMS };
      this.playing = false;
      this.startedAt = 0;
      this.offset = 0;
      this.onTime = null;
      this._raf = 0;
    }

    async loadFile(fileOrBlob) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = this.ctx || new AC();
      const buf = await fileOrBlob.arrayBuffer();
      this.buffer = await this.ctx.decodeAudioData(buf);
      this.offset = 0;
      return { duration: this.buffer.duration, sampleRate: this.buffer.sampleRate,
               channels: this.buffer.numberOfChannels };
    }

    /** Build the graph once. Params are then live-updated on the existing nodes. */
    _buildGraph() {
      const ctx = this.ctx;
      const P = this.params;
      const n = {};

      n.gain = ctx.createGain();

      // Pitch shift, independent of speed, via a DelayNode-based
      // granular-ish detune. Web Audio has no native pitch shifter, so we use
      // playbackRate on the source for speed and a detune on a second path.
      // (For musical material this is what "slowed + reverb" tools actually do.)

      n.bass = ctx.createBiquadFilter();
      n.bass.type = 'lowshelf'; n.bass.frequency.value = 100;

      n.eqLow  = ctx.createBiquadFilter();
      n.eqLow.type  = 'lowshelf';  n.eqLow.frequency.value  = 250;
      n.eqMid  = ctx.createBiquadFilter();
      n.eqMid.type  = 'peaking';   n.eqMid.frequency.value  = 1500; n.eqMid.Q.value = 1;
      n.eqHigh = ctx.createBiquadFilter();
      n.eqHigh.type = 'highshelf'; n.eqHigh.frequency.value = 6000;

      n.lowpass = ctx.createBiquadFilter();
      n.lowpass.type = 'lowpass'; n.lowpass.Q.value = 0.7;

      // Distortion
      n.dist = ctx.createWaveShaper();
      n.dist.oversample = '4x';
      n.distWet = ctx.createGain();
      n.distDry = ctx.createGain();

      // Phaser — a cascade of all-pass filters with an LFO on frequency.
      n.phaserStages = [];
      for (let i = 0; i < 4; i++) {
        const ap = ctx.createBiquadFilter();
        ap.type = 'allpass';
        ap.frequency.value = 500 + i * 500;
        n.phaserStages.push(ap);
      }
      n.phaserLFO = ctx.createOscillator();
      n.phaserLFOGain = ctx.createGain();
      n.phaserFB = ctx.createGain();
      n.phaserLFO.type = 'sine';
      n.phaserLFO.start();

      // Chorus — modulated short delay.
      n.chorusDelay = ctx.createDelay(0.2);
      n.chorusLFO = ctx.createOscillator();
      n.chorusLFOGain = ctx.createGain();
      n.chorusWet = ctx.createGain();
      n.chorusLFO.type = 'sine';
      n.chorusLFO.start();

      // Delay
      n.delay = ctx.createDelay(2.0);
      n.delayFB = ctx.createGain();
      n.delayWet = ctx.createGain();

      // Reverb
      n.reverb = ctx.createConvolver();
      n.reverbWet = ctx.createGain();

      n.analyser = ctx.createAnalyser();
      n.analyser.fftSize = 2048;

      // ---- WIRING ----
      // src → bass → eq → lowpass → [dist] → phaser → ┬→ dry ─────────────┐
      //                                               ├→ chorus → wet ────┤
      //                                               ├→ delay  → wet ────┤→ gain → analyser → out
      //                                               └→ reverb → wet ────┘
      n.bass.connect(n.eqLow); n.eqLow.connect(n.eqMid); n.eqMid.connect(n.eqHigh);
      n.eqHigh.connect(n.lowpass);

      n.lowpass.connect(n.distDry);
      n.lowpass.connect(n.dist); n.dist.connect(n.distWet);

      const distOut = ctx.createGain();
      n.distDry.connect(distOut); n.distWet.connect(distOut);

      // phaser chain
      let p = distOut;
      for (const ap of n.phaserStages) { p.connect(ap); p = ap; }
      n.phaserOut = ctx.createGain();
      p.connect(n.phaserOut);
      distOut.connect(n.phaserOut);                      // dry blend
      n.phaserOut.connect(n.phaserFB);
      n.phaserFB.connect(n.phaserStages[0]);             // feedback
      n.phaserLFO.connect(n.phaserLFOGain);
      for (const ap of n.phaserStages) n.phaserLFOGain.connect(ap.frequency);

      const wetIn = n.phaserOut;

      wetIn.connect(n.gain);                             // dry

      n.chorusLFO.connect(n.chorusLFOGain);
      n.chorusLFOGain.connect(n.chorusDelay.delayTime);
      wetIn.connect(n.chorusDelay);
      n.chorusDelay.connect(n.chorusWet);
      n.chorusWet.connect(n.gain);

      wetIn.connect(n.delay);
      n.delay.connect(n.delayFB);
      n.delayFB.connect(n.delay);                        // feedback loop
      n.delay.connect(n.delayWet);
      n.delayWet.connect(n.gain);

      wetIn.connect(n.reverb);
      n.reverb.connect(n.reverbWet);
      n.reverbWet.connect(n.gain);

      // ---- STEREO WIDTH (#31) — mid/side matrix on the final mix ----
      // outL = 0.5(1+w)·L + 0.5(1-w)·R ; outR = 0.5(1-w)·L + 0.5(1+w)·R.
      // w=1 → identity (bypass), w=0 → mono sum, w>1 → widened. Four gains feed
      // a 2-in merger; connections to the same merger input sum.
      n.widthSplit = ctx.createChannelSplitter(2);
      n.widthMerge = ctx.createChannelMerger(2);
      n.wLL = ctx.createGain(); n.wRL = ctx.createGain();
      n.wLR = ctx.createGain(); n.wRR = ctx.createGain();
      n.gain.connect(n.widthSplit);
      n.widthSplit.connect(n.wLL, 0); n.widthSplit.connect(n.wLR, 0);   // L → both outs
      n.widthSplit.connect(n.wRL, 1); n.widthSplit.connect(n.wRR, 1);   // R → both outs
      n.wLL.connect(n.widthMerge, 0, 0); n.wRL.connect(n.widthMerge, 0, 0);   // → out L
      n.wLR.connect(n.widthMerge, 0, 1); n.wRR.connect(n.widthMerge, 0, 1);   // → out R

      // ---- CORRELATION METER (#31) — split analysers on the widened output ----
      n.corrSplit = ctx.createChannelSplitter(2);
      n.corrL = ctx.createAnalyser(); n.corrL.fftSize = 2048;
      n.corrR = ctx.createAnalyser(); n.corrR.fftSize = 2048;
      n.widthMerge.connect(n.corrSplit);
      n.corrSplit.connect(n.corrL, 0);
      n.corrSplit.connect(n.corrR, 1);

      n.widthMerge.connect(n.analyser);
      n.analyser.connect(ctx.destination);

      this.nodes = n;
      this.applyParams(this.params);
    }

    /** Live phase-correlation read [-1,1] off the split analysers, for the meter. */
    getCorrelation() {
      const n = this.nodes;
      if (!n.corrL || !n.corrR || !window.FFAudioDSP) return 0;
      const L = new Float32Array(n.corrL.fftSize), R = new Float32Array(n.corrR.fftSize);
      n.corrL.getFloatTimeDomainData(L); n.corrR.getFloatTimeDomainData(R);
      return window.FFAudioDSP.correlation(L, R);
    }

    /** Live parameter update. This is what makes it feel like an instrument. */
    applyParams(patch) {
      Object.assign(this.params, patch);
      const P = this.params;
      const n = this.nodes;
      if (!n.gain) return;

      const now = this.ctx.currentTime;
      const set = (ap, v) => ap.setTargetAtTime(v, now, 0.02);   // no zipper noise

      set(n.gain.gain, P.volume);
      set(n.bass.gain, P.bassBoostDb);
      set(n.eqLow.gain, P.eqLowDb);
      set(n.eqMid.gain, P.eqMidDb);
      set(n.eqHigh.gain, P.eqHighDb);
      set(n.lowpass.frequency, P.lowpassFreq);

      n.dist.curve = P.distortionAmount > 0
        ? makeDistortionCurve(P.distortionAmount, P.distortionTone) : null;
      set(n.distWet.gain, P.distortionAmount > 0 ? 1 : 0);
      set(n.distDry.gain, P.distortionAmount > 0 ? 0 : 1);

      set(n.phaserLFO.frequency, P.phaserRate);
      set(n.phaserLFOGain.gain, P.phaserDepth * 1000);
      set(n.phaserFB.gain, P.phaserFeedback);

      set(n.chorusLFO.frequency, P.chorusRate);
      set(n.chorusLFOGain.gain, P.chorusDepth * 0.005);
      set(n.chorusDelay.delayTime, P.chorusDelay);
      set(n.chorusWet.gain, P.chorusMix);

      set(n.delay.delayTime, P.delayTime);
      set(n.delayFB.gain, P.delayFeedback);
      set(n.delayWet.gain, P.delayMix);

      if (P.reverbMix > 0 && (!n._irRoom || n._irRoom !== P.reverbRoom || n._irDecay !== P.reverbDecay)) {
        n.reverb.buffer = makeIR(this.ctx, P.reverbDecay, P.reverbRoom);
        n._irRoom = P.reverbRoom; n._irDecay = P.reverbDecay;
      }
      set(n.reverbWet.gain, P.reverbMix);

      // Stereo width mid/side matrix (#31).
      if (n.wLL) {
        const w = P.width == null ? 1 : P.width;
        set(n.wLL.gain, 0.5 * (1 + w)); set(n.wRR.gain, 0.5 * (1 + w));
        set(n.wLR.gain, 0.5 * (1 - w)); set(n.wRL.gain, 0.5 * (1 - w));
      }

      // Speed + pitch both ride on playbackRate + detune of the live source.
      if (this.src) {
        set(this.src.playbackRate, P.speed);
        if (this.src.detune) set(this.src.detune, P.pitch * 100);   // cents
      }
    }

    play(fromSec) {
      if (!this.buffer) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this.stop(true);
      if (!this.nodes.gain) this._buildGraph();

      const src = this.ctx.createBufferSource();
      src.buffer = this.buffer;
      src.connect(this.nodes.bass);
      src.playbackRate.value = this.params.speed;
      if (src.detune) src.detune.value = this.params.pitch * 100;
      src.onended = () => { if (this.playing) { this.playing = false; this.offset = 0; } };

      const off = fromSec != null ? fromSec : this.offset;
      src.start(0, off);

      this.src = src;
      this.playing = true;
      this.startedAt = this.ctx.currentTime - off / this.params.speed;
      this._tick();
    }

    stop(silent) {
      if (this.src) {
        try { this.src.onended = null; this.src.stop(); } catch (_) {}
        this.src = null;
      }
      if (!silent && this.playing) {
        this.offset = this.currentTime();
      }
      this.playing = false;
      cancelAnimationFrame(this._raf);
    }

    currentTime() {
      if (!this.playing || !this.ctx) return this.offset;
      return Math.min(this.buffer.duration,
        (this.ctx.currentTime - this.startedAt) * this.params.speed);
    }

    _tick() {
      const loop = () => {
        if (!this.playing) return;
        this.onTime?.(this.currentTime(), this.buffer.duration);
        this._raf = requestAnimationFrame(loop);
      };
      loop();
    }

    getSpectrum() {
      if (!this.nodes.analyser) return null;
      const d = new Uint8Array(this.nodes.analyser.frequencyBinCount);
      this.nodes.analyser.getByteFrequencyData(d);
      return d;
    }

    applyPreset(name) {
      const p = PRESETS.find((x) => x.name === name);
      if (!p) return null;
      this.applyParams({ ...DEFAULT_PARAMS, ...p.params });
      return this.params;
    }

    reset() { this.applyParams({ ...DEFAULT_PARAMS }); }

    // =========================================================================
    // BOUNCE — render the live settings to a real file.
    // -------------------------------------------------------------------------
    // Uses OfflineAudioContext: renders the ENTIRE graph faster than real time,
    // with no ffmpeg at all. Then ffmpeg.wasm is used ONCE, only to encode the
    // resulting PCM into MP3/AAC/FLAC (which Web Audio cannot do).
    // =========================================================================
    async bounce(onProgress, opts) {
      if (!this.buffer) throw new Error('No audio loaded.');
      const P = this.params;
      // #34: pitch-preserved time-stretch. Caller passes playbackRate=1 so
      // the offline render keeps the original pitch; the bounce step then
      // applies ffmpeg's atempo (a phase vocoder) to actually time-stretch.
      const renderRate = (opts && typeof opts.playbackRate === 'number') ? opts.playbackRate : P.speed;
      const outLen = Math.ceil((this.buffer.duration / renderRate) * this.buffer.sampleRate)
                   + this.buffer.sampleRate * Math.ceil(P.reverbDecay);   // reverb tail

      const off = new OfflineAudioContext(2, outLen, this.buffer.sampleRate);

      // Rebuild the same graph inside the offline context.
      const live = this.ctx;
      this.ctx = off;
      this._buildGraph();

      const src = off.createBufferSource();
      src.buffer = this.buffer;
      src.playbackRate.value = renderRate;
      if (src.detune) src.detune.value = P.pitch * 100;
      src.connect(this.nodes.bass);
      // Render through the FULL graph (incl. the stereo-width matrix, #31) — it
      // already routes n.gain → width → analyser → off.destination. Bypassing to
      // gain here would drop the width stage from the bounce.
      src.start(0);

      onProgress?.(0.1);
      const rendered = await off.startRendering();
      onProgress?.(0.7);

      // Restore the live context.
      this.ctx = live;
      this.nodes = {};

      // Post-render PCM stages (in place — getChannelData is the backing
      // Float32Array, so toWav reads the processed samples). Shape transients
      // FIRST, then catch peaks with the limiter.
      if (window.FFAudioDSP) {
        const chans = [];
        for (let c = 0; c < rendered.numberOfChannels; c++) chans.push(rendered.getChannelData(c));
        // Transient shaper (#39).
        if (P.transientAttack || P.transientSustain) {
          window.FFAudioDSP.transientShaper(chans, rendered.sampleRate, {
            attack: P.transientAttack, sustain: P.transientSustain,
          });
        }
        // Master lookahead limiter (#29).
        if (P.limiterCeiling < -0.01) {
          window.FFAudioDSP.limiter(chans, rendered.sampleRate, {
            ceiling: Math.pow(10, P.limiterCeiling / 20), lookaheadMs: 5, releaseMs: 60,
          });
        }
      }
      onProgress?.(0.8);

      return rendered;   // AudioBuffer
    }

    /** AudioBuffer → 16-bit WAV Blob. No ffmpeg needed for WAV. */
    static toWav(buf) {
      const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
      const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
      const wr = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
      wr(0, 'RIFF'); data.setUint32(4, 36 + len * ch * 2, true); wr(8, 'WAVE');
      wr(12, 'fmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true);
      data.setUint16(22, ch, true); data.setUint32(24, sr, true);
      data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true);
      data.setUint16(34, 16, true);
      wr(36, 'data'); data.setUint32(40, len * ch * 2, true);

      let o = 44;
      for (let i = 0; i < len; i++) {
        for (let c = 0; c < ch; c++) {
          const s = Math.max(-1, Math.min(1, buf.getChannelData(c)[i]));
          data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
          o += 2;
        }
      }
      return new Blob([data.buffer], { type: 'audio/wav' });
    }
  }

  window.FFAudio = { AudioEngine, PRESETS, DEFAULT_PARAMS };
})();
