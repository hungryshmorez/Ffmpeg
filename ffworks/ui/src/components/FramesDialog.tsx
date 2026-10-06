import { useEffect, useState } from "react";
import { activeSequence } from "../state/sequences";
import { api } from "../api";
import { useProject, useUi } from "../state/stores";

type Fields = "count" | "at" | "every" | "spread" | "seed" | "descending" | "donor";
const MODES: { id: string; name: string; about: string; fields: Fields[] }[] = [
  { id: "classic", name: "Classic", about: "Only the full pictures are removed: motion keeps piling onto the last picture before them.", fields: [] },
  { id: "random", name: "Random", about: "Frames in a random order.", fields: ["seed"] },
  { id: "reverse", name: "Reverse", about: "Frames backwards: movement melts the wrong way.", fields: [] },
  { id: "invert", name: "Invert", about: "Every two neighbouring frames swap places.", fields: [] },
  { id: "invert_reverse", name: "Invert + reverse", about: "Neighbours swap, then everything runs backwards.", fields: [] },
  { id: "bloom", name: "Bloom", about: "One frame repeats many times: its movement keeps going and the picture blooms outward.", fields: ["at", "count"] },
  { id: "pulse", name: "Pulse", about: "Every N frames, one frame repeats a few times.", fields: ["every", "count"] },
  { id: "overlap", name: "Overlap", about: "Groups of frames taken from every N-th position, so they play twice (4 and 2 give 1 2 3 4 3 4 5 6 5 6 …).", fields: ["count", "every"] },
  { id: "jiggle", name: "Jiggle", about: "Each frame is taken from somewhere close by.", fields: ["spread", "seed"] },
  { id: "repeat", name: "Repeat", about: "A short group of frames plays over and over: a melting loop.", fields: ["at", "count"] },
  { id: "sort", name: "Sort by size", about: "Frames sorted by how much data they hold.", fields: ["descending"] },
  { id: "splice", name: "Splice another clip", about: "The picture of this clip, then only the movement of another one: the classic transition mosh.", fields: ["donor"] },
];

/**
 * Frame lab: datamoshes a clip by rearranging, repeating and removing its compressed frames (the tomato / Datamosher Pro way).
 * Needs only FFmpeg; makes a new file on a new track and leaves the clip and the live timeline untouched.
 */
