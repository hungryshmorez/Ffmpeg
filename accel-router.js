// =============================================================================
// accel-router.js  —  Unified graceful-fallback layer (Phase 4.2 keystone)
// =============================================================================
// The app has (or will have) three acceleration tiers, none of them universally
// available: WebCodecs (hardware decode/encode, in hwaccel.js), WebGPU compute
// (blueprint), and OPFS streaming (opfs.js). Each can be MISSING (old browser,
// no GPU) or can THROW AT RUNTIME (context loss, driver eviction, unsupported
// codec). A media editor cannot let any of that take a workflow down.
//
// This is the single decision + resilience surface every accelerated path routes
// through. It:
//   • detects capabilities once (folding in the existing FFHardware.CAPS /
//     FFOPFS probes so nothing is duplicated),
//   • picks accelerated vs. fallback per operation given caps + a user mode,
//   • and — critically — runs the accelerated impl inside a try/catch so that if
//     it throws, it SILENTLY falls back to the wasm/WebGL impl and the operation
//     still completes. All 215 workflows keep working, accelerated or not.
//
// Nothing here forces the accelerated engines to exist; where they're absent
// (e.g. this headless test environment: no WebGPU, no VideoDecoder, no OPFS)
// every route resolves to the proven fallback — which is exactly what the tests
// assert.
// =============================================================================

(function (global) {
  'use strict';

  const KEY = 'ffstudio.accel.mode.v1';
  const state = {
    caps: null,               // { webgpu, webcodecs, opfs, webgl2 } once detected
    mode: 'auto',             // 'auto' | 'wasm' (force fallback) | 'accel' (prefer)
    _forced: null,            // test hook: overrides detected caps
    _listeners: [],
    lastPath: {},             // op name → 'accel' | 'fallback' | 'fallback-after-error'
  };

  try { const m = global.localStorage && localStorage.getItem(KEY); if (m) state.mode = m; } catch (_) {}

  // ---- capability detection --------------------------------------------------
  async function detect() {
    if (state._forced) { state.caps = { ...state._forced }; return state.caps; }
    const caps = { webgpu: false, webcodecs: false, opfs: false, webgl2: false };

    // WebCodecs — reuse the app's own probe if it already ran, else check window.
    try {
      const hw = global.FFHardware;
      caps.webcodecs = !!(hw && hw.CAPS && hw.CAPS.webcodecs) ||
        (('VideoDecoder' in global) && ('VideoEncoder' in global));
    } catch (_) {}

    // WebGPU — presence AND a real adapter (presence alone is not enough).
    try {
      if (global.navigator && global.navigator.gpu) {
        const adapter = await global.navigator.gpu.requestAdapter();
        caps.webgpu = !!adapter;
      }
    } catch (_) { caps.webgpu = false; }

    // OPFS — the async filesystem root must be reachable.
    try { caps.opfs = !!(global.navigator && global.navigator.storage && global.navigator.storage.getDirectory); } catch (_) {}

    // WebGL2 — the current fallback GPU path.
    try {
      const c = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
      caps.webgl2 = !!(c && c.getContext('webgl2'));
    } catch (_) {}

    state.caps = caps;
    _emit({ type: 'detect', caps });
    return caps;
  }

  function caps() { return state.caps || { webgpu: false, webcodecs: false, opfs: false, webgl2: false }; }
  function available(feature) { return !!caps()[feature]; }

  function setMode(mode) {
    if (!['auto', 'wasm', 'accel'].includes(mode)) return;
    state.mode = mode;
    try { global.localStorage && localStorage.setItem(KEY, mode); } catch (_) {}
    _emit({ type: 'mode', mode });
  }
  function mode() { return state.mode; }

  // Test hook: pretend a given capability set (and skip real probing).
  function _setCapsForTest(c) { state._forced = c ? { ...c } : null; state.caps = c ? { ...c } : state.caps; }

  function onEvent(cb) { if (typeof cb === 'function') state._listeners.push(cb); }
  function _emit(e) { for (const cb of state._listeners) { try { cb(e); } catch (_) {} } }

  // ---- the resilient router --------------------------------------------------
  // route({ name, need, accelerated, fallback, onPath }) -> Promise<result>
  //   need         — capability key ('webgpu'|'webcodecs'|'opfs') or predicate(caps)
  //   accelerated  — async () => result   (the hardware path)
  //   fallback     — async () => result   (the wasm/WebGL path; MUST exist)
  //   onPath(path) — optional observer of which path ran
  async function route(op) {
    const { name = 'op', need, accelerated, fallback, onPath } = op || {};
    if (typeof fallback !== 'function') throw new Error('accel.route: a fallback is required');

    const capsNow = state.caps || await detect();
    const capable = typeof need === 'function' ? !!need(capsNow) : (need == null ? true : !!capsNow[need]);
    const wantAccel = state.mode !== 'wasm' && typeof accelerated === 'function' && capable;

    const finish = (path, result) => { state.lastPath[name] = path; if (onPath) try { onPath(path); } catch (_) {} _emit({ type: 'route', name, path }); return result; };

    if (!wantAccel) return finish('fallback', await fallback());

    try {
      return finish('accel', await accelerated());
    } catch (err) {
      // The whole point: a hardware failure must NOT take the operation down.
      try { global.logToConsole && global.logToConsole('warn', `[accel] ${name}: hardware path failed (${err && err.message || err}) — using fallback.`); } catch (_) {}
      return finish('fallback-after-error', await fallback());
    }
  }

  function lastPath(name) { return state.lastPath[name]; }

  const API = { detect, caps, available, setMode, mode, route, lastPath, onEvent, _setCapsForTest, KEY };
  global.FFAccel = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;

  // Probe once at boot so caps() is ready for the first render (non-blocking).
  if (typeof document !== 'undefined') {
    const boot = () => { detect().catch(() => {}); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
