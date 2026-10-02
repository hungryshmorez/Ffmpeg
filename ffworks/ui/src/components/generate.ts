import { fromSec, toSec } from "../time";
import { usePlayhead, useProject, useUi } from "../state/stores";
import type { Clip, Command, Sequence } from "../types";

const DEFAULT_SECONDS = 5;

/** The topmost video track that has room for `[start, start+len)` and is not locked. */
function freeVideoTrack(seq: Sequence, start: number, len: number): string | null {
  const tracks = seq.tracks.filter((t) => t.kind === "video" && !t.locked).reverse();
  for (const t of tracks) {
    const busy = t.clips.some((c) => toSec(c.start) < start + len && start < toSec(c.start) + toSec(c.duration));
    if (!busy) return t.id;
  }
  return null;
}

async function place(make: (track: string, start: string, duration: string) => Command, pick: (c: Clip) => boolean) {
  const st = useProject.getState();
  const seq = () => st.view && useProject.getState().view!.project.sequences.find((s) => s.id === useProject.getState().view!.project.active_sequence)!;
  const start = usePlayhead.getState().t;
  let track = freeVideoTrack(seq()!, start, DEFAULT_SECONDS);
  if (!track) {
    // no room on any video track at the playhead: a new track on top
    if (!(await st.dispatch({ type: "add_track", kind: "video" }))) return;
    const vt = seq()!.tracks.filter((t) => t.kind === "video");
    track = vt[vt.length - 1]!.id;
  }
  if (await st.dispatch(make(track, fromSec(start), fromSec(DEFAULT_SECONDS)))) {
    const clip = seq()!.tracks.find((t) => t.id === track)?.clips.filter(pick).sort((a, b) => toSec(b.start) - toSec(a.start)).find((c) => Math.abs(toSec(c.start) - start) < 0.05);
    if (clip) useUi.getState().select(clip.id);
  }
}

/** A title at the playhead (5 s) on the topmost free video track; selects it so its panel opens. */
export function addTitleAtPlayhead() {
  return place((track, start, duration) => ({ type: "add_title", track, start, duration, text: "Title" }), (c) => c.title !== null);
}

export function addSolidAtPlayhead(color = "#336699") {
  return place((track, start, duration) => ({ type: "add_solid", track, start, duration, color }), (c) => c.title === null);
}
