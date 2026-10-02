import { useState } from "react";
import { fpsOf, fromSec, timecode, toSec } from "../time";
import { usePlayhead, useProject } from "../state/stores";
import type { Marker, Sequence } from "../types";

const COLORS: [string, string][] = [["#ffb020", "Amber"], ["#ff5a36", "Red"], ["#3fbf71", "Green"], ["#3aa0ff", "Blue"], ["#b46bff", "Purple"], ["#e6e8ee", "White"]];

/** Add a marker at the playhead ("Marker N"); one undo step. */
export function addMarkerAtPlayhead(seq: Sequence) {
  const { dispatch } = useProject.getState();
  return dispatch({ type: "add_marker", time: fromSec(usePlayhead.getState().t), name: `Marker ${seq.markers.length + 1}` });
}

function Row({ m, fps }: { m: Marker; fps: number }) {
  const dispatch = useProject((s) => s.dispatch);
  const [name, setName] = useState(m.name);
  const [note, setNote] = useState(m.note);
  return (
    <div className="marker-row" data-marker={m.id}>
      <div className="row">
        <button className="small" title="Move the playhead here" aria-label={`Go to ${m.name}`} onClick={() => usePlayhead.getState().setT(toSec(m.time))}>{timecode(toSec(m.time), fps)}</button>
        <input aria-label={`Name of ${m.name}`} className="grow" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== m.name && void dispatch({ type: "set_marker", marker: m.id, name })} />
        <select aria-label={`Colour of ${m.name}`} value={m.color} onChange={(e) => void dispatch({ type: "set_marker", marker: m.id, color: e.target.value })} style={{ borderLeft: `6px solid ${m.color}` }}>
          {COLORS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          {!COLORS.some(([c]) => c === m.color) && <option value={m.color}>{m.color}</option>}
        </select>
        <button className="small" aria-label={`Delete ${m.name}`} onClick={() => void dispatch({ type: "remove_marker", marker: m.id })}>✕</button>
      </div>
      <textarea aria-label={`Note for ${m.name}`} rows={1} placeholder="Note…" value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== m.note && void dispatch({ type: "set_marker", marker: m.id, note })} />
    </div>
  );
}

/** All markers of the sequence: jump to, rename, recolour, annotate, delete. */
export function MarkerPanel({ seq }: { seq: Sequence }) {
  const fps = fpsOf(useProject((s) => s.view)!.project.settings.fps);
  return (
    <div className="effects" aria-label="Markers">
      <div className="panel-title sub">Markers <button className="small" onClick={() => void addMarkerAtPlayhead(seq)} title="Add a marker at the playhead (M)">+ Marker</button></div>
      {seq.markers.length === 0 && <p className="muted pad">No markers. Press M to drop one at the playhead; [ and ] jump between them.</p>}
      {seq.markers.map((m) => <Row key={`${m.id}:${m.name}:${m.note}`} m={m} fps={fps} />)}
    </div>
  );
}
