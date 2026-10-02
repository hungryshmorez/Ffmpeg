import { useState } from "react";
import { api } from "../api";
import { useJobs, useProject } from "../state/stores";
import type { JobEvent, JobLog } from "../types";

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;
const active = (j: JobEvent) => j.state === "queued" || j.state === "rendering";

export function QueuePanel() {
  const open = useJobs((s) => s.queueOpen);
  const setOpen = useJobs((s) => s.setQueueOpen);
  const jobs = useJobs((s) => s.jobs);
  const order = useJobs((s) => s.order);
  const replaceAll = useJobs((s) => s.replaceAll);
  const toast = useProject((s) => s.toast);
  const [logs, setLogs] = useState<Record<string, JobLog | null | "loading">>({});
  const [shown, setShown] = useState<string | null>(null);
  if (!open) return null;
  const list = order.map((id) => jobs[id]).filter((j): j is JobEvent => !!j);
  const showLog = async (id: string) => {
    if (shown === id) return setShown(null);
    setShown(id);
    setLogs((l) => ({ ...l, [id]: "loading" }));
    try { const log = await api.getJobLog(id); setLogs((l) => ({ ...l, [id]: log })); } catch (e) { toast("error", String(e)); }
  };
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Render queue">
      <div className="modal">
        <h2>Render queue</h2>
        {list.length === 0 && <p className="muted">No jobs yet. Exports you start appear here and run in the background.</p>}
        {list.map((j) => (
          <div key={j.jobId} className={`job-row ${j.state}`} data-job={j.jobId}>
            <div className="row">
              <strong className="grow" title={j.output}>{basename(j.output)}</strong>
              <span className="muted">{j.operation}</span>
              <span className={`state-badge ${j.state}`}>{j.state}</span>
            </div>
            {j.state === "rendering" && (
              <>
                {j.fraction != null ? <progress value={j.fraction} max={1} /> : <progress />}
                <div className="muted">{j.fraction != null ? `${Math.round(j.fraction * 100)}%` : "starting…"}{j.fps ? ` · ${j.fps.toFixed(0)} fps` : ""} · {j.elapsed_secs.toFixed(0)}s{j.eta_secs != null ? ` · ~${j.eta_secs.toFixed(0)}s left` : ""}</div>
              </>
            )}
            {j.state === "failed" && <div className="err">{j.message}</div>}
            <div className="row">
              {active(j) && <button className="small" onClick={() => void api.cancelJob(j.jobId)}>Cancel</button>}
              {j.state !== "queued" && <button className="small" onClick={() => void showLog(j.jobId)}>{shown === j.jobId ? "Hide log" : "Log"}</button>}
            </div>
            {shown === j.jobId && (
              <pre className="cmd">{formatLog(logs[j.jobId])}</pre>
            )}
          </div>
        ))}
        <div className="row end">
          <button disabled={!list.some((j) => !active(j))} onClick={() => void api.clearFinishedJobs().then(() => api.listJobs()).then(replaceAll)}>Clear finished</button>
          <button className="primary" onClick={() => setOpen(false)}>Close</button>
        </div>
      </div>
    </div>
  );
}

function formatLog(l: JobLog | null | "loading" | undefined): string {
  if (l === undefined || l === "loading") return "loading…";
  if (l === null) return "No log (job never started FFmpeg).";
  return `exit code: ${l.exit_code}\n${l.executable} ${l.args.join(" ")}\n\n${l.stderr}`;
}
