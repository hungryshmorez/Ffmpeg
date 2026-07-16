/* =============================================================================
   compositor-ui.js — THE LAYER COMPOSITOR DECK (SauceLab layer manager)
   -----------------------------------------------------------------------------
   performance.js shipped the ENGINE for this — FFPerf.Compositor stacks video
   sources on a 2D canvas with blend modes, opacity, solo, mute, crossfade and
   per-layer hot cues — but nothing ever drove it. This is the missing surface:
   four layer strips, a live composite canvas, a crossfader and a master.

   Why a 2D canvas and not the WebGL engine: the compositor is a *mixer*, not an
   effect. `globalCompositeOperation` gives us the 16 Porter-Duff/separable blend
   modes for free, and — unlike the shader path — it composites decoded frames
   deterministically, so it can actually be verified headless (see
   .test/compositor.mjs, which reads the composited pixels back).

   It lives inside the VJ tab, appended below the deck once vj-mode has built it.
   ========================================================================== */

(function () {
  'use strict';

  let comp = null;                 // the FFPerf.Compositor instance
  let fileInput = null;            // one hidden <input> reused for every "Load…"
  let pendingLayer = -1;           // which layer a file-picker result lands on

  const log = (m, k = '') => window.logToConsole?.(k, `[comp] ${m}`);
  const modes = () => window.FFPerf?.BLEND_MODES || ['normal'];

  // ---------------------------------------------------------------------------
  // BUILD — inject the panel into the VJ deck (once vj-mode has rendered it).
  // ---------------------------------------------------------------------------
  function build() {
    const deck = document.querySelector('#tab-vj .vj-deck');
    if (!deck || deck.dataset.compBuilt) return;
    if (!window.FFPerf?.Compositor) { log('compositor engine not loaded', 'warn'); return; }
    deck.dataset.compBuilt = '1';

    const N = 4;
    const panel = document.createElement('section');
    panel.className = 'comp';
    panel.id = 'vj-compositor';
    panel.innerHTML = `
      <div class="comp-head">
        <strong>🎛 Layer Compositor</strong>
        <small>Stack sources · blend · solo/mute · crossfade — a deck, not a preview</small>
        <button type="button" id="comp-power" class="mini-btn">▶ Run</button>
      </div>
      <div class="comp-stage"><canvas id="comp-canvas" width="640" height="360"></canvas></div>
      <div class="comp-layers" id="comp-layers">
        ${Array.from({ length: N }, (_, i) => layerStrip(i)).join('')}
      </div>
      <div class="comp-master">
        <label class="comp-xf" title="Crossfade between two layers with one fader — the classic VJ move">
          <span>XFADE</span>
          <select id="comp-xf-a" class="ctrl">${layerOpts(N, 0)}</select>
          <input type="range" id="comp-xf" min="0" max="1" step="0.01" value="0.5">
          <select id="comp-xf-b" class="ctrl">${layerOpts(N, 1)}</select>
        </label>
        <label class="comp-mo" title="Master opacity over the whole stack">
          <span>MASTER</span>
          <input type="range" id="comp-master-op" min="0" max="1" step="0.01" value="1">
        </label>
      </div>`;
    deck.appendChild(panel);

    const canvas = panel.querySelector('#comp-canvas');
    comp = new window.FFPerf.Compositor(canvas, N);

    // one shared hidden file input for all the "Load…" buttons
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'video/*';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', onFilePicked);
    panel.appendChild(fileInput);

    bind(panel);
    syncStrips();
    log(`compositor ready — ${N} layers, ${modes().length} blend modes`, 'ok');
  }

  const layerOpts = (n, sel) =>
    Array.from({ length: n }, (_, i) =>
      `<option value="${i}"${i === sel ? ' selected' : ''}>L${i + 1}</option>`).join('');

  function layerStrip(i) {
    return `
      <div class="comp-layer" data-layer="${i}">
        <div class="comp-layer-top">
          <span class="comp-dot"></span>
          <span class="comp-layer-name" data-name="${i}">Layer ${i + 1}</span>
          <button type="button" class="comp-solo" data-layer="${i}" title="Solo">S</button>
          <button type="button" class="comp-mute" data-layer="${i}" title="Mute">M</button>
        </div>
        <div class="comp-src">
          <button type="button" class="mini-btn comp-load" data-layer="${i}">Load…</button>
          <button type="button" class="mini-btn comp-bin"  data-layer="${i}" title="Load the active Media Bin clip">Bin</button>
          <button type="button" class="mini-btn comp-demo" data-layer="${i}" title="Load a generated demo clip">Demo</button>
        </div>
        <label class="comp-ctl">Blend
          <select class="ctrl comp-blend" data-layer="${i}">
            ${modes().map((m) => `<option value="${m}">${m}</option>`).join('')}
          </select>
        </label>
        <label class="comp-ctl">Opacity
          <input type="range" class="comp-op" data-layer="${i}" min="0" max="1" step="0.01"
                 value="${i === 0 ? 1 : 0}">
        </label>
        <div class="comp-cues" data-layer="${i}" title="Click to jump · Shift+click to set">
          <span>CUES</span>
          ${[0, 1, 2, 3].map((c) => `<button type="button" class="comp-cue" data-layer="${i}" data-c="${c}">${c + 1}</button>`).join('')}
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------------------
  // WIRING
  // ---------------------------------------------------------------------------
  function bind(panel) {
    // Run / stop the composite loop.
    const power = panel.querySelector('#comp-power');
    power.addEventListener('click', () => {
      if (comp.raf) { comp.stop(); power.textContent = '▶ Run'; power.classList.remove('on'); }
      else { comp.start(); power.textContent = '⏸ Stop'; power.classList.add('on'); }
    });

    // Source loading.
    panel.querySelectorAll('.comp-load').forEach((b) =>
      b.addEventListener('click', () => { pendingLayer = +b.dataset.layer; fileInput.click(); }));
    panel.querySelectorAll('.comp-bin').forEach((b) =>
      b.addEventListener('click', () => loadFromBin(+b.dataset.layer)));
    panel.querySelectorAll('.comp-demo').forEach((b) =>
      b.addEventListener('click', () => loadDemo(+b.dataset.layer)));

    // Blend / opacity.
    panel.querySelectorAll('.comp-blend').forEach((s) =>
      s.addEventListener('change', () => { comp.layers[+s.dataset.layer].blendMode = s.value; }));
    panel.querySelectorAll('.comp-op').forEach((r) =>
      r.addEventListener('input', () => { comp.layers[+r.dataset.layer].opacity = +r.value; }));

    // Solo / mute.
    panel.querySelectorAll('.comp-solo').forEach((b) =>
      b.addEventListener('click', () => {
        const l = comp.layers[+b.dataset.layer];
        l.solo = !l.solo; b.classList.toggle('on', l.solo);
      }));
    panel.querySelectorAll('.comp-mute').forEach((b) =>
      b.addEventListener('click', () => {
        const l = comp.layers[+b.dataset.layer];
        l.mute = !l.mute; b.classList.toggle('on', l.mute);
      }));

    // Hot cues — jump on click, set on shift-click. Per layer.
    panel.querySelectorAll('.comp-cue').forEach((b) =>
      b.addEventListener('click', (e) => {
        const li = +b.dataset.layer, slot = +b.dataset.c, l = comp.layers[li];
        if (!l.video) return log(`layer ${li + 1} has no source`, 'warn');
        if (e.shiftKey) {
          l.setCue(slot);
          b.classList.add('set');
          b.title = `${(l.hotCues[slot] || 0).toFixed(2)}s`;
        } else if (l.hotCues[slot] != null) {
          l.jumpCue(slot);
          b.classList.add('hit');
          setTimeout(() => b.classList.remove('hit'), 140);
        }
      }));

    // Crossfader: drive two layers' opacity from one fader, reflect into sliders.
    const xf = panel.querySelector('#comp-xf');
    const applyXfade = () => {
      const a = +panel.querySelector('#comp-xf-a').value;
      const b = +panel.querySelector('#comp-xf-b').value;
      if (a === b) return;
      comp.crossfade(a, b, +xf.value);
      reflectOpacity(a); reflectOpacity(b);
    };
    xf.addEventListener('input', applyXfade);
    panel.querySelector('#comp-xf-a').addEventListener('change', applyXfade);
    panel.querySelector('#comp-xf-b').addEventListener('change', applyXfade);

    // Master opacity.
    panel.querySelector('#comp-master-op').addEventListener('input', (e) => {
      comp.masterOpacity = +e.target.value;
    });
  }

  function reflectOpacity(i) {
    const r = document.querySelector(`.comp-op[data-layer="${i}"]`);
    if (r) r.value = comp.layers[i].opacity;
  }

  // ---------------------------------------------------------------------------
  // SOURCES
  // ---------------------------------------------------------------------------
  async function onFilePicked() {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f || pendingLayer < 0) return;
    await loadInto(pendingLayer, f, f.name);
    pendingLayer = -1;
  }

  async function loadFromBin(i) {
    const m = window.state?.inputFile;
    if (!m || !m.blobUrl) return log('no active clip in the Media Bin', 'warn');
    await loadInto(i, m.blobUrl, m.name || 'bin clip');
  }

  async function loadDemo(i) {
    if (typeof window.generateDemoClip !== 'function') return log('demo generator unavailable', 'warn');
    log(`generating a demo clip for layer ${i + 1}…`);
    try {
      const blob = await window.generateDemoClip();
      await loadInto(i, blob, 'demo');
    } catch (e) { log(`demo failed: ${e.message}`, 'error'); }
  }

  /** Load a File/Blob/URL into a layer and label the strip. Also autostarts. */
  async function loadInto(i, fileOrUrl, name) {
    if (!comp) return;
    try {
      await comp.layers[i].load(fileOrUrl, name);
      const label = document.querySelector(`.comp-layer-name[data-name="${i}"]`);
      if (label) label.textContent = name || `Layer ${i + 1}`;
      const dot = document.querySelector(`.comp-layer[data-layer="${i}"] .comp-dot`);
      if (dot) dot.classList.add('live');
      // Give a freshly loaded layer some presence if it was silent.
      if (comp.layers[i].opacity <= 0.001) { comp.layers[i].opacity = 1; reflectOpacity(i); }
      if (!comp.raf) {
        comp.start();
        const p = document.getElementById('comp-power');
        if (p) { p.textContent = '⏸ Stop'; p.classList.add('on'); }
      }
      log(`layer ${i + 1} ← ${name}`, 'ok');
    } catch (e) { log(`layer ${i + 1} load failed: ${e.message}`, 'error'); }
  }

  /** Reflect the current model into the controls (initial paint / restore). */
  function syncStrips() {
    if (!comp) return;
    comp.layers.forEach((l, i) => {
      const blend = document.querySelector(`.comp-blend[data-layer="${i}"]`);
      if (blend) blend.value = l.blendMode;
      reflectOpacity(i);
    });
  }

  // Public surface (and a test hook: loadInto lets the headless test feed clips
  // straight into a layer without a real file dialog).
  window.FFComp = { build, loadInto, get compositor() { return comp; } };

  // Build when the VJ tab is opened — after vj-mode has rendered the deck.
  // vj-mode registers its click handler at DOMContentLoaded; loading this script
  // after vj-mode means our handler runs second, so `.vj-deck` already exists.
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.querySelector('[data-tab="vj"]');
    btn?.addEventListener('click', () => { requestAnimationFrame(build); });
    // In case the tab is already active on load.
    if (document.getElementById('tab-vj')?.classList.contains('active')) requestAnimationFrame(build);
  });
})();
