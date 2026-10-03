import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { useProject } from "../state/stores";
import type { Clip } from "../types";
import type { FieldSpec } from "./KeyframeField";

const SOURCES: [string, string][] = [["cc", "a controller (knob / wheel)"], ["velocity", "note velocity (a pulse per note)"], ["gate", "notes held (on / off)"], ["pitch", "pitch of the latest note"], ["bend", "pitch wheel"]];

/** Drive a parameter from a Standard MIDI file: controller, note velocity pulses, note gate, pitch or pitch wheel. */
export function MidiFollow({ clip, spec, animated, onDone }: { clip: Clip; spec: FieldSpec; animated: boolean; onDone: () => void }) {
  const dispatch = useProject((s) => s.dispatch);
  const [path, setPath] = useState("");
  const [kind, setKind] = useState("cc");
  const [cc, setCc] = useState(1);
  const [channel, setChannel] = useState(0);
  const [low, setLow] = useState(spec.min);
  const [high, setHigh] = useState(spec.max);
  const [decay, setDecay] = useState(0.25);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const pick = async () => {
    const p = await open({ title: "MIDI file", filters: [{ name: "MIDI", extensions: ["mid", "midi"] }] });
    if (typeof p === "string") setPath(p);
  };
  const apply = async () => {
    setBusy(true);
    try {
      const source = kind === "cc" ? `cc:${cc}` : kind;
      if (await dispatch({ type: "animate_from_midi", clip: clip.id, param: spec.param, path, source, channel: channel || null, track: null, low, high, decay, offset })) onDone();
    } finally { setBusy(false); }
  };
  const ok = !!path && [low, high, decay, offset].every(Number.isFinite) && (kind !== "cc" || (Number.isInteger(cc) && cc >= 0 && cc <= 127));
  return (
    <div className="kf-follow" aria-label={`Follow MIDI for ${spec.label}`}>
      <button className="small" aria-label="Choose a MIDI file" onClick={() => void pick()}>{path ? path.split(/[\\/]/).pop() : "Choose a MIDI file…"}</button>
      <label>follow <select aria-label="MIDI source" value={kind} onChange={(e) => setKind(e.target.value)}>{SOURCES.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      {kind === "cc" && <label>controller <input aria-label="Controller number" className="num" type="number" min={0} max={127} step={1} value={cc} onChange={(e) => setCc(e.currentTarget.valueAsNumber)} /></label>}
      <label>channel <select aria-label="MIDI channel" value={channel} onChange={(e) => setChannel(Number(e.target.value))}>
        <option value={0}>all</option>
        {Array.from({ length: 16 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
      </select></label>
      <label>minimum <input aria-label="Value at minimum" className="num" type="number" min={spec.min} max={spec.max} step={spec.step} value={low} onChange={(e) => setLow(e.currentTarget.valueAsNumber)} /></label>
      <label>maximum <input aria-label="Value at maximum" className="num" type="number" min={spec.min} max={spec.max} step={spec.step} value={high} onChange={(e) => setHigh(e.currentTarget.valueAsNumber)} /></label>
      {kind === "velocity" && <label>fall back over <input aria-label="MIDI decay in seconds" className="num" type="number" min={0} max={10} step={0.05} value={decay} onChange={(e) => setDecay(e.currentTarget.valueAsNumber)} />s</label>}
      <label>file starts <input aria-label="MIDI file offset in seconds" className="num" type="number" step={0.1} value={offset} onChange={(e) => setOffset(e.currentTarget.valueAsNumber)} />s after the project</label>
      <button className="small primary" disabled={busy || !ok} onClick={() => void apply()}>{animated ? "Replace keyframes" : "Apply"}</button>
    </div>
  );
}
