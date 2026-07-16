/* =============================================================================
 * FFmpeg Studio v2 — Agent Tools Hub (8 cards)
 * -----------------------------------------------------------------------------
 * Cards:
 *   1. FFmpeg Command Builder (AI)        — NL → workflow settings via keyword match
 *   2. Batch Command Queue                 — multi-workflow sequential runner
 *   3. Command History                     — every command this session, with re-run
 *   4. Custom Workflow Creator             — capture Editor state → localStorage
 *   5. The Audio Master                    — chains 81-99, personality quote
 *   6. The Datamosh Dealer                 — chains 100-110, personality quote
 *   7. Surreal WAiFF Director              — combined audio+video selector
 *   8. Vaporwave Audio Library             — 16 tracks from CDN, fetch → MEMFS
 * ============================================================================= */

'use strict';

// =============================================================================
// VAPORWAVE LIBRARY
// =============================================================================
const VAPORWAVE_CDN = 'https://Glif.b-cdn.net/Midnight/';
const VAPORWAVE_TRACKS = [
  { name: 'S A V E _ Y O U R _ T E A R S.wav',      file: 'S%20A%20V%20E%20_%20Y%20O%20U%20R%20_%20T%20E%20A%20R%20S.wav' },
  { name: '1.------------=----------=.wav',          file: '1.------------=----------=.wav' },
  { name: 'datastream sunset.wav',                  file: 'datastream%20sunset.wav' },
  { name: 'the sound of abandoned websites.wav',    file: 'the%20sound%20of%20abandoned%20websites.wav' },
  { name: '3am dream compression.wav',              file: '3am%20dream%20compression.wav' },
  { name: 'cloud cache forever.wav',                file: 'cloud%20cache%20forever.wav' },
  { name: 'elevator musak for the future.wav',     file: 'elevator%20musak%20for%20the%20future.wav' },
  { name: 'endless summer on betamax.wav',          file: 'endless%20summer%20on%20betamax.wav' },
  { name: 'hologram in my heart.wav',               file: 'hologram%20in%20my%20heart.wav' },
  { name: 'hyperlink halo.wav',                     file: 'hyperlink%20halo.wav' },
  { name: 'Lost Signals (windows 97 Mix).wav',      file: 'Lost%20Signals%20(windows%2097%20Mix).wav' },
  { name: 'midnight at the virtual mall.wav',       file: 'midnight%20at%20the%20virtual%20mall.wav' },
  { name: 'simulated emotions.wav',                 file: 'simulated%20emotions.wav' },
  { name: 'static drift anthem.wav',                file: 'static%20drift%20anthem.wav' },
  { name: 'supermarket nostalgia.wav',              file: 'supermarket%20nostalgia.wav' },
  { name: 'Voices in the datacloud.wav',            file: 'Voices%20in%20the%20datacloud.wav' },
];

// =============================================================================
// AGENT UI BOOT
// =============================================================================
function initAgentsUI() {
  const grid = document.getElementById('agents-grid');
  if (!grid) return;
  grid.innerHTML = AGENT_CARDS.map(cardHtml).join('');
  // Bind all the buttons / interactive bits
  bindAgentNLBuilder();
  bindAgentBatchQueue();
  bindAgentCustomCreator();
  bindAgentAudioMaster();
  bindAgentDatamoshDealer();
  bindAgentWaiffDirector();
  bindAgentVaporwaveLibrary();
  // v3 PART E — bind the four new agent cards
  bindAgentVisualizer();
  bindAgentCompositor();
  bindAgentChainBuilder();
  bindAgentBatchRunner();
  // v4 PART B2 — The Beat Sync Director
  bindAgentBeatSync();
  // Render the command history list (used by the History card)
  if (typeof renderCommandHistory === 'function') renderCommandHistory();
}

function cardHtml(c) {
  return `
    <article class="agent-card" data-agent="${c.id}">
      <div class="agent-icon">${escapeHtml(c.icon)}</div>
      <div class="agent-name">${escapeHtml(c.name)}</div>
      <p class="agent-desc">${escapeHtml(c.desc)}</p>
      ${c.quote ? `<p class="agent-quote">${escapeHtml(c.quote)}</p>` : ''}
      ${c.note ? `<p class="agent-note">${escapeHtml(c.note)}</p>` : ''}
      <div class="agent-actions">
        ${c.actions.map(a => `<button type="button" class="primary-btn" data-agent-action="${c.id}:${a.id}">${escapeHtml(a.label)}</button>`).join('')}
      </div>
      <div class="agent-panel" data-agent-panel="${c.id}"></div>
    </article>
  `;
}

const AGENT_CARDS = [
  {
    id: 'nl-builder',
    name: 'FFmpeg Command Builder (AI)',
    icon: '🧠',
    desc: 'Describe what you want to do in plain English. Local keyword matching maps your description to the right workflow settings. No API call.',
    actions: [{ id: 'open', label: 'Open Builder' }],
  },
  {
    id: 'batch-queue',
    name: 'Batch Command Queue',
    icon: '📋',
    desc: 'Queue multiple workflows and run them in sequence. Each output feeds the next as input. Add by workflow ID, drag to reorder, then Run All.',
    actions: [{ id: 'open', label: 'Open Queue' }],
  },
  {
    id: 'command-history',
    name: 'Command History',
    icon: '🕒',
    desc: 'Every command executed this session, with timestamp, status, and a one-click Re-run.',
    actions: [{ id: 'clear', label: 'Clear History' }],
  },
  {
    id: 'custom-creator',
    name: 'Custom Workflow Creator',
    icon: '⭐',
    desc: 'Save the current Editor state as a custom workflow. Stored in localStorage; appears in the Workflows tab alongside built-ins.',
    actions: [{ id: 'open', label: 'Save Current' }],
  },
  {
    id: 'audio-master',
    name: 'The Audio Master',
    icon: '🎧',
    desc: 'Elite audio engineer. Drop a file, give me a task, or pick a mastering chain from the 20 references.',
    quote: 'I am the FFmpeg Audio Master. Drop an audio file, give me a task, or pick a mastering chain.',
    actions: [{ id: 'open', label: 'Open Panel' }],
  },
  {
    id: 'datamosh-dealer',
    name: 'The Datamosh Dealer',
    icon: '👾',
    desc: 'Your co-pilot for visual chaos. Combines glitch art, datamoshing, lagfun trails, RGB corruption.',
    quote: 'The Datamosh Dealer. Your co-pilot for visual chaos.',
    actions: [{ id: 'open', label: 'Open Panel' }],
  },
  {
    id: 'waiff-director',
    name: 'Surreal WAiFF Director',
    icon: '🎬',
    desc: 'Audio-visual sync specialist. Pick an audio chain and a video glitch pipeline and Sync & Process to apply both to your file.',
    note: 'Processes audio first, then applies video effects to the same file.',
    actions: [{ id: 'open', label: 'Open Panel' }],
  },
  {
    id: 'vaporwave-library',
    name: 'Vaporwave Audio Library',
    icon: '📼',
    desc: '16 vaporwave/slushwave tracks hosted on CDN. Use as Source to load a track directly into the editor. If CORS blocks, the link is provided.',
    actions: [{ id: 'open', label: 'Open Library' }],
  },
  // ============= v3 PART E — four new agent cards (9-12) =============
  {
    id: 'the-visualizer',
    name: 'The Visualizer',
    icon: '📊',
    desc: 'Turns audio into video. Pick a track from the bin or the Vaporwave Library, pick a visualization style, optionally a background image, hit Generate. Produces an audiogram / music-video. Presets: Waveform Line, Spectrum Fire, CQT, Vinyl Spin, Podcast Square.',
    quote: 'I take the sound and I paint with it. What shall we make today?',
    actions: [{ id: 'open', label: 'Open Visualizer' }],
  },
  {
    id: 'the-compositor',
    name: 'The Compositor',
    icon: '🧩',
    desc: 'Multi-file operations, guided. Shows the media bin, lets you pick a composite mode (concat / hstack / vstack / grid / PiP / crossfade / green screen), preview the layout as a wireframe, then render.',
    quote: 'Many pieces, one picture.',
    actions: [{ id: 'open', label: 'Open Compositor' }],
  },
  {
    id: 'chain-builder',
    name: 'The Chain Builder',
    icon: '⛓️',
    desc: 'Visual pipeline builder. Drag workflow cards into an ordered chain. Each step\'s output feeds the next. Save the whole chain as a custom named workflow (persisted to localStorage).',
    quote: 'One click to do the whole 6-step thing — forever.',
    actions: [{ id: 'open', label: 'Open Chain Builder' }],
  },
  {
    id: 'batch-runner',
    name: 'The Batch Runner',
    icon: '⚡',
    desc: 'Select N files in the bin + one workflow → runs it on every file sequentially (max 2 concurrent to avoid OOM), shows a per-file progress table, and dumps all results back into the bin. Includes a Download All as ZIP button.',
    quote: 'N inputs, one workflow, all the outputs.',
    actions: [{ id: 'open', label: 'Open Batch Runner' }],
  },
  // v4 PART B2 — The Beat Sync Director (Agent 13).
  // Front-end for the beat-detection + sync-to-beats panel that lives in
  // the Editor tab. This card is mostly documentation + a shortcut to
  // open the Editor and jump to the panel.
  {
    id: 'beat-sync',
    name: 'The Beat Sync Director',
    icon: '🥁',
    desc: 'Detect beats in the active audio (spectral-flux onsets + median-interval BPM) and auto-generate enable= expressions for any visual effect. Pick an effect, pick a trigger cadence, and the filter fires on every kick.',
    quote: 'I hear structure. I see structure. I sync the chaos.',
    actions: [
      { id: 'open-editor', label: 'Open in Editor' },
      { id: 'detect',      label: 'Detect Beats Now' },
    ],
  },
];

