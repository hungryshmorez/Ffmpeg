// =============================================================================
// section-filter.js  —  progressive disclosure for the Editor controls
// =============================================================================
// The Editor stacks 33 <details class="section"> panels in one column. They are
// individually collapsible, but the user still faces a wall of 33 headers and
// has to hunt for the two or three they actually use. This adds a compact
// controller at the top of the column that reduces the wall to just what's
// relevant right now:
//   • "Active only" — show only the sections whose enable toggle is on (the
//     ones that actually affect the output), hiding the rest;
//   • a search box that filters sections by title;
//   • Expand / Collapse all (of the currently-visible sections);
//   • a live "N of 33 active" count.
// It's a pure presentation layer over the existing DOM — it changes nothing
// about how the sections work or render their commands.
// =============================================================================

(function (global) {
  'use strict';

  const KEY = 'ffstudio.sections.activeOnly.v1';
  const state = { activeOnly: false, term: '' };

  function sections() {
    const col = document.getElementById('controls-column');
    return col ? Array.from(col.querySelectorAll('details.section')) : [];
  }
  function titleOf(sec) {
    return (sec.querySelector('.section-title')?.textContent || '').toLowerCase();
  }
  // A section is "active" if its enable toggle is on. Sections with no enable
  // toggle (e.g. Output Format) are always relevant → always active.
  function isActive(sec) {
    const cb = sec.querySelector('.section-enable');
    return cb ? cb.checked : true;
  }

  function apply() {
    const secs = sections();
    let activeCount = 0, shown = 0;
    for (const sec of secs) {
      if (isActive(sec) && sec.querySelector('.section-enable')) activeCount++;
      const matchesSearch = !state.term || titleOf(sec).includes(state.term);
      const matchesActive = !state.activeOnly || isActive(sec);
      const visible = matchesSearch && matchesActive;
      sec.hidden = !visible;
      if (visible) shown++;
    }
    const count = document.getElementById('section-count');
    if (count) {
      count.textContent = state.activeOnly
        ? `${shown} shown · ${activeCount} on`
        : `${activeCount} of ${secs.length} on`;
    }
    const btn = document.getElementById('section-active-only');
    if (btn) { btn.setAttribute('aria-pressed', state.activeOnly ? 'true' : 'false'); btn.classList.toggle('on', state.activeOnly); }
  }

  function setActiveOnly(on) {
    state.activeOnly = on == null ? !state.activeOnly : !!on;
    try { localStorage.setItem(KEY, state.activeOnly ? '1' : '0'); } catch (_) {}
    apply();
  }
  function setTerm(t) { state.term = String(t || '').trim().toLowerCase(); apply(); }
  function expandAll(open) {
    for (const sec of sections()) if (!sec.hidden) sec.open = !!open;
  }

  function buildToolbar(col) {
    if (document.getElementById('section-filter')) return;
    const bar = document.createElement('div');
    bar.id = 'section-filter';
    bar.className = 'section-filter';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Filter editor sections');
    bar.innerHTML = `
      <input type="search" id="section-search" class="section-search" placeholder="Filter sections…" aria-label="Filter sections by name" autocomplete="off">
      <button type="button" id="section-active-only" class="section-btn" aria-pressed="false" title="Show only enabled sections">Active only</button>
      <button type="button" id="section-expand" class="section-btn" title="Expand visible sections">Expand</button>
      <button type="button" id="section-collapse" class="section-btn" title="Collapse visible sections">Collapse</button>
      <span id="section-count" class="section-count" aria-live="polite"></span>`;
    // insert right after the controls header (or at the top of the column)
    const header = col.querySelector('.controls-header');
    if (header && header.nextSibling) col.insertBefore(bar, header.nextSibling);
    else col.insertBefore(bar, col.firstChild);

    bar.querySelector('#section-search').addEventListener('input', (e) => setTerm(e.target.value));
    bar.querySelector('#section-active-only').addEventListener('click', () => setActiveOnly());
    bar.querySelector('#section-expand').addEventListener('click', () => expandAll(true));
    bar.querySelector('#section-collapse').addEventListener('click', () => expandAll(false));
  }

  function init() {
    const col = document.getElementById('controls-column');
    if (!col) return;
    try { state.activeOnly = localStorage.getItem(KEY) === '1'; } catch (_) {}
    buildToolbar(col);
    // re-apply when a section's enable toggle changes so "active only" tracks live
    if (!col.__sectionFilterBound) {
      col.__sectionFilterBound = true;
      col.addEventListener('change', (e) => {
        if (e.target && e.target.classList && e.target.classList.contains('section-enable')) apply();
      });
    }
    apply();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }

  const API = { init, apply, setActiveOnly, setTerm, expandAll, isActive, KEY,
    state: () => ({ ...state }) };
  global.FFSections = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
