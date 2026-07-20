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
    launchQ: 'off',             // #78 beat-synced launch quantise: off|beat|bar|2bar
    playStart: 0,               // transport start (performance.now) for launch quantise
    banks: new Array(8).fill(null),  // #75 pattern banks (deep-cloned patterns)
    pendingBank: -1,            // a bank queued to switch on the next bar
  };

  let engine = null;            // the TripCam engine driving the visuals
  let chaos = null, sparkles = null;
  const auto = window.FFAutomation ? new window.FFAutomation.Automation() : { recording: false, record() {}, start() {}, stop() {}, length: 0, duration: () => 0, events: [] };  // #76

  // #76 Play the recorded automation back — schedule each master-fader move.
  function playAutomation() {
    if (!auto.events || !auto.events.length) { log('No automation recorded yet.', 'warn'); return; }
    log(`Playing automation — ${auto.events.length} moves.`);
    const mst = document.getElementById('vj-master');
    for (const ev of auto.events) {
      if (ev.param !== 'master') continue;
      setTimeout(() => {
        if (mst) mst.value = ev.value;
        if (engine && window.FFPerf?.Master) { window.FFPerf.Master.capture(engine); window.FFPerf.Master.set(ev.value, engine); window.FFPerf.Master.release(); }
      }, ev.t * 1000);
    }
  }
  let mosher = null;            // the MotionMosher, when Datamosh is triggered
  let srcVideoEl = null;        // the <video> feeding the engine — hot cues seek it
  const cues = [];              // hot-cue jump points, per slot (seconds)

  // ===========================================================================
  // TRIGGERS
  // ===========================================================================

  function fire(id, momentary) {
    const t = TRIGGERS[id];
    if (!t) return;
    window.FFMidiOut?.noteOnFor?.(id);          // #71 MIDI out (no-op if disabled)
    if (!engine) return;

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
    if (!t) return;
    window.FFMidiOut?.noteOffFor?.(id);         // #71 MIDI out (no-op if disabled)
    if (!engine) return;
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

      // PANIC — kill everything instantly (the "0" key or the PANIC button).
      // Non-negotiable on stage: latched effects, sequencer, chaos, strobe and
      // mosh all drop at once and the patch returns to neutral.
      if (e.key === '0') { panic(); e.preventDefault(); return; }

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
    S.playStart = performance.now();
    document.getElementById('vj-play').textContent = '⏸';
    tick();
  }

  // #78 Beat-synced launch — quantise a trigger to the next beat/bar. When the
  // sequencer is stopped, or quantise is off, it fires immediately. Otherwise it
  // waits (via FFBeatSync.nextGridTime) so pads land on the grid, and lights the
  // pad "queued" while it waits.
  function launch(id) {
    if (S.launchQ === 'off' || !S.playing || !window.FFBeatSync) return fire(id, false);
    const elapsed = performance.now() - S.playStart;
    const { delay } = window.FFBeatSync.nextGridTime(elapsed, S.bpm, S.launchQ);
    const pad = document.querySelector(`.vj-pad[data-t="${id}"]`);
    if (delay < 12) return fire(id, false);
    pad?.classList.add('queued');
    setTimeout(() => { pad?.classList.remove('queued'); if (S.playing) fire(id, false); }, delay);
  }

  function stop() {
    S.playing = false;
    clearTimeout(S.timer);
    document.getElementById('vj-play').textContent = '▶';
    document.querySelectorAll('.vj-step').forEach((s) => s.classList.remove('now'));
    for (const id of [...S.active]) release(id);
  }

  // ---- #69 external clock (MIDI clock slave) --------------------------------
  // When slaved, the internal setTimeout scheduler is off and an outside clock
  // calls stepTick() once per 16th note.
  function setExternalClock(on) { S.extClock = !!on; if (S.extClock) clearTimeout(S.timer); }
  function extStart() { S.extClock = true; S.playing = true; S.step = 0; S.playStart = performance.now(); const b = document.getElementById('vj-play'); if (b) b.textContent = '⏸'; }
  function extStop() { stop(); }
  function stepTick() { if (S.playing) stepBody(); }

  // ===========================================================================
  // PANIC — kill everything, instantly. The one control a live tool can't ship
  // without: latched/held triggers, the sequencer, chaos, strobe and mosh all
  // drop at once and the patch snaps back to neutral. Bound to the "0" key and
  // the PANIC button.
  // ===========================================================================
  function panic() {
    for (const id of [...S.active, ...S.held]) release(id);   // release every trigger
    S.active.clear(); S.held.clear();
    try { window.FFMidiOut?.allNotesOff?.(); window.FFMidiOut?.stopClock?.(); } catch (_) {}  // #71 silence MIDI too
    if (S.playing) stop();                                    // stop the sequencer
    try { chaos?.stop(); } catch (_) {}                        // kill the chaos engine
    S.strobeOn = false;
    document.getElementById('vj-chaos')?.classList.remove('active');
    if (engine) {                                             // neutral patch
      try {
        engine.setParams(window.TripCam?.DEFAULTS || {});
        engine.freeze?.(false);
      } catch (_) {}
    }
    try { window.FFPerf?.Master?.release?.(); } catch (_) {}
    try { mosher?.forceIFrame?.(); } catch (_) {}             // drop any mosh
    const mst = document.getElementById('vj-master');
    if (mst) mst.value = '1';                                 // master intensity → full
    document.querySelectorAll('.vj-pad.lit').forEach((p) => p.classList.remove('lit'));
    document.querySelectorAll('.vj-step.now').forEach((s) => s.classList.remove('now'));
    log('PANIC — all effects reset.', 'ok');
  }

  // #75 PATTERN BANKS — 8 slots. Save the current 16-step pattern to a slot,
  // recall a slot. Recalls made while playing are QUANTISED to the next bar
  // (they apply when the sequencer wraps to step 0) so the switch lands on the
  // downbeat; stopped, they apply immediately.
  function clonePattern(p) { const o = {}; for (const k of Object.keys(p)) o[k] = p[k].slice(); return o; }
  function saveBank(i) { if (i < 0 || i >= S.banks.length) return; S.banks[i] = clonePattern(S.pattern); syncBankButtons(); log(`Saved pattern to bank ${i + 1}.`, 'ok'); }
  function applyBank(i) { if (!S.banks[i]) return; S.pattern = clonePattern(S.banks[i]); syncGrid(); syncBankButtons(); }
  function recallBank(i) {
    if (i < 0 || i >= S.banks.length || !S.banks[i]) return;
    if (S.playing) { S.pendingBank = i; syncBankButtons(); log(`Bank ${i + 1} queued — switches on the next bar.`); }
    else { applyBank(i); log(`Recalled bank ${i + 1}.`, 'ok'); }
  }
  function syncGrid() {
    document.querySelectorAll('.vj-cell').forEach((c) => {
      const on = !!(S.pattern[c.dataset.t] && S.pattern[c.dataset.t][+c.dataset.s]);
      c.classList.toggle('on', on);
    });
  }
  function syncBankButtons() {
    document.querySelectorAll('.vj-bank').forEach((b) => {
      const i = +b.dataset.b;
      b.classList.toggle('filled', !!S.banks[i]);
      b.classList.toggle('queued', S.pendingBank === i);
    });
  }

  // One step of the sequencer: bank switch on the bar, light the playhead, fire
  // the hits on this step, then advance. Split out from tick() so an EXTERNAL
  // clock (#69 MIDI clock slave) can drive it one step at a time.
  function stepBody() {
    if (!S.playing) return;

    if (S.step === 0 && S.pendingBank >= 0) { applyBank(S.pendingBank); S.pendingBank = -1; }  // #75 bar-quantised switch

    document.querySelectorAll('.vj-step').forEach((el) =>
      el.classList.toggle('now', +el.dataset.s === S.step));

    for (const [id, steps] of Object.entries(S.pattern)) {
      if (steps[S.step]) { fire(id, true); setTimeout(() => release(id), stepMs() * 0.9); }
    }

    S.step = (S.step + 1) % S.steps;
  }

  function tick() {
    if (!S.playing) return;
    stepBody();
    if (!S.extClock) S.timer = setTimeout(tick, stepMs());   // internal clock only
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
        <div class="vj-start" id="vj-start">
          <button type="button" id="vj-start-btn" class="vj-start-btn">📹 Tap to go live</button>
          <span class="vj-start-hint">then trigger effects with the pads below</span>
        </div>
        <div class="vj-hud">
          <span id="vj-fps" class="vj-fps">— fps</span>
          <span id="vj-midi-status" class="vj-midi">MIDI: —</span>
          <button type="button" id="vj-rec-video" class="vj-rec-video" title="Record the live VJ output → Media Bin (then add more with ffmpeg)">🔴 REC → Bin</button>
        </div>
      </div>

      <div class="vj-deck">
        <div class="vj-transport">
          <button type="button" id="vj-play" class="vj-play">▶</button>
          <button type="button" id="vj-panic" class="vj-panic" title="Reset everything (0)">⏹ PANIC</button>
          <button type="button" id="vj-tap"  class="mini-btn">TAP</button>
          <label class="vj-bpm-wrap">
            <input type="range" id="vj-bpm" min="40" max="220" value="120">
            <span id="vj-bpm-v">120</span> BPM
          </label>
          <button type="button" id="vj-sync" class="mini-btn">🎵 Sync to audio</button>
          <select id="vj-launchq" class="ctrl" title="Beat-synced launch — pads fire on the grid (#78)">
            <option value="off">⚡ Launch: now</option>
            <option value="beat">On beat</option>
            <option value="bar">On bar</option>
            <option value="2bar">Every 2 bars</option>
          </select>
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
          <button type="button" id="vj-auto-rec" class="mini-btn" title="Record master-fader automation (#76)">⏺ REC</button>
          <button type="button" id="vj-auto-play" class="mini-btn" title="Play back recorded automation">▶ AUTO</button>
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
          <div class="vj-banks" id="vj-banks" title="Pattern banks (#75) — click to recall on the bar · Shift+click to save">
            <span class="vj-banks-l">BANKS</span>
            ${Array.from({ length: 8 }, (_, i) => `<button type="button" class="vj-bank" data-b="${i}">${i + 1}</button>`).join('')}
          </div>
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
    bindKeys();          // hold = stab, shift = latch, "0" = panic — this was
                         // defined but never called, so the whole VJ keyboard
                         // (the core live-performance ergonomics) was dead.
    monitorFPS();
    loadMap();
    initMIDI();
  }

  function bind() {
    // Pads — pointer down/up gives you momentary on touch too.
    const pads = document.getElementById('vj-pads');
    pads.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('.vj-pad');
      if (!b) return;
      if (S.launchQ !== 'off') launch(b.dataset.t);   // #78 quantised latch launch
      else fire(b.dataset.t, true);                   // momentary
    });
    pads.addEventListener('pointerup', (e) => {
      const b = e.target.closest('.vj-pad');
      if (b && S.launchQ === 'off') release(b.dataset.t);
    });

    document.getElementById('vj-grid').addEventListener('click', (e) => {
      const c = e.target.closest('.vj-cell');
      if (!c) return;
      const { t, s } = c.dataset;
      S.pattern[t][+s] = !S.pattern[t][+s];
      c.classList.toggle('on', S.pattern[t][+s]);
      // #89 — the sequencer pattern is non-DOM state; flag it for the shared
      // app undo stack so Ctrl+Z reverts step edits like any other change.
      window.scheduleUndoSnapshot?.();
    });

    // #89 — register the sequencer pattern as a custom-undo provider. capture()
    // deep-clones the pattern; restore() puts it back and re-syncs the grid.
    if (typeof window.registerUndoProvider === 'function') {
      window.registerUndoProvider('vj-pattern', {
        capture: () => clonePattern(S.pattern),
        restore: (p) => { S.pattern = clonePattern(p); syncGrid(); },
      });
    }

    // #75 pattern banks — click to recall (bar-quantised while playing),
    // Shift+click to save the current pattern.
    document.getElementById('vj-banks')?.addEventListener('click', (e) => {
      const b = e.target.closest('.vj-bank');
      if (!b) return;
      const i = +b.dataset.b;
      if (e.shiftKey) saveBank(i); else recallBank(i);
    });

    document.getElementById('vj-play').addEventListener('click', play);
    document.getElementById('vj-panic').addEventListener('click', panic);
    document.getElementById('vj-tap').addEventListener('click', tap);
    document.getElementById('vj-sync').addEventListener('click', syncToAudio);

    document.getElementById('vj-launchq')?.addEventListener('change', (e) => { S.launchQ = e.target.value; });
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

    // Record the live VJ visual output to the Media Bin (reuses TripCam's
    // MediaRecorder → addBlobToBin path). What lands is an ordinary bin clip you
    // can then run more ffmpeg over.
    document.getElementById('vj-rec-video')?.addEventListener('click', (e) => {
      const cv = document.getElementById('vj-canvas');
      if (e.target.classList.contains('recording')) { window.TripCam?.stopRec(); e.target.classList.remove('recording'); e.target.textContent = '🔴 REC → Bin'; log('Stopped — VJ recording saved to the Media Bin.', 'ok'); }
      else if (window.TripCam?.startRec) { window.TripCam.startRec(cv, 30); e.target.classList.add('recording'); e.target.textContent = '⏹ STOP'; log('Recording VJ output → Media Bin…'); }
    });
    document.getElementById('vj-source').addEventListener('change', (e) => setSource(e.target.value));

    // Mobile-first: a fresh tap gesture that turns the camera on. The auto-attempt
    // in build() is silently blocked on phones (no user gesture), so this is the
    // reliable way in — no keyboard required.
    document.getElementById('vj-start-btn')?.addEventListener('click', () =>
      setSource(document.getElementById('vj-source')?.value || 'webcam'));

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
      mst.addEventListener('input', (e) => { if (engine) window.FFPerf.Master.set(+e.target.value, engine); auto.record('master', +e.target.value, performance.now() / 1000); });
      mst.addEventListener('pointerup', () => window.FFPerf.Master.release());
    }

    // #76 Automation — record master-fader moves, play them back.
    document.getElementById('vj-auto-rec')?.addEventListener('click', (e) => {
      if (auto.recording) { auto.stop(); e.target.classList.remove('on'); log(`Automation recorded — ${auto.length} moves, ${auto.duration().toFixed(1)}s.`, 'ok'); }
      else { auto.start(performance.now() / 1000); e.target.classList.add('on'); log('Recording automation — move the MASTER fader…'); }
    });
    document.getElementById('vj-auto-play')?.addEventListener('click', () => playAutomation());

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
      document.getElementById('vj-start')?.setAttribute('hidden', '');   // live — drop the tap-to-start overlay
    } catch (e) {
      document.getElementById('vj-start')?.removeAttribute('hidden');    // failed (e.g. mobile blocked the auto-attempt) — let them tap
      log(e.message, 'error');
    }
  }

  function renderMidiStatus(names) {
    const el = document.getElementById('vj-midi-status');
    if (el) el.textContent = names.length ? `MIDI: ${names[0]}` : 'MIDI: none';
  }
  function renderMappings() { /* mappings render into the learn button title */ }

  window.FFVJ = { build, TRIGGERS, fire, release, panic, saveBank, recallBank, applyBank, automation: () => auto, S,
    setExternalClock, extStart, extStop, stepTick };

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('[data-tab="vj"]')?.addEventListener('click', build);
  });
})();
