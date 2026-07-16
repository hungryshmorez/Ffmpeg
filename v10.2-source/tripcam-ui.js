/* =============================================================================
   tripcam-ui.js — TRIP CAM TAB + EDITOR ⚡ LIVE PREVIEW
   ========================================================================== */

(function () {
  'use strict';

  const SLIDERS = [
    ['intensity',           'Intensity',            0,    2,    0.01],
    ['glitchStrength',      'Glitch Strength',      0,    2,    0.01],
    ['threshold',           'Threshold',            0,    1,    0.01],
    ['displacement',        'Displacement',         0,    0.1,  0.001],
    ['feedback',            'Feedback',             0,    1,    0.01],
    ['trailPersistence',    'Trail Persistence',    0,    1.5,  0.01],
    ['motionThreshold',     'Motion Threshold',     0,    1,    0.01],
    ['motionExtrapolation', 'Motion Extrapolation', 0,    2,    0.01],
    ['hueShiftSpeed',       'Hue Shift Speed',    -1,     1,    0.005],
    ['saturation',          'Saturation',           0,    3,    0.01],
    ['brightness',          'Brightness',        -0.5,    0.5,  0.01],
    ['contrast',            'Contrast',             0,    3,    0.01],
    ['scanlineDensity',     'Scanline Density',    50, 1200,    10],
    ['scanlineIntensity',   'Scanline Intensity',   0,    1,    0.01],
    ['phosphorOffset',      'Phosphor Offset',      0,    0.02, 0.0005],
    ['curvatureAmount',     'CRT Curvature',        0,    0.5,  0.005],
    ['kaleidoSegments',     'Kaleidoscope Segments',2,   24,    1],
    ['fisheyeStrength',     'Fisheye Strength',  -1,      1,    0.01],
    ['waveAmplitude',       'Wave Amplitude',       0,    0.2,  0.001],
    ['waveDensity',         'Wave Density',         1,   50,    1],
    ['waveSpeed',           'Wave Speed',           0,    5,    0.05],
    ['vignetteStrength',    'Vignette Strength',    0,    1,    0.01],
    ['vignetteSoftness',    'Vignette Softness',    0,    1,    0.01],
  ];

  let engine = null, srcVideo = null, srcStream = null;
  let chaos = null, sparkles = null;

  // ---------------------------------------------------------------------------
  // TAB
  // ---------------------------------------------------------------------------

  function buildTab() {
    const tab = document.getElementById('tab-tripcam');
    if (!tab) return;

    tab.innerHTML = `
      <div class="trip-stage">
        <canvas id="trip-canvas"></canvas>
        <div class="trip-empty" id="trip-empty">
          <div class="trip-empty-inner">
            <div class="trip-logo">🌀 TRIP CAM</div>
            <p>Real-time GPU glitch. 11 effects, 60fps, audio-reactive.</p>
            <p class="dim">Pick a source to begin. Whatever you record lands straight
               in the Media Bin, where any of the 180 workflows can chew on it.</p>
          </div>
        </div>
      </div>

      <aside class="trip-panel" id="trip-panel">
        <header class="trip-panel-head">
          <strong>🌀 Trip Cam</strong>
          <button type="button" class="mini-btn" id="trip-min">—</button>
        </header>

        <div class="trip-panel-body" id="trip-body">
          <label class="trip-field">
            <span>Source</span>
            <select id="trip-source" class="ctrl">
              <option value="">— choose —</option>
              <option value="webcam">📹 Webcam</option>
              <option value="screen">🖥 Screen</option>
              <option value="bin">📁 Media Bin file</option>
              <option value="upload">⬆ Upload…</option>
            </select>
          </label>

          <label class="trip-field" id="trip-bin-wrap" hidden>
            <span>Bin file</span>
            <select id="trip-bin-file" class="ctrl"></select>
          </label>

          <div class="trip-row">
            <button type="button" class="mini-btn" id="trip-flip">⇄ Flip camera</button>
            <button type="button" class="mini-btn" id="trip-freeze">❄️ Freeze</button>
          </div>

          <label class="trip-field">
            <span>Effect</span>
            <select id="trip-effect" class="ctrl">
              ${window.TripCam.EFFECTS.map(e => `<option value="${e.id}">${e.label}</option>`).join('')}
            </select>
          </label>

          <label class="trip-field">
            <span>Preset</span>
            <select id="trip-preset" class="ctrl">
              ${Object.keys(window.TripCam.PRESETS).map(p =>
                `<option value="${p}">${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}
            </select>
          </label>

          <label class="trip-check">
            <input type="checkbox" id="trip-audio">
            <span>🎵 Audio reactive</span>
          </label>

          <label class="trip-field" id="trip-route-wrap" hidden>
            <span>Which band drives what</span>
            <select id="trip-audio-route" class="ctrl">
              <option value="balanced">Balanced — each band does its own job</option>
              <option value="kick-punch">Kick Punch — bass zooms, very physical</option>
              <option value="hats-shimmer">Hats Shimmer — treble does the fine work</option>
              <option value="melt">Melt — slow, heavy, low-end driven</option>
              <option value="full-chaos">Full Chaos — everything, all at once</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label class="trip-field" id="trip-amt-wrap" hidden>
            <span>Amount</span>
            <input type="range" id="trip-audio-amt" min="0" max="3" step="0.05" value="1">
          </label>
          <p class="trip-hint">
            <strong>Three bands, not one number.</strong> A kick and a hi-hat used to move the same
            slider by the same amount. Now bass, mid and treble each drive different things.
          </p>

          <label class="trip-field">
            <span>Rotation</span>
            <input type="range" id="trip-rot" min="0" max="360" step="1" value="180">
          </label>
          <label class="trip-check">
            <input type="checkbox" id="trip-tilt">
            <span>📱 Follow device tilt</span>
          </label>

          <div class="trip-chaos">
            <label class="trip-check">
              <input type="checkbox" id="trip-chaos">
              <span>🎲 <strong>Auto-Glitch</strong> — it misbehaves on its own</span>
            </label>
            <p class="trip-hint">Random glitches on a random schedule. Leave it running and go do something else.</p>
            <div id="trip-chaos-opts" hidden>
              <label class="trip-field"><span>Frequency</span>
                <input type="range" id="chaos-freq" min="500" max="8000" step="100" value="3500"></label>
              <label class="trip-field"><span>Severity</span>
                <input type="range" id="chaos-heavy" min="0" max="60" step="1" value="10"></label>
              <button type="button" class="mini-btn wide" id="chaos-now">💥 Glitch NOW</button>
            </div>
          </div>

          <label class="trip-check">
            <input type="checkbox" id="trip-sparkle">
            <span>✨ Sparkles <small>(on the treble)</small></span>
          </label>

          <details class="trip-sliders" open>
            <summary>Parameters</summary>
            <div id="trip-slider-list"></div>
          </details>

          <div class="trip-row">
            <button type="button" class="mini-btn" id="trip-random">🎲 Randomize</button>
            <button type="button" class="mini-btn" id="trip-reset">↺ Reset</button>
          </div>

          <div class="trip-row">
            <button type="button" class="mini-btn" id="trip-snap">📸 Snapshot → Bin</button>
          </div>

          <button type="button" class="primary-btn trip-rec" id="trip-rec-btn">
            <span class="rec-dot"></span> Record → Media Bin
          </button>

          <button type="button" class="mini-btn wide" id="trip-bake"
                  title="Reverse-map this shader config into an FFmpeg workflow you can run on a full-length file at full quality.">
            🔥 Bake to FFmpeg workflow
          </button>
        </div>
      </aside>

      <input type="file" id="trip-upload" accept="video/*,image/*" hidden>`;

    // Sliders
    const list = tab.querySelector('#trip-slider-list');
    list.innerHTML = SLIDERS.map(([k, label, min, max, step]) => `
      <div class="trip-slider">
        <label for="trip-${k}">${label}</label>
        <input type="range" id="trip-${k}" min="${min}" max="${max}" step="${step}"
               value="${window.TripCam.DEFAULTS[k]}">
        <input type="number" id="trip-${k}-n" min="${min}" max="${max}" step="${step}"
               value="${window.TripCam.DEFAULTS[k]}" class="trip-num">
      </div>`).join('');

    bind(tab);
  }

  // ---------------------------------------------------------------------------
  // SOURCES
  // ---------------------------------------------------------------------------

  function ensureEngine() {
    if (engine) return engine;
    const cv = document.getElementById('trip-canvas');
    try {
      engine = new window.TripCam.TripEngine(cv);
      engine.start();
      window.logToConsole?.('ok', '[trip] WebGL engine started.');
    } catch (e) {
      window.logToConsole?.('error', `[trip] ${e.message}`);
    }
    return engine;
  }

  function stopSource() {
    srcStream?.getTracks().forEach(t => t.stop());
    srcStream = null;
    if (srcVideo) { srcVideo.pause(); srcVideo.srcObject = null; srcVideo.removeAttribute('src'); }
    engine?.detachAudio();
  }

  function mkVideo() {
    if (srcVideo) return srcVideo;
    srcVideo = document.createElement('video');
    srcVideo.muted = true; srcVideo.playsInline = true; srcVideo.loop = true;
    return srcVideo;
  }

  let facing = 'user';
  async function useWebcam() {
    stopSource();
    srcStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: 1280, height: 720 }, audio: false,
    });
    const v = mkVideo();
    v.srcObject = srcStream;
    await v.play();
    ensureEngine()?.setSource(v);
    hideEmpty();
  }

  async function useScreen() {
    stopSource();
    srcStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const v = mkVideo();
    v.srcObject = srcStream;
    await v.play();
    ensureEngine()?.setSource(v);
    hideEmpty();
  }

  /** The critical one: any file already in the Media Bin, through the shaders. */
  async function useBinFile(id) {
    const m = (window.state?.mediaBin || []).find(x => x.id === id);
    if (!m) return;
    stopSource();
    const v = mkVideo();
    v.src = m.blobUrl;
    v.muted = false;
    await v.play().catch(() => {});
    const e = ensureEngine();
    e?.setSource(v);
    // Audio-reactive against THIS track, not the microphone.
    if (document.getElementById('trip-audio')?.checked) e?.attachAudio(v);
    hideEmpty();
    window.logToConsole?.('', `[trip] source → ${m.name}`);
  }

  async function useUpload(file) {
    stopSource();
    const v = mkVideo();
    v.src = URL.createObjectURL(file);
    v.muted = false;
    await v.play().catch(() => {});
    ensureEngine()?.setSource(v);
    hideEmpty();
  }

  const hideEmpty = () => document.getElementById('trip-empty')?.setAttribute('hidden', '');

  // ---------------------------------------------------------------------------
  // BIND
  // ---------------------------------------------------------------------------

  function bind(tab) {
    const $ = (s) => tab.querySelector(s);

    $('#trip-source').addEventListener('change', async (e) => {
      const v = e.target.value;
      $('#trip-bin-wrap').hidden = v !== 'bin';
      try {
        if (v === 'webcam') await useWebcam();
        else if (v === 'screen') await useScreen();
        else if (v === 'upload') $('#trip-upload').click();
        else if (v === 'bin') {
          const sel = $('#trip-bin-file');
          sel.innerHTML = (window.state?.mediaBin || [])
            .map(m => `<option value="${m.id}">${m.name}</option>`).join('')
            || '<option value="">(bin is empty)</option>';
          if (sel.value) await useBinFile(sel.value);
        }
      } catch (err) {
        window.logToConsole?.('error', `[trip] ${err.message}`);
      }
    });

    $('#trip-bin-file').addEventListener('change', (e) => useBinFile(e.target.value));
    $('#trip-upload').addEventListener('change', (e) => { if (e.target.files[0]) useUpload(e.target.files[0]); });

    $('#trip-flip').addEventListener('click', async () => {
      facing = facing === 'user' ? 'environment' : 'user';
      if (srcStream) await useWebcam();
    });

    $('#trip-freeze').addEventListener('click', (e) => {
      const on = !engine?.frozen;
      engine?.freeze(on);
      e.target.textContent = on ? '▶ Unfreeze' : '❄️ Freeze';
    });

    $('#trip-effect').addEventListener('change', (e) => ensureEngine()?.setEffect(e.target.value));

    $('#trip-preset').addEventListener('change', (e) => {
      const en = ensureEngine();
      en?.applyPreset(e.target.value);
      syncSliders();
    });

    $('#trip-audio').addEventListener('change', (e) => {
      const on = e.target.checked;
      $('#trip-route-wrap').hidden = !on;
      $('#trip-amt-wrap').hidden = !on;
      if (!on) return ensureEngine()?.detachAudio();

      const en = ensureEngine();
      en?.setAudioRoute($('#trip-audio-route').value);
      if (srcVideo && srcVideo.src) en?.attachAudio(srcVideo);          // the bin track
      else navigator.mediaDevices.getUserMedia({ audio: true })
             .then(s => en?.attachAudio(s))                             // or the mic
             .catch(() => {});
    });

    $('#trip-audio-route').addEventListener('change', (e) =>
      ensureEngine()?.setAudioRoute(e.target.value));

    $('#trip-audio-amt').addEventListener('input', (e) => {
      const en = ensureEngine();
      if (en) en.audioAmount = parseFloat(e.target.value);
    });

    // ---- Rotation ----
    $('#trip-rot').addEventListener('input', (e) =>
      window.FFShaderPlus.Rotation.setDegrees(+e.target.value));

    $('#trip-tilt').addEventListener('change', (e) => {
      window.FFShaderPlus.Rotation.followOrientation(e.target.checked);
      $('#trip-rot').disabled = e.target.checked;
    });

    // ---- Auto-glitch (chaos) ----
    $('#trip-chaos').addEventListener('change', (e) => {
      $('#trip-chaos-opts').hidden = !e.target.checked;
      const en = ensureEngine();
      if (!en) return;
      if (!chaos) chaos = new window.FFShaderPlus.ChaosEngine(en);
      e.target.checked ? chaos.start() : chaos.stop();
    });

    $('#chaos-freq').addEventListener('input', (e) => {
      const mid = +e.target.value;
      chaos?.setConfig({ intervalMs: [mid * 0.5, mid * 1.5] });
    });
    $('#chaos-heavy').addEventListener('input', (e) =>
      chaos?.setConfig({ heavyProb: +e.target.value / 100 }));
    $('#chaos-now').addEventListener('click', () => {
      const en = ensureEngine();
      if (!chaos && en) chaos = new window.FFShaderPlus.ChaosEngine(en);
      chaos?.fire(true);
    });

    // ---- Sparkles, emitted on the treble ----
    $('#trip-sparkle').addEventListener('change', (e) => {
      if (!e.target.checked) { sparkles?.clear(); sparkles = null; return; }
      const overlay = document.getElementById('trip-canvas');
      sparkles = new window.FFShaderPlus.Sparkles(overlay);
      const loop = () => {
        if (!sparkles) return;
        sparkles.step(engine?.bands);
        requestAnimationFrame(loop);
      };
      loop();
    });

    for (const [k] of SLIDERS) {
      const r = $(`#trip-${k}`), n = $(`#trip-${k}-n`);
      const set = (v) => { ensureEngine()?.setParam(k, parseFloat(v)); r.value = v; n.value = v; };
      r.addEventListener('input', () => set(r.value));
      n.addEventListener('input', () => set(n.value));
    }

    $('#trip-random').addEventListener('click', () => {
      const en = ensureEngine();
      en?.randomize();
      $('#trip-effect').value = en.effect;
      syncSliders();
    });

    $('#trip-reset').addEventListener('click', () => {
      ensureEngine()?.setParams({ ...window.TripCam.DEFAULTS });
      syncSliders();
    });

    $('#trip-snap').addEventListener('click', async () => {
      const blob = await ensureEngine()?.snapshot();
      if (blob) {
        await window.addBlobToBin?.(blob, `tripcam-${Date.now()}.png`, 'image/png');
        window.logToConsole?.('ok', 'Snapshot → Media Bin.');
      }
    });

    $('#trip-rec-btn').addEventListener('click', () => {
      const cv = document.getElementById('trip-canvas');
      if (document.getElementById('trip-rec-btn').classList.contains('recording')) window.TripCam.stopRec();
      else window.TripCam.startRec(cv, 30);
    });

    $('#trip-bake').addEventListener('click', () => {
      if (engine) window.TripCam.bakeToFFmpeg(engine);
    });

    $('#trip-min').addEventListener('click', () => {
      $('#trip-body').hidden = !$('#trip-body').hidden;
    });
  }

  function syncSliders() {
    if (!engine) return;
    for (const [k] of SLIDERS) {
      const r = document.getElementById(`trip-${k}`);
      const n = document.getElementById(`trip-${k}-n`);
      if (r) r.value = engine.params[k];
      if (n) n.value = engine.params[k];
    }
  }

  // ===========================================================================
  // EDITOR ⚡ LIVE PREVIEW
  // ---------------------------------------------------------------------------
  // The Editor's FFmpeg sliders drive the TRIP shaders at 60fps. This is what
  // kills the 5-to-30-second render-to-see-a-change loop.
  // ===========================================================================

  const UNIFORM_MAP = [
    ['eq-brightness',      'brightness',        (v) => +v],
    ['eq-contrast',        'contrast',          (v) => +v],
    ['eq-saturation',      'saturation',        (v) => +v],
    ['hue-shift',          'hueShiftSpeed',     (v) => +v / 360],
    ['vignette-angle',     'vignetteStrength',  (v) => +v],
    ['g-lagfun-decay',     'trailPersistence',  (v) => +v],
    ['g-geq-intensity',    'glitchStrength',    (v) => +v / 100],
    ['noise-strength',     'glitchStrength',    (v) => +v / 100],
    ['crt-curvature',      'curvatureAmount',   (v) => +v],
    ['scanline-opacity',   'scanlineIntensity', (v) => +v],
    ['chroma-rh',          'phosphorOffset',    (v) => Math.abs(+v) / 1000],
  ];

  const TEMPORAL = ['enable-19', 'g-tmix-enable', 'g-tblend-enable', 'reverse-video'];

  let liveEngine = null, liveRaf = 0;

  function startLive() {
    const video  = document.getElementById('preview-video') || document.querySelector('#preview-wrapper video');
    const canvas = document.getElementById('live-canvas');
    if (!video || !canvas) return;

    canvas.hidden = false;
    if (!liveEngine) {
      try { liveEngine = new window.TripCam.TripEngine(canvas); }
      catch (e) { return window.logToConsole?.('error', `[live] ${e.message}`); }
      liveEngine.setEffect('colorshift');   // closest analogue to a colour-grade chain
    }
    liveEngine.setSource(video);
    liveEngine.start();
    pushEditorParams();

    // Temporal filters cannot be approximated in a fragment shader. Say so.
    const badge = document.getElementById('live-badge');
    const temporal = TEMPORAL.some((id) => document.getElementById(id)?.checked);
    if (badge) {
      badge.hidden = false;
      badge.textContent = temporal
        ? '⚡ Live preview — temporal effects (tmix/tblend/reverse) render on export'
        : '⚡ Live preview — ~approximate';
    }
  }

  function stopLive() {
    liveEngine?.stop();
    const c = document.getElementById('live-canvas');
    if (c) c.hidden = true;
    const b = document.getElementById('live-badge');
    if (b) b.hidden = true;
  }

  function pushEditorParams() {
    if (!liveEngine) return;
    for (const [id, uni, fn] of UNIFORM_MAP) {
      const el = document.getElementById(id);
      if (!el) continue;
      const sec = el.closest('[id^="section-"]');
      const toggle = sec ? document.getElementById(sec.id.replace('section-', 'enable-')) : null;
      if (toggle && !toggle.checked) continue;               // section is off — skip
      const v = fn(el.value);
      if (isFinite(v)) liveEngine.setParam(uni, v);
    }
  }

  function bindLive() {
    const toggle = document.getElementById('live-toggle');
    if (toggle) {
      toggle.addEventListener('change', (e) => (e.target.checked ? startLive() : stopLive()));
    }
    // Any editor control change pushes straight to the GPU. 60fps feedback.
    document.addEventListener('input', (e) => {
      if (liveEngine && e.target.closest?.('#controls-column, .controls-column')) pushEditorParams();
    }, true);
  }

  // ---------------------------------------------------------------------------

  function init() {
    if (!window.TripCam) return;
    buildTab();
    bindLive();
  }

  /**
   * Publish the live preview's shader config so the HARDWARE ENCODE can use it.
   *
   * Without this, `state.liveShaderEffect` was read by the hardware path in
   * app.js and never set by anything — so the encode always got a NULL shader.
   * The ⚡ Live preview showed one thing and the export produced another.
   * The preview is only worth having if what you see is what you get.
   */
  function getLiveConfig() {
    const on = document.getElementById('live-toggle')?.checked;
    if (!on || !liveEngine) return null;
    pushEditorParams();                       // make sure it's current
    return { effect: liveEngine.effect, params: { ...liveEngine.params } };
  }

  window.TripCamUI = { init, startLive, stopLive, useBinFile, getLiveConfig };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
