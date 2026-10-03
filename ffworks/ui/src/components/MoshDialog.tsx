import { useEffect, useState } from "react";
import { api } from "../api";
import { useProject, useUi } from "../state/stores";
import type { GlitchStatus } from "../types";

type Kind = "amplify" | "drift" | "transfer";

/**
 * Datamosh lab: rewrites the motion vectors inside the clip's compressed video with FFglitch and puts the result on a new
 * track. It makes a new file (through a lossy intermediate); the clip itself and the live timeline are untouched.
 */
export function MoshDialog() {
  const clipId = useUi((s) => s.moshClip);
  const close = () => useUi.getState().setMoshClip(null);
  const view = useProject((s) => s.view);
  const setView = useProject((s) => s.setView);
  const toast = useProject((s) => s.toast);
  const [status, setStatus] = useState<GlitchStatus | null>(null);
  const [dir, setDir] = useState("");
  const [kind, setKind] = useState<Kind>("amplify");
  const [factor, setFactor] = useState(3);
  const [x, setX] = useState(6);
  const [y, setY] = useState(0);
  const [donor, setDonor] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!clipId) return;
    void api.ffglitchStatus().then((st) => { setStatus(st); setDir(st.dir ?? ""); }).catch((e) => toast("error", String(e)));
  }, [clipId, toast]);
  useEffect(() => {
    if (!busy) return;
    const un = api.onMoshProgress(setProgress);
    return () => { void un.then((f) => f()); };
  }, [busy]);
  if (!clipId || !view) return null;

  const clips = view.project.sequences[0]?.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips) ?? [];
  const others = clips.filter((c) => c.id !== clipId);
  const saveDir = async () => {
    try { setStatus(await api.setFfglitchDir(dir)); } catch (e) { toast("error", String(e)); }
  };
  const make = async () => {
    setBusy(true);
    setProgress(0);
    try {
      setView(await api.makeMosh(clipId, kind === "amplify" ? { kind, factor } : kind === "drift" ? { kind, x, y } : { kind, donor }));
      toast("info", "Datamosh clip added on a new track");
      close();
    } catch (e) {
      if (String(e) !== "Canceled") toast("error", `Datamosh failed: ${e}`);
    } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Datamosh lab">
      <div className="modal">
        <h2>Datamosh lab</h2>
        <p className="muted">Rewrites the motion inside the clip's compressed video, so movement smears, overshoots and drags the picture along. The result is a <b>new file</b> (made through a lossy intermediate) placed on a new track; this clip is not changed.</p>
        {status && !status.found && (
          <div className="field" role="status">
            <p>FFglitch was not found. It is a separate free tool from ffglitch.org; unpack it and choose the folder that holds <code>ffedit</code> and <code>ffgac</code>.</p>
            <div className="row">
              <input aria-label="FFglitch folder" className="grow" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/path/to/ffglitch" />
              <button onClick={() => void saveDir()}>Use this folder</button>
            </div>
          </div>
        )}
        {status?.found && (
          <>
            <div className="field row">
              <select aria-label="Kind of mosh" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="amplify">Amplify the motion</option>
                <option value="drift">Push everything in a direction</option>
                <option value="transfer">Borrow the motion of another clip</option>
              </select>
            </div>
            {kind === "amplify" && (
              <div className="field row"><label>Motion × <input aria-label="Motion multiplier" type="number" className="num" min={0} max={16} step={0.5} value={factor} onChange={(e) => setFactor(Number(e.target.value))} /></label><span className="muted">1 = as filmed, 0 = frozen vectors</span></div>
            )}
            {kind === "drift" && (
              <div className="field row">
                <label>Across <input aria-label="Push across" type="number" className="num" min={-256} max={256} value={x} onChange={(e) => setX(Number(e.target.value))} /></label>
                <label>Down <input aria-label="Push down" type="number" className="num" min={-256} max={256} value={y} onChange={(e) => setY(Number(e.target.value))} /></label>
                <span className="muted">half-pixels added to every block's movement, every frame</span>
              </div>
            )}
            {kind === "transfer" && (
              <div className="field row">
                <select aria-label="Clip lending its motion" value={donor} onChange={(e) => setDonor(e.target.value)}>
                  <option value="">Choose a clip…</option>
                  {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <span className="muted">the shorter of the two lengths is used</span>
              </div>
            )}
            <p className="muted">Works on the clip's own footage at normal speed. Effects, transforms and opacity are not copied; add them to the new clip.</p>
          </>
        )}
        <div className="row end">
          {busy && <span className="muted grow" role="status">Making the mosh… {Math.round(progress * 100)}%</span>}
          {busy && <button onClick={() => void api.cancelMosh()}>Cancel</button>}
          <button className="primary" disabled={busy || !status?.found || (kind === "transfer" && !donor)} onClick={() => void make()}>Make datamosh clip</button>
          <button disabled={busy} onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