// =============================================================================
// AGENT 1: NL BUILDER
// =============================================================================
function bindAgentNLBuilder() {
  const btn = document.querySelector('[data-agent-action="nl-builder:open"]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    showModal('FFmpeg Command Builder (AI)', `
      <p>Describe what you want to do in plain English. Examples:</p>
      <ul>
        <li><code>make this look like VHS from 1987</code></li>
        <li><code>slow it down to half speed</code></li>
        <li><code>extract the audio as mp3</code></li>
        <li><code>reverse and add glitch</code></li>
      </ul>
      <textarea id="nl-input" placeholder="Describe your edit…"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button type="button" class="primary-btn" id="nl-apply">Apply to Editor</button>
        <button type="button" class="primary-btn" id="nl-apply-run">Apply &amp; Run</button>
      </div>
    `);
    document.getElementById('nl-apply').addEventListener('click', () => {
      const txt = document.getElementById('nl-input').value;
      const result = nlToFFmpegCommand(txt);
      if (result.error) {
        showInfo('No Match', result.error);
        return;
      }
      // Build a temporary workflow object and apply it
      const tempWf = {
        id: 'nl-temp',
        name: result.name,
        category: 'custom',
        description: 'Generated from: ' + txt,
        tags: ['nl', 'ai', 'temp'],
        icon: '🧠',
        settings: result.settings,
        outputFormat: result.outputFormat,
        codec: result.codec,
        crf: result.crf,
      };
      WORKFLOWS.unshift(tempWf);
      if (typeof applyAndEditWorkflow === 'function') applyAndEditWorkflow('nl-temp');
      // Remove the temp workflow after a moment so it doesn't pollute
      setTimeout(() => {
        const i = WORKFLOWS.findIndex(w => w.id === 'nl-temp');
        if (i >= 0) WORKFLOWS.splice(i, 1);
      }, 5000);
      closeModal();
    });
    document.getElementById('nl-apply-run').addEventListener('click', async () => {
      const txt = document.getElementById('nl-input').value;
      const result = nlToFFmpegCommand(txt);
      if (result.error) { showInfo('No Match', result.error); return; }
      const tempWf = {
        id: 'nl-temp', name: result.name, category: 'custom',
        description: 'Generated from: ' + txt, tags: ['nl','ai','temp'], icon: '🧠',
        settings: result.settings, outputFormat: result.outputFormat, codec: result.codec, crf: result.crf,
      };
      WORKFLOWS.unshift(tempWf);
      if (typeof applyAndRunWorkflow === 'function') await applyAndRunWorkflow('nl-temp');
      const i = WORKFLOWS.findIndex(w => w.id === 'nl-temp');
      if (i >= 0) WORKFLOWS.splice(i, 1);
      closeModal();
    });
  });
}

// =============================================================================
// AGENT 2: BATCH QUEUE
// =============================================================================
function bindAgentBatchQueue() {
  const btn = document.querySelector('[data-agent-action="batch-queue:open"]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    renderBatchQueue();
  });
}

function renderBatchQueue() {
  const panel = document.querySelector('[data-agent-panel="batch-queue"]');
  if (!panel) return;
  panel.innerHTML = `
    <div class="queue-add">
      <select id="bq-select" class="ctrl">
        <option value="">— Add a workflow —</option>
        ${WORKFLOWS.map(w => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`).join('')}
      </select>
      <button type="button" class="mini-btn" id="bq-add">Add</button>
    </div>
    <div class="queue-list" id="bq-list"></div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button type="button" class="primary-btn" id="bq-run">Run All</button>
      <button type="button" class="danger-btn" id="bq-clear">Clear Queue</button>
    </div>
  `;
  document.getElementById('bq-add').addEventListener('click', () => {
    const sel = document.getElementById('bq-select');
    const id = sel.value;
    if (!id) return;
    const wf = WORKFLOWS.find(w => w.id === id);
    if (!wf) return;
    stateV2.batchQueue.push({ workflowId: wf.id, workflowName: wf.name });
    renderQueueList();
  });
  document.getElementById('bq-run').addEventListener('click', runBatchQueue);
  document.getElementById('bq-clear').addEventListener('click', () => {
    stateV2.batchQueue = [];
    renderQueueList();
  });
  renderQueueList();
}

function renderQueueList() {
  const el = document.getElementById('bq-list');
  if (!el) return;
  if (stateV2.batchQueue.length === 0) {
    el.innerHTML = '<em class="muted">Queue is empty. Add workflows above.</em>';
    return;
  }
  el.innerHTML = stateV2.batchQueue.map((q, i) => `
    <div class="queue-item" data-bq-index="${i}" draggable="true">
      <span class="merge-handle">⋮⋮</span>
      <span style="flex:1">${escapeHtml(q.workflowName)}</span>
      <button type="button" class="mini-btn" data-bq-remove="${i}">×</button>
    </div>
  `).join('');
  el.querySelectorAll('[data-bq-remove]').forEach(b => {
    b.addEventListener('click', () => {
      const idx = parseInt(b.dataset.bqRemove, 10);
      stateV2.batchQueue.splice(idx, 1);
      renderQueueList();
    });
  });
  let dragSrc = null;
  el.querySelectorAll('.queue-item').forEach(item => {
    item.addEventListener('dragstart', (e) => { dragSrc = parseInt(item.dataset.bqIndex, 10); });
    item.addEventListener('dragover',  (e) => { e.preventDefault(); });
    item.addEventListener('drop',      (e) => {
      e.preventDefault();
      const dst = parseInt(item.dataset.bqIndex, 10);
      if (dragSrc === null || dragSrc === dst) return;
      const m = stateV2.batchQueue.splice(dragSrc, 1)[0];
      stateV2.batchQueue.splice(dst, 0, m);
      dragSrc = null;
      renderQueueList();
    });
  });
}

async function runBatchQueue() {
  if (stateV2.batchQueue.length === 0) {
    showInfo('Empty Queue', 'Add at least one workflow to the queue first.');
    return;
  }
  if (!state.inputFile) {
    showInfo('No File', 'Load a file first, then Run All.');
    return;
  }
  logToConsole('', `=== Batch queue: ${stateV2.batchQueue.length} workflows ===`);
  for (let i = 0; i < stateV2.batchQueue.length; i++) {
    const q = stateV2.batchQueue[i];
    logToConsole('', `[Batch ${i+1}/${stateV2.batchQueue.length}] ${q.workflowName}`);
    const wf = WORKFLOWS.find(w => w.id === q.workflowId);
    if (!wf) continue;
    if (typeof applyWorkflow === 'function') applyWorkflow(wf.id);
    await new Promise(r => setTimeout(r, 100));
    if (typeof executeFromUI === 'function') await executeFromUI();
  }
  logToConsole('ok', '=== Batch queue complete ===');
  showInfo('Batch Complete', `${stateV2.batchQueue.length} workflows processed. Check the Preview tab for the final output.`);
}

// =============================================================================
// AGENT 3: COMMAND HISTORY (rendering is in app.js; this wires the Clear button)
// =============================================================================
function bindAgentCommandHistory() {
  const btn = document.querySelector('[data-agent-action="command-history:clear"]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    stateV2.commandHistory = [];
    if (typeof renderCommandHistory === 'function') renderCommandHistory();
  });
}

// =============================================================================
// AGENT 4: CUSTOM WORKFLOW CREATOR
// =============================================================================
function bindAgentCustomCreator() {
  const btn = document.querySelector('[data-agent-action="custom-creator:open"]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    showModal('Save Custom Workflow', `
      <div class="control-row">
        <label for="cw-name">Name</label>
        <input type="text" id="cw-name" class="ctrl" value="My Custom Workflow" />
      </div>
      <div class="control-row">
        <label for="cw-desc">Description</label>
        <input type="text" id="cw-desc" class="ctrl" value="Saved from Editor state" />
      </div>
      <div class="control-row">
        <label for="cw-cat">Category</label>
        <select id="cw-cat" class="ctrl">
          ${CATEGORIES.filter(c => c.id !== 'all').map(c => `<option value="${c.id}">${c.label}</option>`).join('')}
          <option value="custom" selected>Custom</option>
        </select>
      </div>
      <p class="muted small">This captures the current Editor control values.</p>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button type="button" class="primary-btn" id="cw-save">Save</button>
      </div>
    `);
    document.getElementById('cw-save').addEventListener('click', () => {
      const name = document.getElementById('cw-name').value.trim() || 'My Custom Workflow';
      const desc = document.getElementById('cw-desc').value.trim() || 'Custom workflow';
      const cat  = document.getElementById('cw-cat').value;
      const wf = createCustomWorkflowFromCurrentState();
      wf.name = name;
      wf.description = desc;
      wf.category = cat;
      const existing = loadCustomWorkflows();
      existing.unshift(wf);
      saveCustomWorkflows(existing);
      stateV2.customWorkflows = existing;
      if (typeof renderWorkflows === 'function') renderWorkflows();
      if (typeof renderCategoryPills === 'function') renderCategoryPills();
      closeModal();
      showInfo('Saved', `Workflow "${name}" saved. Find it in the Workflows tab under "My Custom".`);
    });
  });
}

// =============================================================================
// AGENT 5: THE AUDIO MASTER
// =============================================================================
function bindAgentAudioMaster() {
  const btn = document.querySelector('[data-agent-action="audio-master:open"]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const panel = document.querySelector('[data-agent-panel="audio-master"]');
    if (!panel) return;
    panel.innerHTML = `
      <div class="agent-panel-list" id="am-list">
        ${AUDIO_MASTERING_WORKFLOWS.map(w => `
          <div class="agent-panel-item" data-am-id="${escapeHtml(w.id)}">
            <span class="wf-icon">${escapeHtml(w.icon)}</span>
            <div style="flex:1">
              <div class="wf-name">${escapeHtml(w.name)}</div>
              <div class="agent-note">${escapeHtml(w.description)}</div>
            </div>
            <span class="wf-badge full">⚡ Full</span>
            <span class="wf-badge simplified">⚠️ Simplified</span>
          </div>
        `).join('')}
      </div>
      <p class="muted small">Output format auto-selects WAV for mastering chains. The badge is set after the first run.</p>
    `;
    panel.querySelectorAll('[data-am-id]').forEach(item => {
      item.addEventListener('click', async () => {
        const id = item.dataset.amId;
        const wf = AUDIO_MASTERING_WORKFLOWS.find(w => w.id === id);
        if (!wf) return;
        await runAudioMasteringWorkflow(wf);
      });
    });
  });
}

async function runAudioMasteringWorkflow(wf) {
  if (!state.ffmpeg) { showInfo('Engine', 'Engine not ready yet.'); return; }
  if (!state.inputFile) { showInfo('No File', 'Load an audio or video file first.'); return; }
  if (typeof analyzeMedia === 'function') {
    try { await analyzeMedia(state.inputFile.virtualName); } catch (_) {}
  }
  // Auto-select output format: WAV for mastering
  const of = document.getElementById('out-format');
  if (of) { of.value = 'wav'; of.dispatchEvent(new Event('change', { bubbles: true })); }
  // Enable section 12 (audio)
  const e12 = document.getElementById('enable-12');
  if (e12 && !e12.checked) e12.checked = true;
  const e18 = document.getElementById('enable-18');
  if (e18 && !e18.checked) e18.checked = true;

  // Run full chain first, fall back to simplified on "No such filter"
  let useChain = wf.fullChain;
  let useBadge = 'full';
  const outFile = 'output.wav';
  const inFile = state.inputFile.virtualName;
  const args = ['-i', inFile, '-af', wf.fullChain, '-ar', '44100', '-c:a', 'pcm_s16le', outFile];
  logToConsole('', `Audio Master: ${wf.name} (Full chain)`);
  if (typeof executePipeline === 'function') {
    // Use the pipeline engine for proper error handling & retry
    const steps = [{
      name: 'Full Chain',
      description: 'Apply the full audio mastering chain.',
      args: args,
      inputFile: inFile,
      outputFile: outFile,
    }];
    const retry = [{
      label: 'Simplified fallback',
      args: ['-i', inFile, '-af', wf.simplifiedChain, '-ar', '44100', '-c:a', 'pcm_s16le', outFile],
    }];
    const result = await executePipeline(steps, { retryOnFail: retry });
    if (!result || !result.ok) {
      logToConsole('err', 'Audio mastering failed completely: ' + (result && result.error || ''));
      return;
    }
    // Determine which chain ran by checking the engine log is too expensive;
    // we always show "Full" if it worked. If the pipeline fell back via retry,
    // we know it was Simplified.
    if (result.fellBack) {
      useBadge = 'simplified';
      logToConsole('warn', 'Audio Master: Full chain unavailable — used Simplified chain.');
    }
  } else {
    // Fallback: direct exec
    const data = await executeFFmpeg(args);
    if (!data) {
      logToConsole('warn', 'Full chain failed — retrying with simplified.');
      const data2 = await executeFFmpeg(['-i', inFile, '-af', wf.simplifiedChain, '-ar', '44100', '-c:a', 'pcm_s16le', outFile]);
      if (!data2) return;
      useBadge = 'simplified';
    }
  }
  // Read the result, push to history
  try {
    const data = await state.ffmpeg.readFile(outFile);
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const ext = 'wav';
    const mime = 'audio/wav';
    const blob = new Blob([u8], { type: mime });
    if (state.outputBlobUrl) URL.revokeObjectURL(state.outputBlobUrl);
    state.outputBlobUrl = URL.createObjectURL(blob);
    if (typeof loadOutputPreview === 'function') loadOutputPreview(state.outputBlobUrl, mime);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    state.outputFilename = `output_${ts}.${ext}`;
    if (typeof setDownloadEnabled === 'function') setDownloadEnabled(true);
    if (typeof setOutputInfo === 'function') setOutputInfo({ size: u8.byteLength, mime, filename: state.outputFilename, ext });
    if (typeof pushOutputHistory === 'function') pushOutputHistory({ timestamp: new Date(), workflowName: wf.name, blobUrl: state.outputBlobUrl, size: u8.byteLength, ext, mime });
    if (typeof switchTab === 'function') { switchTab('preview'); setPreviewMode('output'); }
    if (typeof addCommandHistory === 'function') addCommandHistory(`Audio Master: ${wf.name} (${useBadge})`, 'ok');
    logToConsole('ok', `Audio Master complete: ${wf.name} [${useBadge}]`);
  } catch (e) {
    logToConsole('err', 'Failed to read output: ' + (e && e.message || e));
  }
}

// =============================================================================
// AGENT 6: THE DATAMOSH DEALER
// =============================================================================
function bindAgentDatamoshDealer() {
  const btn = document.querySelector('[data-agent-action="datamosh-dealer:open"]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const panel = document.querySelector('[data-agent-panel="datamosh-dealer"]');
    if (!panel) return;
    panel.innerHTML = `
      <div class="agent-panel-list" id="dd-list">
        ${VIDEO_GLITCH_PIPELINES.map(w => `
          <div class="agent-panel-item" data-dd-id="${escapeHtml(w.id)}">
            <span class="wf-icon">${escapeHtml(w.icon)}</span>
            <div style="flex:1">
              <div class="wf-name">${escapeHtml(w.name)}</div>
              <div class="agent-note">${escapeHtml(w.description)}</div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    panel.querySelectorAll('[data-dd-id]').forEach(item => {
      item.addEventListener('click', async () => {
        const wf = VIDEO_GLITCH_PIPELINES.find(w => w.id === item.dataset.ddId);
        if (!wf) return;
        await runVideoGlitchPipeline(wf);
      });
    });
  });
}

async function runVideoGlitchPipeline(wf) {
  if (!state.ffmpeg) { showInfo('Engine', 'Engine not ready yet.'); return; }
  if (!state.inputFile) { showInfo('No File', 'Load a file first.'); return; }
  // v5 motion-mosh workflows are category video-glitch-pipelines but drive a JS
  // engine via run() instead of a pipelineSteps chain — honour that first.
  if (typeof wf.run === 'function') {
    try { await wf.run(); }
    catch (e) { logToConsole('error', `${wf.name} failed: ${e && e.message || e}`); }
    return;
  }
  if (typeof analyzeMedia === 'function') {
    try { await analyzeMedia(state.inputFile.virtualName); } catch (_) {}
  }
  // Build pipeline steps. Each step uses (inputFile, outputFile) -> args.
  // We use intermediate file names so each step chains.
  if (typeof executePipeline !== 'function') {
    showInfo('Pipeline', 'Pipeline engine not loaded.'); return;
  }
  const inFile = state.inputFile.virtualName;
  const steps = [];
  // If wf has a 'pipelineSteps' function array, use it
  if (Array.isArray(wf.pipelineSteps)) {
    let curInput = inFile;
    for (let i = 0; i < wf.pipelineSteps.length; i++) {
      const s = wf.pipelineSteps[i];
      const outFile = i === wf.pipelineSteps.length - 1 ? 'output.mp4' : `pipeline_${i+1}.mp4`;
      const args = (typeof s.args === 'function') ? s.args(curInput, outFile) : (s.args || []);
      steps.push({
        name: s.name,
        description: s.description,
        args,
        inputFile: curInput,
        outputFile: outFile,
      });
      curInput = outFile;
    }
  } else if (wf.fallbackArgs) {
    // Single-step with a retry-fallback
    const outFile = 'output.mp4';
    const args = (typeof wf.pipelineSteps[0].args === 'function') ? wf.pipelineSteps[0].args(inFile, outFile) : [];
    steps.push({
      name: wf.pipelineSteps[0].name,
      description: wf.pipelineSteps[0].description,
      args,
      inputFile: inFile,
      outputFile: outFile,
    });
    const fbArgs = wf.fallbackArgs(inFile, outFile);
    steps.retryStrategies = [{ label: 'Fallback without rgbashift', args: fbArgs }];
  }
  const result = await executePipeline(steps, { retryStrategies: steps.retryStrategies || [] });
  if (!result || !result.ok) {
    if (result && result.partialData) {
      logToConsole('warn', 'Pipeline partially completed — showing last good intermediate.');
    } else {
      showInfo('Datamosh', 'Pipeline failed. See log for details.');
      return;
    }
  }
  const outFile = steps[steps.length - 1].outputFile;
  try {
    const data = await state.ffmpeg.readFile(outFile);
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const mime = 'video/mp4';
    const blob = new Blob([u8], { type: mime });
    if (state.outputBlobUrl) URL.revokeObjectURL(state.outputBlobUrl);
    state.outputBlobUrl = URL.createObjectURL(blob);
    if (typeof loadOutputPreview === 'function') loadOutputPreview(state.outputBlobUrl, mime);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    state.outputFilename = `output_${ts}.mp4`;
    if (typeof setDownloadEnabled === 'function') setDownloadEnabled(true);
    if (typeof setOutputInfo === 'function') setOutputInfo({ size: u8.byteLength, mime, filename: state.outputFilename, ext: 'mp4' });
    if (typeof pushOutputHistory === 'function') pushOutputHistory({ timestamp: new Date(), workflowName: wf.name, blobUrl: state.outputBlobUrl, size: u8.byteLength, ext: 'mp4', mime });
    if (typeof switchTab === 'function') { switchTab('preview'); setPreviewMode('output'); }
    if (typeof addCommandHistory === 'function') addCommandHistory(`Datamosh: ${wf.name}`, 'ok');
  } catch (e) {
    logToConsole('err', 'Failed to read pipeline output: ' + (e && e.message || e));
  }
}

// =============================================================================
// AGENT 7: SURREAL WAIFF DIRECTOR
// =============================================================================
function bindAgentWaiffDirector() {
  const btn = document.querySelector('[data-agent-action="waiff-director:open"]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const panel = document.querySelector('[data-agent-panel="waiff-director"]');
    if (!panel) return;
    panel.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div>
          <label class="muted small">Audio Chain</label>
          <select id="waiff-audio" class="ctrl">
            <option value="">— pick audio chain —</option>
            ${AUDIO_MASTERING_WORKFLOWS.map(w => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="muted small">Video Glitch Pipeline</label>
          <select id="waiff-video" class="ctrl">
            <option value="">— pick video pipeline —</option>
            ${VIDEO_GLITCH_PIPELINES.map(w => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button type="button" class="primary-btn" id="waiff-sync">Sync &amp; Process</button>
      </div>
      <p class="muted small" style="margin-top:6px">Processes audio first, then applies video effects to the same file.</p>
    `;
    document.getElementById('waiff-sync').addEventListener('click', async () => {
      const aid = document.getElementById('waiff-audio').value;
      const vid = document.getElementById('waiff-video').value;
      if (!aid && !vid) { showInfo('WAiFF', 'Pick at least one chain.'); return; }
      // Audio first
      if (aid) {
        const aw = AUDIO_MASTERING_WORKFLOWS.find(w => w.id === aid);
        if (aw) await runAudioMasteringWorkflow(aw);
      }
      // Then video
      if (vid) {
        const vw = VIDEO_GLITCH_PIPELINES.find(w => w.id === vid);
        if (vw) await runVideoGlitchPipeline(vw);
      }
      showInfo('WAiFF', 'Sync & Process complete. See Preview tab.');
    });
  });
}

// =============================================================================
// AGENT 8: VAPORWAVE AUDIO LIBRARY
// =============================================================================
function bindAgentVaporwaveLibrary() {
  const btn = document.querySelector('[data-agent-action="vaporwave-library:open"]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const panel = document.querySelector('[data-agent-panel="vaporwave-library"]');
    if (!panel) return;
    panel.innerHTML = `
      <div class="agent-panel-list" id="vap-list">
        ${VAPORWAVE_TRACKS.map((t, i) => `
          <div class="agent-panel-item" data-vap-index="${i}">
            <button type="button" class="audio-pill" data-vap-play="${i}">▶</button>
            <span style="flex:1" class="wf-name">${escapeHtml(t.name)}</span>
            <button type="button" class="mini-btn" data-vap-load="${i}">Use as Source</button>
          </div>
        `).join('')}
      </div>
      <audio id="vap-audio" controls style="width:100%;margin-top:8px"></audio>
      <p class="muted small">If CORS blocks the fetch, you'll see a fallback message with a direct link.</p>
    `;
    panel.querySelectorAll('[data-vap-play]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = parseInt(btn.dataset.vapPlay, 10);
        const t = VAPORWAVE_TRACKS[i];
        if (!t) return;
        const audio = document.getElementById('vap-audio');
        audio.src = VAPORWAVE_CDN + t.file;
        audio.play().catch(() => {
          showInfo('CDN Blocked', 'CDN blocked by CORS. Download the track manually: <a href="' + VAPORWAVE_CDN + t.file + '" target="_blank">' + escapeHtml(t.name) + '</a>');
        });
      });
    });
    panel.querySelectorAll('[data-vap-load]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const i = parseInt(btn.dataset.vapLoad, 10);
        const t = VAPORWAVE_TRACKS[i];
        if (!t) return;
        await loadVaporwaveTrackAsInput(t);
      });
    });
  });
}

