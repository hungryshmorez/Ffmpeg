import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useJobs, useProject, useUi } from "../state/stores";
import type { EngineInfo, ExportPreset, JobEvent } from "../types";

export function ExportDialog() {
  const open = useUi((s) => s.exportOpen);
  const setOpen = useUi((s) => s.setExportOpen);
  const view = useProject((s) => s.view)!;
  const toast = useProject((s) => s.toast);
  const [presets, setPresets] = useState<ExportPreset[]>([]);
  const [preset, setPreset] = useState("h264_mp4");
  const [output, setOutput] = useState("");
  const [command, setCommand] = useState("");
  const setQueueOpen = useJobs((st) => st.setQueueOpen);
  const [jobId, setJobId] = useState<string | null>(null);
  const job: JobEvent | null = useJobs((st) => (jobId ? st.jobs[jobId] ?? null : null));
  const [verify, setVerify] = useState<string | null>(null);
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [engine, setEngine] = useState("default");

  useEffect(() => { void api.listExportPresets().then(setPresets); }, []);
  useEffect(() => { if (open) void api.listEngines().then((r) => { setEngines(r.engines.filter((x) => x.ok)); setEngine((cur) => (r.engines.some((x) => x.id === cur) ? cur : r.active)); }); }, [open]);
  useEffect(() => {
    if (!open || !output) return setCommand("");
    api.previewCommand(preset, output, engine).then(setCommand).catch((e) => setCommand(`Cannot build command: ${e}`));
  }, [open, preset, output, engine, view.project]);
  useEffect(() => {
    if (job?.state === "completed") api.verifyOutput(job.output).then(setVerify).catch((e) => setVerify(`Verification failed: ${e}`));
  }, [job]);

  if (!open) return null;
  const p = presets.find((x) => x.id === preset);
  const running = job && (job.state === "queued" || job.state === "rendering");
  const choose = async () => {
    const ext = p?.extension ?? "mp4";
    const picked = await save({ title: "Export to", defaultPath: `${view.project.name}.${ext}`, filters: [{ name: p?.name ?? ext, extensions: [ext] }] });
    if (picked) setOutput(picked);
  };
  const start = async () => {
    setVerify(null);
    try { setJobId(await api.startExport(preset, output, engine)); } catch (e) { toast("error", String(e)); }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Export">
      <div className="modal">
        <h2>Export</h2>
        <div className="field">
          <label htmlFor="preset">Preset</label>
          <select id="preset" value={preset} onChange={(e) => { setPreset(e.target.value); setOutput(""); }} disabled={false}>
            {presets.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </div>
        {engines.length > 1 && (
          <div className="field">
            <label htmlFor="engine">FFmpeg build</label>
            <select id="engine" value={engine} onChange={(e2) => setEngine(e2.target.value)}>
              {engines.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.license})</option>)}
            </select>
          </div>
        )}
        <div className="field">
          <label>Destination</label>
          <div className="row"><input readOnly value={output} placeholder="Choose a file…" aria-label="Destination" /><button onClick={() => void choose()}>Browse…</button></div>
        </div>
        <details><summary>FFmpeg command (Command Inspector)</summary><pre className="cmd">{command || "Choose a destination to see the exact FFmpeg command."}</pre></details>
        {job && (
          <div className="job" aria-live="polite">
            {job.state === "rendering" && (
              <>
                {job.fraction != null ? <progress value={job.fraction} max={1} /> : <progress />}
                <div className="muted">{job.fraction != null ? `${Math.round(job.fraction * 100)}%` : "working…"}{job.fps ? ` · ${job.fps.toFixed(0)} fps` : ""} · {job.elapsed_secs.toFixed(0)}s elapsed{job.eta_secs != null ? ` · ~${job.eta_secs.toFixed(0)}s left` : ""}</div>
              </>
            )}
            {job.state === "queued" && <div className="muted">Queued — it starts when earlier jobs finish.</div>}
            {job.state === "completed" && <div className="ok">Export complete → {job.output}</div>}
            {job.state === "failed" && <div className="err">Export failed: {job.message}</div>}
            {job.state === "canceled" && <div className="muted">Export canceled. No file was written.</div>}
            {verify && <pre className="cmd">{verify}</pre>}
          </div>
        )}
        <div className="row end">
          {running && <button onClick={() => job && void api.cancelJob(job.jobId)}>Cancel this export</button>}
          <button onClick={() => { setOpen(false); setQueueOpen(true); }}>Open queue</button>
          <button onClick={() => setOpen(false)}>Close</button>
          <button className="primary" disabled={!output} onClick={() => void start()}>Add to queue</button>
        </div>
      </div>
    </div>
  );
}
