/* =============================================================================
   storage.js — AUTOSAVE · SESSION RESTORE · PROJECT EXPORT/IMPORT
   -----------------------------------------------------------------------------
   Until now, one accidental refresh destroyed everything: every control value,
   the media bin, custom workflows, saved chains. There was no persistence of
   any kind. This was the single highest-severity non-blocker in the app.

   What is saved:
     • every control value in all 32 sections (+ which sections are enabled)
     • the active workflow / preset
     • custom workflows and saved chains
     • a MANIFEST of the media bin (names, sizes, durations) — NOT the bytes.
       File bytes cannot go in localStorage (5MB cap) and shouldn't: on restore
       we ask the user to re-add the files by name.
   ========================================================================== */

(function () {
  'use strict';

  const KEY_SESSION = 'ffs.session.v1';
  const KEY_CUSTOM  = 'ffs.customWorkflows.v1';
  const KEY_CHAINS  = 'ffs.chains.v1';
  const AUTOSAVE_MS = 30000;

  let _dirty = false;
  let _timer = null;

  // ---------------------------------------------------------------------------
  // SERIALIZE
  // ---------------------------------------------------------------------------

  function snapshotControls() {
    const out = {};
    document.querySelectorAll('.ctrl, [id^="enable-"]').forEach((el) => {
      if (!el.id) return;
      if (el.type === 'checkbox' || el.type === 'radio') out[el.id] = el.checked;
      else if (el.type === 'file') { /* never persist file inputs */ }
      else out[el.id] = el.value;
    });
    return out;
  }

  function snapshotBinManifest() {
    return (window.state?.mediaBin || []).map((m) => ({
      id: m.id,
      name: m.name,
      size: m.size,
      type: m.type,
      mime: m.mime,
      durationSec: m.durationSec,
      width: m.width,
      height: m.height,
      isOutput: !!m.isOutput,
    }));
  }

  function snapshotSession() {
    return {
      v: 1,
      savedAt: Date.now(),
      controls: snapshotControls(),
      activeWorkflow: window.state?.activeWorkflowId || null,
      activeCategory: (typeof window.getActiveCategory === 'function')
        ? window.getActiveCategory() : 'all',
      activeTab: document.querySelector('.tab-btn.active')?.dataset?.tab || 'workflows',
      binManifest: snapshotBinManifest(),
    };
  }

  // ---------------------------------------------------------------------------
  // SAVE / LOAD
  // ---------------------------------------------------------------------------

  function saveSession() {
    try {
      localStorage.setItem(KEY_SESSION, JSON.stringify(snapshotSession()));
      _dirty = false;
      const el = document.getElementById('autosave-chip');
      if (el) {
        el.textContent = '✔ Saved';
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 900);
      }
      return true;
    } catch (e) {
      // QuotaExceeded — degrade gracefully, never throw during a render.
      console.warn('[storage] autosave failed:', e.message);
      return false;
    }
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(KEY_SESSION);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function clearSession() {
    try { localStorage.removeItem(KEY_SESSION); } catch (_) {}
  }

  /** Apply a saved session's control values back onto the DOM. */
  function applyControls(controls) {
    if (!controls) return 0;
    let n = 0;
    for (const [id, val] of Object.entries(controls)) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked !== val) { el.checked = val; el.dispatchEvent(new Event('change', { bubbles: true })); }
      } else {
        if (el.value !== String(val)) {
          el.value = val;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      n++;
    }
    return n;
  }

  // ---------------------------------------------------------------------------
  // RESTORE PROMPT
  // ---------------------------------------------------------------------------

  function offerRestore() {
    const s = loadSession();
    if (!s || !s.controls) return;

    const ageMin = Math.round((Date.now() - (s.savedAt || 0)) / 60000);
    const files  = (s.binManifest || []).map((m) => m.name);

    const bar = document.createElement('div');
    bar.className = 'restore-bar';
    bar.innerHTML = `
      <span class="restore-msg">
        <strong>Restore your last session?</strong>
        <span class="dim">Saved ${ageMin < 1 ? 'moments' : ageMin + ' min'} ago${
          files.length ? ` · expects: ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3} more` : ''}` : ''
        }</span>
      </span>
      <button type="button" id="restore-yes" class="mini-btn primary">Restore</button>
      <button type="button" id="restore-no"  class="mini-btn">Start fresh</button>`;
    document.body.appendChild(bar);

    bar.querySelector('#restore-yes').addEventListener('click', () => {
      const n = applyControls(s.controls);
      if (s.activeCategory && typeof window.setActiveCategory === 'function') {
        window.setActiveCategory(s.activeCategory);
      }
      if (s.activeTab && typeof window.switchTab === 'function') window.switchTab(s.activeTab);
      window.logToConsole?.('ok', `Session restored — ${n} control(s).`);
      if (files.length) {
        window.logToConsole?.('warn',
          `Re-add your media to continue: ${files.join(', ')}`);
      }
      bar.remove();
    });

    bar.querySelector('#restore-no').addEventListener('click', () => {
      clearSession();
      bar.remove();
    });
  }

  // ---------------------------------------------------------------------------
  // PROJECT EXPORT / IMPORT
  // ---------------------------------------------------------------------------

  function exportProject() {
    const proj = {
      ...snapshotSession(),
      kind: 'ffmpeg-studio-project',
      customWorkflows: JSON.parse(localStorage.getItem(KEY_CUSTOM) || '[]'),
      chains:          JSON.parse(localStorage.getItem(KEY_CHAINS) || '[]'),
    };
    const blob = new Blob([JSON.stringify(proj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ffmpeg-studio-project-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    window.logToConsole?.('ok', 'Project exported.');
  }

  function importProject(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const p = JSON.parse(fr.result);
        if (p.kind !== 'ffmpeg-studio-project') throw new Error('Not an FFmpeg Studio project file.');

        const n = applyControls(p.controls);
        if (p.customWorkflows) localStorage.setItem(KEY_CUSTOM, JSON.stringify(p.customWorkflows));
        if (p.chains)          localStorage.setItem(KEY_CHAINS, JSON.stringify(p.chains));

        window.logToConsole?.('ok', `Project imported — ${n} control(s).`);
        const want = (p.binManifest || []).map((m) => m.name);
        if (want.length) {
          window.logToConsole?.('warn', `This project expects: ${want.join(', ')}`);
          alert(`Project loaded.\n\nRe-add these files to the Media Bin:\n\n• ${want.join('\n• ')}`);
        }
        if (typeof window.renderWorkflows === 'function') window.renderWorkflows();
      } catch (e) {
        window.logToConsole?.('error', `Import failed: ${e.message}`);
      }
    };
    fr.readAsText(file);
  }

  // ---------------------------------------------------------------------------
  // WIRE UP
  // ---------------------------------------------------------------------------

  function markDirty() { _dirty = true; }

  function init() {
    // Any control change marks the session dirty.
    document.addEventListener('input',  markDirty, true);
    document.addEventListener('change', markDirty, true);

    // Periodic autosave — only writes when something actually changed.
    _timer = setInterval(() => { if (_dirty) saveSession(); }, AUTOSAVE_MS);

    // Save immediately on the events most likely to precede a data loss.
    window.addEventListener('pagehide', saveSession);
    window.addEventListener('blur', () => { if (_dirty) saveSession(); });

    // Warn if a render is in flight.
    window.addEventListener('beforeunload', (e) => {
      if (_dirty) saveSession();
      if (window.state?.isProcessing) {
        e.preventDefault();
        e.returnValue = 'A render is still running. Leave anyway?';
        return e.returnValue;
      }
    });

    offerRestore();
    window.logToConsole?.('', `Autosave active (every ${AUTOSAVE_MS / 1000}s).`);
  }

  window.FFStorage = {
    init, saveSession, loadSession, clearSession,
    exportProject, importProject, snapshotSession, applyControls,
    KEY_CUSTOM, KEY_CHAINS,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
