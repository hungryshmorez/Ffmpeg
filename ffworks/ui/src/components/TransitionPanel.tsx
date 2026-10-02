import { useEffect, useState } from "react";
import { api } from "../api";
import { fpsOf, fromSec, toSec } from "../time";
import { useProject } from "../state/stores";
import type { Clip, Sequence, Track, Transition } from "../types";
import { CommitSlider } from "./CommitSlider";

let kindsCache: [string, string][] | null = null;

/** Transitions at the clip's two cuts. Each is a command (undoable, recordable); the engine validates adjacency and media handles. */
export function TransitionPanel({ clip, track, seq }: { clip: Clip; track: Track; seq: Sequence }) {
  const dispatch = useProject((s) => s.dispatch);
  const fps = fpsOf(useProject((s) => s.view)!.project.settings.fps);
  const [kinds, setKinds] = useState<[string, string][]>(kindsCache ?? []);
  const [pick, setPick] = useState("fade");
  useEffect(() => {
    if (!kindsCache) void api.listTransitions().then((k) => { kindsCache = k; setKinds(k); });
  }, []);
  void seq;

  const end = toSec(clip.start) + toSec(clip.duration);
  const next = track.clips.find((c) => Math.abs(toSec(c.start) - end) < 1e-6 && c.id !== clip.id);
  const prev = track.clips.find((c) => Math.abs(toSec(c.start) + toSec(c.duration) - toSec(clip.start)) < 1e-6 && c.id !== clip.id);
  const outgoing = track.transitions.find((t) => t.clip_a === clip.id);
  const incoming = track.transitions.find((t) => t.clip_b === clip.id);

  const edit = (t: Transition, which: string) => (
    <div className="fx" data-transition={t.id} aria-label={`${which} transition`}>
      <div className="row fx-head">
        <strong>{which}</strong>
        <span className="grow" />
        <button className="small" aria-label={`Remove ${which} transition`} onClick={() => void dispatch({ type: "remove_transition", transition: t.id })}>✕</button>
      </div>
      <div className="field compact">
        <select aria-label="Transition type" value={t.kind} onChange={(e) => void dispatch({ type: "set_transition", transition: t.id, kind: e.target.value })}>
          {kinds.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </div>
      <CommitSlider label="Duration" unit="s" value={Number(toSec(t.duration).toFixed(3))} min={2 / fps} max={5} step={0.04} onCommit={(v) => void dispatch({ type: "set_transition", transition: t.id, duration: fromSec(v) })} />
    </div>
  );
  const add = (a: Clip, b: Clip) => (
    <div className="field">
      <div className="row">
        <select aria-label="New transition type" value={pick} onChange={(e) => setPick(e.target.value)}>
          {kinds.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <button onClick={() => void dispatch({ type: "add_transition", clip_a: a.id, clip_b: b.id, kind: pick, duration: fromSec(1) })}>Add</button>
      </div>
    </div>
  );

  if (!next && !prev) return null;
  return (
    <div className="effects" aria-label="Transitions">
      <div className="panel-title sub">Transitions</div>
      {next && (outgoing ? edit(outgoing, "To next clip") : <><p className="muted pad">Cut to “{next.name}”:</p>{add(clip, next)}</>)}
      {prev && (incoming ? edit(incoming, "From previous clip") : <><p className="muted pad">Cut from “{prev.name}”:</p>{add(prev, clip)}</>)}
      <p className="muted pad">Centered on the cut; needs unused media on both sides of it.</p>
    </div>
  );
}
