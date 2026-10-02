import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { useEffect } from "react";
import { api } from "./api";
import { APP_NAME } from "./brand";
import { QueuePanel } from "./components/QueuePanel";
import { RecoveryDialog } from "./components/RecoveryDialog";
import { Diagnostics } from "./components/Diagnostics";
import { FilterBrowser } from "./components/FilterBrowser";
import { GraphEditor } from "./components/GraphEditor";
import { ExportDialog } from "./components/ExportDialog";
import { Inspector } from "./components/Inspector";
import { importPaths, MediaBrowser } from "./components/MediaBrowser";
import { Mixer } from "./components/Mixer";
import { Monitor } from "./components/Monitor";
import { Timeline } from "./components/Timeline";
import { deleteSelected, openProject, saveProject, splitAtPlayhead, Toolbar } from "./components/Toolbar";
import { useJobs, usePlayhead, useProject, useUi } from "./state/stores";
import { fpsOf } from "./time";
import { neighbourMarkers } from "./timeline/math";
import { addMarkerAtPlayhead } from "./components/MarkerPanel";

function Toasts() {
  const toasts = useProject((s) => s.toasts);
  const dismiss = useProject((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>{t.text}</div>
      ))}
    </div>
  );
}

export default function App() {
  const view = useProject((s) => s.view);

  useEffect(() => {
    void api.getState().then((v) => useProject.getState().setView(v)).catch((e) => useProject.getState().toast("error", String(e)));
  }, []);

  // Mirror the Rust render queue.
  useEffect(() => {
    let un: (() => void) | undefined;
    void api.listJobs().then((l) => useJobs.getState().replaceAll(l)).catch(() => undefined);
    void api.onJob((e) => useJobs.getState().upsert(e)).then((u) => (un = u));
    return () => un?.();
  }, []);

  // Native window title mirrors project name / dirty state.
  useEffect(() => {
    if (!view) return;
    const title = `${view.dirty ? "• " : ""}${view.project.name} — ${APP_NAME}`;
    document.title = title;
    void getCurrentWindow().setTitle(title).catch(() => undefined);
  }, [view]);

  // OS file drops import media.
  useEffect(() => {
    let un: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "drop") void importPaths(e.payload.paths);
    }).then((u) => (un = u));
    return () => un?.();
  }, []);

  // Guard against losing unsaved work.
  useEffect(() => {
    let un: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested(async (ev) => {
      if (!useProject.getState().view?.dirty) {
        await api.discardRecovery(); // clean exit: a stale autosave (e.g. after undoing back to the saved state) is not a crash
        return;
      }
      {
        ev.preventDefault();
        if (await ask("This project has unsaved changes. Close without saving?", { title: APP_NAME, kind: "warning" })) {
          await api.discardRecovery(); // a deliberate discard must not look like a crash next launch
          await getCurrentWindow().destroy();
        }
      }
    }).then((u) => (un = u));
    return () => un?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // timeline shortcuts must not act on the project behind an open dialog (Delete in the graph editor would delete the clip)
      if (document.querySelector("[aria-modal='true']")) return;
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") {
        if (!(e.ctrlKey || e.metaKey)) return;
      }
      const { view: v, run } = useProject.getState();
      if (!v) return;
      const fps = fpsOf(v.project.settings.fps);
      const ph = usePlayhead.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); if (v.undoLabel) void run(api.undo); }
      else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); if (v.redoLabel) void run(api.redo); }
      else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); void saveProject(e.shiftKey); }
      else if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); void openProject(); }
      else if (e.key === " ") { e.preventDefault(); ph.setPlaying(!ph.playing); }
      else if (e.key.toLowerCase() === "s" && !mod) { e.preventDefault(); splitAtPlayhead(); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(e.shiftKey); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); ph.setT(Math.max(0, Math.round(ph.t * fps) / fps - (e.shiftKey ? 10 : 1) / fps)); }
      else if (e.key === "ArrowRight") { e.preventDefault(); ph.setT(Math.round(ph.t * fps) / fps + (e.shiftKey ? 10 : 1) / fps); }
      else if (e.key === "Home") ph.setT(0);
      else if (e.key.toLowerCase() === "m" && !mod) { e.preventDefault(); void addMarkerAtPlayhead(v.project.sequences.find((q) => q.id === v.project.active_sequence)!); }
      else if (e.key === "[" || e.key === "]") {
        const n = neighbourMarkers(v.project.sequences.find((q) => q.id === v.project.active_sequence)!, ph.t);
        const to = e.key === "[" ? n.prev : n.next;
        if (to !== null) ph.setT(to);
      }
      else if (e.key === "Escape") useUi.getState().select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!view) return <div className="boot">Starting {APP_NAME}…</div>;
  return (
    <div className="app">
      <Toolbar />
      <div className="leftcol"><MediaBrowser /><Mixer /></div>
      <Monitor />
      <Inspector />
      <Timeline />
      <ExportDialog />
      <Diagnostics />
      <FilterBrowser />
      <GraphEditor />
      <QueuePanel />
      <RecoveryDialog />
      <Toasts />
    </div>
  );
}
