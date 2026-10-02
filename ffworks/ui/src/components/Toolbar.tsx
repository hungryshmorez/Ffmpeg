import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { PROJECT_EXTENSION } from "../brand";
import { fromSec } from "../time";
import { findClip, visibleVideoAt } from "../timeline/math";
import { useJobs, usePlayhead, useProject, useUi } from "../state/stores";
import { importViaDialog } from "./MediaBrowser";

export async function newProject() {
  const { view, run } = useProject.getState();
  if (view?.dirty && !confirm("Discard unsaved changes?")) return;
  useUi.getState().select(null);
  usePlayhead.getState().setT(0);
  await run(() => api.newProject("Untitled"));
}
export async function openProject() {
  const { view, run } = useProject.getState();
  if (view?.dirty && !confirm("Discard unsaved changes?")) return;
  const p = await open({ title: "Open project", filters: [{ name: "FFWORKS project", extensions: [PROJECT_EXTENSION] }] });
  if (typeof p === "string") {
    useUi.getState().select(null);
    usePlayhead.getState().setT(0);
    await run(() => api.openProject(p));
  }
}
export async function saveProject(forceDialog = false) {
  const { view, run, toast } = useProject.getState();
  if (!view) return;
  let path = view.path ?? undefined;
  if (!path || forceDialog) {
    const p = await save({ title: "Save project", defaultPath: `${view.project.name}.${PROJECT_EXTENSION}`, filters: [{ name: "FFWORKS project", extensions: [PROJECT_EXTENSION] }] });
    if (!p) return;
    path = p;
  }
  if (await run(() => api.saveProject(path))) toast("info", "Project saved");
}

export function splitAtPlayhead() {
  const { view, dispatch, toast } = useProject.getState();
  if (!view) return;
  const seq = view.project.sequences.find((s) => s.id === view.project.active_sequence)!;
  const t = usePlayhead.getState().t;
  const sel = useUi.getState().selected;
  // With no selection, split the topmost visible video clip under the playhead.
  const id = sel ?? visibleVideoAt(seq, t)?.clip.id ?? null;
  if (!id || !findClip(seq, id)) return toast("error", "Select a clip (or park the playhead over one) to split");
  void dispatch({ type: "split_clip", clip: id, at: fromSec(t) });
}

export function deleteSelected(ripple: boolean) {
  const { view, dispatch } = useProject.getState();
  const sel = useUi.getState().selected;
  if (!view || !sel) return;
  const seq = view.project.sequences.find((s) => s.id === view.project.active_sequence)!;
  if (!findClip(seq, sel)) return;
  void dispatch({ type: "delete_clip", clip: sel, ripple }).then((ok) => ok && useUi.getState().select(null));
}

export function Toolbar() {
  const view = useProject((s) => s.view)!;
  const setExportOpen = useUi((s) => s.setExportOpen);
  const setDiagOpen = useUi((s) => s.setDiagOpen);
  const run = useProject((s) => s.run);
  const activeJobs = useJobs((s) => Object.values(s.jobs).filter((j) => j.state === "queued" || j.state === "rendering").length);
  const setQueueOpen = useJobs((s) => s.setQueueOpen);
  return (
    <div className="toolbar" role="toolbar" aria-label="Main toolbar">
      <span className="brand">FFWORKS</span>
      <button onClick={() => void newProject()}>New</button>
      <button onClick={() => void openProject()}>Open…</button>
      <button onClick={() => void saveProject()}>Save{view.dirty ? " •" : ""}</button>
      <button onClick={() => void saveProject(true)}>Save As…</button>
      <span className="sep" />
      <button onClick={() => void importViaDialog()}>Import…</button>
      <span className="sep" />
      <button disabled={!view.undoLabel} title={view.undoLabel ? `Undo ${view.undoLabel} (Ctrl+Z)` : "Nothing to undo"} onClick={() => void run(api.undo)}>↶ Undo</button>
      <button disabled={!view.redoLabel} title={view.redoLabel ? `Redo ${view.redoLabel} (Ctrl+Y)` : "Nothing to redo"} onClick={() => void run(api.redo)}>↷ Redo</button>
      <span className="sep" />
      <button onClick={splitAtPlayhead} title="Split selected clip at playhead (S)">✂ Split</button>
      <button onClick={() => deleteSelected(false)} title="Delete (Del)">Delete</button>
      <button onClick={() => deleteSelected(true)} title="Ripple delete (Shift+Del)">Ripple delete</button>
      <span className="grow" />
      <span className="muted">{view.path ? view.path : "unsaved project"}</span>
      <button onClick={() => setQueueOpen(true)} title="Render queue">Queue{activeJobs ? ` (${activeJobs})` : ""}</button>
      <button onClick={() => setDiagOpen(true)}>Diagnostics</button>
      <button className="primary" onClick={() => setExportOpen(true)}>Export…</button>
    </div>
  );
}
