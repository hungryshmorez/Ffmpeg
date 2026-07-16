/* =============================================================================
   vj-mode.js — LIVE PERFORMANCE MODE
   (ported from your SauceLab VJ)
   -----------------------------------------------------------------------------
   Everything in this app so far has been about MAKING a file. This is about
   PERFORMING — playing the effects live, with your hands, in time with music.

     • MIDI LEARN     — twist a knob on your controller, it binds to a parameter
     • KEYBOARD       — bind any effect to any key, trigger it like a drum pad
     • BPM SEQUENCER  — 16 steps, tap tempo, effects fire on the beat
     • BEAT-SYNC      — the sequencer can lock to the actual audio (beat-detection.js)
     • LAYERS         — stack sources with blend modes and opacity
     • FPS MONITOR    — because dropping frames on stage is the only real bug

   Momentary vs latched: hold a key for a stab, tap it to latch. That difference
   is the entire ergonomics of live performance and it's why a VJ tool can't just
   be a checkbox list.
   ========================================================================== */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Triggerable effects. Each is a short-lived override on the shader params.
  // ---------------------------------------------------------------------------
  const TRIGGERS = {
    flash:      { label: 'Flash',        key: 'q', params: { brightness: 0.9, contrast: 1.6 }, decay: 120 },
    strobe:     { label: 'Strobe',       key: 'w', params: { brightness: 1.0 }, strobe: true, decay: 0 },
    invert:     { label: 'Invert',       key: 'e', params: { saturation: -1 }, decay: 0 },
    kaleido:    { label: 'Kaleidoscope', key: 'r', effect: 'kaleidoscope', decay: 0 },
    mirror:     { label: 'Mirror',       key: 't', effect: 'mirror', decay: 0 },
    pixelate:   { label: 'Pixelate',     key: 'y', effect: 'pixelsort', params: { intensity: 1.4 }, decay: 0 },
    wave:       { label: 'Wave Warp',    key: 'u', effect: 'wavewarp', params: { waveAmplitude: 0.08 }, decay: 0 },
    chroma:     { label: 'Chromatic',    key: 'i', effect: 'colorshift', params: { phosphorOffset: 0.012 }, decay: 0 },
    smear:      { label: 'Smear',        key: 'a', params: { trailPersistence: 0.99 }, decay: 0 },
    glitch:     { label: 'Glitch',       key: 's', effect: 'noiseGlitch', params: { glitchStrength: 1.6 }, decay: 90 },
    datamosh:   { label: 'Datamosh',     key: 'd', mosh: true, decay: 0 },
    freeze:     { label: 'Freeze',       key: 'f', freeze: true, decay: 0 },
    zoom:       { label: 'Zoom Punch',   key: 'g', effect: 'fisheye', params: { fisheyeStrength: 0.8 }, decay: 150 },
    cube:       { label: 'RGB Split',    key: 'h', effect: 'colorshift', params: { phosphorOffset: 0.02 }, decay: 100 },
    blackout:   { label: 'Blackout',     key: ' ', params: { brightness: -1 }, decay: 0 },
    chaos:      { label: 'CHAOS',        key: 'z', chaos: true, decay: 400 },
    sparkle:    { label: 'Sparkle',      key: 'x', sparkle: true, decay: 0 },
  };

  const S = {
    active: new Set(),          // latched triggers
    held: new Set(),            // momentary (key down)
    bpm: 120,
    playing: false,
    step: 0,
    steps: 16,
    pattern: {},                // { triggerId: [bool × 16] }
    timer: null,
    tapTimes: [],
    midi: null,
    midiMap: {},                // { 'cc:74': 'intensity' }
    learning: null,             // param id awaiting a MIDI move
    fps: 0,
    lastFrame: performance.now(),
    strobeOn: false,
    beatSync: false,
  };

  let engine = null;            // the TripCam engine driving the visuals
  let chaos = null, sparkles = null;
  let mosher = null;            // the MotionMosher, when Datamosh is triggered
  let srcVideoEl = null;        // the <video> feeding the engine — hot cues seek it
  const cues = [];              // hot-cue jump points, per slot (seconds)

  // ===========================================================================
  // TRIGGERS
  // ===========================================================================

  function fire(id, momentary) {
    const t = TRIGGERS[id];
    if (!t || !engine) return;

    if (t.effect) engine.setEffect(t.effect);
    if (t.params) engine.setParams(t.params);
    if (t.freeze) engine.freeze(true);
    if (t.strobe) S.strobeOn = true;
    if (t.mosh) window.dispatchEvent(new CustomEvent('vj:mosh', { detail: { on: true } }));
    if (t.chaos) {
      if (!chaos) chaos = new window.FFShaderPlus.ChaosEngine(engine);
      chaos.fire(true);                       // a full heavy burst, on demand
    }
    if (t.sparkle) {
      if (!sparkles) sparkles = new window.FFShaderPlus.Sparkles(document.getElementById('vj-canvas'));
      sparkles.emit(120);
    }
    if (t.chaos) {
      if (!chaos) chaos = new window.FFShaderPlus.ChaosEngine(engine);
      chaos.fire(true);                      // a full heavy burst, on demand
    }
    if (t.sparkle) {
      if (!sparkles) sparkles = new window.FFShaderPlus.Sparkles(document.getElementById('vj-canvas'));
      sparkles.emit(120);
    }

    (momentary ? S.held : S.active).add(id);
    paint(id, true);

    // A momentary trigger with a decay auto-releases — that's a stab.
    if (t.decay > 0) setTimeout(() => release(id), t.decay);
  }

  function release(id) {
    const t = TRIGGERS[id];
    if (!t || !engine) return;
    S.held.delete(id);
    S.active.delete(id);

    if (t.freeze) engine.freeze(false);
    if (t.strobe) { S.strobeOn = false; engine.setParams({ brightness: 0 }); }
    if (t.mosh) window.dispatchEvent(new CustomEvent('vj:mosh', { detail: { on: false } }));
    if (t.params) {
      // Restore this param group to the base patch.
      const base = window.TripCam?.DEFAULTS || {};
      const revert = {};
      for (const k of Object.keys(t.params)) revert[k] = base[k];
      engine.setParams(revert);
    }
    paint(id, false);
  }

  const paint = (id, on) =>
    document.querySelector(`.vj-pad[data-t="${id}"]`)?.classList.toggle('lit', on);

  // ===========================================================================
  // KEYBOARD — hold = momentary, tap = latch. This distinction IS the instrument.
  // ===========================================================================

  function bindKeys() {
    const keyToId = {};
    for (const [id, t] of Object.entries(TRIGGERS)) keyToId[t.key] = id;

    document.addEventListener('keydown', (e) => {
      if (!document.getElementById('tab-vj')?.classList.contains('active')) return;
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;

      const id = keyToId[e.key.toLowerCase()];
      if (!id || e.repeat) return;
      e.preventDefault();

      // Shift = latch (stays on until pressed again). Otherwise momentary.
      if (e.shiftKey) {
        S.active.has(id) ? release(id) : fire(id, false);
      } else {
        fire(id, true);
      }
    });

    document.addEventListener('keyup', (e) => {
      const id = keyToId[e.key.toLowerCase()];
      if (id && S.held.has(id)) release(id);
    });
  }

  // ===========================================================================
  // MIDI — Web MIDI API. Twist a knob, it binds.
  // ===========================================================================

  async function initMIDI() {
    if (!navigator.requestMIDIAccess) {
      log('MIDI not supported in this browser (Chrome/Edge only).', 'warn');
      return;
    }
    try {
      S.midi = await navigator.requestMIDIAccess();
      const names = [];
      S.midi.inputs.forEach((inp) => {
        names.push(inp.name);
        inp.onmidimessage = onMIDI;
      });
      log(names.length
        ? `MIDI: ${names.join(', ')}`
        : 'MIDI ready — no devices connected.', names.length ? 'ok' : '');
      renderMidiStatus(names);
    } catch (e) {
      log(`MIDI failed: ${e.message}`, 'warn');
    }
  }

  function onMIDI(msg) {
    const [status, d1, d2] = msg.data;
    const type = status & 0xf0;

    // 0xB0 = control change (a knob/fader). 0x90 = note on (a pad).
    const sig = type === 0xb0 ? `cc:${d1}` : type === 0x90 ? `note:${d1}` : null;
    if (!sig) return;

    // LEARN MODE — the next thing you touch gets bound.
    if (S.learning) {
      S.midiMap[sig] = S.learning;
      log(`MIDI learned: ${sig} → ${S.learning}`, 'ok');
      S.learning = null;
      document.querySelectorAll('.vj-learn').forEach((b) => b.classList.remove('learning'));
      saveMap();
      renderMappings();
      return;
    }

    const target = S.midiMap[sig];
    if (!target) return;

    if (type === 0x90 && d2 > 0) {                 // pad hit
      TRIGGERS[target] ? fire(target, false) : null;
    } else if (type === 0x90) {
      TRIGGERS[target] ? release(target) : null;
    } else if (type === 0xb0 && engine) {          // knob
      const v = d2 / 127;
      const range = PARAM_RANGE[target];
      if (range) engine.setParam(target, range[0] + v * (range[1] - range[0]));
    }
  }

  const PARAM_RANGE = {
    intensity: [0, 2], glitchStrength: [0, 2], trailPersistence: [0, 1.2],
    saturation: [0, 3], brightness: [-0.5, 0.5], contrast: [0, 3],
    hueShiftSpeed: [-1, 1], phosphorOffset: [0, 0.02], fisheyeStrength: [-1, 1],
    waveAmplitude: [0, 0.2], kaleidoSegments: [2, 24], scanlineIntensity: [0, 1],
  };

  const saveMap = () => localStorage.setItem('ffs.midiMap', JSON.stringify(S.midiMap));
  const loadMap = () => { try { S.midiMap = JSON.parse(localStorage.getItem('ffs.midiMap') || '{}'); } catch (_) {} };

  // ===========================================================================
  // SEQUENCER — 16 steps. Effects fire on the beat.
  // ===========================================================================

  function stepMs() { return (60 / S.bpm) * 1000 / 4; }   // 16ths

  function play() {
    if (S.playing) return stop();
    S.playing = true;
    S.step = 0;
    document.getElementById('vj-play').textContent = '⏸';
    tick();
  }

  function stop() {
    S.playing = false;
    clearTimeout(S.timer);
    document.getElementById('vj-play').textContent = '▶';
    document.querySelectorAll('.vj-step').forEach((s) => s.classList.remove('now'));
    for (const id of [...S.active]) release(id);
  }

  function tick() {
    if (!S.playing) return;

    document.querySelectorAll('.vj-step').forEach((el) =>
      el.classList.toggle('now', +el.dataset.s === S.step));

    for (const [id, steps] of Object.entries(S.pattern)) {
      if (steps[S.step]) { fire(id, true); setTimeout(() => release(id), stepMs() * 0.9); }
    }

    S.step = (S.step + 1) % S.steps;
    S.timer = setTimeout(tick, stepMs());
  }

  /** Tap tempo — the only way anyone actually sets a BPM in a dark room. */
  function tap() {
    const now = performance.now();
    S.tapTimes = S.tapTimes.filter((t) => now - t < 2500);
    S.tapTimes.push(now);
    if (S.tapTimes.length < 2) return;

    const gaps = [];
    for (let i = 1; i < S.tapTimes.length; i++) gaps.push(S.tapTimes[i] - S.tapTimes[i - 1]);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    S.bpm = Math.round(Math.max(40, Math.min(220, 60000 / avg)));
    document.getElementById('vj-bpm').value = S.bpm;
    document.getElementById('vj-bpm-v').textContent = S.bpm;
  }

  /** Lock the sequencer to the ACTUAL music — uses the existing beat detector. */
  async function syncToAudio() {
    const m = window.state?.inputFile;
    if (!m) return log('Load a track into the Media Bin first.', 'warn');
    log('Detecting BPM…');
    try {
      const r = await window.detectBeatsForActive?.();
      if (r?.bpm) {
        S.bpm = Math.round(r.bpm);
        document.getElementById('vj-bpm').value = S.bpm;
        document.getElementById('vj-bpm-v').textContent = S.bpm;
        S.beatSync = true;
        log(`Locked to ${S.bpm} BPM from the audio.`, 'ok');
      }
    } catch (e) { log(`Beat detection failed: ${e.message}`, 'warn'); }
  }

  // ===========================================================================
  // FPS — dropping frames on stage is the only bug that matters.
  // ===========================================================================

  function monitorFPS() {
    const loop = () => {
      const now = performance.now();
      const dt = now - S.lastFrame;
      S.lastFrame = now;
      S.fps = 0.92 * S.fps + 0.08 * (1000 / Math.max(1, dt));

      const el = document.getElementById('vj-fps');
      if (el) {
        const f = Math.round(S.fps);
        el.textContent = `${f} fps`;
        el.className = 'vj-fps ' + (f >= 50 ? 'good' : f >= 30 ? 'ok' : 'bad');
      }

      // Strobe runs on the frame clock, not a timer — it must be frame-accurate.
      if (S.strobeOn && engine) {
        engine.setParams({ brightness: (Math.floor(now / 50) % 2) ? 1.0 : -1.0 });
      }
      requestAnimationFrame(loop);
    };
    loop();
  }

  const log = (m, k = '') => window.logToConsole?.(k, `[vj] ${m}`);

  // ===========================================================================
  // UI
  // ===========================================================================

  function build() {
    const tab = document.getElementById('tab-vj');
    if (!tab || tab.dataset.built) return;
    tab.dataset.built = '1';

    tab.innerHTML = `
      <div class="vj-stage">
        <canvas id="vj-canvas"></canvas>
        <div class="vj-hud">
          <span id="vj-fps" class="vj-fps">— fps</span>
          <span id="vj-midi-status" class="vj-midi">MIDI: —</span>
        </div>
      </div>

      <div class="vj-deck">
        <div class="vj-transport">
          <button type="button" id="vj-play" class="vj-play">▶</button>
          <button type="button" id="vj-tap"  class="mini-btn">TAP</button>
          <label class="vj-bpm-wrap">
            <input type="range" id="vj-bpm" min="40" max="220" value="120">
            <span id="vj-bpm-v">120</span> BPM
          </label>
          <button type="button" id="vj-sync" class="mini-btn">🎵 Sync to audio</button>
          <button type="button" id="vj-midi-learn" class="mini-btn vj-learn">🎹 MIDI Learn</button>
          <select id="vj-source" class="ctrl">
            <option value="webcam">📹 Webcam</option>
            <option value="screen">🖥 Screen</option>
            <option value="bin">📁 Media Bin</option>
          </select>
          <select id="vj-route" class="ctrl" title="Which frequency band drives which effect">
            <option value="off">🎵 Audio: off</option>
            <option value="balanced">Balanced</option>
            <option value="kick-punch">Kick Punch</option>
            <option value="hats-shimmer">Hats Shimmer</option>
            <option value="melt">Melt</option>
            <option value="full-chaos">Full Chaos</option>
          </select>
          <button type="button" id="vj-chaos" class="mini-btn">🎲 Auto-Glitch</button>
          <label class="vj-bpm-wrap" title="Global intensity — one knob toward neutral over every effect">
            <input type="range" id="vj-master" min="0" max="1" step="0.01" value="1">
            <span>MASTER</span>
          </label>
          <select id="vj-quality" class="ctrl" title="Render quality — Auto sheds resolution when the frame rate drops">
            <option value="auto">⚡ Quality: Auto</option>
            <option value="ultra">Ultra</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
            <option value="potato">Minimum</option>
          </select>
        </div>

        <div class="vj-cues">
          <span class="vj-cues-l">HOT CUES</span>
          <button type="button" class="vj-cue" data-c="0">1</button>
          <button type="button" class="vj-cue" data-c="1">2</button>
          <button type="button" class="vj-cue" data-c="2">3</button>
          <button type="button" class="vj-cue" data-c="3">4</button>
          <small>Click to jump · <kbd>Shift</kbd>+click to set</small>
        </div>

        <div class="vj-pads" id="vj-pads"></div>

        <div class="vj-seq">
          <div class="vj-seq-head">
            <strong>Sequencer</strong>
            <small>Click a cell to fire that effect on that 16th. Effects lock to the beat.</small>
          </div>
          <div id="vj-grid" class="vj-grid"></div>
        </div>

        <p class="vj-hint">
          <strong>Hold</strong> a key for a stab · <strong>Shift+key</strong> to latch it on ·
          <strong>TAP</strong> four times to set the tempo
        </p>
      </div>`;

    // Pads
    document.getElementById('vj-pads').innerHTML = Object.entries(TRIGGERS).map(([id, t]) => `
      <button type="button" class="vj-pad" data-t="${id}">
        <kbd>${t.key === ' ' ? '␣' : t.key.toUpperCase()}</kbd>
        <span>${t.label}</span>
      </button>`).join('');

    // Sequencer grid
    const grid = document.getElementById('vj-grid');
    grid.innerHTML = `<div class="vj-row vj-row-head"><span></span>${
      Array.from({ length: S.steps }, (_, i) =>
        `<span class="vj-step ${i % 4 === 0 ? 'beat' : ''}" data-s="${i}">${i + 1}</span>`).join('')
    }</div>` + Object.entries(TRIGGERS).slice(0, 8).map(([id, t]) => {
      S.pattern[id] = S.pattern[id] || new Array(S.steps).fill(false);
      return `<div class="vj-row"><span class="vj-row-l">${t.label}</span>${
        Array.from({ length: S.steps }, (_, i) =>
          `<button type="button" class="vj-cell ${i % 4 === 0 ? 'beat' : ''}" data-t="${id}" data-s="${i}"></button>`).join('')
      }</div>`;
    }).join('');

    bind();
    monitorFPS();
    loadMap();
    initMIDI();
  }

  function bind() {
    // Pads — pointer down/up gives you momentary on touch too.
    const pads = document.getElementById('vj-pads');
    pads.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('.vj-pad');
      if (b) fire(b.dataset.t, true);
    });
    pads.addEventListener('pointerup', (e) => {
      const b = e.target.closest('.vj-pad');
      if (b) release(b.dataset.t);
    });

    document.getElementById('vj-grid').addEventListener('click', (e) => {
      const c = e.target.closest('.vj-cell');
      if (!c) return;
      const { t, s } = c.dataset;
      S.pattern[t][+s] = !S.pattern[t][+s];
      c.classList.toggle('on', S.pattern[t][+s]);
    });

    document.getElementById('vj-play').addEventListener('click', play);
    document.getElementById('vj-tap').addEventListener('click', tap);
    document.getElementById('vj-sync').addEventListener('click', syncToAudio);

    document.getElementById('vj-bpm').addEventListener('input', (e) => {
      S.bpm = +e.target.value;
      document.getElementById('vj-bpm-v').textContent = S.bpm;
    });

    document.getElementById('vj-midi-learn').addEventListener('click', (e) => {
      const target = prompt(
        'Bind the next MIDI knob/pad to which parameter?\n\n' +
        'Params: ' + Object.keys(PARAM_RANGE).join(', ') + '\n' +
        'Triggers: ' + Object.keys(TRIGGERS).join(', '));
      if (!target) return;
      S.learning = target;
      e.target.classList.add('learning');
      log(`Learning… move a knob or hit a pad to bind it to "${target}".`);
    });

    document.getElementById('vj-source').addEventListener('change', (e) => setSource(e.target.value));

    // HOT CUES — stored jump points in the source video. Click to jump,
    // Shift+click to set the current position. This is what makes a source
    // playable rather than just previewed. (File sources are seekable; live
    // webcam/screen streams simply have nothing to seek.)
    document.querySelector('.vj-cues')?.addEventListener('click', (e) => {
      const b = e.target.closest('.vj-cue');
      if (!b || !srcVideoEl) return;
      const slot = +b.dataset.c;
      if (e.shiftKey) {
        cues[slot] = srcVideoEl.currentTime;
        b.classList.add('set');
        b.title = `${cues[slot].toFixed(2)}s`;
        log(`cue ${slot + 1} = ${cues[slot].toFixed(2)}s`, 'ok');
      } else if (cues[slot] != null) {
        srcVideoEl.currentTime = cues[slot];
        srcVideoEl.play().catch(() => {});
        b.classList.add('hit');
        setTimeout(() => b.classList.remove('hit'), 140);
      }
    });

    // MASTER — global intensity. One knob scales every effect param toward its
    // neutral value (0 = full bypass, 1 = as dialled). Backed by FFPerf.Master
    // (performance.js). pointerdown captures the current patch as the base so
    // the drag lerps from there; pointerup releases it.
    const mst = document.getElementById('vj-master');
    if (mst && window.FFPerf?.Master) {
      mst.addEventListener('pointerdown', () => { if (engine) window.FFPerf.Master.capture(engine); });
      mst.addEventListener('input', (e) => { if (engine) window.FFPerf.Master.set(+e.target.value, engine); });
      mst.addEventListener('pointerup', () => window.FFPerf.Master.release());
    }

    // QUALITY — Auto lets the adaptive monitor shed load when FPS drops; the
    // named tiers lock a fixed quality. Backed by FFPerf.Perf (performance.js).
    const q = document.getElementById('vj-quality');
    if (q && window.FFPerf?.Perf) {
      q.addEventListener('change', (e) => {
        const v = e.target.value;
        if (v === 'auto') { window.FFPerf.Perf.auto = true; log('Quality: Auto — it sheds load if the frame rate drops.', 'ok'); }
        else { window.FFPerf.Perf.setTier(v); log(`Quality locked to ${v}.`, 'ok'); }
      });
    }

    document.getElementById('vj-route').addEventListener('change', async (e) => {
      const v = e.target.value;
      if (!engine) return;
      engine.setAudioRoute(v);
      if (v !== 'off' && !engine.band) {
        try {
          const st = await navigator.mediaDevices.getUserMedia({ audio: true });
          engine.attachAudio(st);
          log('Audio reactive — bass, mid and treble each drive different things.', 'ok');
        } catch (_) { log('Mic denied.', 'warn'); }
      }
    });

    document.getElementById('vj-chaos').addEventListener('click', (e) => {
      if (!engine) return;
      if (!chaos) chaos = new window.FFShaderPlus.ChaosEngine(engine);
      const on = !e.target.classList.contains('active');
      e.target.classList.toggle('active', on);
      on ? chaos.start() : chaos.stop();
    });

    // Beat-synced chaos: when the sequencer is running, glitch ON the beat
    // rather than at random. This is what locks the visuals to the track.
    window.addEventListener('chaos:fire', (ev) => {
      if (S.playing) log(`chaos: ${ev.detail.fired.join(', ')}${ev.detail.heavy ? ' (HEAVY)' : ''}`);
    });

    // Datamosh trigger hooks the motion mosher in and out.
    window.addEventListener('vj:mosh', (e) => {
      if (e.detail.on) {
        if (!mosher) mosher = new window.FFMosh.MotionMosher(document.getElementById('vj-canvas'));
        mosher.moshCut();
      } else {
        mosher?.forceIFrame();
      }
    });

    setSource('webcam');
  }

  async function setSource(kind) {
    const cv = document.getElementById('vj-canvas');
    if (!engine) {
      try { engine = new window.TripCam.TripEngine(cv); engine.start(); }
      catch (e) { return log(e.message, 'error'); }
    }
    try {
      let v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.loop = true;

      if (kind === 'webcam') {
        v.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
      } else if (kind === 'screen') {
        v.srcObject = await navigator.mediaDevices.getDisplayMedia({ video: true });
      } else {
        const m = window.state?.inputFile;
        if (!m) return log('No file in the Media Bin.', 'warn');
        v.src = m.blobUrl;
      }
      await v.play();
      engine.setSource(v);
      srcVideoEl = v;           // hot cues seek this element (file sources are seekable)
    } catch (e) { log(e.message, 'error'); }
  }

  function renderMidiStatus(names) {
    const el = document.getElementById('vj-midi-status');
    if (el) el.textContent = names.length ? `MIDI: ${names[0]}` : 'MIDI: none';
  }
  function renderMappings() { /* mappings render into the learn button title */ }

  window.FFVJ = { build, TRIGGERS, fire, release, S };

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('[data-tab="vj"]')?.addEventListener('click', build);
  });
})();
