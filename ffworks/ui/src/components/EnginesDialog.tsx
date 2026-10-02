import { open as pickPath } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useProject, useUi } from "../state/stores";
import type { EngineInfo, FoundEngine } from "../types";

/** What a build is good for, in a few words, from what it reported. */
export function summarise(e: EngineInfo): string {
  const bits = [e.license, `${e.filters} filters`];
  if (e.xfade_custom) bits.push("GL transitions");
  if (e.notable.some((n) => n.includes("nvenc"))) bits.push("NVENC");
  if (e.notable.some((n) => n.includes("qsv"))) bits.push("Quick Sync");
  if (e.notable.some((n) => n.includes("amf"))) bits.push("AMF");
  if (e.notable.includes("libx265")) bits.push("x265");
  if (e.notable.some((n) => n.includes("av1"))) bits.push("AV1");
  return bits.join(" · ");
}

/** Register several FFmpeg builds, see what each really supports, pick the active one. */
export function EnginesDialog() {
  const open = useUi((s) => s.enginesOpen);
  const setOpen = useUi((s) => s.setEnginesOpen);
  const toast = useProject((s) => s.toast);
  const [list, setList] = useState<EngineInfo[] | null>(null);
  const [active, setActive] = useState("default");
  const [found, setFound] = useState<FoundEngine[]>([]);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [f0, setF0] = useState<{ ffmpegHasFilter: boolean; dirs: string[]; installed: number; offered: string[] } | null>(null);
  const [f0dirs, setF0dirs] = useState("");
  const refresh = useCallback(async () => {
    try { const r = await api.listEngines(); setList(r.engines); setActive(r.active); } catch (e) { toast("error", String(e)); }
  }, [toast]);
  const refreshF0 = useCallback(async () => { try { const r = await api.frei0rStatus(); setF0(r); setF0dirs(r.dirs.join("\n")); } catch (e) { toast("error", String(e)); } }, [toast]);
  useEffect(() => { if (open) { void refresh(); void refreshF0(); } }, [open, refresh, refreshF0]);
  if (!open) return null;
  const guard = async (f: () => Promise<unknown>) => { setBusy(true); try { await f(); await refresh(); } catch (e) { toast("error", String(e)); } finally { setBusy(false); } };
  const scan = async () => {
    const dir = await pickPath({ directory: true, title: "Folder that holds your FFmpeg installs" });
    if (typeof dir !== "string") return;
    setBusy(true);
    try { const f = await api.scanEngines(dir); setFound(f); if (!f.length) toast("info", "No ffmpeg with an ffprobe beside it was found there."); } finally { setBusy(false); }
  };
  const registered = new Set((list ?? []).map((e) => e.ffmpeg_path));
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="FFmpeg builds">
      <div className="modal engines-dialog">
        <h2>FFmpeg builds</h2>
        <p className="muted">Register every FFmpeg you install (full, essentials, GPL, LGPL, a GPU build…). Each is run to show what it can really do. One is used for everything; an export can pick another.</p>
        {!list && <p>Checking…</p>}
        <ul className="engine-list" aria-label="Registered builds">
          {list?.map((e) => (
            <li key={e.id} data-engine={e.id} className={e.id === active ? "active" : ""}>
              <div className="row">
                <strong>{e.name}</strong>
                {e.id === active && <span className="badge ok">in use</span>}
                {!e.ok && <span className="badge err">not working</span>}
                <span className="grow" />
                {e.id !== active && e.ok && <button disabled={busy} onClick={() => void guard(() => api.setActiveEngine(e.id === "default" ? null : e.id).then((v) => toast("info", `Now using ${v}`)))}>Use this</button>}
                {e.id !== "default" && <button className="small" aria-label={`Remove ${e.name}`} disabled={busy} onClick={() => void guard(() => api.removeEngine(e.id))}>✕</button>}
              </div>
              {e.ok ? <div className="muted">{e.version}<br />{summarise(e)}</div> : <div className="err">{e.error}</div>}
              <div className="muted">{e.ffmpeg_path}</div>
            </li>
          ))}
        </ul>
        <h3>Add builds</h3>
        <div className="row">
          <button disabled={busy} onClick={() => void scan()}>Scan a folder…</button>
          <span className="muted">finds every ffmpeg that has an ffprobe next to it</span>
        </div>
        {found.length > 0 && (
          <ul className="engine-list" aria-label="Found builds">
            {found.map((f) => (
              <li key={f.ffmpeg_path}>
                <div className="row"><strong>{f.suggested_name}</strong><span className="muted grow">{f.ffmpeg_path}</span>
                  <button disabled={busy || registered.has(f.ffmpeg_path)} onClick={() => void guard(() => api.addEngine(f.suggested_name, f.ffmpeg_path, f.ffprobe_path))}>{registered.has(f.ffmpeg_path) ? "Added" : "Add"}</button></div>
              </li>
            ))}
            <li><button disabled={busy} onClick={() => void guard(async () => { for (const f of found) if (!registered.has(f.ffmpeg_path)) await api.addEngine(f.suggested_name, f.ffmpeg_path, f.ffprobe_path).catch(() => undefined); })}>Add all</button></li>
          </ul>
        )}
        <div className="row">
          <input type="text" aria-label="Build name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 140 }} />
          <input type="text" aria-label="Path of ffmpeg" placeholder="Path of ffmpeg.exe" value={path} onChange={(e) => setPath(e.target.value)} className="grow" />
          <button disabled={busy} onClick={async () => { const p = await pickPath({ title: "Select ffmpeg" }); if (typeof p === "string") setPath(p); }}>Browse…</button>
          <button disabled={busy || !name.trim() || !path.trim()} onClick={() => void guard(async () => { await api.addEngine(name, path); setName(""); setPath(""); })}>Add</button>
        </div>
        <h3>frei0r plugins (glitch0r and friends)</h3>
        <p className="muted" data-frei0r-status>
          {f0 ? (f0.ffmpegHasFilter ? `The FFmpeg in use can load frei0r plugins. ${f0.installed} plugin file(s) found, ${f0.offered.length} usable as effects (listed under “Frei0r” in the effect list).` : "The FFmpeg in use has no frei0r filter; pick a build that has it (the “full” builds usually do). Plugins found: " + f0.installed + ".") : "Checking…"}
        </p>
        <div className="field">
          <label htmlFor="f0dirs">Extra plugin folders (one per line)</label>
          <textarea id="f0dirs" rows={2} value={f0dirs} onChange={(e) => setF0dirs(e.target.value)} placeholder="C:\\frei0r-1\\lib" />
          <div className="row">
            <button onClick={async () => { const d = await pickPath({ directory: true, title: "Folder with frei0r plugins (.dll)" }); if (typeof d === "string") setF0dirs((v) => (v.trim() ? v.trim() + "\n" : "") + d); }}>Add folder…</button>
            <button disabled={busy} onClick={() => void guard(async () => { await api.setFrei0rDirs(f0dirs.split("\n")); await refreshF0(); })}>Save and rescan</button>
          </div>
        </div>
        <div className="row end"><button onClick={() => setOpen(false)}>Close</button></div>
      </div>
    </div>
  );
}
