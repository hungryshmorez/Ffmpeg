// =============================================================================
// midi-out.js  —  #71 MIDI output from the sequencer
// =============================================================================
// Sends MIDI from the VJ deck so external gear — lighting desks, hardware
// synths, other software — follows along: a 24-PPQN MIDI clock locked to the
// deck's BPM (start/stop/continue), and note-on/off whenever a trigger fires.
//
// The message encoding, the clock timing, and the sequencer integration are all
// pure and unit-tested against an injected output. The only part that needs a
// real machine is the physical MIDIOutput delivery (Web MIDI +  a connected
// device); everything degrades gracefully when that isn't present — send()
// still records to an in-memory log so nothing throws.
// =============================================================================

(function (global) {
  'use strict';

  // ---- Message encoders (pure) ----------------------------------------------
  const CLOCK = 0xF8, START = 0xFA, CONTINUE = 0xFB, STOP = 0xFC;
  const noteOn = (ch, note, vel) => [0x90 | (ch & 0x0f), note & 0x7f, vel & 0x7f];
  const noteOff = (ch, note) => [0x80 | (ch & 0x0f), note & 0x7f, 0];
  const cc = (ch, num, val) => [0xB0 | (ch & 0x0f), num & 0x7f, val & 0x7f];

  // 24 pulses per quarter note is the MIDI-clock standard.
  const PPQN = 24;
  const clockIntervalMs = (bpm) => 60000 / ((bpm > 0 ? bpm : 120) * PPQN);

  const S = {
    enabled: false,
    channel: 0,
    output: null,          // a MIDIOutput-like { send(bytes) }
    access: null,          // MIDIAccess when Web MIDI is available
    _sent: [],             // rolling log of sent messages (for debug + tests)
    _clockTimer: null,
    _notes: new Map(),     // trigger id → MIDI note
    _nextNote: 36,         // C1 — where GM percussion starts
    baseVelocity: 100,
  };

  function _log(bytes) { S._sent.push(bytes.slice()); if (S._sent.length > 512) S._sent.shift(); }

  function send(bytes) {
    _log(bytes);
    try { if (S.output && typeof S.output.send === 'function') S.output.send(bytes); } catch (_) {}
    return bytes;
  }

  // ---- Web MIDI wiring (graceful when absent) --------------------------------
  async function init() {
    if (S.access) return outputs();
    try {
      if (typeof navigator !== 'undefined' && navigator.requestMIDIAccess) {
        S.access = await navigator.requestMIDIAccess({ sysex: false });
        const outs = outputs();
        if (!S.output && outs.length) setOutput(outs[0].id);
        return outs;
      }
    } catch (_) { /* denied / unsupported → stays in log-only mode */ }
    return [];
  }

  function outputs() {
    if (!S.access || !S.access.outputs) return [];
    const list = [];
    S.access.outputs.forEach((port) => list.push({ id: port.id, name: port.name || port.id }));
    return list;
  }

  // Accept a Web-MIDI output id, a MIDIOutput, or any { send } stub (tests).
  function setOutput(portOrId) {
    if (portOrId && typeof portOrId.send === 'function') { S.output = portOrId; return true; }
    if (S.access && S.access.outputs && typeof portOrId === 'string') {
      const p = S.access.outputs.get ? S.access.outputs.get(portOrId) : null;
      if (p) { S.output = p; return true; }
    }
    return false;
  }

  function enable(on) { S.enabled = on == null ? true : !!on; if (!S.enabled) stopClock(); return S.enabled; }
  function setChannel(ch) { S.channel = ch & 0x0f; }

  // ---- Trigger → note mapping ------------------------------------------------
  function noteFor(id) {
    if (!S._notes.has(id)) { S._notes.set(id, S._nextNote); S._nextNote = Math.min(127, S._nextNote + 1); }
    return S._notes.get(id);
  }
  // Seed the map deterministically from the sequencer's trigger table so notes
  // are stable across a session.
  function mapTriggers(ids) {
    if (!Array.isArray(ids)) return;
    S._notes.clear(); S._nextNote = 36;
    ids.forEach((id) => noteFor(id));
  }

  function noteOnFor(id, vel) {
    if (!S.enabled) return null;
    return send(noteOn(S.channel, noteFor(id), vel == null ? S.baseVelocity : vel));
  }
  function noteOffFor(id) {
    if (!S.enabled) return null;
    return send(noteOff(S.channel, noteFor(id)));
  }
  function allNotesOff() {
    // GM "all notes off" CC 123, plus explicit note-offs for anything mapped.
    send(cc(S.channel, 123, 0));
    S._notes.forEach((note) => send(noteOff(S.channel, note)));
  }

  // ---- Clock -----------------------------------------------------------------
  function startClock(bpm) {
    stopClock();
    if (!S.enabled) return false;
    send([START]);
    const iv = clockIntervalMs(bpm);
    S._clockTimer = setInterval(() => send([CLOCK]), iv);
    return true;
  }
  function continueClock(bpm) {
    stopClock();
    if (!S.enabled) return false;
    send([CONTINUE]);
    S._clockTimer = setInterval(() => send([CLOCK]), clockIntervalMs(bpm));
    return true;
  }
  function stopClock() {
    if (S._clockTimer) { clearInterval(S._clockTimer); S._clockTimer = null; send([STOP]); return true; }
    return false;
  }
  function isClockRunning() { return !!S._clockTimer; }

  // test/debug helpers
  function sentLog() { return S._sent; }
  function clearLog() { S._sent = []; }

  const API = {
    // encoders
    noteOn, noteOff, cc, CLOCK, START, CONTINUE, STOP, PPQN, clockIntervalMs,
    // device
    init, outputs, setOutput, enable, setChannel,
    isEnabled: () => S.enabled, channel: () => S.channel, hasOutput: () => !!S.output,
    // notes + clock
    noteFor, mapTriggers, noteOnFor, noteOffFor, allNotesOff,
    startClock, continueClock, stopClock, isClockRunning,
    send, sentLog, clearLog,
  };
  global.FFMidiOut = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
