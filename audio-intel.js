/* =============================================================================
   audio-intel.js — MUSICAL INTELLIGENCE + SEMANTIC MACROS
   (from your Aesthetic Audio)
   -----------------------------------------------------------------------------
   Two ideas worth stealing wholesale.

   1. THE APP SHOULD KNOW WHAT THE MUSIC IS.
      Key and tempo, detected from the audio itself. Once you know the key you
      can pitch-shift in MUSICAL intervals ("down a fifth") instead of arbitrary
      semitones, and warn when a speed change lands you on a dissonant pitch.

   2. SEMANTIC KNOBS BEAT TECHNICAL ONES.
      Nobody thinks "I want a 6 kHz low-pass at Q 0.7 with 40% wet convolution."
      They think "make it MELT." So: five macro knobs — MELT, MUFFLE, WASH,
      SLUSH, VINTAGE — each of which moves a whole coordinated set of the
      underlying parameters along a curve that always sounds good.

      The 23 real knobs are still there. But you should be able to make something
      beautiful in five seconds without knowing what a convolver is.
   ========================================================================== */

(function () {
  'use strict';

  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  // Krumhansl-Schmuckler key profiles — the standard weights for how much each
  // pitch class "belongs" to a major or minor key.
  const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  // ===========================================================================
  // KEY DETECTION — chromagram + Krumhansl-Schmuckler correlation
  // ===========================================================================

  function chromagram(buffer) {
    const sr = buffer.sampleRate;
    const data = buffer.getChannelData(0);
    const chroma = new Float64Array(12);

    const FFT = 4096;
    const hop = FFT * 2;
    const win = new Float64Array(FFT);
    for (let i = 0; i < FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT - 1)); // Hann

    // Sample across the whole track, not just the top — intros lie.
    const frames = Math.min(200, Math.floor((data.length - FFT) / hop));
    if (frames < 1) return chroma;

    for (let f = 0; f < frames; f++) {
      const off = Math.floor((f / frames) * (data.length - FFT));

      // Goertzel per semitone bin — far cheaper than a full FFT when you only
      // want 12 × 6 octaves of specific frequencies.
      for (let midi = 24; midi < 96; midi++) {                 // C1..B6
        const freq = 440 * Math.pow(2, (midi - 69) / 12);
        if (freq > sr / 2) continue;

        const k = (2 * Math.PI * freq) / sr;
        const cosK = Math.cos(k), coeff = 2 * cosK;
        let s0 = 0, s1 = 0, s2 = 0;

        for (let i = 0; i < FFT; i += 2) {                     // stride 2 = 2× faster
          s0 = win[i] * data[off + i] + coeff * s1 - s2;
          s2 = s1; s1 = s0;
        }
        const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
        chroma[midi % 12] += Math.sqrt(Math.max(0, power));
      }
    }

    const max = Math.max(...chroma) || 1;
    for (let i = 0; i < 12; i++) chroma[i] /= max;
    return chroma;
  }

  function correlate(chroma, profile, rotation) {
    let num = 0, dc = 0, dp = 0;
    const mc = chroma.reduce((a, b) => a + b, 0) / 12;
    const mp = profile.reduce((a, b) => a + b, 0) / 12;
    for (let i = 0; i < 12; i++) {
      const c = chroma[(i + rotation) % 12] - mc;
      const p = profile[i] - mp;
      num += c * p; dc += c * c; dp += p * p;
    }
    return num / (Math.sqrt(dc * dp) || 1);
  }

  function detectKey(buffer) {
    const chroma = chromagram(buffer);
    let best = { score: -2, key: 'C', mode: 'major' };

    for (let r = 0; r < 12; r++) {
      const maj = correlate(chroma, MAJOR, r);
      const min = correlate(chroma, MINOR, r);
      if (maj > best.score) best = { score: maj, key: NOTES[r], mode: 'major' };
      if (min > best.score) best = { score: min, key: NOTES[r], mode: 'minor' };
    }

    return {
      key: best.key,
      mode: best.mode,
      label: `${best.key} ${best.mode}`,
      confidence: Math.max(0, Math.min(1, (best.score + 1) / 2)),
      chroma: Array.from(chroma),
    };
  }

  // ===========================================================================
  // TEMPO — spectral-flux onset detection + autocorrelation of the envelope
  // ===========================================================================

  function detectTempo(buffer) {
    const sr = buffer.sampleRate;
    const data = buffer.getChannelData(0);

    // 1. Energy envelope at ~86 Hz
    const win = Math.floor(sr / 86);
    const n = Math.floor(data.length / win);
    const env = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let e = 0;
      for (let j = 0; j < win; j++) { const s = data[i * win + j]; e += s * s; }
      env[i] = Math.sqrt(e / win);
    }

    // 2. Spectral flux — positive change only. An onset is a RISE in energy.
    const flux = new Float64Array(n);
    for (let i = 1; i < n; i++) flux[i] = Math.max(0, env[i] - env[i - 1]);

    // 3. Autocorrelate the flux over plausible BPM lags.
    const envRate = sr / win;
    let bestBpm = 120, bestScore = -1;
    for (let bpm = 60; bpm <= 190; bpm++) {
      const lag = Math.round((60 / bpm) * envRate);
      if (lag < 2 || lag >= n) continue;
      let score = 0;
      for (let i = lag; i < n; i++) score += flux[i] * flux[i - lag];
      score /= (n - lag);
      if (score > bestScore) { bestScore = score; bestBpm = bpm; }
    }

    // 4. Beat positions, for the waveform ticks + the VJ sequencer.
    const period = (60 / bestBpm) * envRate;
    const beats = [];
    let phase = 0, bestPhase = 0, bestSum = -1;
    for (phase = 0; phase < period; phase += 1) {
      let sum = 0;
      for (let b = phase; b < n; b += period) sum += flux[Math.round(b)] || 0;
      if (sum > bestSum) { bestSum = sum; bestPhase = phase; }
    }
    for (let b = bestPhase; b < n; b += period) beats.push(b / envRate);

    return { bpm: bestBpm, confidence: Math.min(1, bestScore * 100), beats };
  }

  // ===========================================================================
  // ANALYSE — one call, everything the app should know about a track.
  // ===========================================================================

  async function analyse(fileOrBuffer) {
    const AC = window.AudioContext || window.webkitAudioContext;
    let buf = fileOrBuffer;
    if (!(buf instanceof AudioBuffer)) {
      const ac = new AC();
      buf = await ac.decodeAudioData(await fileOrBuffer.arrayBuffer());
      ac.close();
    }

    window.logToConsole?.('', '[intel] analysing key and tempo…');
    const key   = detectKey(buf);
    const tempo = detectTempo(buf);

    window.logToConsole?.('ok',
      `[intel] ${key.label} · ${tempo.bpm} BPM ` +
      `(key ${Math.round(key.confidence * 100)}% · tempo ${Math.round(tempo.confidence * 100)}%)`);

    // Beat ticks go straight onto the waveform, which had nowhere to draw before.
    window.FFWaveform?.setBeats?.(tempo.beats);

    render({ key, tempo, duration: buf.duration });
    return { key, tempo, duration: buf.duration };
  }

  function render(r) {
    const el = document.getElementById('audio-intel');
    if (!el) return;
    const semis = { 'C':0,'C#':1,'D':2,'D#':3,'E':4,'F':5,'F#':6,'G':7,'G#':8,'A':9,'A#':10,'B':11 };
    el.innerHTML = `
      <div class="ai-row">
        <span class="ai-k">Key</span>
        <span class="ai-v"><b>${r.key.label}</b>
          <small>${Math.round(r.key.confidence * 100)}%</small></span>
      </div>
      <div class="ai-row">
        <span class="ai-k">Tempo</span>
        <span class="ai-v"><b>${r.tempo.bpm} BPM</b>
          <small>${r.tempo.beats.length} beats</small></span>
      </div>
      <div class="ai-note">
        Pitch is now shown in <b>musical intervals</b>, not just semitones.
        Speed changes that land on a dissonant pitch are flagged.
      </div>`;
    window._trackKey = semis[r.key.key];
  }

  /**
   * A speed change shifts the pitch. Tell the user WHERE it lands musically.
   * "0.75× speed" means nothing. "Down a perfect fourth, to G minor" means
   * everything.
   */
  function describeShift(speed, semitoneOffset = 0) {
    const fromSpeed = 12 * Math.log2(speed);
    const total = fromSpeed + semitoneOffset;
    const rounded = Math.round(total);
    const cents = Math.round((total - rounded) * 100);

    const INTERVAL = ['unison','minor 2nd','major 2nd','minor 3rd','major 3rd','perfect 4th',
                      'tritone','perfect 5th','minor 6th','major 6th','minor 7th','major 7th','octave'];
    const dir = rounded < 0 ? 'down' : 'up';
    const iv = INTERVAL[Math.min(12, Math.abs(rounded) % 12 || (Math.abs(rounded) ? 12 : 0))];

    let newKey = null;
    if (window._trackKey != null) {
      newKey = NOTES[(((window._trackKey + rounded) % 12) + 12) % 12];
    }

    return {
      semitones: total,
      label: rounded === 0
        ? (Math.abs(cents) < 5 ? 'original pitch' : `${cents > 0 ? '+' : ''}${cents} cents`)
        : `${dir} a ${iv}${Math.abs(cents) > 8 ? ` (${cents > 0 ? '+' : ''}${cents}¢ — OUT OF TUNE)` : ''}`,
      newKey,
      inTune: Math.abs(cents) <= 8,
    };
  }

  // ===========================================================================
  // SEMANTIC MACROS
  // ---------------------------------------------------------------------------
  // Nobody thinks "6 kHz low-pass at Q 0.7 with 40% wet convolution."
  // They think "make it MELT."
  //
  // Each macro is 0-100 and moves a whole coordinated set of the 23 real
  // parameters along a curve that always sounds good. The real knobs are still
  // there underneath — this is a shortcut, not a replacement.
  // ===========================================================================

  const MACROS = {
    melt: {
      label: 'MELT', icon: '🫠',
      desc: 'Slows, detunes and smears. The whole thing sags.',
      apply: (v) => ({
        speed: 1 - v * 0.30,
        pitch: -v * 4,
        chorusMix: v * 0.55,
        chorusRate: 0.4 + v * 0.3,
        chorusDepth: 0.3 + v * 0.5,
        lowpassFreq: 20000 - v * 13000,
        reverbMix: v * 0.35,
      }),
    },
    muffle: {
      label: 'MUFFLE', icon: '🫥',
      desc: 'Puts it behind a wall. Underwater at the extreme.',
      apply: (v) => ({
        lowpassFreq: 20000 - v * 19000,
        eqHighDb: -v * 14,
        eqMidDb: -v * 5,
        bassBoostDb: v * 5,
      }),
    },
    wash: {
      label: 'WASH', icon: '🌊',
      desc: 'Dissolves it into space. Reverb, delay, and air.',
      apply: (v) => ({
        reverbMix: v * 0.85,
        reverbRoom: 1.5 + v * 3.5,
        reverbDecay: 2 + v * 7,
        delayMix: v * 0.35,
        delayTime: 0.25 + v * 0.35,
        delayFeedback: 0.2 + v * 0.4,
      }),
    },
    slush: {
      label: 'SLUSH', icon: '🧊',
      desc: 'The signature. Slowed, pitched, washed, warm.',
      apply: (v) => ({
        speed: 1 - v * 0.22,
        pitch: -v * 3,
        reverbMix: v * 0.6,
        reverbDecay: 2 + v * 4,
        chorusMix: v * 0.35,
        delayMix: v * 0.28,
        lowpassFreq: 20000 - v * 13000,
        bassBoostDb: v * 5,
        eqHighDb: -v * 4,
      }),
    },
    vintage: {
      label: 'VINTAGE', icon: '📻',
      desc: 'Age it. Band-limit, saturate, and wobble.',
      apply: (v) => ({
        lowpassFreq: 20000 - v * 14500,
        eqHighDb: -v * 9,
        eqLowDb: -v * 4,
        distortionAmount: v * 22,
        distortionTone: 0.35,
        chorusMix: v * 0.28,
        chorusRate: 0.3,
        chorusDepth: 0.6,
      }),
    },
  };

  const macroValues = { melt: 0, muffle: 0, wash: 0, slush: 0, vintage: 0 };

  /** Macros COMPOSE. Apply them in order over the base patch. */
  function applyMacros(engine) {
    if (!engine) return;
    const base = { ...(window.FFAudio?.DEFAULT_PARAMS || {}) };
    let patch = { ...base };
    for (const [id, v] of Object.entries(macroValues)) {
      if (v <= 0) continue;
      const p = MACROS[id].apply(v / 100);
      // Take the more extreme of the two for each param — macros stack, they
      // don't average each other into blandness.
      for (const [k, val] of Object.entries(p)) {
        const cur = patch[k];
        const bs = base[k];
        patch[k] = (Math.abs(val - bs) > Math.abs(cur - bs)) ? val : cur;
      }
    }
    engine.applyParams(patch);
    return patch;
  }

  function buildMacroUI(container, engine) {
    if (!container) return;
    container.innerHTML = `
      <div class="macro-head">
        <strong>Macros</strong>
        <small>One knob, the whole sound. The 23 real controls are still below.</small>
      </div>` +
      Object.entries(MACROS).map(([id, m]) => `
        <div class="macro">
          <label for="macro-${id}">
            <span class="macro-icon">${m.icon}</span>
            <strong>${m.label}</strong>
            <small>${m.desc}</small>
          </label>
          <input type="range" id="macro-${id}" data-m="${id}" min="0" max="100" value="0">
          <output id="macro-${id}-v">0</output>
        </div>`).join('');

    container.addEventListener('input', (e) => {
      const id = e.target.dataset.m;
      if (!id) return;
      macroValues[id] = +e.target.value;
      document.getElementById(`macro-${id}-v`).textContent = e.target.value;
      const eng = engine || window.FFAudioStudio?.engine?.();
      applyMacros(eng);
      window.FFAudioStudio?.refresh?.();      // pull the 23 real sliders into line
    });
  }

  window.FFAudioIntel = {
    detectKey, detectTempo, analyse, describeShift,
    MACROS, macroValues, applyMacros, buildMacroUI, NOTES,
  };
})();
