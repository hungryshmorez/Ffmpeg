import { useEffect, useState } from "react";
import { api } from "../api";
import { useProject, useUi } from "../state/stores";

const CODECS: [string, string][] = [["mpeg4", "MPEG-4: blocky smears"], ["mjpeg", "MJPEG: colour and scanline tears"], ["mpeg2video", "MPEG-2: long macroblock smears"]];

/**
 * Corruption lab: damages the compressed video of a clip on purpose (bits flipped, packets dropped) and decodes the wreck into a
 * new file on a new track. Needs only FFmpeg; the clip and the live timeline are untouched.
 */
export function CorruptDialog() {
  const clipId = useUi((s) => s.corruptClip);
  const close = () => useUi.getState().setCorruptClip(null);
  const setView = useProject((s) => s.setView);
  const toast = useProject((s) => s.toast);
  const [codec, setCodec] = useState("mpeg4");
  const [bitsOn, setBitsOn] = useState(true);
  const [bits, setBits] = useState(5);
  const [dropOn, setDropOn] = useState(false);
  const [dropEvery, setDropEvery] = useState(8);
  const [keyEvery, setKeyEvery] = useState(30);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const un = api.onCorruptionProgress(setProgress);
    return () => { void un.then((f) => f()); };
  }, [busy]);
  if (!clipId) return null;
  const ok = (bitsOn || dropOn) && Number.isInteger(keyEvery) && keyEvery >= 1 && keyEvery <= 600 && (!dropOn || (Number.isInteger(dropEvery) && dropEvery >= 2 && dropEvery <= 100));
  const make = async () => {
    setBusy(true);
    setProgress(0);
    try {
      setView(await api.makeCorruption(clipId, { codec, bits: bitsOn ? bits : null, dropEvery: dropOn ? dropEvery : null, keyframeEvery: keyEvery }));
      toast("info", "Corrupted clip added on a new track");
      close();
    } catch (e) {
      if (/cancel/i.test(String(e))) toast("info", "Corruption canceled");
      else toast("error", `Corruption failed: ${e}`);
    } finally { setBusy(false); }
  };
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Corruption lab">
      <div className="modal">
        <h2>Corruption lab</h2>
        <p className="muted">Compresses the clip with an old codec, damages the compressed data on purpose, then decodes the wreck: errors smear, tear and freeze the way real corruption does. The result is a <b>new file</b> on a new track; this clip is not changed. Which bytes break is repeatable; how the decoder papers over them can vary a little between runs.</p>
        <div className="field row">
          <label>Codec <select aria-label="Codec" value={codec} onChange={(e) => setCodec(e.target.value)}>{CODECS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        </div>
        <div className="field row">
          <label><input type="checkbox" aria-label="Damage bits" checked={bitsOn} onChange={(e) => setBitsOn(e.target.checked)} /> Flip bits</label>
          <label>level <input aria-label="Bit damage level" type="number" className="num" min={1} max={10} step={1} disabled={!bitsOn} value={bits} onChange={(e) => setBits(Number(e.target.value))} /></label>
          <span className="muted">1 = a few, 10 = shredded</span>
        </div>
        <div className="field row">
          <label><input type="checkbox" aria-label="Drop packets" checked={dropOn} onChange={(e) => setDropOn(e.target.checked)} /> Drop packets</label>
          <label>every <input aria-label="Drop one packet in" type="number" className="num" min={2} max={100} step={1} disabled={!dropOn} value={dropEvery} onChange={(e) => setDropEvery(Number(e.target.value))} />th</label>
          <span className="muted">the picture freezes where one is missing</span>
        </div>
        <div className="field row">
          <label>Full picture every <input aria-label="Keyframe spacing in frames" type="number" className="num" min={1} max={600} step={1} value={keyEvery} onChange={(e) => setKeyEvery(Number(e.target.value))} /> frames</label>
          <span className="muted">damage smears until the next one: small heals fast, large lingers</span>
        </div>
        <p className="muted">Works on the clip's own footage at normal speed. Effects, transforms and opacity are not copied; add them to the new clip.</p>
        <div className="row end">
          {busy && <span className="muted grow" role="status">Corrupting… {Math.round(progress * 100)}%</span>}
          {busy && <button onClick={() => void api.cancelCorruption()}>Cancel</button>}
          <button className="primary" disabled={busy || !ok} onClick={() => void make()}>Make corrupted clip</button>
          <button disabled={busy} onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
