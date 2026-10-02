import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useUi } from "../state/stores";
import type { FilterHelp, FilterInfo } from "../types";

type Kind = "all" | "video" | "audio";

/** Which kind of media a filter works on, from FFmpeg's `V->V` style summary. */
export function filterKind(io: string): "video" | "audio" | "other" {
  const chars = io.replace("->", "");
  if (/^[V|N]+$/.test(chars) && chars.includes("V")) return "video";
  if (/^[A|N]+$/.test(chars) && chars.includes("A")) return "audio";
  return "other";
}

export function FilterBrowser() {
  const open = useUi((s) => s.filtersOpen);
  const setOpen = useUi((s) => s.setFiltersOpen);
  const [all, setAll] = useState<FilterInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [sel, setSel] = useState<string | null>(null);
  const [help, setHelp] = useState<FilterHelp | null>(null);
  useEffect(() => { if (open && !all) api.listFilters().then(setAll).catch((e) => setErr(String(e))); }, [open, all]);
  useEffect(() => {
    if (!sel) { setHelp(null); return; }
    let live = true;
    setHelp(null);
    api.filterHelp(sel).then((h) => { if (live) setHelp(h); }).catch((e) => { if (live) setErr(String(e)); });
    return () => { live = false; };
  }, [sel]);
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (all ?? []).filter((f) => (kind === "all" || filterKind(f.io) === kind) && (!n || f.name.includes(n) || f.description.toLowerCase().includes(n)));
  }, [all, q, kind]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Filter browser">
      <div className="modal filter-browser">
        <h2>FFmpeg filters {all && <span className="muted">({shown.length} of {all.length})</span>}</h2>
        <p className="muted">Read from the FFmpeg that FFWORKS is using, so this list matches your build exactly.</p>
        <div className="row">
          <input type="search" aria-label="Search filters" placeholder="Search name or description" value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label="Media type" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="all">All</option><option value="video">Video</option><option value="audio">Audio</option>
          </select>
        </div>
        {err && <p className="err">{err}</p>}
        {!all && !err && <p>Loading…</p>}
        <div className="filter-cols">
          <ul className="filter-list" aria-label="Filters">
            {shown.map((f) => (
              <li key={f.name}>
                <button className={f.name === sel ? "active" : ""} onClick={() => setSel(f.name)}>
                  <b>{f.name}</b> <span className="muted">{f.io}</span><br /><span className="muted">{f.description}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="filter-detail" aria-label="Filter details">
            {!sel && <p className="muted">Select a filter to see its options.</p>}
            {sel && !help && !err && <p>Loading…</p>}
            {help && (
              <>
                <h3>{help.name}</h3>
                <p>{help.description}</p>
                <p className="muted">Inputs: {help.inputs.join(", ") || "none"} · Outputs: {help.outputs.join(", ") || "none"}{help.timeline ? " · supports timeline (enable)" : ""}</p>
                <table className="filter-opts">
                  <thead><tr><th>Option</th><th>Type</th><th>Default</th><th>Range / choices</th></tr></thead>
                  <tbody>
                    {help.options.map((o) => (
                      <tr key={o.name}>
                        <td title={o.description}><b>{o.name}</b>{o.dynamic ? " ⏱" : ""}<br /><span className="muted">{o.description}</span></td>
                        <td>{o.kind}</td>
                        <td>{o.default ?? "—"}</td>
                        <td>{o.choices.length ? o.choices.map((c) => c[0]).join(", ") : o.min != null ? `${o.min} … ${o.max}` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {help.options.length === 0 && <p className="muted">No options.</p>}
                <p className="muted">⏱ = value can change over time. Adding a filter to a clip arrives with the filter-graph editor.</p>
              </>
            )}
          </div>
        </div>
        <div className="row end"><button onClick={() => setOpen(false)}>Close</button></div>
      </div>
    </div>
  );
}
