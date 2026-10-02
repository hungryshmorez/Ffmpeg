import { create } from "zustand";
import { api } from "../api";
import type { Command, PreviewInfo, StateView } from "../types";

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
  pxPerSec: number;
  selected: string | null;
  exportOpen: boolean;
  diagOpen: boolean;
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
  pxPerSec: 80,
  selected: null,
  exportOpen: false,
  diagOpen: false,
  setZoom: (z) => set({ pxPerSec: Math.min(2000, Math.max(4, z)) }),
  select: (selected) => set({ selected }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setDiagOpen: (diagOpen) => set({ diagOpen }),
}));
