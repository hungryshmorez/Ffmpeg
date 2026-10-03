import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { addMarkerAtPlayhead } from "./MarkerPanel";
import { importSubtitlesViaDialog, importViaDialog } from "./MediaBrowser";
import { filterActions, type PaletteAction } from "./palette";
import { deleteSelected, newProject, openProject, saveProject, splitAtPlayhead } from "./Toolbar";
import { fitCompound, leaveCompound, makeCompound, openCompound, takeCompoundApart } from "./compound";
import { hintFor } from "../state/keymap";
import { useJobs, usePlayhead, useProject, useUi } from "../state/stores";

/** Everything the toolbar and shortcuts can do, searchable from the keyboard (Ctrl+K). */
function buildActions(): PaletteAction[] {
  const ui = useUi.getState();
  const proj = useProject.getState();
  const v = proj.view;
  const seq = v?.project.sequences.find((s) => s.id === v.project.active_sequence);
  const list: PaletteAction[] = [
    { id: "new", label: "New project", run: () => void newProject() },
    { id: "open", label: "Open project…", run: () => void openProject() },
    { id: "save", label: "Save project", run: () => void saveProject() },
    { id: "package", label: "Package project and media into a folder…", keywords: "collect archive copy move", run: () => void (async () => {
      const dir = await open({ directory: true, title: "Folder to collect the project and its media into" });
      if (typeof dir !== "string") return;
      try { proj.toast("info", `Packaged: ${await api.packageProject(dir)}`); } catch (e) { proj.toast("error", String(e)); }
    })() },
    ui.recording
      ? { id: "rec-stop", label: "Stop recording and save macro…", keywords: "macro script", run: () => void (async () => {
          const p = await save({ title: "Save macro", defaultPath: "macro.json", filters: [{ name: "Macro", extensions: ["json"] }] });
          try { const n = await api.stopRecording(p ?? null); ui.setRecording(false); proj.toast("info", p ? `Macro saved (${n} commands)` : "Recording discarded"); } catch (e) { ui.setRecording(false); proj.toast("error", String(e)); }
        })() }
      : { id: "rec-start", label: "Start recording a macro", keywords: "macro script record", run: () => void api.startRecording().then(() => { ui.setRecording(true); proj.toast("info", "Recording: do the edits, then choose “Stop recording and save macro…”"); }) },
    { id: "rec-run", label: "Run a macro on the selected clip…", keywords: "macro script replay", run: () => void (async () => {
      const p = await open({ title: "Macro to run", filters: [{ name: "Macro", extensions: ["json"] }] });
      if (typeof p !== "string") return;
      try { proj.setView(await api.runMacro(p, ui.selected)); proj.toast("info", "Macro applied (one undo step)"); } catch (e) { proj.toast("error", String(e)); }
    })() },
    { id: "script-run", label: "Run a script (Rhai) on the project…", keywords: "macro automation rhai loop condition", run: () => void (async () => {
      const p = await open({ title: "Script to run", filters: [{ name: "Rhai script", extensions: ["rhai"] }] });
      if (typeof p !== "string") return;
      try {
        const r = await api.runScript(p, ui.selected, false);
        proj.setView(r.view);
        proj.toast("info", `Script ran: ${r.commands} commands, one undo step${r.log.length ? ` — ${r.log[r.log.length - 1]}` : ""}`);
      } catch (e) { proj.toast("error", String(e)); }
    })() },
    { id: "compound-make", label: "Make a compound clip from the selected clips", keywords: "nest group fold sequence", run: () => void makeCompound() },
    { id: "compound-open", label: "Open the selected compound clip to edit what is inside", keywords: "nest enter sequence", run: () => void openCompound() },
    { id: "compound-leave", label: "Back to the main timeline (leave the compound clip)", keywords: "nest exit close sequence", run: () => void leaveCompound() },
    { id: "compound-apart", label: "Take the selected compound clip apart", keywords: "nest ungroup unnest", run: () => void takeCompoundApart() },
    { id: "compound-fit", label: "Fit the selected compound clip's length to its contents", keywords: "nest shorten", run: () => void fitCompound() },
    { id: "snapshots", label: "Snapshots (save and restore the timeline)…", keywords: "version backup history", run: () => ui.setSnapshotsOpen(true) },
    { id: "saveas", label: "Save project as…", run: () => void saveProject(true) },
    { id: "import", label: "Import media…", run: () => void importViaDialog() },
    { id: "subs", label: "Import subtitles…", keywords: "srt vtt captions", run: () => void importSubtitlesViaDialog() },
    { id: "undo", label: "Undo", run: () => v?.undoLabel && void proj.run(api.undo) },
    { id: "redo", label: "Redo", run: () => v?.redoLabel && void proj.run(api.redo) },
    { id: "split", label: "Split clip at playhead", keywords: "cut razor", run: splitAtPlayhead },
    { id: "delete", label: "Delete selected clip", run: () => deleteSelected(false) },
    { id: "ripple", label: "Ripple delete selected clip", run: () => deleteSelected(true) },
    { id: "marker", label: "Add marker at playhead", run: () => seq && void addMarkerAtPlayhead(seq) },
    { id: "play", label: "Play / pause", run: () => usePlayhead.getState().setPlaying(!usePlayhead.getState().playing) },
    { id: "start", label: "Go to start", run: () => usePlayhead.getState().setT(0) },
    { id: "export", label: "Export…", keywords: "render save video", run: () => ui.setExportOpen(true) },
    { id: "queue", label: "Show render queue", run: () => useJobs.getState().setQueueOpen(true) },
    { id: "demo", label: "Demo mode (cycle random transitions and effects)", keywords: "random", run: () => ui.setDemoOpen(true) },
    { id: "filters", label: "Browse FFmpeg filters", run: () => ui.setFiltersOpen(true) },
    { id: "favs", label: "Favourites and groups", keywords: "star", run: () => ui.setFavsOpen(true) },
    { id: "builds", label: "FFmpeg builds and frei0r plugins", keywords: "engine glitch0r", run: () => ui.setEnginesOpen(true) },
    { id: "diag", label: "Diagnostics", run: () => ui.setDiagOpen(true) },
    { id: "shortcuts", label: "Keyboard shortcuts…", keywords: "keys keymap bindings hotkeys", run: () => ui.setShortcutsOpen(true) },
  ];
  // the shortcut shown next to an action is whatever it is bound to now
  return list.map((a) => ({ ...a, hint: hintFor(ui.keymap, a.id) ?? a.hint }));
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const actions = useMemo(() => (open ? buildActions() : []), [open]);
  const shown = useMemo(() => filterActions(actions, query), [actions, query]);
  useEffect(() => { if (open) { setQuery(""); setIndex(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  useEffect(() => setIndex(0), [query]);
  if (!open) return null;
  const run = (a: PaletteAction | undefined) => { if (!a) return; setOpen(false); setTimeout(a.run, 0); };
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="modal palette">
        <input
          ref={input}
          aria-label="Type a command"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
            else if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(shown.length - 1, i + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); run(shown[index]); }
          }}
        />
        <ul role="listbox" aria-label="Commands">
          {shown.length === 0 && <li className="muted">No command matches “{query}”.</li>}
          {shown.map((a, i) => (
            <li key={a.id} role="option" aria-selected={i === index} className={i === index ? "sel" : ""} onMouseEnter={() => setIndex(i)} onClick={() => run(a)}>
              <span>{a.label}</span>
              {a.hint && <kbd>{a.hint}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
