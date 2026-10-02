import { useEffect, useState } from "react";
import { api } from "../api";
import { addGroup, removeGroup, toggleInGroup, toggleStar, useFavs, type FavKind } from "../state/favourites";
import { useProject, useUi } from "../state/stores";
import type { EffectDef } from "../types";

/** Star effects/transitions and sort them into named groups; random buttons and demo mode can draw from any of these. */
export function FavouritesDialog() {
  const open = useUi((s) => s.favsOpen);
  const { favs, load, save } = useFavs();
  const toast = useProject((s) => s.toast);
  const [tab, setTab] = useState<FavKind>("effects");
  const [effects, setEffects] = useState<EffectDef[]>([]);
  const [transitions, setTransitions] = useState<[string, string][]>([]);
  const [name, setName] = useState("");
  useEffect(() => {
    if (!open) return;
    void load();
    void api.listEffects().then((d) => setEffects(d.filter((e) => e.id !== "graph")));
    void api.listTransitions().then(setTransitions);
  }, [open, load]);
  if (!open) return null;
  const guard = (p: Promise<void>) => p.catch((e) => toast("error", String(e)));
  const rows: { id: string; label: string; note: string }[] =
    tab === "effects" ? effects.map((e) => ({ id: e.id, label: e.name, note: e.kind })) : transitions.map(([id, label]) => ({ id, label, note: "" }));
  const groups = Object.keys(favs.groups);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Favourites">
      <div className="modal fav-dialog">
        <h2>Favourites</h2>
        <p className="muted">Star the ones you like, or sort them into groups (for example “Glitchy” and “Clean”). The random buttons and demo mode can then use just those.</p>
        <div className="row">
          <button className={tab === "effects" ? "primary" : ""} onClick={() => setTab("effects")}>Effects</button>
          <button className={tab === "transitions" ? "primary" : ""} onClick={() => setTab("transitions")}>Transitions</button>
          <span className="grow" />
          <input type="text" aria-label="New group name" placeholder="New group name" value={name} onChange={(e) => setName(e.target.value)} />
          <button onClick={() => { void guard(save(addGroup(favs, name))); setName(""); }}>Add group</button>
        </div>
        <div className="fav-table-wrap">
          <table className="filter-opts" aria-label={`Favourite ${tab}`}>
            <thead>
              <tr>
                <th>{tab === "effects" ? "Effect" : "Transition"}</th><th>★</th>
                {groups.map((g) => <th key={g}>{g} <button className="small" aria-label={`Delete group ${g}`} onClick={() => void guard(save(removeGroup(favs, g)))}>✕</button></th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-fav={r.id}>
                  <td>{r.label} {r.note && <span className="muted">({r.note})</span>}</td>
                  <td><input type="checkbox" aria-label={`Star ${r.label}`} checked={favs.starred[tab].includes(r.id)} onChange={() => void guard(save(toggleStar(favs, tab, r.id)))} /></td>
                  {groups.map((g) => <td key={g}><input type="checkbox" aria-label={`${r.label} in ${g}`} checked={favs.groups[g]![tab].includes(r.id)} onChange={() => void guard(save(toggleInGroup(favs, g, tab, r.id)))} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row end"><button onClick={() => useUi.getState().setFavsOpen(false)}>Close</button></div>
      </div>
    </div>
  );
}
