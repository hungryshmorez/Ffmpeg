/* =============================================================================
   tools.js — COMMAND PALETTE · RECORDING · LUTs · SUBTITLES · TARGET SIZE
   ========================================================================== */

(function () {
  'use strict';

  // ===========================================================================
  // COMMAND PALETTE (Ctrl+K / Cmd+K)
  // ---------------------------------------------------------------------------
  // With 180 workflows and 32 sections, browsing stopped being a viable
  // navigation model several versions ago. This is now the primary way in.
  // ===========================================================================

  let paletteEl = null, paletteItems = [], paletteSel = 0;

  function buildIndex() {
    const items = [];

    for (const wf of (window.ALL_WORKFLOWS || [])) {
      items.push({
        kind: 'Workflow', icon: wf.icon || '▶',
        label: wf.name, sub: wf.description || '',
        hay: `${wf.name} ${wf.description} ${(wf.tags || []).join(' ')} ${wf.category}`.toLowerCase(),
        run: () => window.applyWorkflow?.(wf.id, true),
      });
    }

    document.querySelectorAll('[id^="section-"]').forEach((sec) => {
      const title = sec.querySelector('summary, .section-title, h3')?.textContent?.trim();
      if (!title) return;
      items.push({
        kind: 'Section', icon: '⚙',
        label: title, sub: 'Jump to this editor section',
        hay: title.toLowerCase(),
        run: () => {
          window.switchTab?.('editor');
          sec.setAttribute('open', '');
          sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
          sec.classList.add('flash-highlight');
          setTimeout(() => sec.classList.remove('flash-highlight'), 1200);
        },
      });
    });

    const actions = [
      ['Add Media',            '＋', () => document.getElementById('file-input')?.click()],
      ['Run',                  '▶',  () => window.executeFromUI?.()],
      ['Download Output',      '⬇',  () => document.getElementById('btn-download')?.click()],
      ['Cancel Render',        '✕',  () => window.cancelRender?.()],
      ['Export Project',       '💾', () => window.FFStorage?.exportProject()],
      ['Measure Loudness (LUFS)', '🔊', () => window.FFAnalysis?.analyzeLoudness()],
      ['Detect Silence',       '✂',  () => window.FFAnalysis?.analyzeSilence()],
      ['Detect Scenes',        '🎬', () => window.FFAnalysis?.analyzeScenes()],
      ['Record Screen',        '🖥', () => window.FFRecord?.start('screen')],
      ['Record Webcam',        '📹', () => window.FFRecord?.start('camera')],
      ['Record Microphone',    '🎙', () => window.FFRecord?.start('mic')],
      ['Reset All Controls',   '↺',  () => window.resetAllControls?.()],
    ];
    for (const [label, icon, run] of actions) {
      items.push({ kind: 'Action', icon, label, sub: '', hay: label.toLowerCase(), run });
    }
    return items;
  }

  function score(q, item) {
    if (!q) return 1;
    const h = item.hay, l = item.label.toLowerCase();
    if (l === q) return 1000;
    if (l.startsWith(q)) return 500;
    if (l.includes(q)) return 200;
    if (h.includes(q)) return 50;
    // subsequence fallback: "vhs" matches "V-H-S retro"
    let i = 0;
    for (const c of h) { if (c === q[i]) i++; if (i === q.length) return 10; }
    return 0;
  }

  function openPalette() {
    if (paletteEl) return closePalette();
    paletteItems = buildIndex();
    paletteSel = 0;

    paletteEl = document.createElement('div');
    paletteEl.className = 'cmdk-overlay';
    paletteEl.innerHTML = `
      <div class="cmdk">
        <input id="cmdk-input" type="text" placeholder="Search ${paletteItems.length} workflows, sections, actions…" autocomplete="off" spellcheck="false">
        <div id="cmdk-list" class="cmdk-list"></div>
        <div class="cmdk-foot"><kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>↵</kbd> run · <kbd>esc</kbd> close</div>
      </div>`;
    document.body.appendChild(paletteEl);

    const input = paletteEl.querySelector('#cmdk-input');
    const list  = paletteEl.querySelector('#cmdk-list');

    const render = () => {
      const q = input.value.trim().toLowerCase();
      const hits = paletteItems
        .map((it) => ({ it, s: score(q, it) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 40);

      paletteSel = Math.min(paletteSel, Math.max(0, hits.length - 1));
      list.innerHTML = hits.length
        ? hits.map((x, i) => `
            <div class="cmdk-item ${i === paletteSel ? 'sel' : ''}" data-i="${i}">
              <span class="cmdk-icon">${x.it.icon}</span>
              <span class="cmdk-label">${x.it.label}</span>
              <span class="cmdk-sub">${x.it.sub}</span>
              <span class="cmdk-kind">${x.it.kind}</span>
            </div>`).join('')
        : '<div class="cmdk-empty">No matches.</div>';

      list._hits = hits;
      list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    };

    input.addEventListener('input', () => { paletteSel = 0; render(); });

    paletteEl.addEventListener('keydown', (e) => {
      const hits = list._hits || [];
      if (e.key === 'Escape')      { e.preventDefault(); closePalette(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); paletteSel = Math.min(paletteSel + 1, hits.length - 1); render(); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); render(); }
      else if (e.key === 'Enter')     {
        e.preventDefault();
        const h = hits[paletteSel];
        if (h) { closePalette(); setTimeout(() => h.it.run(), 30); }
      }
    });

    list.addEventListener('click', (e) => {
      const row = e.target.closest('.cmdk-item');
      if (!row) return;
      const h = (list._hits || [])[+row.dataset.i];
      if (h) { closePalette(); setTimeout(() => h.it.run(), 30); }
    });

    paletteEl.addEventListener('click', (e) => { if (e.target === paletteEl) closePalette(); });

    render();
    input.focus();
  }

  function closePalette() { paletteEl?.remove(); paletteEl = null; }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  });

  // ===========================================================================
  // RECORDING — mic / webcam / screen. MediaRecorder → straight into the bin.
  // ===========================================================================

  const REC = { rec: null, chunks: [], stream: null, kind: null, t0: 0, raf: 0 };

  async function startRecording(kind) {
    if (REC.rec) return stopRecording();
    try {
      let stream;
      if (kind === 'screen') {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      } else if (kind === 'camera') {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      const mime = kind === 'mic'
        ? (MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm')
        : (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm');

      REC.stream = stream;
      REC.kind = kind;
      REC.chunks = [];
      REC.rec = new MediaRecorder(stream, { mimeType: mime });
      REC.t0 = Date.now();

      REC.rec.ondataavailable = (e) => { if (e.data.size) REC.chunks.push(e.data); };
      REC.rec.onstop = async () => {
        const blob = new Blob(REC.chunks, { type: mime });
        const ext  = kind === 'mic' ? 'webm' : 'webm';
        const name = `${kind}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${ext}`;
        await window.addBlobToBin?.(blob, name, mime);
        window.logToConsole?.('ok', `Recording saved to the Media Bin: ${name}`);
        cleanupRec();
      };

      // A screen share that the user ends from the browser's own UI.
      stream.getTracks().forEach((t) => { t.onended = () => stopRecording(); });

      REC.rec.start(250);
      showRecChip();
      window.logToConsole?.('', `Recording (${kind})… click the chip to stop.`);
    } catch (e) {
      window.logToConsole?.('error', `Recording failed: ${e.message}`);
      cleanupRec();
    }
  }

  function stopRecording() {
    try { REC.rec?.stop(); } catch (_) {}
    REC.stream?.getTracks().forEach((t) => t.stop());
  }

  function cleanupRec() {
    cancelAnimationFrame(REC.raf);
    document.getElementById('rec-chip')?.remove();
    REC.rec = null; REC.stream = null; REC.chunks = []; REC.kind = null;
  }

  function showRecChip() {
    const chip = document.createElement('button');
    chip.id = 'rec-chip';
    chip.className = 'rec-chip';
    chip.type = 'button';
    document.body.appendChild(chip);
    chip.addEventListener('click', stopRecording);
    const tick = () => {
      const s = Math.floor((Date.now() - REC.t0) / 1000);
      chip.innerHTML = `<span class="rec-dot"></span> REC ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')} — click to stop`;
      REC.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  // ===========================================================================
  // CUSTOM LUT (.cube / Hald CLUT)
  // ===========================================================================

  const BUILTIN_LUTS = ['Teal & Orange', 'Bleach Bypass', 'Vintage', 'Cyberpunk', 'Moonlight', 'Golden Hour'];

  /** Generate a .cube on the fly from a simple RGB transform. No download needed. */
  function generateCube(name, size = 17) {
    const f = {
      'Teal & Orange': (r, g, b) => [Math.min(1, r * 1.12 - b * 0.08), g, Math.min(1, b * 0.92 + r * 0.06)],
      'Bleach Bypass': (r, g, b) => { const l = 0.3 * r + 0.59 * g + 0.11 * b; return [r * 0.5 + l * 0.5, g * 0.5 + l * 0.5, b * 0.5 + l * 0.5].map((v) => Math.min(1, (v - 0.5) * 1.3 + 0.5)); },
      'Vintage':       (r, g, b) => [Math.min(1, r * 0.95 + 0.06), Math.min(1, g * 0.9 + 0.04), Math.min(1, b * 0.82 + 0.02)],
      'Cyberpunk':     (r, g, b) => [Math.min(1, r * 1.1 + b * 0.1), Math.min(1, g * 0.92), Math.min(1, b * 1.25)],
      'Moonlight':     (r, g, b) => [Math.min(1, r * 0.82), Math.min(1, g * 0.92), Math.min(1, b * 1.18)],
      'Golden Hour':   (r, g, b) => [Math.min(1, r * 1.15), Math.min(1, g * 1.02), Math.min(1, b * 0.85)],
    }[name] || ((r, g, b) => [r, g, b]);

    let out = `# ${name}\nTITLE "${name}"\nLUT_3D_SIZE ${size}\n`;
    for (let b = 0; b < size; b++)
      for (let g = 0; g < size; g++)
        for (let r = 0; r < size; r++) {
          const [R, G, B] = f(r / (size - 1), g / (size - 1), b / (size - 1));
          out += `${R.toFixed(6)} ${G.toFixed(6)} ${B.toFixed(6)}\n`;
        }
    return out;
  }

  async function loadLUT(nameOrFile) {
    let text, label;
    if (typeof nameOrFile === 'string') { text = generateCube(nameOrFile); label = nameOrFile; }
    else { text = await nameOrFile.text(); label = nameOrFile.name; }

    await window.ff.writeFile('lut.cube', new TextEncoder().encode(text));
    window.state.activeLUT = label;
    window.logToConsole?.('ok', `LUT loaded: ${label}`);
    return 'lut.cube';
  }

  /** Blend the graded and ungraded streams so the LUT has an intensity slider. */
  function lutFilter(intensity = 1.0) {
    if (intensity >= 0.999) return `lut3d=file=lut.cube`;
    const i = Math.max(0, Math.min(1, intensity)).toFixed(3);
    return `split[a][b];[a]lut3d=file=lut.cube[g];[b][g]blend=all_expr='A*(1-${i})+B*${i}'`;
  }

  // ===========================================================================
  // SUBTITLE BURN-IN
  // ===========================================================================

  async function loadSubtitles(file) {
    const text = await file.text();
    const name = /\.ass$/i.test(file.name) ? 'subs.ass' : 'subs.srt';
    await window.ff.writeFile(name, new TextEncoder().encode(text));
    window.state.activeSubs = name;
    window.logToConsole?.('ok', `Subtitles loaded: ${file.name}`);
    return name;
  }

  function subtitleFilter(opts = {}) {
    const {
      file = 'subs.srt', fontSize = 24, color = 'ffffff',
      outline = '000000', borderStyle = 3, marginV = 24,
    } = opts;
    const bgr = (hex) => hex.slice(4, 6) + hex.slice(2, 4) + hex.slice(0, 2);   // ASS is BGR
    const style = [
      'FontName=Roboto',
      `FontSize=${fontSize}`,
      `PrimaryColour=&H00${bgr(color.replace('#', ''))}`,
      `OutlineColour=&H00${bgr(outline.replace('#', ''))}`,
      `BorderStyle=${borderStyle}`,
      `MarginV=${marginV}`,
    ].join(',');
    // fontsdir=/ is REQUIRED — ffmpeg.wasm has no system fonts.
    return `subtitles=${file}:fontsdir=/:force_style='${style}'`;
  }

  // ===========================================================================
  // TARGET FILE SIZE — bitrate budget, then binary-search CRF if it overshoots.
  // ===========================================================================

  const SIZE_PRESETS = [
    { id: 'discord',  label: 'Discord (8 MB)',        mb: 8 },
    { id: 'nitro',    label: 'Discord Nitro (50 MB)', mb: 50 },
    { id: 'email',    label: 'Email (25 MB)',         mb: 25 },
    { id: 'whatsapp', label: 'WhatsApp (16 MB)',      mb: 16 },
  ];

  function budget(targetMB, durationSec, audioKbps = 128) {
    const totalKbit = (targetMB * 8 * 1024) * 0.97;                 // 3% muxing overhead
    const videoKbps = Math.max(100, Math.floor(totalKbit / durationSec) - audioKbps);
    return { videoKbps, audioKbps, estMB: ((videoKbps + audioKbps) * durationSec) / 8 / 1024 };
  }

  async function encodeToTargetSize(targetMB, opts = {}) {
    const m = window.state?.inputFile;
    if (!m) { window.logToConsole?.('warn', 'No file selected.'); return null; }
    const dur = m.durationSec || 0;
    if (!dur) { window.logToConsole?.('error', 'Unknown duration — cannot compute a bitrate budget.'); return null; }

    const b = budget(targetMB, dur, opts.audioKbps || 128);
    window.logToConsole?.('', `[target] ${targetMB} MB over ${dur.toFixed(1)}s → ~${b.videoKbps} kbps video + ${b.audioKbps} kbps audio (est. ${b.estMB.toFixed(1)} MB)`);

    const out = 'target.mp4';
    const vf = opts.vf ? ['-vf', opts.vf] : [];

    // Two-pass gives a far more accurate landing than a single CBR pass.
    await window.ff.exec(['-i', m.virtualName, ...vf, '-c:v', 'libx264', '-preset', 'ultrafast',
      '-b:v', `${b.videoKbps}k`, '-pass', '1', '-an', '-f', 'mp4', '-y', '/dev/null']).catch(() => {});
    await window.ff.exec(['-i', m.virtualName, ...vf, '-c:v', 'libx264', '-preset', 'ultrafast',
      '-b:v', `${b.videoKbps}k`, '-pass', '2', '-c:a', 'aac', '-b:a', `${b.audioKbps}k`,
      '-pix_fmt', 'yuv420p', '-y', out]);

    let data = await window.ff.readFile(out);
    let mb = data.length / 1024 / 1024;
    window.logToConsole?.(mb <= targetMB ? 'ok' : 'warn', `[target] landed at ${mb.toFixed(2)} MB`);

    // Overshoot → binary-search the CRF. Max 3 iterations.
    let lo = 20, hi = 40, tries = 0;
    while (mb > targetMB && tries < 3) {
      const crf = Math.round((lo + hi) / 2);
      window.logToConsole?.('', `[target] overshoot — retrying at CRF ${crf}`);
      await window.ff.exec(['-i', m.virtualName, ...vf, '-c:v', 'libx264', '-preset', 'ultrafast',
        '-crf', String(crf), '-c:a', 'aac', '-b:a', `${b.audioKbps}k`, '-pix_fmt', 'yuv420p', '-y', out]);
      data = await window.ff.readFile(out);
      mb = data.length / 1024 / 1024;
      if (mb > targetMB) lo = crf + 1; else hi = crf - 1;
      tries++;
      window.logToConsole?.(mb <= targetMB ? 'ok' : 'warn', `[target] now ${mb.toFixed(2)} MB`);
    }

    const blob = new Blob([data.buffer], { type: 'video/mp4' });
    await window.addBlobToBin?.(blob, `${m.name} (${targetMB}MB)`, 'video/mp4');
    await window.ff.deleteFile(out).catch(() => {});
    return { mb, targetMB, ok: mb <= targetMB };
  }

  window.FFTools = {
    openPalette, closePalette,
    BUILTIN_LUTS, generateCube, loadLUT, lutFilter,
    loadSubtitles, subtitleFilter,
    SIZE_PRESETS, budget, encodeToTargetSize,
  };
  window.FFRecord = { start: startRecording, stop: stopRecording };
})();