async function loadVaporwaveTrackAsInput(track) {
  if (!state.ffmpeg) { showInfo('Engine', 'Engine not ready.'); return; }
  logToConsole('', `Fetching ${track.name} from CDN…`);
  try {
    // v4 PART B10: Use fetch() with CORS-aware flow. We try mode:'cors'
    // first; if the host refuses, we show a friendly download link.
    const url = VAPORWAVE_CDN + track.file;
    const resp = await fetch(url, { mode: 'cors' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const buf = await resp.arrayBuffer();
    const u8 = new Uint8Array(buf);
    const ext = 'wav';
    const blob = new Blob([u8], { type: 'audio/wav' });
    const file = new File([blob], track.name, { type: 'audio/wav' });
    if (typeof handleFileUpload === 'function') {
      await handleFileUpload(file);
    } else {
      // Manual mini-ingest
      const objUrl = URL.createObjectURL(blob);
      const virtualName = `input.${ext}`;
      try { await state.ffmpeg.deleteFile(virtualName); } catch (_) {}
      await state.ffmpeg.writeFile(virtualName, u8);
      state.inputFile = {
        name: track.name, size: u8.byteLength, type: 'audio/wav',
        virtualName, extension: ext, url: objUrl,
      };
      const v = document.getElementById('video-preview');
      if (v) { v.src = objUrl; v.load(); }
    }
    if (typeof analyzeMedia === 'function') {
      try { await analyzeMedia(`input.${ext}`); } catch (_) {}
    }
    showInfo('Loaded', `${track.name} loaded as the active source.`);
  } catch (err) {
    const url = VAPORWAVE_CDN + track.file;
    logToConsole('err', `CDN fetch failed: ${err && err.message ? err.message : err}`);
    showInfo('CDN Blocked', `The CDN blocked direct fetching (CORS). Use the direct link to download, then drag the file into the bin: <br><a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(track.name)}</a>`);
  }
}

// =============================================================================
// MODAL HELPERS (the v1 modals are #info-modal; we reuse them but allow big body)
// =============================================================================
function showModal(title, bodyHtml) {
  const m = document.getElementById('info-modal');
  if (!m) return;
  document.getElementById('info-title').textContent = title;
  const body = document.getElementById('info-body');
  body.innerHTML = bodyHtml;
  const card = m.querySelector('.modal-card');
  if (card) card.classList.add('large');
  m.classList.remove('hidden');
}
function closeModal() {
  const m = document.getElementById('info-modal');
  if (m) m.classList.add('hidden');
}

// =============================================================================
// AGENT 9: THE VISUALIZER (v3 PART E)
// =============================================================================
// Turns audio into video. Picks a track from the bin, picks a viz style,
// optionally a background image, hits Generate. Produces an audiogram /
// music-video and adds it to the bin.
const VIZ_PRESETS = [
  { id: 'waveform-line',  label: 'Waveform Line',  type: 'showwaves',    mode: 'line',  color: '#00d4ff', w: 1280, h: 720 },
  { id: 'spectrum-fire',  label: 'Spectrum Fire',  type: 'showspectrum', mode: '',      color: '#ff6600', w: 1280, h: 720, colormap: 'fire' },
  { id: 'cqt',            label: 'CQT Spectrum',   type: 'showcqt',      mode: '',      color: '#ffffff', w: 1280, h: 720 },
  { id: 'vinyl-spin',     label: 'Vinyl Spin',     type: 'showwaves',    mode: 'cline', color: '#ffffff', w: 1280, h: 720, needsBg: true },
  { id: 'podcast-square', label: 'Podcast Square', type: 'showwaves',    mode: 'cline', color: '#ffffff', w: 1080, h: 1080, needsBg: true },
  { id: 'frequency-bars', label: 'Frequency Bars', type: 'showfreqs',    mode: '',      color: '#00ff88', w: 1280, h: 720 },
];

function bindAgentVisualizer() {
  const btn = document.querySelector('[data-agent-action="the-visualizer:open"]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const panel = document.querySelector('[data-agent-panel="the-visualizer"]');
    if (!panel) return;
    const audioOpts = (typeof state !== 'undefined' && state.mediaBin)
      ? state.mediaBin.filter(m => m.hasAudio).map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('')
      : '';
    const bgOpts = (typeof state !== 'undefined' && state.mediaBin)
      ? '<option value="">— none —</option>' + state.mediaBin.filter(m => m.type === 'image' || m.hasVideo).map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('')
      : '<option value="">— none —</option>';
    const vaporwaveOpts = VAPORWAVE_TRACKS.map((t, i) => `<option value="vap:${i}">📼 ${escapeHtml(t.name)}</option>`).join('');
    panel.innerHTML = `
      <div class="control-row">
        <label>Audio Source</label>
        <select id="viz-audio-source" class="ctrl">
          <optgroup label="From Media Bin">${audioOpts || '<option value="">(no audio in bin)</option>'}</optgroup>
          <optgroup label="Vaporwave Library">${vaporwaveOpts}</optgroup>
        </select>
      </div>
      <div class="control-row">
        <label>Visualization Preset</label>
        <select id="viz-preset" class="ctrl">
          ${VIZ_PRESETS.map(p => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('')}
        </select>
      </div>
      <div class="control-row">
        <label>Background Image (optional)</label>
        <select id="viz-bg-image" class="ctrl">${bgOpts}</select>
      </div>
      <div class="control-row">
        <label>Color</label>
        <input type="color" id="viz-line-color" value="#00d4ff" />
      </div>
      <div class="control-row">
        <label>FPS</label>
        <select id="viz-fps-pick" class="ctrl">
          <option value="15">15</option>
          <option value="24">24</option>
          <option value="30" selected>30</option>
          <option value="60">60</option>
        </select>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button type="button" class="primary-btn" id="viz-generate">Generate Video</button>
      </div>
      <p class="muted small" style="margin-top:6px">Result is added to the Media Bin as a new video.</p>
    `;
    // Apply preset color/dim hints
    const presetSel = document.getElementById('viz-preset');
    const colorInp = document.getElementById('viz-line-color');
    presetSel.addEventListener('change', () => {
      const p = VIZ_PRESETS.find(x => x.id === presetSel.value);
      if (p && colorInp) colorInp.value = p.color;
    });
    document.getElementById('viz-generate').addEventListener('click', runVisualizerGenerate);
  });
}

async function runVisualizerGenerate() {
  const audioId = document.getElementById('viz-audio-source').value;
  const presetId = document.getElementById('viz-preset').value;
  const bgId = document.getElementById('viz-bg-image').value;
  const color = document.getElementById('viz-line-color').value;
  const fps = parseInt(document.getElementById('viz-fps-pick').value, 10) || 30;
  if (!audioId) { showInfo('Visualizer', 'Pick an audio source.'); return; }
  if (!state.ffmpeg) { showInfo('Engine', 'Engine not ready.'); return; }
  const preset = VIZ_PRESETS.find(p => p.id === presetId) || VIZ_PRESETS[0];

  // Resolve the audio virtual name. If a vaporwave track, fetch + write to MEMFS.
  let virtualName = '';
  let cleanup = null;
  if (audioId.startsWith('vap:')) {
    const idx = parseInt(audioId.slice(4), 10);
    const track = VAPORWAVE_TRACKS[idx];
    if (!track) return;
    const fetchName = `vap_${idx}.wav`;
    try {
      logToConsole('', `Fetching ${track.name} from CDN…`);
      const resp = await fetch(VAPORWAVE_CDN + track.file);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = await resp.arrayBuffer();
      await state.ffmpeg.writeFile(fetchName, new Uint8Array(buf));
      virtualName = fetchName;
      cleanup = async () => { try { await state.ffmpeg.deleteFile(fetchName); } catch (_) {} };
    } catch (e) {
      showInfo('CDN Blocked', `CDN blocked. Download manually: <a href="${VAPORWAVE_CDN + track.file}" target="_blank">${escapeHtml(track.name)}</a>`);
      return;
    }
  } else {
    const m = state.mediaBin.find(x => x.id === audioId);
    if (!m) { showInfo('Visualizer', 'Source not found.'); return; }
    virtualName = m.virtualName;
  }

  // Build the ffmpeg command using buildVisualizationCommand-like logic.
  const w = preset.w, h = preset.h;
  const colorFF = '0x' + color.replace('#', '').toLowerCase();
  const outName = 'output.mp4';
  try { await state.ffmpeg.deleteFile(outName); } catch (_) {}
  state.isProcessing = true;
  setControlsEnabled(false);
  setCancelVisible(true);
  setProgress(0);
  setProgressText(`Visualizing ${preset.label}…`);
  try {
    let args;
    if (bgId) {
      const bg = state.mediaBin.find(x => x.id === bgId);
      if (bg) {
        const wv = Math.max(80, Math.floor(h / 3));
        const viz = (preset.type === 'showwaves')
          ? `[1:a]showwaves=s=${w}x${wv}:mode=${preset.mode || 'line'}:colors=${colorFF}:rate=${fps},format=rgba[wave]`
          : `[1:a]${preset.type}=s=${w}x${wv}:rate=${fps},format=rgba[wave]`;
        const bgScale = `[0:v]scale=${w}:${h},format=yuv420p[bg]`;
        const complex = `${viz};${bgScale};[bg][wave]overlay=0:H-h-40:shortest=1[v]`;
        args = ['-loop', '1', '-i', bg.virtualName, '-i', virtualName,
                '-filter_complex', complex,
                '-map', '[v]', '-map', '1:a',
                '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
                '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', outName];
      } else {
        bgId = null;
      }
    }
    if (!bgId) {
      let viz;
      if (preset.type === 'showwaves') {
        viz = `[0:a]showwaves=s=${w}x${h}:mode=${preset.mode || 'line'}:colors=${colorFF}:rate=${fps}[v]`;
      } else if (preset.type === 'showspectrum') {
        viz = `[0:a]showspectrum=s=${w}x${h}:mode=combined:color=${preset.colormap || 'intensity'}:scale=log:fps=${fps}[v]`;
      } else if (preset.type === 'showfreqs') {
        viz = `[0:a]showfreqs=s=${w}x${h}:mode=bar:colors=${colorFF}:fps=${fps}[v]`;
      } else if (preset.type === 'showvolume') {
        viz = `[0:a]showvolume=w=${w}:h=${h}:c=${colorFF}[v]`;
      } else if (preset.type === 'showcqt') {
        viz = `[0:a]showcqt=s=${w}x${h}:fps=${fps}[v]`;
      } else {
        viz = `[0:a]showwaves=s=${w}x${h}:mode=line:colors=${colorFF}:rate=${fps}[v]`;
      }
      const complex = `${viz};color=c=black:s=${w}x${h}:r=${fps}[bg];[bg][v]overlay=0:0:shortest=1[vf]`;
      args = ['-i', virtualName, '-filter_complex', complex,
              '-map', '[vf]', '-map', '0:a',
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
              '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', outName];
    }
    logToConsole('', `Visualizer: ffmpeg ${args.map(quoteArg).join(' ')}`);
    await state.ffmpeg.exec(args);
    const data = await state.ffmpeg.readFile(outName);
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const blob = new Blob([u8], { type: 'video/mp4' });
    if (state.outputBlobUrl) URL.revokeObjectURL(state.outputBlobUrl);
    state.outputBlobUrl = URL.createObjectURL(blob);
    state.outputFilename = `visualizer_${preset.id}.mp4`;
    setDownloadEnabled(true);
    setOutputInfo({ size: u8.byteLength, mime: 'video/mp4', filename: state.outputFilename, ext: 'mp4' });
    setProgress(100);
    setProgressText(`Visualization done`);
    if (cleanup) await cleanup();
    try { await state.ffmpeg.deleteFile(outName); } catch (_) {}
    // Add to bin
    await addOutputToBin({ blob, name: `visualizer_${preset.id}`, mime: 'video/mp4', ext: 'mp4', workflowName: 'Visualizer' });
    logToConsole('ok', `Visualization complete (${preset.label}).`);
  } catch (err) {
    const msg = String((err && err.message) || err);
    logToConsole('err', `Visualizer failed: ${msg}`);
    if (typeof showFriendlyError === 'function') showFriendlyError(msg);
  } finally {
    state.isProcessing = false;
    setCancelVisible(false);
    setControlsEnabled(true);
  }
}

// =============================================================================
// AGENT 10: THE COMPOSITOR (v3 PART E)
// =============================================================================
// Multi-file operations, guided. Shows the media bin, lets you pick a
// composite mode, preview the layout as a wireframe, then render.
const COMPOSITOR_MODES = [
  { id: 'concat',  label: 'Concatenate',    needs: 2, desc: 'Sequential join of selected files.' },
  { id: 'hstack',  label: 'Side-by-Side',   needs: 2, desc: 'Horizontal stack (hstack=inputs=2).' },
  { id: 'vstack',  label: 'Stacked',        needs: 2, desc: 'Vertical stack (vstack=inputs=2).' },
  { id: 'grid',    label: '2×2 Grid',       needs: 4, desc: 'Four-up grid (xstack=4).' },
  { id: 'pip',     label: 'Picture-in-Picture', needs: 2, desc: 'PiP overlay, 25% scale, bottom-right.' },
  { id: 'merge',   label: 'Merge A+V',      needs: 2, desc: 'Video from file 1, audio from file 2.' },
];

function bindAgentCompositor() {
  const btn = document.querySelector('[data-agent-action="the-compositor:open"]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const panel = document.querySelector('[data-agent-panel="the-compositor"]');
    if (!panel) return;
    const opts = COMPOSITOR_MODES.map(m => `<option value="${m.id}">${escapeHtml(m.label)} (${m.needs} files)</option>`).join('');
    panel.innerHTML = `
      <p class="muted small">Select files in the Media Bin (check the boxes), then choose a composite mode and click Render.</p>
      <div class="control-row">
        <label>Mode</label>
        <select id="compositor-mode" class="ctrl">${opts}</select>
      </div>
      <div id="compositor-wireframe" style="margin-top:8px"></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button type="button" class="primary-btn" id="compositor-render">Render</button>
      </div>
    `;
    const sel = document.getElementById('compositor-mode');
    const wire = document.getElementById('compositor-wireframe');
    const updateWire = () => {
      const m = COMPOSITOR_MODES.find(x => x.id === sel.value);
      if (!m) return;
      let wireHtml = '';
      if (m.id === 'concat')  wireHtml = '<div class="muted small">— file 1 — file 2 —</div>';
      if (m.id === 'hstack')  wireHtml = '<div style="display:flex;gap:4px"><div style="width:60px;height:36px;background:#00d4ff"></div><div style="width:60px;height:36px;background:#ff6600"></div></div>';
      if (m.id === 'vstack')  wireHtml = '<div style="display:flex;flex-direction:column;gap:4px"><div style="width:80px;height:18px;background:#00d4ff"></div><div style="width:80px;height:18px;background:#ff6600"></div></div>';
      if (m.id === 'grid')    wireHtml = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px"><div style="width:60px;height:36px;background:#00d4ff"></div><div style="width:60px;height:36px;background:#ff6600"></div><div style="width:60px;height:36px;background:#00ff88"></div><div style="width:60px;height:36px;background:#ff00aa"></div></div>';
      if (m.id === 'pip')     wireHtml = '<div style="position:relative;width:160px;height:90px;background:#00d4ff"><div style="position:absolute;bottom:4px;right:4px;width:40px;height:22px;background:#ff6600"></div></div>';
      if (m.id === 'merge')   wireHtml = '<div class="muted small">file 1 (video) + file 2 (audio) → mp4</div>';
      wire.innerHTML = `<div class="muted small" style="margin-bottom:4px">${escapeHtml(m.desc)}</div>${wireHtml}`;
    };
    sel.addEventListener('change', updateWire);
    updateWire();
    document.getElementById('compositor-render').addEventListener('click', async () => {
      const mode = sel.value;
      if (typeof runBinComposite === 'function') await runBinComposite(mode);
    });
  });
}

