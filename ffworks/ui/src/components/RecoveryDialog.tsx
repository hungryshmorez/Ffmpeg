import { useEffect, useState } from "react";
import { api } from "../api";
import { useProject } from "../state/stores";
import type { RecoveryInfo } from "../types";

/** Shown at startup when an autosave from an abnormal exit exists (spec §101). */
export function RecoveryDialog() {
  const [info, setInfo] = useState<RecoveryInfo | null>(null);
  const { run, toast } = useProject.getState();
  useEffect(() => { void api.findRecovery().then(setInfo).catch(() => undefined); }, []);
  if (!info) return null;
  const when = new Date(info.saved_unix * 1000).toLocaleString();
  const recover = async () => { if (await run(api.recoverProject)) { setInfo(null); toast("info", "Recovered. Save the project to keep it."); } };
  const discard = async () => { await api.discardRecovery(); setInfo(null); };
  const openOriginal = async () => {
    const p = info.original_path;
    await api.discardRecovery();
    setInfo(null);
    if (p) await run(() => api.openProject(p));
  };
  return (
    <div className="modal-backdrop" role="alertdialog" aria-modal="true" aria-label="Recover unsaved work">
      <div className="modal">
        <h2>Recover unsaved work?</h2>
        <p>FFWORKS did not close normally last time. An autosave of <strong>{info.name}</strong> ({info.clips} clips) from {when} was found.</p>
        {info.original_path && <p className="muted">Original file: {info.original_path}</p>}
        <div className="row end">
          <button onClick={() => void discard()}>Discard</button>
          <button disabled={!info.original_path} title={info.original_path ? "Open the last saved version and discard the autosave" : "This project was never saved"} onClick={() => void openOriginal()}>Open original</button>
          <button className="primary" onClick={() => void recover()}>Recover</button>
        </div>
      </div>
    </div>
  );
}
