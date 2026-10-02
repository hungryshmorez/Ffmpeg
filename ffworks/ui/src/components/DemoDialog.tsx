import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { POOL_ALL, POOL_STARRED, toggleStar, useFavs } from "../state/favourites";
import { useProject, useUi } from "../state/stores";
import { pasteCommands } from "../state/fxClipboard";
import type { DemoBatch } from "../types";
import { prettyKind, stepAt } from "./demo";

/**
 * Demo mode: cuts one of your clips into short segments with random transitions and/or effects, renders that as a preview,
 * plays it and keeps replacing it with a new random one until you stop. Your project is never changed.
 */
/** Add a demo segment's effects (with their values) to the clip selected on the timeline, as one undo step. */
function applyDemoLook(fx: { effect: string; params: Record<string, number> }[]) {
  const { view, dispatch, toast } = useProject.getState();
  const sel = useUi.getState().selected;
  const clip = view?.project.sequences.find((q) => q.id === view.project.active_sequence)?.tracks.flatMap((t) => t.clips).find((c) => c.id === sel);
  if (!clip || clip.kind !== "video") return toast("error", "Select a video clip on the timeline first");
  void dispatch({ type: "batch", label: "Use demo look", commands: pasteCommands(fx.map((e, i) => ({ id: String(i), enabled: true, ...e })), clip).commands });
}

