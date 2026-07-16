/* =============================================================================
   clips.js — CLIP LIBRARY & QUEUE
   (from your Trippy Cam Clip Studio)
   -----------------------------------------------------------------------------
   The missing link between "I recorded something cool" and "I have a finished
   piece."

   Right now every Trip Cam / VJ recording drops into the media bin and sits
   there next to your source footage, undifferentiated. That's fine for one clip.
   It's useless after a session where you captured thirty.

   A clip library is a different thing from a media bin:
     • clips are OUTPUTS, not inputs — they have a take number and a timestamp
     • you want to review them fast, in a grid, and bin the bad ones
     • you want to SEQUENCE the good ones into one piece
     • you want to drop a music track over the whole sequence
     • you want to export the lot in one go

   That is a session workflow, and it is where all the actual work happens.
   ========================================================================== */

(function () {
  'use strict';

  const KEY = 'ffs.clips.v1';
  let clips = [];          // { id, name, blobUrl, blob, durationSec, take, at, selected }
  let take = 1;
  let audioTrack = null;   // a media-bin item to lay under the whole sequence

  // ---------------------------------------------------------------------------

  function add(blob, name, meta = {}) {
    const c = {
      id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: name || `Take ${take}`,
      blob,
      blobUrl: URL.createObjectURL(blob),
      size: blob.size,
      durationSec: meta.durationSec || 0,
      take: take++,
      at: Date.now(),
      source: meta.source || 'tripcam',
      selected: true,
    };
    clips.push(c);

    // Measure the duration natively — instant, no ffmpeg.
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      c.durationSec = isFinite(v.duration) ? v.duration : 0;
      render();
    };
    v.src = c.blobUrl;

    render();
    updateBadge();
    window.logToConsole?.('ok', `[clips] ${c.name} added (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    return c;
  }

  function remove(id) {
    const c = clips.find((x) => x.id === id);
    if (c) URL.revokeObjectURL(c.blobUrl);
    clips = clips.filter((x) => x.id !== id);
    render(); updateBadge();
  }

  function clear() {
    if (clips.length && !confirm(`Delete all ${clips.length} clips? This cannot be undone.`)) return;
    clips.forEach((c) => URL.revokeObjectURL(c.blobUrl));
    clips = []; take = 1;
    render(); updateBadge();
  }

  const selected = () => clips.filter((c) => c.selected);
  const totalDur = () => selected().reduce((s, c) => s + (c.durationSec || 0), 0);

  function updateBadge() {
    const b = document.getElementById('clips-badge');
    if (b) { b.textContent = String(clips.length); b.hidden = !clips.length; }
  }

  // ---------------------------------------------------------------------------
  // REORDER — drag to sequence. Order is the edit.
  // ---------------------------------------------------------------------------

  let dragId = null;

  function bindDrag(el, id) {
    el.draggable = true;
    el.addEventListener('dragstart', () => { dragId = id; el.classList.add('dragging'); });
    el.addEventListener('dragend',   () => { dragId = null; el.classList.remove('dragging'); });
    el.addEventListener('dragover',  (e) => { e.preventDefault(); el.classList.add('drop-target'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');
      if (!dragId || dragId === id) return;
      const from = clips.findIndex((c) => c.id === dragId);
      const to   = clips.findIndex((c) => c.id === id);
      const [m] = clips.splice(from, 1);
      clips.splice(to, 0, m);
      render();
    });
  }

  // ---------------------------------------------------------------------------
  // SEQUENCE + EXPORT — concat the selected clips, optionally under a track.
  // ---------------------------------------------------------------------------

  async function exportSequence() {
    const sel = selected();
    if (!sel.length) return window.logToConsole?.('warn', '[clips] nothing selected.');

    const status = document.getElementById('clips-status');
    const say = (m) => { if (status) status.textContent = m; window.logToConsole?.('', `[clips] ${m}`); };

    try {
      say(`Writing ${sel.length} clip(s) to the engine…`);
      const names = [];
      for (let i = 0; i < sel.length; i++) {
        const n = `clip_${String(i).padStart(3, '0')}.webm`;
        await window.ff.writeFile(n, new Uint8Array(await sel[i].blob.arrayBuffer()));
        names.push(n);
      }

      // The concat demuxer needs a list file. Re-encoding is required because
      // clips recorded at different times can have different stream params.
      const list = names.map((n) => `file '${n}'`).join('\n');
      await window.ff.writeFile('concat.txt', new TextEncoder().encode(list));

      say(`Concatenating ${sel.length} clips…`);
      const concatArgs = [
        '-f', 'concat', '-safe', '0', '-i', 'concat.txt',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1',
        '-pix_fmt', 'yuv420p', '-r', '30',
      ];

      let out = 'sequence.mp4';

      if (audioTrack) {
        // Lay the music under the whole thing, cut to the video's length.
        say('Laying the audio track under the sequence…');
        await window.ff.writeFile('bed.audio',
          new Uint8Array(await audioTrack.file.arrayBuffer()));
        await window.ff.exec([...concatArgs, '-an', '-y', 'seq_v.mp4']);
        await window.ff.exec([
          '-i', 'seq_v.mp4', '-i', 'bed.audio',
          '-map', '0:v', '-map', '1:a',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
          '-shortest', '-y', out,
        ]);
        await window.ff.deleteFile('seq_v.mp4').catch(() => {});
        await window.ff.deleteFile('bed.audio').catch(() => {});
      } else {
        await window.ff.exec([...concatArgs, '-y', out]);
      }

      const data = await window.ff.readFile(out);
      if (!data?.length) throw new Error('Concat produced no output.');

      const blob = new Blob([data.buffer], { type: 'video/mp4' });
      const name = `sequence_${sel.length}clips_${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.mp4`;

      await window.addBlobToBin?.(blob, name, 'video/mp4');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();

      for (const n of [...names, 'concat.txt', out]) await window.ff.deleteFile(n).catch(() => {});

      say(`✔ ${name} — ${(blob.size / 1024 / 1024).toFixed(1)} MB`);
      window.logToConsole?.('ok', `[clips] sequence exported → Media Bin + downloaded`);
    } catch (e) {
      say(`✗ ${e.message}`);
      window.logToConsole?.('error', `[clips] ${e.message}`);
    }
  }

  /** Send every selected clip to the Media Bin individually. */
  async function sendAllToBin() {
    for (const c of selected()) {
      await window.addBlobToBin?.(c.blob, `${c.name}.webm`, 'video/webm');
    }
    window.logToConsole?.('ok', `[clips] ${selected().length} clip(s) → Media Bin`);
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  function render() {
    const grid = document.getElementById('clips-grid');
    if (!grid) return;

    if (!clips.length) {
      grid.innerHTML = `
        <div class="clips-empty">
          <div class="ce-icon">🎬</div>
          <p><strong>No clips yet.</strong></p>
          <p class="dim">Record in <b>Trip Cam</b> or <b>VJ Mode</b> — every take lands here.
             Then reorder them, drop a track underneath, and export the whole session as one piece.</p>
        </div>`;
    } else {
      grid.innerHTML = clips.map((c) => `
        <div class="clip-card ${c.selected ? 'sel' : ''}" data-id="${c.id}">
          <div class="clip-num">${c.take}</div>
          <video src="${c.blobUrl}" muted loop preload="metadata"></video>
          <div class="clip-meta">
            <input type="checkbox" class="clip-check" data-id="${c.id}" ${c.selected ? 'checked' : ''}>
            <span class="clip-name">${c.name}</span>
            <span class="clip-dur">${c.durationSec ? c.durationSec.toFixed(1) + 's' : '—'}</span>
          </div>
          <div class="clip-acts">
            <button type="button" class="mini-btn" data-a="play" data-id="${c.id}">▶</button>
            <button type="button" class="mini-btn" data-a="bin"  data-id="${c.id}">→ Bin</button>
            <button type="button" class="mini-btn danger" data-a="del" data-id="${c.id}">✕</button>
          </div>
        </div>`).join('');

      grid.querySelectorAll('.clip-card').forEach((el) => bindDrag(el, el.dataset.id));
      grid.querySelectorAll('video').forEach((v) => {
        v.addEventListener('mouseenter', () => v.play().catch(() => {}));
        v.addEventListener('mouseleave', () => { v.pause(); v.currentTime = 0; });
      });
    }

    const info = document.getElementById('clips-info');
    if (info) {
      const s = selected();
      info.textContent = clips.length
        ? `${s.length} of ${clips.length} selected · ${totalDur().toFixed(1)}s total`
        : '';
    }
  }

  function build() {
    const tab = document.getElementById('tab-clips');
    if (!tab || tab.dataset.built) return;
    tab.dataset.built = '1';

    tab.innerHTML = `
      <div class="clips-wrap">
        <header class="clips-head">
          <div>
            <h2>🎬 Clip Library</h2>
            <p class="dim" id="clips-info"></p>
          </div>
          <div class="clips-actions">
            <select id="clips-audio" class="ctrl" title="Lay a music track under the whole sequence">
              <option value="">— no audio bed —</option>
            </select>
            <button type="button" class="mini-btn" id="clips-tobin">→ All to Media Bin</button>
            <button type="button" class="primary-btn" id="clips-export">⬇ Export sequence</button>
            <button type="button" class="mini-btn danger" id="clips-clear">Clear all</button>
          </div>
        </header>
        <p class="clips-hint">Drag to reorder — <strong>the order is the edit.</strong> Hover a clip to preview it.</p>
        <div id="clips-status" class="clips-status"></div>
        <div id="clips-grid" class="clips-grid"></div>
      </div>`;

    // Audio bed dropdown — any audio file in the media bin.
    const sel = document.getElementById('clips-audio');
    const refreshAudio = () => {
      const tracks = (window.state?.mediaBin || []).filter(
        (m) => m.type === 'audio' || (m.mime || '').startsWith('audio/'));
      sel.innerHTML = '<option value="">— no audio bed —</option>' +
        tracks.map((t) => `<option value="${t.id}">🎵 ${t.name}</option>`).join('');
    };
    refreshAudio();
    sel.addEventListener('focus', refreshAudio);
    sel.addEventListener('change', (e) => {
      audioTrack = (window.state?.mediaBin || []).find((m) => m.id === e.target.value) || null;
      window.logToConsole?.('', audioTrack
        ? `[clips] audio bed: ${audioTrack.name}`
        : '[clips] audio bed removed');
    });

    document.getElementById('clips-export').addEventListener('click', exportSequence);
    document.getElementById('clips-tobin').addEventListener('click', sendAllToBin);
    document.getElementById('clips-clear').addEventListener('click', clear);

    document.getElementById('clips-grid').addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (b) {
        const { a, id } = b.dataset;
        if (a === 'del') remove(id);
        if (a === 'bin') {
          const c = clips.find((x) => x.id === id);
          if (c) window.addBlobToBin?.(c.blob, `${c.name}.webm`, 'video/webm');
        }
        if (a === 'play') {
          const v = b.closest('.clip-card').querySelector('video');
          v.paused ? v.play() : v.pause();
        }
        return;
      }
      const chk = e.target.closest('.clip-check');
      if (chk) {
        const c = clips.find((x) => x.id === chk.dataset.id);
        if (c) { c.selected = chk.checked; render(); }
      }
    });

    render();
  }

  window.FFClips = { add, remove, clear, build, render, clips: () => clips, exportSequence };

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('[data-tab="clips"]')?.addEventListener('click', build);
  });
})();
