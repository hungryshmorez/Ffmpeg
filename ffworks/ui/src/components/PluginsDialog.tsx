import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { api, type PluginGrant, type PluginInfo, type PluginList } from "../api";
import { useProject, useUi } from "../state/stores";

/**
 * Installed plugins and what each may do. Every plugin can edit the project (one undo step); anything beyond that is off until you
 * allow it here, and only what the plugin's own manifest asks for can be allowed: media analysis, calling named web hosts, and
 * reading and writing the folders you pick.
 */
export function PluginsDialog() {
  const open = useUi((s) => s.pluginsOpen);
  const setOpen = useUi((s) => s.setPluginsOpen);
  const toast = useProject((s) => s.toast);
  const [list, setList] = useState<PluginList | null>(null);
  const reload = useCallback(() => api.listPlugins().then(setList).catch((e) => toast("error", String(e))), [toast]);
  useEffect(() => { if (open) void reload(); }, [open, reload]);
  if (!open) return null;
  const save = async (p: PluginInfo, grant: PluginGrant) => {
    try { await api.setPluginGrant(p.folder, grant); await reload(); } catch (e) { toast("error", String(e)); }
  };
  const install = async () => {
    const dir = await pickFolder({ directory: true, title: "Plugin folder (contains plugin.json and the .wasm file)" });
    if (typeof dir !== "string") return;
    try { const p = await api.installPlugin(dir); toast("info", `Installed plugin “${p.name}”`); await reload(); } catch (e) { toast("error", String(e)); }
  };
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Plugins">
      <div className="modal">
        <h2>Plugins</h2>
        <p className="muted">Plugins are sandboxed WebAssembly programs. They can edit the project (one undo step) and nothing else until you allow it below. A plugin only gets what it asks for <i>and</i> you allow.</p>
        {list && list.plugins.length === 0 && <p className="muted">No plugins installed. Plugins live in <code>{list.dir}</code>.</p>}
        <ul aria-label="Installed plugins" className="snap-list">
          {(list?.plugins ?? []).map((p) => {
            const g = p.granted;
            const ask = p.requests;
            const nothing = !ask.analysis && ask.network.length === 0 && ask.files.length === 0;
            return (
              <li key={p.folder} data-plugin={p.folder}>
                <strong>{p.name}</strong> <span className="muted">{p.version}</span>
                <div className="muted">{p.description}</div>
                <div className="muted">{p.actions.length} action{p.actions.length === 1 ? "" : "s"} in the command palette{p.wasi ? " · uses WASI" : ""}</div>
                {nothing && <div className="muted">Asks for nothing beyond editing.</div>}
                {ask.analysis && (
                  <label><input type="checkbox" aria-label={`Allow ${p.name} to analyse the project's media`} checked={g.analysis} onChange={(e) => void save(p, { ...g, analysis: e.target.checked })} /> Analyse the project's media with FFmpeg (follow audio, beats)</label>
                )}
                {ask.network.map((h) => (
                  <label key={h}><input type="checkbox" aria-label={`Allow ${p.name} to contact ${h}`} checked={g.hosts.includes(h)} onChange={(e) => void save(p, { ...g, hosts: e.target.checked ? [...g.hosts, h] : g.hosts.filter((x) => x !== h) })} /> Contact <code>{h}</code> over the internet</label>
                ))}
                {ask.files.map((guest) => (
                  <div key={guest} className="row">
                    <span>Folder it sees as <code>{guest}</code> (it can read <b>and write</b> there):</span>
                    <span className="muted grow" title={g.folders[guest]}>{g.folders[guest] ?? "none"}</span>
                    <button className="small" aria-label={`Choose the folder for ${guest} of ${p.name}`} onClick={() => void (async () => {
                      const dir = await pickFolder({ directory: true, title: `Folder for ${p.name} (${guest})` });
                      if (typeof dir === "string") await save(p, { ...g, folders: { ...g.folders, [guest]: dir } });
                    })()}>Choose…</button>
                    {g.folders[guest] && <button className="small" aria-label={`Stop giving ${p.name} the folder ${guest}`} onClick={() => { const f = { ...g.folders }; delete f[guest]; void save(p, { ...g, folders: f }); }}>✕</button>}
                  </div>
                ))}
              </li>
            );
          })}
        </ul>
        {list && list.broken.length > 0 && <div className="err">{list.broken.map(([f, why]) => <div key={f}>{f}: {why}</div>)}</div>}
        <div className="row end">
          <button onClick={() => void install()}>Install a plugin from a folder…</button>
          <button className="primary" onClick={() => setOpen(false)}>Close</button>
        </div>
      </div>
    </div>
  );
}