export function DemoDialog() {
  const open = useUi((s) => s.demoOpen);
  const setOpen = useUi((s) => s.setDemoOpen);
  const toast = useProject((s) => s.toast);
  const { favs, load, save } = useFavs();
  const [useT, setUseT] = useState(true);
  const [useE, setUseE] = useState(false);
  const [tPool, setTPool] = useState(POOL_ALL);
  const [ePool, setEPool] = useState(POOL_ALL);
  const [stack, setStack] = useState(1);
  const [gl, setGl] = useState(false);
  const [segments, setSegments] = useState(4);
  const [segSecs, setSegSecs] = useState(3);
  const [scaleDiv, setScaleDiv] = useState(4);
  const [running, setRunning] = useState(false);
  const [hold, setHold] = useState(false);
  const [status, setStatus] = useState("");
  const [batch, setBatch] = useState<DemoBatch | null>(null);
  const [now, setNow] = useState(0);
  const [played, setPlayed] = useState(0);
  const ready = useRef<DemoBatch[]>([]);
  const runId = useRef(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const holdRef = useRef(false);
  holdRef.current = hold;
  const batchRef = useRef<DemoBatch | null>(null);
  batchRef.current = batch;
  useEffect(() => { if (open) void load(); }, [open, load]);

  const req = useCallback(() => ({ useTransitions: useT, useEffects: useE, transitionPool: tPool, effectPool: ePool, effectStack: stack, includeGl: gl, segments, segmentSecs: segSecs, scaleDiv }), [useT, useE, tPool, ePool, stack, gl, segments, segSecs, scaleDiv]);

  const stop = useCallback(() => { runId.current++; setRunning(false); ready.current = []; setStatus("Stopped"); }, []);
  useEffect(() => { if (!open) stop(); }, [open, stop]);

  const start = async () => {
    if (!useT && !useE) { toast("error", "Turn on transitions, effects or both."); return; }
    const id = ++runId.current;
    ready.current = [];
    batchRef.current = null;
    setBatch(null);
    setPlayed(0);
    setRunning(true);
    // producer: always keep one finished batch ready so the next look appears without a wait
    for (;;) {
      if (runId.current !== id) return;
      if (ready.current.length === 0) {
        setStatus(videoRef.current && !videoRef.current.paused ? "Rendering the next one…" : "Rendering…");
        try {
          const b = await api.demoBatch(req());
          if (runId.current !== id) return;
          // the first finished batch plays at once; later ones wait their turn (one is always rendered ahead)
          if (batchRef.current === null) { batchRef.current = b; setBatch(b); } else ready.current.push(b);
          setStatus("Playing");
        } catch (e) {
          if (runId.current === id) { toast("error", String(e)); setRunning(false); setStatus("Stopped"); runId.current++; }
          return;
        }
      } else {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  };

  // when the current batch ends, move on to the next finished one (or replay while holding / while the next is rendering)
  const onEnded = () => {
    const v = videoRef.current;
    if (!v) return;
    const next = !holdRef.current ? ready.current.shift() : undefined;
    if (next) { batchRef.current = next; setBatch(next); setPlayed((p) => p + 1); } else { void v.play(); }
  };

  useEffect(() => { void videoRef.current?.play().catch(() => undefined); }, [batch]);

  if (!open) return null;
  const poolOptions = (
    <>
      <option value={POOL_ALL}>everything</option>
      <option value={POOL_STARRED}>favourites ★</option>
      {Object.keys(favs.groups).map((g) => <option key={g} value={g}>group: {g}</option>)}
    </>
  );
  const cur = batch ? stepAt(batch.steps, now) : -1;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Demo mode">
      <div className="modal demo-dialog">
        <h2>Demo mode</h2>
        <p className="muted">Cuts one of your clips into short pieces with random transitions and/or effects, plays it, then another, again and again. Star the ones you like. Your project is not changed.</p>
        <div className="demo-boards">
          <fieldset><legend><label><input type="checkbox" aria-label="Random transitions" checked={useT} disabled={running} onChange={(e) => setUseT(e.target.checked)} /> Transitions</label></legend>
            <div className="row"><span>from</span><select aria-label="Transition pool" value={tPool} disabled={running} onChange={(e) => setTPool(e.target.value)}>{poolOptions}</select></div>
            <label className="check"><input type="checkbox" aria-label="Include GL transitions" checked={gl} disabled={running} onChange={(e) => setGl(e.target.checked)} /> include GL transitions (slow to render)</label>
          </fieldset>
          <fieldset><legend><label><input type="checkbox" aria-label="Random effects" checked={useE} disabled={running} onChange={(e) => setUseE(e.target.checked)} /> Effects</label></legend>
            <div className="row"><span>from</span><select aria-label="Effect pool" value={ePool} disabled={running} onChange={(e) => setEPool(e.target.value)}>{poolOptions}</select></div>
            <div className="row"><span>stack</span><input type="number" aria-label="Effects per piece" min={1} max={6} value={stack} disabled={running} onChange={(e) => setStack(Math.min(6, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 56 }} /></div>
          </fieldset>
        </div>
        <div className="row">
          <label>pieces <input type="number" aria-label="Pieces per demo" min={2} max={12} value={segments} disabled={running} onChange={(e) => setSegments(Number(e.target.value) || 2)} style={{ width: 56 }} /></label>
          <label>seconds each <input type="number" aria-label="Seconds per piece" min={1} max={10} step={0.5} value={segSecs} disabled={running} onChange={(e) => setSegSecs(Number(e.target.value) || 1)} style={{ width: 64 }} /></label>
          <label>quality <select aria-label="Demo quality" value={scaleDiv} disabled={running} onChange={(e) => setScaleDiv(Number(e.target.value))}><option value={8}>draft</option><option value={4}>quarter</option><option value={2}>half</option></select></label>
          <span className="grow" />
          {!running ? <button className="primary" onClick={() => void start()}>Start demo</button> : <button onClick={stop}>Stop</button>}
          <button disabled={!running} aria-pressed={hold} onClick={() => setHold((h) => !h)}>{hold ? "Release" : "Hold this one"}</button>
        </div>
        <div className="demo-stage">
          {batch ? <video ref={videoRef} key={batch.path} src={convertFileSrc(batch.path)} autoPlay muted playsInline onEnded={onEnded} onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} aria-label="Demo video" /> : <div className="muted pad" aria-live="polite">{running ? status : "Press Start demo."}</div>}
        </div>
        <div className="muted" aria-live="polite" data-demo-status>{status}{batch ? ` · look ${played + 1} · seed ${batch.seed}` : ""}</div>
        {batch && (
          <ol className="demo-steps" aria-label="What is playing">
            {batch.steps.map((s) => (
              <li key={s.index} className={s.index === cur ? "now" : ""} data-step={s.index}>
                <span className="muted">{s.start.toFixed(1)} s</span>{" "}
                {s.transition && <>
                  <b>{prettyKind(s.transition)}</b>
                  <button className="small" aria-label={`${favs.starred.transitions.includes(s.transition) ? "Unstar" : "Star"} transition ${s.transition}`} onClick={() => void save(toggleStar(favs, "transitions", s.transition!)).catch((e) => toast("error", String(e)))}>{favs.starred.transitions.includes(s.transition) ? "★" : "☆"}</button>
                </>}
                {s.effects.map((e, i) => (
                  <span key={i}> {e}<button className="small" aria-label={`${favs.starred.effects.includes(e) ? "Unstar" : "Star"} effect ${e}`} onClick={() => void save(toggleStar(favs, "effects", e)).catch((er) => toast("error", String(er)))}>{favs.starred.effects.includes(e) ? "★" : "☆"}</button></span>
                ))}
                {s.fx.length > 0 && <>
                  {" "}
                  <button className="small" title="Save this segment's effect stack (with its random values) as a saved look" aria-label={`Keep look of segment ${s.index + 1}`} onClick={() => void api.saveEffectPreset(`Demo look ${batch.seed}-${s.index + 1}`, { kind: "video", effects: s.fx }).then(() => toast("info", `Saved "Demo look ${batch.seed}-${s.index + 1}" (apply it from the clip's Effects panel)`)).catch((er) => toast("error", String(er)))}>Keep look</button>
                  <button className="small" title="Add this segment's effects to the clip selected on the timeline" aria-label={`Use look of segment ${s.index + 1} on the selected clip`} onClick={() => applyDemoLook(s.fx)}>Use on selected</button>
                </>}
                {!s.transition && s.effects.length === 0 && <span className="muted">start</span>}
              </li>
            ))}
          </ol>
        )}
        <div className="row end"><button onClick={() => setOpen(false)}>Close</button></div>
      </div>
    </div>
  );
}
