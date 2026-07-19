// =============================================================================
// midi-in.js  —  #69 MIDI clock sync (slave)
// =============================================================================
// Locks the VJ sequencer to an INCOMING MIDI clock so the deck plays in time
// with anyone else on the wire (a DAW, a drum machine, another VJ rig). It
// decodes the realtime stream — 24 PPQN clock (0xF8), start (0xFA), continue
// (0xFB), stop (0xFC) — counts 6 pulses per 16th-note step, derives BPM from
// the pulse interval, and drives the sequencer one step at a time.
//
// The decoder (pulse counting, transport, tempo derivation) is pure and tested
// by feeding a synthetic clock stream with explicit timestamps. Only receiving
// real messages from hardware needs Web MIDI + a device; it degrades to idle
// when that isn't present.
// =============================================================================

(function (global) {
  'use strict';

  const CLOCK = 0xF8, START = 0xFA, CONTINUE = 0xFB, STOP = 0xFC;
  const PPQN = 24;

  const S = {
    playing: false,
    bpm: 120,
    clocksPerStep: 6,      // 24 PPQN / 4 steps-per-beat = 6 → 16th notes
    _pulse: 0,
    _lastT: null,
    _ema: null,
    access: null,
    inputs: [],
    // callbacks (set by slaveVJ or a custom consumer)
    onStep: null, onStart: null, onStop: null, onContinue: null, onTempo: null,
  };

  function _normalize(msg) {
    if (!msg) return null;
    if (Array.isArray(msg)) return msg;
    if (msg.data) return Array.from(msg.data);            // MIDIMessageEvent
    if (typeof msg[Symbol.iterator] === 'function') return Array.from(msg);
    return null;
  }

  function _deriveTempo(t) {
    if (t == null) return;
    if (S._lastT != null) {
      const dt = t - S._lastT;
      if (dt > 0 && dt < 1000) {                          // ignore junk gaps
        const inst = 60000 / (dt * PPQN);
        S._ema = S._ema == null ? inst : S._ema * 0.8 + inst * 0.2;
        S.bpm = Math.round(S._ema * 10) / 10;
        if (S.onTempo) try { S.onTempo(S.bpm); } catch (_) {}
      }
    }
    S._lastT = t;
  }

  function _onClock(t) {
    _deriveTempo(t);
    if (!S.playing) return;
    S._pulse++;
    if (S._pulse % S.clocksPerStep === 0 && S.onStep) {
      try { S.onStep(); } catch (_) {}
    }
  }

  // Feed one MIDI message (bytes, MIDIMessageEvent, or Uint8Array). `tMs` is an
  // optional timestamp (ms) used for tempo derivation; falls back to the event's
  // timeStamp or performance.now().
  function handleMessage(msg, tMs) {
    const b = _normalize(msg);
    if (!b || !b.length) return;
    const t = tMs != null ? tMs : (msg && msg.timeStamp != null ? msg.timeStamp
      : (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    switch (b[0]) {
      case CLOCK: _onClock(t); break;
      case START: S._pulse = 0; S._lastT = null; S.playing = true; if (S.onStart) try { S.onStart(); } catch (_) {} break;
      case CONTINUE: S.playing = true; if (S.onContinue) try { S.onContinue(); } catch (_) {} break;
      case STOP: S.playing = false; if (S.onStop) try { S.onStop(); } catch (_) {} break;
      default: break; // ignore channel/other messages
    }
  }

  function setClocksPerStep(n) { S.clocksPerStep = Math.max(1, n | 0); }
  function setCallbacks(cb) { Object.assign(S, cb || {}); }
  function reset() { S._pulse = 0; S._lastT = null; S._ema = null; S.playing = false; }

  // ---- Web MIDI wiring (graceful when absent) --------------------------------
  async function init() {
    try {
      if (typeof navigator !== 'undefined' && navigator.requestMIDIAccess) {
        S.access = await navigator.requestMIDIAccess({ sysex: false });
        S.inputs = [];
        S.access.inputs.forEach((port) => {
          S.inputs.push({ id: port.id, name: port.name || port.id });
          port.onmidimessage = (e) => handleMessage(e);
        });
        return S.inputs;
      }
    } catch (_) { /* denied / unsupported → idle */ }
    return [];
  }
  function inputs() { return S.inputs.slice(); }

  // ---- Slave the VJ sequencer to the incoming clock --------------------------
  function slaveVJ(on) {
    const VJ = global.FFVJ;
    if (!VJ) return false;
    if (on === false) {
      setCallbacks({ onStep: null, onStart: null, onStop: null, onContinue: null, onTempo: null });
      if (VJ.setExternalClock) VJ.setExternalClock(false);
      return false;
    }
    setCallbacks({
      onStart: () => { if (VJ.extStart) VJ.extStart(); },
      onStop: () => { if (VJ.extStop) VJ.extStop(); },
      onContinue: () => { if (VJ.setExternalClock) { VJ.setExternalClock(true); VJ.S.playing = true; } },
      onStep: () => { if (VJ.stepTick) VJ.stepTick(); },
      onTempo: (bpm) => { if (VJ.S) VJ.S.bpm = bpm; },
    });
    if (VJ.setExternalClock) VJ.setExternalClock(true);
    return true;
  }

  const API = {
    CLOCK, START, CONTINUE, STOP, PPQN,
    handleMessage, setClocksPerStep, setCallbacks, reset,
    init, inputs, slaveVJ,
    isPlaying: () => S.playing, bpm: () => S.bpm, pulses: () => S._pulse,
  };
  global.FFMidiIn = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
