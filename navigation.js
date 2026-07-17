/* =============================================================================
   navigation.js — AUDIO / VIDEO MODE SPLIT
   -----------------------------------------------------------------------------
   THE PROBLEM: this app grew to 6 tabs, 32 editor sections and 186 workflows.
   Someone who doesn't already know what's going on opens it and sees a wall.

   THE FIX: one decision at the top — AM I WORKING ON AUDIO OR VIDEO? — and
   everything reshapes around that answer.

       ♪ AUDIO                              ▶ VIDEO
       ├─ Studio    (real-time rack)        ├─ Editor    (32 sections)
       ├─ Workflows (audio only)            ├─ Workflows (video only)
       └─ Master    (LUFS / bounce)         ├─ Trip Cam  (real-time glitch)
                                            ├─ Graph     (node editor)
                                            └─ Preview

   Nothing is removed. Everything is still there. It's just no longer all
   shouting at you simultaneously.

   The Media Bin stays global — it is shared by both modes, because a file is a
   file.
   ========================================================================== */

(function () {
  'use strict';

  const MODES = {
    audio: {
      label: '♪ Audio',
      hint: 'Music, podcasts, mastering, sound design',
      tabs: [
        { id: 'audio',     label: '🎛 Studio',    hint: 'Live rack — turn a knob, hear it instantly' },
        { id: 'workflows', label: '📋 Workflows', hint: 'One-click recipes for audio' },
        { id: 'preview',   label: '▶ Preview',    hint: 'Compare source and output' },
      ],
      categories: [
        'audio', 'audio-mastering', 'audio-visualization',
        'audio-repair-utility', 'speed-time',
      ],
      accent: '#ff00aa',
    },
    video: {
      label: '▶ Video',
      hint: 'Editing, colour, glitch, export',
      tabs: [
        { id: 'workflows', label: '📋 Workflows', hint: 'One-click recipes for video' },
        { id: 'editor',    label: '✂️ Editor',    hint: 'Every control, 32 sections' },
        { id: 'tripcam',   label: '🌀 Trip Cam',  hint: 'Real-time GPU glitch + webcam' },
        { id: 'vj',        label: '🎚 VJ',        hint: 'Live performance — MIDI, sequencer, hot cues' },
        { id: 'clips',     label: '🎬 Clips',     hint: 'Clip library — reorder takes, export a sequence' },
        { id: 'graph',     label: '⛓️ Graph',     hint: 'Build a filter chain visually' },
        { id: 'preview',   label: '▶ Preview',    hint: 'Compare source and output' },
        { id: 'agents',    label: '🤖 Agents',    hint: 'Batch, chains, history' },
      ],
      categories: [
        'video-editing', 'color-grading', 'glitch-creative',
        'video-glitch-pipelines', 'social-media', 'gif',
        'multi-file-composites', 'retro-analog', 'artistic-stylize',
        'motion-speed', 'utility',
      ],
      accent: '#00d4ff',
    },
  };

  let mode = localStorage.getItem('ffs.mode') || null;

  // ---------------------------------------------------------------------------
  // MODE SWITCHER
  // ---------------------------------------------------------------------------

  function buildModeBar() {
    if (document.getElementById('mode-bar')) return;

    const bar = document.createElement('div');
    bar.id = 'mode-bar';
    bar.className = 'mode-bar';
    bar.innerHTML = Object.entries(MODES).map(([k, m]) => `
      <button type="button" class="mode-btn" data-mode="${k}" style="--accent:${m.accent}">
        <strong>${m.label}</strong>
        <small>${m.hint}</small>
      </button>`).join('') + `
      <button type="button" class="mode-btn mode-both" data-mode="both">
        <strong>⚙ Everything</strong>
        <small>Show all tabs at once</small>
      </button>`;

    // Slot it directly under the top bar, above the tabs.
    const tabBar = document.querySelector('.tab-bar');
    tabBar?.parentNode.insertBefore(bar, tabBar);

    bar.addEventListener('click', (e) => {
      const b = e.target.closest('.mode-btn');
      if (b) setMode(b.dataset.mode);
    });
  }

  function setMode(m) {
    mode = m;
    localStorage.setItem('ffs.mode', m);

    document.querySelectorAll('.mode-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === m));

    const cfg = MODES[m];
    const allow = cfg ? new Set(cfg.tabs.map((t) => t.id)) : null;   // null = show everything

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      const id = btn.dataset.tab;
      const show = !allow || allow.has(id);
      btn.hidden = !show;
      if (cfg) {
        const t = cfg.tabs.find((x) => x.id === id);
        if (t) { btn.textContent = t.label; btn.title = t.hint; }
      }
    });

    document.documentElement.style.setProperty('--mode-accent', cfg?.accent || '#00d4ff');
    document.body.dataset.mode = m;

    // If the current tab isn't in this mode, jump to the mode's first tab.
    const cur = document.querySelector('.tab-btn.active')?.dataset.tab;
    if (cfg && !allow.has(cur)) window.switchTab?.(cfg.tabs[0].id);

    filterWorkflows();
    window.logToConsole?.('', `[mode] ${m}`);
  }

  // ---------------------------------------------------------------------------
  // WORKFLOW SUB-TABS  (Audio / Video / All)
  // ---------------------------------------------------------------------------

  function buildWorkflowSubTabs() {
    const tab = document.getElementById('tab-workflows');
    if (!tab || document.getElementById('wf-subtabs')) return;

    const bar = document.createElement('div');
    bar.id = 'wf-subtabs';
    bar.className = 'wf-subtabs';
    bar.innerHTML = `
      <button type="button" class="wf-sub" data-sub="all">All</button>
      <button type="button" class="wf-sub" data-sub="audio">♪ Audio</button>
      <button type="button" class="wf-sub" data-sub="video">▶ Video</button>`;

    // Above the search box.
    const search = tab.querySelector('input[type="search"], #wf-search, .wf-search');
    (search?.parentNode || tab).insertBefore(bar, search || tab.firstChild);

    bar.addEventListener('click', (e) => {
      const b = e.target.closest('.wf-sub');
      if (!b) return;
      bar.querySelectorAll('.wf-sub').forEach((x) => x.classList.toggle('active', x === b));
      window._wfSub = b.dataset.sub;
      filterWorkflows();
    });
  }

  /** Hide workflow cards that don't belong to the active mode / sub-tab. */
  function filterWorkflows() {
    const sub = window._wfSub || (mode === 'audio' ? 'audio' : mode === 'video' ? 'video' : 'all');

    document.querySelectorAll('.wf-sub').forEach((b) =>
      b.classList.toggle('active', b.dataset.sub === sub));

    const audioCats = new Set(MODES.audio.categories);
    const videoCats = new Set(MODES.video.categories);

    let shown = 0;
    document.querySelectorAll('.workflow-card, .wf-card').forEach((card) => {
      const cat = card.dataset.category || card.dataset.cat || '';
      const isAudio = audioCats.has(cat);
      const isVideo = videoCats.has(cat);
      const show = sub === 'all' || (sub === 'audio' && isAudio) || (sub === 'video' && isVideo);
      card.hidden = !show;
      if (show) shown++;
    });

    // Hide category pills that have no visible cards in this sub-tab.
    document.querySelectorAll('.wf-cat-pill').forEach((pill) => {
      const c = pill.dataset.cat;
      if (c === 'all' || c === 'my-custom') return;
      const inAudio = audioCats.has(c), inVideo = videoCats.has(c);
      pill.hidden = !(sub === 'all' || (sub === 'audio' && inAudio) || (sub === 'video' && inVideo));
    });

    const counter = document.getElementById('wf-count');
    if (counter) counter.textContent = `${shown} workflow${shown === 1 ? '' : 's'}`;
  }

  // ---------------------------------------------------------------------------
  // FIRST RUN — one question, not a wall.
  // ---------------------------------------------------------------------------

  function firstRun() {
    if (mode) return;                                    // already chosen once

    const ov = document.createElement('div');
    ov.className = 'firstrun';
    ov.innerHTML = `
      <div class="firstrun-card">
        <h1>FFmpeg Studio</h1>
        <p class="fr-sub">Everything runs in your browser. Nothing is uploaded, ever.</p>
        <p class="fr-q">What are you working on?</p>
        <div class="fr-choices">
          <button type="button" class="fr-choice" data-mode="audio" style="--accent:#ff00aa">
            <span class="fr-icon">♪</span>
            <strong>Audio</strong>
            <small>Slowed + reverb, mastering, podcasts, sound design.<br>
                   <em>Live rack — turn a knob, hear it instantly.</em></small>
          </button>
          <button type="button" class="fr-choice" data-mode="video" style="--accent:#00d4ff">
            <span class="fr-icon">▶</span>
            <strong>Video</strong>
            <small>Editing, colour grading, glitch, export.<br>
                   <em>Real-time GPU preview + 180 one-click recipes.</em></small>
          </button>
        </div>
        <button type="button" class="fr-skip" data-mode="both">Show me everything →</button>
      </div>`;
    document.body.appendChild(ov);

    ov.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      setMode(b.dataset.mode);
      ov.classList.add('out');
      setTimeout(() => ov.remove(), 300);
    });
  }

  // ---------------------------------------------------------------------------
  // ROUTE A BIN FILE TO THE RIGHT PLACE
  // ---------------------------------------------------------------------------
  // Click an audio file in the bin → it opens in the Audio Studio.
  // Click a video file → it opens in the Video Editor. Obvious, and previously
  // not the case.
  // ---------------------------------------------------------------------------

  function routeMedia(media) {
    if (!media) return;
    const isAudio = media.type === 'audio' ||
                    (media.mime || '').startsWith('audio/') ||
                    (!media.hasVideo && media.hasAudio);

    if (isAudio && mode !== 'video') {
      window.switchTab?.('audio');
      window.FFAudioStudio?.loadFromBin(media.id);
    }
  }

  // ---------------------------------------------------------------------------

  function init() {
    buildModeBar();
    buildWorkflowSubTabs();
    if (mode) setMode(mode); else firstRun();

    // Re-filter whenever the workflow grid re-renders.
    const grid = document.querySelector('.workflows-grid');
    if (grid) new MutationObserver(() => filterWorkflows()).observe(grid, { childList: true });
  }

  window.FFNav = { setMode, filterWorkflows, routeMedia, MODES, mode: () => mode };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
