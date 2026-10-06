import { useEffect, useState } from "react";
import { api, type LibraryEntry } from "../api";
import { describe, folderOf } from "../library";
import { useProject, useUi } from "../state/stores";
import { importPaths } from "./MediaBrowser";

/** Every file ever imported on this machine (a SQLite index), searchable by name or folder; importing is one click. */
export function LibraryDialog() {
  const open = useUi((s) => s.libraryOpen);
  const setOpen = useUi((s) => s.setLibraryOpen);
  const toast = useProject((s) => s.toast);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<LibraryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    const t = setTimeout(() => {
      api.searchLibrary(query, 100).then((r) => { if (!stale) { setRows(r); setError(null); } }).catch((e) => { if (!stale) setError(String(e)); });
    }, 120);
    return () => { stale = true; clearTimeout(t); };
  }, [open, query]);
  if (!open) return null;
  const forget = async () => {
    try { const n = await api.forgetMissingLibrary(); toast("info", n ? `Forgot ${n} file${n === 1 ? "" : "s"} that no longer exist` : "Nothing to forget: every remembered file is still there"); setRows(await api.searchLibrary(query, 100)); } catch (e) { toast("error", String(e)); }
  };
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Media library">
      <div className="modal">
        <h2>Media library</h2>
        <p className="muted">Files you imported into any project on this computer. Search by part of a name or folder.</p>
        <input aria-label="Search the media library" placeholder="Search…" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }} />
        {error && <p className="err">{error}</p>}
        {rows && rows.length === 0 && !error && <p className="muted">{query ? `Nothing matches “${query}”.` : "Nothing remembered yet. Import some media and it will appear here."}</p>}
        <ul aria-label="Remembered files" className="snap-list">
          {(rows ?? []).map((e) => (
            <li key={e.path}>
              <strong>{e.name}</strong> <span className="muted" title={e.path}>{folderOf(e.path)}</span>
              <div className="muted">{describe(e)}{!e.exists && " · missing"}</div>
              <button disabled={!e.exists} title={e.exists ? "Import this file into the open project" : "The file is no longer there"} aria-label={`Import ${e.name}`} onClick={() => void importPaths([e.path])}>Import</button>
            </li>
          ))}
        </ul>
        <div className="row end">
          <button onClick={() => void forget()}>Forget missing files</button>
          <button className="primary" onClick={() => setOpen(false)}>Close</button>
        </div>
      </div>
    </div>
  );
}
