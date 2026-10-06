import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useProject, useUi } from "../state/stores";
import type { ScriptOutcome } from "../types";

const KEY = "ffworks.scriptEditor.source";
const read = () => { try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; } };
const remember = (s: string) => { try { localStorage.setItem(KEY, s); } catch { /* private window or blocked storage: the draft is simply not kept */ } };

/**
 * Script editor: write a Rhai script, **dry run** it (it runs for real so errors, output and the list of commands are exact, then
 * every change is taken back) or **run** it (one undo step). Scripts edit the project through the command bus only: no files,
 * network or programs.
 */
export function ScriptDialog() {
  const isOpen = useUi((s) => s.scriptOpen);
  const close = () => useUi.getState().setScriptOpen(false);
  const selected = useUi((s) => s.selected);
  const setView = useProject((s) => s.setView);
  const toast = useProject((s) => s.toast);
  const [source, setSource] = useState(read);
  const [examples, setExamples] = useState<[string, string, string][]>([]);
  const [analysis, setAnalysis] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "dry" | "run" | "error"; outcome?: ScriptOutcome; error?: string } | null>(null);
  useEffect(() => {
    if (isOpen && examples.length === 0) void api.scriptExamples().then(setExamples).catch((e) => toast("error", String(e)));
  }, [isOpen, examples.length, toast]);
  if (!isOpen) return null;

  const edit = (text: string) => { setSource(text); remember(text); setResult(null); };
  const go = async (dry: boolean) => {
    setBusy(true);
    try {
      const outcome = await api.runScriptText(source, selected, analysis, dry);
      if (!dry) setView(outcome.view);
      setResult({ kind: dry ? "dry" : "run", outcome });
      if (!dry) toast("info", `Script ran: ${outcome.commands} commands, one undo step`);
    } catch (e) {
      setResult({ kind: "error", error: String(e) });
    } finally { setBusy(false); }
  };
  const openFile = async () => {
    const p = await open({ title: "Script to edit", filters: [{ name: "Rhai script", extensions: ["rhai"] }] });
    if (typeof p !== "string") return;
    try { edit(await api.readScriptFile(p)); } catch (e) { toast("error", String(e)); }
  };
  const saveFile = async () => {
    const p = await save({ title: "Save script", defaultPath: "script.rhai", filters: [{ name: "Rhai script", extensions: ["rhai"] }] });
    if (typeof p !== "string") return;
    try { await api.writeScriptFile(p, source); toast("info", "Script saved"); } catch (e) { toast("error", String(e)); }
  };
  const shown = result?.outcome;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Script editor">
      <div className="modal wide">
        <h2>Script editor</h2>
        <p className="muted">Write a <a href="https://rhai.rs/book/" target="_blank" rel="noreferrer">Rhai</a> script that edits the project: loops, conditions, <code>clips()</code>, <code>add_effect(...)</code> and the other commands. <b>Dry run</b> runs it and shows exactly what it would do, then takes it all back. <b>Run</b> applies it as one undo step; an error anywhere undoes everything. Scripts cannot touch files, the network or other programs.</p>
        <div className="field row">
          <label>Example
            <select aria-label="Insert an example" value="" onChange={(e) => { const ex = examples.find((x) => x[0] === e.target.value); if (ex) edit(ex[2]); }}>
              <option value="">Insert an example…</option>
              {examples.map(([title, about]) => <option key={title} value={title}>{title} ({about})</option>)}
            </select>
          </label>
          <button onClick={() => void openFile()}>Open…</button>
          <button disabled={!source.trim()} onClick={() => void saveFile()}>Save…</button>
        </div>
        <textarea aria-label="Script source" className="code" spellCheck={false} autoCapitalize="off" autoCorrect="off" rows={14} value={source} onChange={(e) => edit(e.target.value)} placeholder={'// for example:\nfor c in clips() {\n    if c.kind == "video" { set_opacity(c.id, 0.8); }\n}'} />
        <div className="field row">
          <label><input type="checkbox" aria-label="Allow audio analysis" checked={analysis} onChange={(e) => setAnalysis(e.target.checked)} /> Allow audio analysis (animate_from_audio / animate_from_beats run FFmpeg)</label>
          <span className="muted grow">{selected ? "selected() is the clip you have selected" : "selected() is empty: no clip is selected"}</span>
        </div>
        {result?.kind === "error" && <div role="alert" className="field script-error"><b>The script did not run:</b> {result.error}</div>}
        {shown && (
          <div className="field" role="status" aria-label="Script result">
            <b>{result?.kind === "dry" ? `Dry run: ${shown.commands} command${shown.commands === 1 ? "" : "s"} would run (nothing was changed)` : `Ran: ${shown.commands} command${shown.commands === 1 ? "" : "s"}, one undo step`}</b>
            {shown.log.length > 0 && <pre className="script-log" aria-label="Script output">{shown.log.join("\n")}</pre>}
            {shown.changes.length > 0 && (
              <ol className="script-changes" aria-label="Commands issued">
                {shown.changes.map((c, i) => <li key={i}>{c}</li>)}
              </ol>
            )}
          </div>
        )}
        <div className="row end">
          <button disabled={busy || !source.trim()} onClick={() => void go(true)}>Dry run</button>
          <button className="primary" disabled={busy || !source.trim()} onClick={() => void go(false)}>Run</button>
          <button disabled={busy} onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
