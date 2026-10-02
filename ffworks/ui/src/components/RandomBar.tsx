import { useEffect, useState } from "react";
import { POOL_ALL, POOL_STARRED, useFavs, type FavKind } from "../state/favourites";
import { useProject, useUi } from "../state/stores";
import type { RandomResult } from "../types";

/** Pool + stack size + optional seed + roll button, shared by the effect and transition panels. */
export function RandomBar({ kind, roll }: { kind: FavKind; roll: (pool: string, count: number, seed?: number) => Promise<RandomResult> }) {
  const { favs, pool, count, load, setPool, setCount } = useFavs();
  const setView = useProject((s) => s.setView);
  const toast = useProject((s) => s.toast);
  const [seed, setSeed] = useState("");
  const [last, setLast] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void load(); }, [load]);
  const noun = kind === "effects" ? "effect" : "transition";
  const go = async () => {
    const parsed = seed.trim() === "" ? undefined : Number(seed);
    if (parsed !== undefined && (!Number.isInteger(parsed) || parsed < 0)) { toast("error", "Seed must be a whole number, or blank for a new one."); return; }
    setBusy(true);
    try {
      const r = await roll(pool, count, parsed);
      setView(r.state);
      setLast(r.seed);
      if (r.skipped?.length) toast("info", `Added ${r.applied} of ${count}. Skipped: ${r.skipped.join("; ")}`);
    } catch (e) { toast("error", String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="field random-bar" aria-label={`Random ${noun}`}>
      <div className="row">
        <select aria-label={`Random ${noun} pool`} value={pool} onChange={(e) => setPool(e.target.value)}>
          <option value={POOL_ALL}>From everything</option>
          <option value={POOL_STARRED}>From favourites ★</option>
          {Object.keys(favs.groups).map((g) => <option key={g} value={g}>From group: {g}</option>)}
        </select>
        <input type="number" aria-label={`How many random ${noun}s to stack`} title="How many to stack" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: 56 }} />
        <button disabled={busy} onClick={() => void go()}>🎲 Random {noun}{count > 1 ? "s" : ""}</button>
      </div>
      <div className="row">
        <input type="text" aria-label="Seed (blank for a new one)" placeholder="seed (blank = new)" value={seed} onChange={(e) => setSeed(e.target.value)} style={{ width: 130 }} />
        {last !== null && <span className="muted">last seed {last} <button className="small" onClick={() => setSeed(String(last))}>reuse</button></span>}
        <span className="grow" />
        <button className="small" onClick={() => useUi.getState().setFavsOpen(true)}>Favourites…</button>
      </div>
    </div>
  );
}
