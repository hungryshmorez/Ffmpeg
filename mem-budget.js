// =============================================================================
// mem-budget.js  —  #24 A real memory budget
// =============================================================================
// MEMFS (the wasm heap), GPU textures, decoded VideoFrames and AudioBuffers all
// draw on the same finite pool, and when it runs out the tab dies mid-render.
// This unifies every source into ONE number measured against a device-derived
// budget, with an ok / warn / over status you can act on before the crash.
//
// The model + estimators are pure and unit-tested. `attach()` wires the live
// MEMFS figure (already tracked in state.memfsBytes) and paints a compact
// readout, without disturbing the existing per-source MEMFS gauge.
// =============================================================================

(function (global) {
  'use strict';

  const GB = 1024 * 1024 * 1024;
  const HARD_CAP = 2 * GB;           // wasm32 linear-memory ceiling
  const WARN = 0.75, OVER = 0.90;    // fractions of the budget

  // Budget derived from the device. navigator.deviceMemory is coarse GiB
  // (0.25–8). We keep a fraction for our tab and never exceed the wasm cap.
  function deviceBudgetBytes() {
    let dm = 0;
    try { dm = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 0; } catch (_) { dm = 0; }
    if (!dm) return Math.round(1.5 * GB);           // unknown → conservative default
    return Math.min(HARD_CAP, Math.round(dm * GB * 0.4));
  }

  // ---- Per-source estimators (bytes) ----------------------------------------
  const textureBytes = (w, h, n) => (w | 0) * (h | 0) * 4 * (n == null ? 1 : n);          // RGBA8
  const videoFrameBytes = (w, h, n, fmt) => {
    const count = n == null ? 1 : n;
    const bpp = fmt === 'i420' || fmt === 'nv12' ? 1.5 : 4;                                 // planar YUV vs RGBA
    return Math.round((w | 0) * (h | 0) * bpp * count);
  };
  const audioBufferBytes = (channels, samples) => (channels | 0) * (samples | 0) * 4;       // Float32
  const memfsBytesOf = (files) => (Array.isArray(files) ? files.reduce((s, f) => s + ((f && (f.size || f.length)) || 0), 0) : 0);

  // ---- Live registry of named sources ---------------------------------------
  const _sources = new Map();        // name → bytes
  // NB: use Math.floor, NOT `| 0` — bitwise ops overflow the 32-bit signed range
  // and a multi-GB figure would wrap negative (then clamp to 0).
  function report(name, bytes) { if (name) _sources.set(name, Math.max(0, Math.floor(bytes) || 0)); return bytes; }
  function clear(name) { if (name == null) _sources.clear(); else _sources.delete(name); }
  function breakdown() { const o = {}; for (const [k, v] of _sources) o[k] = v; return o; }
  function total() { let t = 0; for (const v of _sources.values()) t += v; return t; }

  function status(budgetOverride) {
    const budgetBytes = budgetOverride || deviceBudgetBytes();
    const usedBytes = total();
    const pct = budgetBytes ? usedBytes / budgetBytes : 0;
    const level = pct >= OVER ? 'over' : pct >= WARN ? 'warn' : 'ok';
    return { usedBytes, budgetBytes, pct, level, breakdown: breakdown() };
  }

  function format(bytes) {
    const b = Math.max(0, Math.floor(bytes) || 0);   // Math.floor, not `| 0` (32-bit overflow)
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    if (b < GB) return (b / (1024 * 1024)).toFixed(b < 100 * 1024 * 1024 ? 1 : 0) + ' MB';
    return (b / GB).toFixed(2) + ' GB';
  }

  // ---- Readout ---------------------------------------------------------------
  function readoutString(st) {
    const s = st || status();
    return `MEM ${format(s.usedBytes)} / ${format(s.budgetBytes)} (${Math.round(s.pct * 100)}%)`;
  }

  function renderInto(el, st) {
    if (!el) return;
    const s = st || status();
    el.textContent = readoutString(s);
    el.classList.remove('ok', 'warn', 'over');
    el.classList.add(s.level);
    el.title = 'Unified memory budget — ' + Object.entries(s.breakdown).map(([k, v]) => `${k}: ${format(v)}`).join(' · ');
  }

  // Own a compact readout next to the MEMFS gauge (never rewrites that gauge).
  let _el = null, _timer = 0;
  function _ensureEl() {
    if (typeof document === 'undefined') return null;
    if (_el && document.body.contains(_el)) return _el;
    _el = document.getElementById('mem-budget');
    if (_el) return _el;
    const gauge = document.getElementById('memfs-gauge');
    _el = document.createElement('span');
    _el.id = 'mem-budget';
    _el.className = 'mem-budget ok';
    _el.style.cssText = 'margin-left:10px;font:12px/1 system-ui;opacity:.9';
    if (gauge && gauge.parentNode) gauge.parentNode.insertBefore(_el, gauge.nextSibling);
    else document.body.appendChild(_el);
    return _el;
  }

  function refresh() {
    // pull the live MEMFS figure the app already computes
    try { report('memfs', (global.state && global.state.memfsBytes) || 0); } catch (_) {}
    const el = _ensureEl();
    if (el) renderInto(el, status());
  }

  function attach(intervalMs) {
    if (typeof document === 'undefined') return;
    if (_timer) return;
    refresh();
    _timer = setInterval(refresh, Math.max(500, intervalMs || 2000));
  }

  if (typeof document !== 'undefined') {
    const boot = () => attach();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  const API = {
    GB, HARD_CAP, WARN, OVER,
    deviceBudgetBytes, textureBytes, videoFrameBytes, audioBufferBytes, memfsBytesOf,
    report, clear, breakdown, total, status, format, readoutString, renderInto, refresh, attach,
  };
  global.FFMemBudget = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
