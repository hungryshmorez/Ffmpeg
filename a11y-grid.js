// =============================================================================
// a11y-grid.js  —  keyboard-navigable, accessible card grids (UX redesign)
// =============================================================================
// The two highest-traffic surfaces — the Media Bin and the 215-card Workflow
// grid — were non-focusable <div>/<article> elements packed with nested buttons.
// That produced two problems at once:
//   • no keyboard access to the cards themselves, and
//   • a tab order with ~645 stops in the workflow grid alone (a keyboard trap).
//
// This turns any card container into an ARIA listbox with a SINGLE tab stop and
// roving-tabindex arrow navigation (the WAI-ARIA composite-widget pattern):
//   • Tab lands on the grid once; arrows move between cards; Home/End jump.
//   • Enter/Space runs the card's primary action; typed keys run secondary ones.
//   • Inner buttons are removed from the tab order (still clickable by mouse),
//     so power users fly through cards without 600 tab stops.
// It is idempotent — re-run it after every re-render; handlers bind once to the
// stable container.
// =============================================================================

(function (global) {
  'use strict';

  function columnsOf(items) {
    if (items.length < 2) return 1;
    const top0 = items[0].offsetTop;
    let c = 1;
    for (let i = 1; i < items.length; i++) { if (items[i].offsetTop !== top0) break; c++; }
    return c;
  }

  // Enhance `container`. opts:
  //   itemSelector   (required) — CSS for the cards
  //   label          — aria-label for the container
  //   role/itemRole  — default 'listbox' / 'option'
  //   selectedSelector — card that is the current selection (tabindex 0 + aria-selected)
  //   trapInner      — remove inner focusables from the tab order (default true)
  //   onActivate(item, e)     — Enter/Space
  //   onKey(e, item) -> bool  — secondary keys; return true if handled
  function enhance(container, opts) {
    if (!container || typeof document === 'undefined') return;
    opts = opts || {};
    const sel = opts.itemSelector;
    if (!sel) return;
    const items = () => Array.from(container.querySelectorAll(sel));

    container.setAttribute('role', opts.role || 'listbox');
    if (opts.label && !container.getAttribute('aria-label')) container.setAttribute('aria-label', opts.label);

    // (re)apply roles + roving tabindex on the current item set
    const list = items();
    let current = opts.selectedSelector ? list.findIndex((el) => el.matches(opts.selectedSelector)) : -1;
    if (current < 0) current = 0;
    list.forEach((el, i) => {
      el.setAttribute('role', opts.itemRole || 'option');
      el.tabIndex = i === current ? 0 : -1;
      if (opts.selectedSelector) el.setAttribute('aria-selected', el.matches(opts.selectedSelector) ? 'true' : 'false');
      if (opts.trapInner !== false) {
        el.querySelectorAll('a[href],button,input,select,textarea,[tabindex]').forEach((f) => {
          if (f !== el) f.tabIndex = -1;
        });
      }
    });

    if (container.__gridNavBound) return;    // the container is stable across re-renders
    container.__gridNavBound = true;

    const focusAt = (i) => {
      const l = items(); if (!l.length) return;
      i = Math.max(0, Math.min(l.length - 1, i));
      l.forEach((el, j) => { el.tabIndex = j === i ? 0 : -1; });
      l[i].focus();
    };

    container.addEventListener('keydown', (e) => {
      const item = e.target.closest(sel);
      if (!item || !container.contains(item)) return;
      const l = items();
      const i = l.indexOf(item);
      if (i < 0) return;
      const c = columnsOf(l);
      let handled = true;
      switch (e.key) {
        case 'ArrowRight': focusAt(i + 1); break;
        case 'ArrowLeft':  focusAt(i - 1); break;
        case 'ArrowDown':  focusAt(i + c); break;
        case 'ArrowUp':    focusAt(i - c); break;
        case 'Home':       focusAt(0); break;
        case 'End':        focusAt(l.length - 1); break;
        case 'Enter':
        case ' ':          if (opts.onActivate) opts.onActivate(item, e); break;
        default:           handled = !!(opts.onKey && opts.onKey(e, item));
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    });

    // keep the roving tabindex synced to whatever actually took focus (mouse).
    container.addEventListener('focusin', (e) => {
      const item = e.target.closest(sel);
      if (!item) return;
      items().forEach((el) => { el.tabIndex = el === item ? 0 : -1; });
    });
  }

  global.FFGridNav = { enhance, columnsOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.FFGridNav;
})(typeof window !== 'undefined' ? window : globalThis);
