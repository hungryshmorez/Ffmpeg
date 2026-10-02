import { create } from "zustand";
import { api } from "../api";
import type { Command, JobEvent, PreviewInfo, StateView } from "../types";

/** Persistent project state mirrored from the Rust engine (serialisable; the engine is the source of truth). */
interface ProjectStore {
  view: StateView | null;
  toasts: { id: number; kind: "error" | "info"; text: string }[];
  setView: (v: StateView) => void;
  toast: (kind: "error" | "info", text: string) => void;
  dismissToast: (id: number) => void;
  /** Run a backend call that returns a new state; failures become toasts and leave state untouched. */
  run: (fn: () => Promise<StateView>) => Promise<boolean>;
  dispatch: (c: Command) => Promise<boolean>;
}

let toastId = 0;
export const useProject = create<ProjectStore>((set, get) => ({
  view: null,
  toasts: [],
  setView: (view) => set({ view }),
  toast: (kind, text) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), kind === "error" ? 8000 : 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  run: async (fn) => {
    try {
      set({ view: await fn() });
      return true;
    } catch (e) {
      get().toast("error", String(e));
      return false;
    }
  },
  dispatch: (c) => get().run(() => api.dispatch(c)),
}));

/** Render queue mirror: updated from backend `job-state` events (the queue itself lives in Rust). */
interface JobsStore {
  jobs: Record<string, JobEvent>;
  order: string[];
  queueOpen: boolean;
  upsert: (e: JobEvent) => void;
  replaceAll: (e: JobEvent[]) => void;
  setQueueOpen: (o: boolean) => void;
}
export const useJobs = create<JobsStore>((set) => ({
  jobs: {},
  order: [],
  queueOpen: false,
  upsert: (e) => set((s) => ({ jobs: { ...s.jobs, [e.jobId]: e }, order: s.order.includes(e.jobId) ? s.order : [...s.order, e.jobId] })),
  replaceAll: (list) => set({ jobs: Object.fromEntries(list.map((j) => [j.jobId, j])), order: list.map((j) => j.jobId) }),
  setQueueOpen: (queueOpen) => set({ queueOpen }),
}));

/** High-frequency playback state lives apart so ticking the playhead never re-renders the whole editor. */
interface PlayheadStore {
  t: number;
  playing: boolean;
  setT: (t: number) => void;
  setPlaying: (p: boolean) => void;
}
export const usePlayhead = create<PlayheadStore>((set) => ({
  t: 0,
  playing: false,
  setT: (t) => set({ t }),
  setPlaying: (playing) => set({ playing }),
}));

/** Transient UI state: never saved in the project file. */
interface UiStore {
  preview: PreviewInfo | null;
  previewBusy: boolean;
  setPreview: (p: PreviewInfo | null) => void;
  setPreviewBusy: (b: boolean) => void;
  snapBeats: boolean;
  setSnapBeats: (b: boolean) => void;
  pxPerSec: number;
  selected: string | null;
  exportOpen: boolean;
  diagOpen: boolean;
  filtersOpen: boolean;
  demoOpen: boolean;
  paletteOpen: boolean;
  snapshotsOpen: boolean;
  setSnapshotsOpen: (o: boolean) => void;
  recording: boolean;
  setRecording: (r: boolean) => void;
  /** Clips added to the selection with Shift/Ctrl+click (besides `selected`). */
  extra: string[];
  toggleExtra: (id: string) => void;
  setPaletteOpen: (o: boolean) => void;
  setDemoOpen: (o: boolean) => void;
  enginesOpen: boolean;
  setEnginesOpen: (o: boolean) => void;
  favsOpen: boolean;
  setFavsOpen: (o: boolean) => void;
  graphEdit: { clip: string; fx: string } | null;
  setGraphEdit: (g: { clip: string; fx: string } | null) => void;
  setFiltersOpen: (o: boolean) => void;
  setZoom: (z: number) => void;
  select: (id: string | null) => void;
  setExportOpen: (o: boolean) => void;
  setDiagOpen: (o: boolean) => void;
}
export const useUi = create<UiStore>((set) => ({
  preview: null,
  previewBusy: false,
  setPreview: (preview) => set({ preview }),
  setPreviewBusy: (previewBusy) => set({ previewBusy }),
  snapBeats: false,
  setSnapBeats: (snapBeats) => set({ snapBeats }),
  pxPerSec: 80,
  selected: null,
  exportOpen: false,
  diagOpen: false,
  filtersOpen: false,
  demoOpen: false,
  paletteOpen: false,
  snapshotsOpen: false,
  setSnapshotsOpen: (snapshotsOpen) => set({ snapshotsOpen }),
  recording: false,
  setRecording: (recording) => set({ recording }),
  extra: [],
  toggleExtra: (id) => set((s) => ({ extra: s.extra.includes(id) ? s.extra.filter((x) => x !== id) : [...s.extra, id] })),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setDemoOpen: (demoOpen) => set({ demoOpen }),
  enginesOpen: false,
  setEnginesOpen: (enginesOpen) => set({ enginesOpen }),
  favsOpen: false,
  setFavsOpen: (favsOpen) => set({ favsOpen }),
  graphEdit: null,
  setGraphEdit: (graphEdit) => set({ graphEdit }),
  setFiltersOpen: (filtersOpen) => set({ filtersOpen }),
  setZoom: (z) => set({ pxPerSec: Math.min(2000, Math.max(4, z)) }),
  select: (selected) => set({ selected, extra: [] }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setDiagOpen: (diagOpen) => set({ diagOpen }),
}));
