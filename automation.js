/* =============================================================================
   automation.js — AUTOMATION RECORDING (#76)
   -----------------------------------------------------------------------------
   Record parameter moves during a performance, play them back. A small,
   deterministic event recorder: each move is stamped with its time since the
   take started; playback reads the value of any parameter at any time (the last
   move at or before that time — a sample-and-hold automation lane). Pure, so
   it's unit-tested directly; the VJ deck wires a REC/PLAY button to it.
   ========================================================================== */
(function () {
  'use strict';

  class Automation {
    constructor() { this.events = []; this.recording = false; this._t0 = 0; }

    /** Start a fresh take. `now` is a clock reading (e.g. performance.now()/1000). */
    start(now = 0) { this.events = []; this.recording = true; this._t0 = now; }
    stop() { this.recording = false; }

    /** Log a parameter move. No-op unless recording. */
    record(param, value, now = 0) {
      if (!this.recording) return;
      this.events.push({ t: now - this._t0, param, value });
    }

    /** Value of `param` at time `t` — the last move at or before t (or undefined). */
    valueAt(param, t) {
      let v; for (const e of this.events) { if (e.param !== param) continue; if (e.t <= t + 1e-9) v = e.value; else break; }
      return v;
    }

    /** Every parameter's value at time `t` — the full patch to apply on playback. */
    stateAt(t) {
      const s = {}; for (const e of this.events) if (e.t <= t + 1e-9) s[e.param] = e.value; return s;
    }

    duration() { return this.events.length ? this.events[this.events.length - 1].t : 0; }
    get length() { return this.events.length; }
    serialize() { return JSON.stringify({ events: this.events }); }
    static deserialize(str) { const a = new Automation(); try { a.events = (JSON.parse(str).events) || []; } catch (_) {} return a; }
  }

  window.FFAutomation = { Automation };
})();
