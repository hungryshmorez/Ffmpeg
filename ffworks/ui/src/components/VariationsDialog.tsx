import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { api } from "../api";
import { POOL_ALL, POOL_STARRED, useFavs } from "../state/favourites";
import { usePlayhead, useProject, useUi } from "../state/stores";

type Sheet = Awaited<ReturnType<typeof api.contactSheet>>;

/** A contact sheet of random looks for the selected clip: pick one and it is applied with the same seed (so it is exactly what you saw). */
export function VariationsDialog() {
  const clip = useUi((s) => s.variationsClip);
  const close = () => useUi.getState().setVariationsClip(null);
  const { favs, pool, count: stack, load, setPool, setCount: setStack } = useFavs();
  const toast = useProject((s) => s.toast);
  const setView = useProject((s) => s.setView);
  const [n, setN] = useState(9);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  useEffect(() => { if (clip) { void load(); setSheet(null); setPick(null); } }, [clip, load]);
  if (!clip) return null;
  const make = async (seed: number | null) => {
    setBusy(true);
    try {
      setSheet(await api.contactSheet(clip, n, stack, pool, seed, usePlayhead.getState().t));
      setPick(null);
    } catch (e) { toast("error", String(e)); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!sheet || pick === null) return;
    try {
      const r = await api.randomEffects(clip, stack, pool, sheet.seeds[pick]);
      setView(r.state);
      close();
    } catch (e) { toast("error", String(e)); }
  };
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Look variations">
      <div className="modal" style={{ width: "min(900px, 94vw)" }}>
        <h2>Look variations</h2>
        <div className="row">
          <select aria-label="Variation pool" value={pool} onChange={(e) => setPool(e.target.value)}>
            <option value={POOL_ALL}>From everything</option>
            <option value={POOL_STARRED}>From favourites ★</option>
            {Object.keys(favs.groups).map((g) => <option key={g} value={g}>From group: {g}</option>)}
          </select>
          <label>effects per look <input type="number" aria-label="Effects per look" min={1} max={6} value={stack} onChange={(e) => setStack(Number(e.target.value))} style={{ width: 52 }} /></label>
          <select aria-label="Number of variations" value={n} onChange={(e) => setN(Number(e.target.value))}>
            {[4, 9, 16].map((v) => <option key={v} value={v}>{v} looks</option>)}
          </select>
          <button className="primary" disabled={busy} onClick={() => void make(null)}>{busy ? "Rendering…" : sheet ? "🎲 New set" : "🎲 Show looks"}</button>
        </div>
        {sheet && (
          <div className="variation-sheet" style={{ position: "relative", marginTop: 8 }}>
            <img data-testid="variation-image" alt="Random looks of the selected clip" src={convertFileSrc(sheet.path)} style={{ width: "100%", display: "block" }} />
            <div style={{ position: "absolute", inset: 0, display: "grid", gridTemplateColumns: `repeat(${sheet.columns}, 1fr)`, gridTemplateRows: `repeat(${sheet.rows}, 1fr)` }}>
              {sheet.seeds.map((sd, i) => (
                <button key={sd} aria-label={`Look ${i + 1}: ${sheet.effects[i]!.join(", ")}`} aria-pressed={pick === i} onClick={() => setPick(i)}
                  style={{ background: pick === i ? "rgba(80,160,255,.35)" : "transparent", border: pick === i ? "2px solid #5af" : "1px solid rgba(255,255,255,.15)", color: "#fff", textAlign: "left", verticalAlign: "top", padding: 4, cursor: "pointer", fontSize: 12, textShadow: "0 0 3px #000" }}>
                  <b>{i + 1}</b> {sheet.effects[i]!.join(" + ")}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="row end">
          <span className="muted grow">{sheet ? `seed ${sheet.baseSeed}` : "Renders one frame at the playhead for each look."}</span>
          <button className="primary" disabled={pick === null} onClick={() => void apply()}>Apply look {pick === null ? "" : pick + 1}</button>
          <button onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
