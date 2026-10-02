import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";
import { api } from "../api";
import type { Waveform } from "../types";

type Slot<T> = "loading" | "failed" | T;

/** Cache of background analysis results (thumbnails, waveforms). Never blocks the UI; failures are remembered. */
interface AnalysisStore {
  thumbs: Record<string, Slot<string[]>>;
  waves: Record<string, Slot<Waveform>>;
  ensureThumbs: (mediaId: string) => void;
  ensureWave: (mediaId: string) => void;
}

export const useAnalysis = create<AnalysisStore>((set, get) => ({
  thumbs: {},
  waves: {},
  ensureThumbs: (id) => {
    if (get().thumbs[id]) return;
    set((s) => ({ thumbs: { ...s.thumbs, [id]: "loading" } }));
    api
      .getThumbnails(id)
      .then((paths) => set((s) => ({ thumbs: { ...s.thumbs, [id]: paths.map((p) => convertFileSrc(p)) } })))
      .catch(() => set((s) => ({ thumbs: { ...s.thumbs, [id]: "failed" } })));
  },
  ensureWave: (id) => {
    if (get().waves[id]) return;
    set((s) => ({ waves: { ...s.waves, [id]: "loading" } }));
    api
      .getWaveform(id)
      .then((w) => set((s) => ({ waves: { ...s.waves, [id]: w } })))
      .catch(() => set((s) => ({ waves: { ...s.waves, [id]: "failed" } })));
  },
}));
