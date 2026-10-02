import { useEffect, useState } from "react";
import { api } from "../api";
import { useJobs, useProject } from "../state/stores";

interface Unfinished { output: string; wasRunning: boolean; enqueuedUnix: number }

/** Shown at startup when exports were still queued or rendering when FFWORKS last closed or crashed. */
export function UnfinishedExportsDialog() {
  const [jobs, setJobs] = useState<Unfinished[] | null>(null);
  // wait for the recovery question first, so two startup dialogs never stack
  const [recoveryGone, setRecoveryGone] = useState(false);
  useEffect(() => { void api.unfinishedExports().then((j) => setJobs(j.length ? j : null)).catch(() => undefined); }, []);
  useEffect(() => {
    if (recoveryGone || !jobs) return;
    const t = setInterval(() => { if (!document.querySelector("[aria-label='Recover unsaved work']")) setRecoveryGone(true); }, 300);
    return () => clearInterval(t);
  }, [jobs, recoveryGone]);
  if (!jobs || !recoveryGone) return null;
  const resolve = async (requeue: boolean) => {
    const ids = await api.resolveUnfinished(requeue);
    setJobs(null);
    if (requeue) { useJobs.getState().setQueueOpen(true); useProject.getState().toast("info", `${ids.length} export(s) queued again`); }
  };
  return (
    <div className="modal-backdrop" role="alertdialog" aria-modal="true" aria-label="Unfinished exports">
      <div className="modal">
        <h2>Unfinished exports</h2>
        <p>{jobs.length === 1 ? "This export" : `These ${jobs.length} exports`} had not finished when FFWORKS last closed:</p>
        <ul className="snap-list" aria-label="Exports that did not finish">
          {jobs.map((j) => (
            <li key={j.output}><span className="mono">{j.output}</span> <span className="muted">{j.wasRunning ? "was rendering — starts again from the beginning" : "was waiting"} · queued {new Date(j.enqueuedUnix * 1000).toLocaleString()}</span></li>
          ))}
        </ul>
        <p className="muted">They render exactly what was queued then (later edits to the project are not included).</p>
        <div className="row end">
          <button onClick={() => void resolve(false)}>Discard</button>
          <button className="primary" onClick={() => void resolve(true)}>Queue them again</button>
        </div>
      </div>
    </div>
  );
}