export function FramesDialog() {
  const clipId = useUi((s) => s.framesClip);
  const close = () => useUi.getState().setFramesClip(null);
  const view = useProject((s) => s.view);
  const setView = useProject((s) => s.setView);
  const toast = useProject((s) => s.toast);
  const [mode, setMode] = useState("classic");
  const [count, setCount] = useState(10);
  const [at, setAt] = useState(20);
  const [every, setEvery] = useState(10);
  const [spread, setSpread] = useState(4);
  const [seed, setSeed] = useState(1);
  const [descending, setDescending] = useState(false);
  const [donor, setDonor] = useState("");
  const [spliceAt, setSpliceAt] = useState(1);
  const [keyEvery, setKeyEvery] = useState(30);
  const [dropKeys, setDropKeys] = useState(true);
  const [keepFirst, setKeepFirst] = useState(true);
  const [killOn, setKillOn] = useState(false);
  const [kill, setKill] = useState(0.7);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const un = api.onFramelabProgress(setProgress);
    return () => { void un.then((f) => f()); };
  }, [busy]);
  if (!clipId || !view) return null;
  const def = MODES.find((m) => m.id === mode)!;
  const has = (f: Fields) => def.fields.includes(f);
  const others = (activeSequence(view.project)?.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips) ?? []).filter((c) => c.id !== clipId && !c.title);
  const int = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
  const valid =
    int(keyEvery, 1, 600) && (!killOn || (kill >= 0.05 && kill <= 1)) &&
    (!has("count") || int(count, 1, 1000)) && (!has("every") || int(every, 1, 1000)) && (!has("at") || int(at, 0, 100000)) &&
    (!has("spread") || int(spread, 1, 100)) && (!has("donor") || (donor !== "" && spliceAt > 0)) &&
    (mode !== "classic" || dropKeys);
  const make = async () => {
    setBusy(true);
    setProgress(0);
    try {
      setView(await api.makeFrames(clipId, {
        kind: mode, count: has("count") ? count : undefined, at: has("at") ? at : undefined, every: has("every") ? every : undefined,
        spread: has("spread") ? spread : undefined, seed: has("seed") ? seed : undefined, descending: has("descending") ? descending : undefined,
        donor: has("donor") ? donor : undefined, spliceAt: has("donor") ? spliceAt : undefined,
        keyframeEvery: keyEvery, dropKeyframes: dropKeys, keepFirst, kill: killOn ? kill : undefined,
      }));
      toast("info", "Frame-lab clip added on a new track");
      close();
    } catch (e) {
      if (/cancel/i.test(String(e))) toast("info", "Frame lab canceled");
      else toast("error", `Frame lab failed: ${e}`);
    } finally { setBusy(false); }
  };
  const num = (label: string, value: number, set: (n: number) => void, min: number, max: number, step = 1) => (
    <label>{label} <input aria-label={label} type="number" className="num" min={min} max={max} step={step} value={value} onChange={(e) => set(Number(e.target.value))} /></label>
  );
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Frame lab">
      <div className="modal">
        <h2>Frame lab</h2>
        <p className="muted">Datamoshing the classic way: the clip is compressed, its frames are rearranged, repeated or removed (most of all the <b>full pictures</b>, so later movement piles onto an old picture), and the result is decoded into a <b>new file</b> on a new track. This clip is not changed. Techniques from tomato and Datamosher Pro.</p>
        <div className="field row">
          <label>Mode <select aria-label="Frame mode" value={mode} onChange={(e) => setMode(e.target.value)}>{MODES.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          <span className="muted grow">{def.about}</span>
        </div>
        {(has("at") || has("count") || has("every") || has("spread") || has("seed")) && (
          <div className="field row">
            {has("at") && num("Frame number", at, setAt, 0, 100000)}
            {has("every") && num("Every N frames", every, setEvery, 1, 1000)}
            {has("count") && num(mode === "overlap" || mode === "repeat" ? "Group size" : "Repeats", count, setCount, 1, 1000)}
            {has("spread") && num("Spread", spread, setSpread, 1, 100)}
            {has("seed") && num("Random seed", seed, setSeed, 0, 1_000_000)}
          </div>
        )}
        {has("descending") && <div className="field row"><label><input type="checkbox" aria-label="Busiest frames first" checked={descending} onChange={(e) => setDescending(e.target.checked)} /> Busiest frames first</label></div>}
        {has("donor") && (
          <div className="field row">
            <select aria-label="Clip lending its movement" value={donor} onChange={(e) => setDonor(e.target.value)}>
              <option value="">Choose a clip…</option>
              {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {num("Splice after (seconds)", spliceAt, setSpliceAt, 0.04, 3600, 0.5)}
          </div>
        )}
        <div className="field row">
          {num("Full picture every (frames)", keyEvery, setKeyEvery, 1, 600)}
          <span className="muted">few = many removal points, many = one long hold</span>
        </div>
        <div className="field row">
          <label><input type="checkbox" aria-label="Remove keyframes" checked={dropKeys} onChange={(e) => setDropKeys(e.target.checked)} /> Remove keyframes</label>
          <label><input type="checkbox" aria-label="Keep the first frame" checked={keepFirst} onChange={(e) => setKeepFirst(e.target.checked)} /> Keep the first frame</label>
          <label><input type="checkbox" aria-label="Remove frames with too much data" checked={killOn} onChange={(e) => setKillOn(e.target.checked)} /> Drop big frames above</label>
          <input aria-label="Big frame limit" type="number" className="num" min={0.05} max={1} step={0.05} disabled={!killOn} value={kill} onChange={(e) => setKill(Number(e.target.value))} />
        </div>
        <p className="muted">Works on the clip's own footage at normal speed. The result is cut or padded (last picture held) to the clip's length. Effects, transforms and opacity are not copied; add them to the new clip.</p>
        <div className="row end">
          {busy && <span className="muted grow" role="status">Rearranging… {Math.round(progress * 100)}%</span>}
          {busy && <button onClick={() => void api.cancelFramelab()}>Cancel</button>}
          <button className="primary" disabled={busy || !valid} onClick={() => void make()}>Make frame-lab clip</button>
          <button disabled={busy} onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
