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
import { FavouritesDialog } from "./components/FavouritesDialog";
import { EnginesDialog } from "./components/EnginesDialog";
import { DemoDialog } from "./components/DemoDialog";
import { UnfinishedExportsDialog } from "./components/UnfinishedExportsDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { actionFor, chordOf, hasCtrl } from "./state/keymap";
import { CommandPalette } from "./components/CommandPalette";
import { SnapshotsDialog } from "./components/SnapshotsDialog";
import { LibraryDialog } from "./components/LibraryDialog";
import { VariationsDialog } from "./components/VariationsDialog";
import { MoshDialog } from "./components/MoshDialog";
import { CorruptDialog } from "./components/CorruptDialog";
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

  // Edits made through the local API arrive as an event; refetch the project.
  useEffect(() => {
    let un: (() => void) | undefined;
    void api.onProjectChanged(() => void api.getState().then((v) => useProject.getState().setView(v)).catch(() => undefined)).then((u) => (un = u));
    return () => un?.();
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
      const chord = chordOf(e);
      if (!chord) return;
      const ui = useUi.getState();
      // while the shortcut editor is waiting for a key, that key is being assigned, not used
      if (ui.shortcutsOpen) return;
      const action = actionFor(ui.keymap, chord);
      if (!action) return;
      if (action === "palette") {
        e.preventDefault();
        if (!document.querySelector("[aria-modal='true']") || ui.paletteOpen) ui.setPaletteOpen(!ui.paletteOpen);
        return;
      }
      // timeline shortcuts must not act on the project behind an open dialog (Delete in the graph editor would delete the clip)
      if (document.querySelector("[aria-modal='true']")) return;
      const el = e.target as HTMLElement;
      if ((el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") && !hasCtrl(chord)) return;
      const { view: v, run } = useProject.getState();
      if (!v) return;
      const fps = fpsOf(v.project.settings.fps);
      const ph = usePlayhead.getState();
      const seq = () => v.project.sequences.find((q) => q.id === v.project.active_sequence)!;
      const step = (n: number) => ph.setT(Math.max(0, Math.round(ph.t * fps) / fps + n / fps));
      const handlers: Record<string, () => void> = {
        undo: () => { if (v.undoLabel) void run(api.undo); },
        redo: () => { if (v.redoLabel) void run(api.redo); },
        save: () => void saveProject(false),
        saveas: () => void saveProject(true),
        open: () => void openProject(),
        play: () => ph.setPlaying(!ph.playing),
        split: () => splitAtPlayhead(),
        delete: () => deleteSelected(false),
        ripple: () => deleteSelected(true),
        frameBack: () => step(-1),
        frameFwd: () => step(1),
        back10: () => step(-10),
        fwd10: () => step(10),
        start: () => ph.setT(0),
        marker: () => void addMarkerAtPlayhead(seq()),
        prevMarker: () => { const to = neighbourMarkers(seq(), ph.t).prev; if (to !== null) ph.setT(to); },
        nextMarker: () => { const to = neighbourMarkers(seq(), ph.t).next; if (to !== null) ph.setT(to); },
        deselect: () => ui.select(null),
      };
      const h = handlers[action];
      if (!h) return;
      e.preventDefault();
      h();
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
      <FavouritesDialog />
      <EnginesDialog />
      <DemoDialog />
      <CommandPalette />
      <SnapshotsDialog />
      <LibraryDialog />
      <ShortcutsDialog />
      <VariationsDialog />
      <MoshDialog />
      <CorruptDialog />
      <QueuePanel />
      <RecoveryDialog />
      <UnfinishedExportsDialog />
      <Toasts />
    </div>
  );
}
