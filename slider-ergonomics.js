// =============================================================================
// slider-ergonomics.js  —  DAW-style range-input ergonomics (UX redesign)
// =============================================================================
// The app has ~31 audio knobs, ~24 trip-cam sliders and dozens of editor
// sliders. Native <input type=range> gives you keyboard steps but nothing else,
// so precise/repeated adjustment is fiddly. This adds, via one delegated
// listener (so it covers every current AND dynamically-built slider):
//   • double-click / double-tap → reset to the control's default (its markup
//     `value` attribute) — the single most-wanted knob gesture;
//   • wheel over a FOCUSED slider → nudge by one step (Shift = ×10), so you can
//     dial a value without a pixel-perfect drag; only when focused, so it never
//     hijacks page scroll.
// Every change dispatches input + change, so command previews, the audio graph
// and the undo stack all update exactly as if the user moved the thumb.
// =============================================================================

(function (global) {
  'use strict';

  const isRange = (el) => el && el.tagName === 'INPUT' && el.type === 'range';

  function clampToInput(el, v) {
    const min = el.min !== '' ? parseFloat(el.min) : -Infinity;
    const max = el.max !== '' ? parseFloat(el.max) : Infinity;
    return Math.min(max, Math.max(min, v));
  }
  function commit(el, v) {
    const before = el.value;
    el.value = String(v);
    if (el.value === before) return false;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // Reset a range to its markup default (the `value="..."` attribute).
  function resetToDefault(el) {
    if (!isRange(el)) return false;
    const def = el.getAttribute('value');
    if (def == null) return false;
    return commit(el, clampToInput(el, parseFloat(def)));
  }

  function nudge(el, dir, big) {
    if (!isRange(el)) return false;
    const step = (parseFloat(el.step) || 1) * (big ? 10 : 1);
    return commit(el, clampToInput(el, (parseFloat(el.value) || 0) + dir * step));
  }

  function install() {
    if (typeof document === 'undefined' || document.__sliderErgo) return;
    document.__sliderErgo = true;

    // double-click → reset
    document.addEventListener('dblclick', (e) => {
      const el = e.target;
      if (isRange(el)) { e.preventDefault(); resetToDefault(el); }
    });

    // wheel → nudge, but only when the slider is focused (intentional), so
    // scrolling the page over a rack never moves a value by accident.
    document.addEventListener('wheel', (e) => {
      const el = e.target;
      if (!isRange(el) || document.activeElement !== el) return;
      e.preventDefault();
      nudge(el, e.deltaY < 0 ? 1 : -1, e.shiftKey);
    }, { passive: false });

    // discoverability: hint the reset gesture (kept out of any existing title).
    const hint = (el) => { if (isRange(el) && !el.title) el.title = 'Double-click to reset · scroll to fine-tune (when focused)'; };
    document.querySelectorAll('input[type="range"]').forEach(hint);
    if (global.MutationObserver) {
      new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (isRange(n)) hint(n);
          else if (n.querySelectorAll) n.querySelectorAll('input[type="range"]').forEach(hint);
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
    else install();
  }

  const API = { install, resetToDefault, nudge };
  global.FFSliders = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
