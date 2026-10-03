import { api } from "../api";
import { activeSequence, compoundOf, mainSequence } from "../state/sequences";
import { useProject, useUi } from "../state/stores";

/** The selected clips: the primary one plus any added with Shift/Ctrl+click. */
function selection(): string[] {
  const ui = useUi.getState();
  return [...(ui.selected ? [ui.selected] : []), ...ui.extra.filter((c) => c !== ui.selected)];
}

function selectedClip() {
  const v = useProject.getState().view;
  const id = useUi.getState().selected;
  if (!v || !id) return undefined;
  return activeSequence(v.project).tracks.flatMap((t) => t.clips).find((c) => c.id === id);
}

/** Fold the selected clips (and their linked audio) into one compound clip that stays editable. One undo step. */
export async function makeCompound(): Promise<void> {
  const clips = selection();
  const p = useProject.getState();
  if (clips.length === 0) return p.toast("error", "Select the clips to put in a compound clip first (Shift+click adds more)");
  if (await p.dispatch({ type: "nest_clips", clips })) {
    useUi.getState().select(null);
    p.toast("info", "Compound clip made — double-click it to edit what is inside");
  }
}

/** Show the contents of the selected compound clip on the timeline. */
export async function openCompound(clipId?: string): Promise<void> {
  const p = useProject.getState();
  const v = p.view;
  if (!v) return;
  const clip = clipId ? activeSequence(v.project).tracks.flatMap((t) => t.clips).find((c) => c.id === clipId) : selectedClip();
  const inner = compoundOf(v.project, clip);
  if (!inner) return p.toast("error", "Select a compound clip first");
  await p.run(() => api.setActiveSequence(inner.id));
  useUi.getState().select(null);
}

/** Go back to the main timeline from a compound clip's contents. */
export async function leaveCompound(): Promise<void> {
  const p = useProject.getState();
  const v = p.view;
  const main = v && mainSequence(v.project);
  if (!main) return;
  await p.run(() => api.setActiveSequence(main.id));
  useUi.getState().select(null);
}

/** Replace the selected compound clip by the clips it holds. */
export async function takeCompoundApart(): Promise<void> {
  const clip = selectedClip();
  const p = useProject.getState();
  if (!clip || !p.view || !compoundOf(p.view.project, clip)) return p.toast("error", "Select a compound clip first");
  if (await p.dispatch({ type: "unnest_clip", clip: clip.id })) useUi.getState().select(null);
}

/** Make the selected compound clip's source exactly as long as its contents. */
export async function fitCompound(): Promise<void> {
  const clip = selectedClip();
  const p = useProject.getState();
  if (!clip || !p.view || !compoundOf(p.view.project, clip)) return p.toast("error", "Select a compound clip first");
  if (await p.dispatch({ type: "fit_compound", media: clip.media })) p.toast("info", "Compound length fitted to its contents");
}