// =============================================================================
// AGENT 11: THE CHAIN BUILDER (v3 PART E)
// =============================================================================
// Visual pipeline builder. Drag workflow cards into an ordered chain. Save
// the whole chain as a custom named workflow (persisted to localStorage).
const CHAIN_STORAGE_KEY = 'ffmpeg-studio:chains-v3';
function loadChains() {
  try { return JSON.parse(localStorage.getItem(CHAIN_STORAGE_KEY) || '[]') || []; } catch (_) { return []; }
}
function saveChains(arr) { try { localStorage.setItem(CHAIN_STORAGE_KEY, JSON.stringify(arr)); } catch (_) {} }

function bindAgentChainBuilder() {
  const btn = document.querySelector('[data-agent-action="chain-builder:open"]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const panel = document.querySelector('[data-agent-panel="chain-builder"]');
    if (!panel) return;
    renderChainBuilderPanel(panel);
  });
}

function renderChainBuilderPanel(panel) {
  // The chain editor is a self-contained UI in the panel.
  const all = (typeof WORKFLOWS !== 'undefined') ? WORKFLOWS : [];
  if (all.length === 0) {
    panel.innerHTML = '<em class="muted">Workflows not loaded.</em>';
    return;
  }
  // Each "chain" is an array of workflow IDs in execution order.
  let chain = [];
  const html = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div>
        <h4 style="margin:4px 0 6px 0;font-size:12px">Available Workflows</h4>
        <select id="cb-pool" class="ctrl" size="8" style="height:auto">
          ${all.map(w => `<option value="${w.id}">${escapeHtml(w.icon || '🎬')} ${escapeHtml(w.name)}</option>`).join('')}
        </select>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button type="button" class="primary-btn" id="cb-add">Add to Chain →</button>
        </div>
      </div>
      <div>
        <h4 style="margin:4px 0 6px 0;font-size:12px">Current Chain</h4>
        <div id="cb-chain" style="min-height:80px;border:1px dashed var(--border);border-radius:6px;padding:6px;background:var(--panel-1)">
          <em class="muted">No steps. Add from the left.</em>
        </div>
        <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
          <button type="button" class="secondary-btn" id="cb-up">↑</button>
          <button type="button" class="secondary-btn" id="cb-down">↓</button>
          <button type="button" class="secondary-btn" id="cb-del">Remove</button>
          <button type="button" class="secondary-btn" id="cb-clear">Clear</button>
          <button type="button" class="primary-btn" id="cb-run">Run Chain</button>
        </div>
      </div>
    </div>
    <div style="margin-top:10px">
      <h4 style="margin:4px 0 6px 0;font-size:12px">Saved Chains</h4>
      <div id="cb-saved"></div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <input type="text" id="cb-name" class="ctrl" placeholder="Chain name" style="flex:1" />
        <button type="button" class="primary-btn" id="cb-save">Save Chain</button>
      </div>
    </div>
  `;
  panel.innerHTML = html;

  const renderChain = () => {
    const target = document.getElementById('cb-chain');
    if (chain.length === 0) {
      target.innerHTML = '<em class="muted">No steps. Add from the left.</em>';
      return;
    }
    target.innerHTML = chain.map((id, i) => {
      const w = all.find(x => x.id === id);
      if (!w) return `<div class="chain-step" data-idx="${i}"><span class="chain-num">${i+1}</span><span class="chain-name">[unknown: ${escapeHtml(id)}]</span><button data-rm="${i}">×</button></div>`;
      return `<div class="chain-step" data-idx="${i}"><span class="drag-handle">⋮⋮</span><span class="chain-num">${i+1}</span><span class="chain-name">${escapeHtml(w.icon || '🎬')} ${escapeHtml(w.name)}</span><button data-rm="${i}">×</button></div>`;
    }).join('');
    target.querySelectorAll('[data-rm]').forEach(b => {
      b.addEventListener('click', () => {
        const idx = parseInt(b.dataset.rm, 10);
        chain.splice(idx, 1);
        renderChain();
      });
    });
  };
  renderChain();

  document.getElementById('cb-add').addEventListener('click', () => {
    const sel = document.getElementById('cb-pool');
    if (sel.value) { chain.push(sel.value); renderChain(); }
  });
  document.getElementById('cb-up').addEventListener('click', () => {
    // Move the last-added step up. (Single-step move; users can click repeatedly.)
    if (chain.length < 2) return;
    const idx = chain.length - 2;
    [chain[idx], chain[idx + 1]] = [chain[idx + 1], chain[idx]];
    renderChain();
  });
  document.getElementById('cb-down').addEventListener('click', () => {
    if (chain.length < 2) return;
    const idx = chain.length - 2;
    [chain[idx], chain[idx + 1]] = [chain[idx + 1], chain[idx]];
    renderChain();
  });
  document.getElementById('cb-del').addEventListener('click', () => {
    chain.pop();
    renderChain();
  });
  document.getElementById('cb-clear').addEventListener('click', () => {
    chain = [];
    renderChain();
  });
  document.getElementById('cb-run').addEventListener('click', async () => {
    if (chain.length === 0) { showInfo('Chain', 'Add at least one workflow to the chain.'); return; }
    await runChain(chain, all);
  });
  document.getElementById('cb-save').addEventListener('click', () => {
    const name = (document.getElementById('cb-name').value || '').trim();
    if (!name) { showInfo('Save Chain', 'Enter a name.'); return; }
    if (chain.length === 0) { showInfo('Save Chain', 'Empty chain.'); return; }
    const list = loadChains();
    list.unshift({ id: 'chain-' + Date.now(), name, steps: chain.slice(), created: new Date().toISOString() });
    saveChains(list);
    renderSaved();
  });
  function renderSaved() {
    const list = loadChains();
    const el = document.getElementById('cb-saved');
    if (list.length === 0) { el.innerHTML = '<em class="muted">No saved chains yet.</em>'; return; }
    el.innerHTML = list.map(c => `
      <div class="chain-step" data-saved-id="${c.id}">
        <span class="chain-name">${escapeHtml(c.name)} <span class="muted small">(${c.steps.length} steps)</span></span>
        <button data-load="${c.id}">Load</button>
        <button data-run-saved="${c.id}">Run</button>
        <button data-del-saved="${c.id}" class="danger-btn">Delete</button>
      </div>
    `).join('');
    el.querySelectorAll('[data-load]').forEach(b => b.addEventListener('click', () => {
      const c = list.find(x => x.id === b.dataset.load);
      if (c) { chain = c.steps.slice(); renderChain(); document.getElementById('cb-name').value = c.name; }
    }));
    el.querySelectorAll('[data-run-saved]').forEach(b => b.addEventListener('click', async () => {
      const c = list.find(x => x.id === b.dataset.runSaved);
      if (c) await runChain(c.steps, all);
    }));
    el.querySelectorAll('[data-del-saved]').forEach(b => b.addEventListener('click', () => {
      const newList = list.filter(x => x.id !== b.dataset.delSaved);
      saveChains(newList);
      renderSaved();
    }));
  }
  renderSaved();
}

async function runChain(steps, all) {
  if (steps.length === 0) return;
  if (!state.inputFile) { showInfo('Chain', 'Load a file first.'); return; }
  for (let i = 0; i < steps.length; i++) {
    const id = steps[i];
    const w = all.find(x => x.id === id);
    if (!w) continue;
    logToConsole('', `[Chain ${i+1}/${steps.length}] ${w.name}`);
    if (typeof applyWorkflow === 'function') applyWorkflow(w.id);
    await new Promise(r => setTimeout(r, 50));
    try {
      if (typeof executeFromUI === 'function') await executeFromUI();
    } catch (e) {
      logToConsole('err', `Chain step ${i+1} failed: ${e && e.message || e}`);
      showInfo('Chain', `Step ${i+1} (${w.name}) failed. Stopping.`);
      return;
    }
    // After each step, the output becomes the new input for the next step.
    if (state.outputBlobUrl && state.outputFilename) {
      // Read the output back into the bin and set it active.
      try {
        const ext = (state.outputFilename || 'out.bin').split('.').pop().toLowerCase();
        const blob = await fetch(state.outputBlobUrl).then(r => r.blob());
        const mime = (typeof EXT_TO_MIME !== 'undefined' && EXT_TO_MIME[ext]) ? EXT_TO_MIME[ext] : (blob.type || 'application/octet-stream');
        const newId = await addOutputToBin({ blob, name: 'chain_step_' + (i+1), mime, ext, workflowName: w.name });
        if (newId && typeof setActiveMedia === 'function') setActiveMedia(newId);
        // Free MEMFS file from the prior step
        try { state.ffmpeg.deleteFile('output.' + ext); } catch (_) {}
      } catch (e) {
        logToConsole('err', 'Failed to chain output: ' + (e && e.message || e));
      }
    }
  }
  logToConsole('ok', `Chain complete (${steps.length} steps).`);
  showInfo('Chain Complete', `${steps.length} workflows applied. See Media Bin for the final result.`);
}

// =============================================================================
// AGENT 12: THE BATCH RUNNER (v3 PART E)
// =============================================================================
// Select N files in the bin + one workflow → runs it on every file
// sequentially (max 2 concurrent), shows a per-file progress table, and
// offers a "Download All as ZIP" button.
function bindAgentBatchRunner() {
  const btn = document.querySelector('[data-agent-action="batch-runner:open"]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const panel = document.querySelector('[data-agent-panel="batch-runner"]');
    if (!panel) return;
    const all = (typeof WORKFLOWS !== 'undefined') ? WORKFLOWS : [];
    const opts = all.map(w => `<option value="${w.id}">${escapeHtml(w.icon || '🎬')} ${escapeHtml(w.name)}</option>`).join('');
    const selected = (typeof state !== 'undefined' && state.mediaBin)
      ? state.mediaBin.filter(m => typeof binSelected !== 'undefined' && binSelected.has(m.id))
      : [];
    panel.innerHTML = `
      <p class="muted small">Check the boxes in the Media Bin to select files. Then choose a workflow and click Run.</p>
      <div class="control-row">
        <label>Workflow</label>
        <select id="br-wf" class="ctrl">${opts}</select>
      </div>
      <div class="control-row">
        <label>Concurrency</label>
        <select id="br-conc" class="ctrl">
          <option value="1" selected>1 (sequential, safe)</option>
          <option value="2">2 (parallel, may OOM on large files)</option>
        </select>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button type="button" class="primary-btn" id="br-run">Run on Selected</button>
        <button type="button" class="secondary-btn" id="br-zip" disabled>Download All as ZIP</button>
      </div>
      <table class="batch-progress-table" id="br-table" style="margin-top:10px">
        <thead>
          <tr><th>File</th><th>Status</th><th>Size</th><th>Output</th></tr>
        </thead>
        <tbody id="br-tbody"></tbody>
      </table>
      <p id="br-summary" class="muted small" style="margin-top:6px"></p>
    `;
    // Render initial selected count
    const tbl = document.getElementById('br-tbody');
    tbl.innerHTML = selected.map(m => `<tr data-br-id="${m.id}"><td>${escapeHtml(m.name)}</td><td class="status-pend">pending</td><td>${formatBytes(m.size)}</td><td>—</td></tr>`).join('');
    document.getElementById('br-run').addEventListener('click', runBatchRunner);
    document.getElementById('br-zip').addEventListener('click', downloadBatchRunnerZip);
  });
}

const _br_results = [];  // array of { name, blob, ext }

async function runBatchRunner() {
  if (typeof binSelected === 'undefined' || binSelected.size === 0) {
    showInfo('Batch Runner', 'Select at least one file in the Media Bin (use the checkboxes).');
    return;
  }
  const wfId = document.getElementById('br-wf').value;
  const all = (typeof WORKFLOWS !== 'undefined') ? WORKFLOWS : [];
  const wf = all.find(w => w.id === wfId);
  if (!wf) { showInfo('Batch Runner', 'Pick a workflow.'); return; }
  const conc = parseInt(document.getElementById('br-conc').value, 10) || 1;
  const selected = state.mediaBin.filter(m => binSelected.has(m.id));
  _br_results.length = 0;
  document.getElementById('br-zip').disabled = true;

  const updateRow = (id, status, outName) => {
    const row = document.querySelector(`#br-tbody tr[data-br-id="${id}"]`);
    if (!row) return;
    row.cells[1].className = 'status-' + status;
    row.cells[1].textContent = status;
    if (outName) row.cells[3].textContent = outName;
  };
  const fmt = (id, name) => {
    const row = document.querySelector(`#br-tbody tr[data-br-id="${id}"]`);
    if (row) row.cells[1].textContent = name;
  };

  // Concurrency-limited runner. `conc` files in flight at once.
  let i = 0;
  const runOne = async (m) => {
    fmt(m.id, 'running…');
    updateRow(m.id, 'run');
    setActiveMedia(m.id);
    if (typeof applyWorkflow === 'function') applyWorkflow(wf.id);
    await new Promise(r => setTimeout(r, 50));
    let outBlob = null, outName = null, outExt = null;
    try {
      const plan = buildFFmpegCommand();
      if (plan && plan.ok) {
        if (plan.gifTwoPass) await createGIF();
        else if (plan.twoPass) await runTwoPass(plan);
        else await executeFFmpeg(plan.args);
      }
      if (state.outputBlobUrl) {
        outExt = (state.outputFilename || 'out.bin').split('.').pop().toLowerCase();
        outBlob = await fetch(state.outputBlobUrl).then(r => r.blob());
        outName = state.outputFilename;
        const mime = (typeof EXT_TO_MIME !== 'undefined' && EXT_TO_MIME[outExt]) ? EXT_TO_MIME[outExt] : (outBlob.type || 'application/octet-stream');
        const wfTag = wf.name.replace(/[^\w \-]/g, '').slice(0, 30);
        await addOutputToBin({ blob: outBlob, name: m.name, mime, ext: outExt, sourceName: m.name, workflowName: wfTag });
      }
      updateRow(m.id, 'ok', outName || '—');
      if (outBlob && outName) _br_results.push({ name: outName, blob: outBlob, ext: outExt });
    } catch (e) {
      const msg = String((e && e.message) || e);
      logToConsole('err', `Batch run on ${m.name} failed: ${msg}`);
      updateRow(m.id, 'err', msg.slice(0, 30));
    }
  };

  // Simple pool: `conc` workers
  const queue = selected.slice();
  const workers = [];
  for (let w = 0; w < conc; w++) {
    workers.push((async () => {
      while (queue.length) {
        const next = queue.shift();
        await runOne(next);
      }
    })());
  }
  await Promise.all(workers);

  document.getElementById('br-zip').disabled = (_br_results.length === 0);
  document.getElementById('br-summary').textContent =
    `Batch complete: ${_br_results.length}/${selected.length} succeeded. Use Download All as ZIP to grab the outputs.`;
  showInfo('Batch Complete', `${_br_results.length}/${selected.length} succeeded.`);
}

