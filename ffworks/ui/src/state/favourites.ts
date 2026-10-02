import { create } from "zustand";
import { api } from "../api";
import type { FavGroup, Favourites } from "../types";

export type FavKind = "effects" | "transitions";
export const POOL_ALL = "all";
export const POOL_STARRED = "favourites";

const toggled = (list: string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

export function toggleStar(f: Favourites, kind: FavKind, id: string): Favourites {
  return { ...f, starred: { ...f.starred, [kind]: toggled(f.starred[kind], id) } };
}
export function toggleInGroup(f: Favourites, group: string, kind: FavKind, id: string): Favourites {
  const g: FavGroup = f.groups[group] ?? { effects: [], transitions: [] };
  return { ...f, groups: { ...f.groups, [group]: { ...g, [kind]: toggled(g[kind], id) } } };
}
export function addGroup(f: Favourites, name: string): Favourites {
  const n = name.trim();
  if (!n || f.groups[n]) return f;
  return { ...f, groups: { ...f.groups, [n]: { effects: [], transitions: [] } } };
}
export function removeGroup(f: Favourites, name: string): Favourites {
  const { [name]: _gone, ...rest } = f.groups;
  void _gone;
  return { ...f, groups: rest };
}
/** The ids a pool name selects for one kind; `null` means unrestricted. */
export function poolIds(f: Favourites, pool: string, kind: FavKind): string[] | null {
  if (pool === POOL_ALL) return null;
  return (pool === POOL_STARRED ? f.starred : f.groups[pool])?.[kind] ?? [];
}

const empty: Favourites = { starred: { effects: [], transitions: [] }, groups: {} };

interface FavState {
  favs: Favourites;
  loaded: boolean;
  /** Pool used by the random buttons: all | favourites | a group name. */
  pool: string;
  count: number;
  load: () => Promise<void>;
  save: (next: Favourites) => Promise<void>;
  setPool: (p: string) => void;
  setCount: (n: number) => void;
}

export const useFavs = create<FavState>((set, get) => ({
  favs: empty,
  loaded: false,
  pool: POOL_ALL,
  count: 1,
  load: async () => { if (!get().loaded) set({ favs: await api.getFavourites(), loaded: true }); },
  save: async (next) => {
    const prev = get().favs;
    set({ favs: next });
    try {
      set({ favs: await api.setFavourites(next) });
    } catch (e) {
      set({ favs: prev });
      throw e;
    }
    if (get().pool !== POOL_ALL && get().pool !== POOL_STARRED && !(get().pool in get().favs.groups)) set({ pool: POOL_ALL });
  },
  setPool: (pool) => set({ pool }),
  setCount: (count) => set({ count: Math.min(20, Math.max(1, Math.round(count) || 1)) }),
}));
