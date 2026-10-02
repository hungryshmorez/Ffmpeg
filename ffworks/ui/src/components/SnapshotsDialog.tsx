import { useState } from "react";
import { useProject, useUi } from "../state/stores";

export const SNAPSHOT_PREFIX = "Snapshot: ";

/** Named copies of the timeline: take one before a risky edit, restore it later (restoring is itself one undo step). */
export function SnapshotsDialog() {
  const open = useUi((s) => s.snapshotsOpen);
  const setOpen = useUi((s) => s.setSnapshotsOpen);
  const view = useProject((s) => s.view);
  const dispatch = useProject((s) => s.dispatch);
  const [name, setName] = useState("");
  if (!open || !view) return null;
  const snaps = view.project.sequences.filter((s) => s.name.startsWith(SNAPSHOT_PREFIX));
  const take = async () => {
    const n = name.trim() || `${new Date().toLocaleTimeString()}`;
    if (await dispatch({ type: "take_snapshot", name: n })) setName("");
  };
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Snapshots">
      <div className="modal">
        <h2>Snapshots</h2>
        <div className="row">
          <input aria-label="Snapshot name" placeholder="name (optional)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void take(); }} />
          <button className="primary" onClick={() => void take()}>Take snapshot</button>
        </div>
        {snaps.length === 0 && <p className="muted">No snapshots yet. Take one before a big edit; restore it any time.</p>}
        <ul aria-label="Saved snapshots" className="snap-list">
          {snaps.map((s) => (
            <li key={s.id}>
              <span>{s.name.slice(SNAPSHOT_PREFIX.length)}</span>{" "}
              <span className="muted">{s.tracks.reduce((n, t) => n + t.clips.length, 0)} clips</span>{" "}
              <button onClick={() => void dispatch({ type: "restore_snapshot", snapshot: s.id })} title="Replace the timeline with this snapshot (undo brings your current state back)">Restore</button>
              <button className="small" aria-label={`Delete snapshot ${s.name.slice(SNAPSHOT_PREFIX.length)}`} onClick={() => void dispatch({ type: "delete_snapshot", snapshot: s.id })}>✕</button>
            </li>
          ))}
        </ul>
        <div className="row end"><button onClick={() => setOpen(false)}>Close</button></div>
      </div>
    </div>
  );
}