async function downloadBatchRunnerZip() {
  if (_br_results.length === 0) return;
  if (typeof JSZip === 'undefined') { showInfo('JSZip', 'JSZip not loaded.'); return; }
  const zip = new JSZip();
  for (const r of _br_results) {
    zip.file(r.name, r.blob);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'batch_outputs.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// =============================================================================
// AGENT 13: THE BEAT SYNC DIRECTOR (v4 PART B2)
// =============================================================================
// This card is the "marketing surface" for the beat detection + sync panel
// that lives in the Editor tab (see #section-beatsync). The two surfaces
// share the same underlying state (state.beats, state.bpm, the apply
// helper), so toggling one updates the other.
function bindAgentBeatSync() {
  const openBtn = document.querySelector('[data-agent-action="beat-sync:open-editor"]');
  const detectBtn = document.querySelector('[data-agent-action="beat-sync:detect"]');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      // Switch to the Editor tab and scroll the beatsync section into view.
      const tabBtn = document.querySelector('.tab-btn[data-tab="editor"]');
      if (tabBtn) tabBtn.click();
      const sec = document.getElementById('section-beatsync');
      if (sec) {
        sec.open = true;
        sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }
  if (detectBtn) {
    detectBtn.addEventListener('click', async () => {
      // Same path the Editor's "Detect beats" button uses. The actual
      // detection lives in beat-detection.js.
      if (typeof detectBeatsForActive === 'function') {
        await detectBeatsForActive();
      } else {
        showInfo('Beat detection', 'beat-detection.js did not load.');
      }
    });
  }
}

// =============================================================================
// Boot wiring
// =============================================================================
// PHASE 0 FIX: the previous v4 code wrapped `initAgentsUI` in a
// `initAgentsUI_v2` helper and then did
// `window.initAgentsUI = initAgentsUI_v2`. Because classic-script
// function declarations create a binding on the global object, the
// v2 wrapper ended up calling itself (the lexical lookup of
// `initAgentsUI` inside the wrapper resolved to the v2 wrapper
// itself, since the global was reassigned), causing an infinite
// recursion / "Maximum call stack size exceeded" in `bootV2`.
//
// Fix: rename the boot entry point so there is no name collision
// with the agent boot function. `app.js` calls
// `bootAgentsHub()` (not `initAgentsUI()`) which in turn calls
// the agent boot function and the command-history binder.
function bootAgentsHub() {
  // The agent card render + bind work is in `initAgentsUI`
  // (declared at the top of this file).
  initAgentsUI();
  // The command-history card needs its own one-time binding so the
  // "Clear" button is wired.
  if (typeof bindAgentCommandHistory === 'function') bindAgentCommandHistory();
}
// Expose the boot entry on window so app.js can find it. We do NOT
// overwrite `window.initAgentsUI` (the agent boot function) so
// future code can still call the agent boot directly.
window.bootAgentsHub = bootAgentsHub;
