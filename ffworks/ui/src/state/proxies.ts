import { create } from "zustand";
import { api } from "../api";
import type { ProxyStatus } from "../types";

const KEY = "ffworks.useProxies";
const load = (): boolean => { try { return localStorage.getItem(KEY) !== "0"; } catch { return true; } };

interface ProxyStore {
  status: Record<string, ProxyStatus>;
  /** Play proxies in the monitor when they exist (exports and processed previews always use the originals). */
  enabled: boolean;
  /** Media the preview player failed to decode (a real <video> error, not a guess). */
  undecodable: Record<string, boolean>;
  refresh: () => Promise<void>;
  setEnabled: (b: boolean) => void;
  markUndecodable: (mediaId: string) => void;
  clearUndecodable: (mediaId: string) => void;
}

export const useProxies = create<ProxyStore>((set, get) => ({
  status: {},
  enabled: load(),
  undecodable: {},
  refresh: async () => {
    try {
      const list = await api.proxyStatus();
      set({ status: Object.fromEntries(list.map((p) => [p.mediaId, p])) });
    } catch { /* no backend (tests) */ }
  },
  setEnabled: (enabled) => { try { localStorage.setItem(KEY, enabled ? "1" : "0"); } catch { /* private mode */ } set({ enabled }); },
  clearUndecodable: (id) => { if (get().undecodable[id]) set((s) => { const u = { ...s.undecodable }; delete u[id]; return { undecodable: u }; }); },
  markUndecodable: (id) => { if (!get().undecodable[id]) set((s) => ({ undecodable: { ...s.undecodable, [id]: true } })); },
}));

/** The URL the monitor should play for a media item: its proxy when enabled and ready, else the original file. */
export function playbackPath(mediaPath: string, status: ProxyStatus | undefined, enabled: boolean): { path: string; proxy: boolean } {
  return enabled && status?.ready && status.path ? { path: status.path, proxy: true } : { path: mediaPath, proxy: false };
}
