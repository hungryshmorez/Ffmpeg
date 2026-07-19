/* =============================================================================
   prefs.js — PREFERENCES (#95)
   -----------------------------------------------------------------------------
   A tiny localStorage-backed settings store + a panel to edit it. Preferences
   survive reloads and are applied to the document (reduced motion, accent
   colour) so they actually do something. Pure get/set/all, unit-tested through
   the round trip.
   ========================================================================== */
(function () {
  'use strict';

  const KEY = 'ffstudio.prefs.v1';
  const DEFAULTS = Object.freeze({
    reduceMotion: false,       // dial down animations
    defaultFormat: 'mp4',      // preselected export format
    autoSuggest: true,         // #88 workflow suggestions on load
    confirmDelete: true,       // ask before deleting a bin item
    accent: '#7c5cff',         // UI accent colour
  });

  function all() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { stored = {}; }
    return Object.assign({}, DEFAULTS, stored);
  }
  function get(k) { return all()[k]; }
  function set(k, v) {
    const p = all(); p[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (_) {}
    apply();
    return p;
  }
  function reset() { try { localStorage.removeItem(KEY); } catch (_) {} apply(); }

  /** Reflect the prefs onto the document so they take effect. */
  function apply() {
    const p = all();
    const root = document.documentElement;
    if (root) {
      root.classList.toggle('reduce-motion', !!p.reduceMotion);
      if (p.accent) root.style.setProperty('--accent', p.accent);
    }
  }

  /** Build / open the preferences modal. */
  function openPanel() {
    let el = document.getElementById('ff-prefs-modal');
    if (el) { el.hidden = false; return el; }
    const p = all();
    el = document.createElement('div');
    el.id = 'ff-prefs-modal'; el.className = 'ff-prefs-modal';
    const fmt = ['mp4', 'webm', 'mov', 'gif'];
    el.innerHTML = `<div class="ff-prefs-box" role="dialog" aria-label="Preferences">
        <header><strong>⚙ Preferences</strong><button type="button" id="ff-prefs-close" aria-label="Close">✕</button></header>
        <label class="ff-prefs-row"><input type="checkbox" id="pf-reduceMotion"${p.reduceMotion ? ' checked' : ''}> Reduce motion</label>
        <label class="ff-prefs-row"><input type="checkbox" id="pf-autoSuggest"${p.autoSuggest ? ' checked' : ''}> Suggest workflows when a clip loads</label>
        <label class="ff-prefs-row"><input type="checkbox" id="pf-confirmDelete"${p.confirmDelete ? ' checked' : ''}> Confirm before deleting a bin item</label>
        <label class="ff-prefs-row">Default export <select id="pf-defaultFormat" class="ctrl">${fmt.map((f) => `<option${p.defaultFormat === f ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
        <label class="ff-prefs-row">Accent colour <input type="color" id="pf-accent" value="${p.accent}"></label>
        <footer><button type="button" id="ff-prefs-reset" class="mini-btn">Reset to defaults</button></footer>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target === el) el.hidden = true; });
    el.querySelector('#ff-prefs-close').onclick = () => { el.hidden = true; };
    el.querySelector('#pf-reduceMotion').onchange = (e) => set('reduceMotion', e.target.checked);
    el.querySelector('#pf-autoSuggest').onchange = (e) => set('autoSuggest', e.target.checked);
    el.querySelector('#pf-confirmDelete').onchange = (e) => set('confirmDelete', e.target.checked);
    el.querySelector('#pf-defaultFormat').onchange = (e) => set('defaultFormat', e.target.value);
    el.querySelector('#pf-accent').oninput = (e) => set('accent', e.target.value);
    el.querySelector('#ff-prefs-reset').onclick = () => { reset(); el.remove(); openPanel(); };
    return el;
  }

  window.FFPrefs = { all, get, set, reset, apply, openPanel, DEFAULTS, KEY };
  // "," opens preferences (unless typing in a field)
  document.addEventListener('keydown', (e) => {
    if (e.key === ',' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault(); openPanel();
    }
  });
  // apply on load so a saved accent / reduced-motion is live immediately
  if (document.readyState !== 'loading') apply();
  else document.addEventListener('DOMContentLoaded', apply);
})();
