import { useEffect, useState } from "react";
import { fpsOf, fromSec, toSec } from "../time";
import { evalKeyframes, keyNear } from "../keyframes";
import { usePlayhead, useProject } from "../state/stores";
import type { Clip, ClipProps, Interp } from "../types";
import { CommitSlider } from "./CommitSlider";

export interface FieldSpec { param: string; label: string; unit?: string; min: number; max: number; step: number; value: number; animatable: boolean }

/**
 * A parameter slider that can be animated. Not animated: edits set the static value (one undo step per drag).
 * Animated: the slider shows the curve's value at the playhead and edits write a keyframe there (auto-key).
 * The ◆ button adds/removes a key at the playhead; the list below edits time, value and interpolation per key.
 */
export function KeyframeField({ clip, spec, interps }: { clip: Clip; spec: FieldSpec; interps: ClipProps["interps"] }) {
  const dispatch = useProject((s) => s.dispatch);
  const fps = fpsOf(useProject((s) => s.view)!.project.settings.fps);
  const t = usePlayhead((s) => s.t);
  const rel = t - toSec(clip.start);
  const dur = toSec(clip.duration);
  const inside = rel >= -0.5 / fps && rel <= dur + 0.5 / fps;
  const kfs = clip.keyframes[spec.param] ?? [];
  const animated = kfs.length > 0;
  const shown = animated ? (evalKeyframes(kfs, Math.min(Math.max(rel, 0), dur)) ?? spec.value) : spec.value;
  const near = keyNear(kfs, rel, fps);
  const [open, setOpen] = useState(false);
  const [follow, setFollow] = useState(false);
  const [busy, setBusy] = useState(false);
  const span = spec.max - spec.min;
  const [low, setLow] = useState(spec.value);
  const [high, setHigh] = useState(Math.min(spec.max, spec.value + span * 0.25));
  const [smooth, setSmooth] = useState(0.1);
  const [band, setBand] = useState("all");
  const [mode, setMode] = useState<"loudness" | "beats">("loudness");
  const [decay, setDecay] = useState(0.25);
  const [lfo, setLfo] = useState(false);
  const [shape, setShape] = useState("sine");
  const [rate, setRate] = useState(1);
  const [phase, setPhase] = useState(0);
  const [formula, setFormula] = useState(false);
  const [expr, setExpr] = useState("p");
  const [source, setSource] = useState("");
  const [clamp, setClamp] = useState(true);
  const sources = clip.kind === "audio" ? [["gain_db", "volume"], ["pan", "balance"]] : [["opacity", "opacity"], ["x", "position X"], ["y", "position Y"], ["scale", "scale"], ["rotation", "rotation"]];
  const applyFormula = async () => {
    setBusy(true);
    try {
      if (await dispatch({ type: "animate_from_expression", clip: clip.id, param: spec.param, expr, source: source || null, clamp })) { setFormula(false); setOpen(true); }
    } finally { setBusy(false); }
  };
  const applyLfo = async () => {
    setBusy(true);
    try {
      if (await dispatch({ type: "animate_from_lfo", clip: clip.id, param: spec.param, shape, rate, low, high, phase, seed: 1 })) { setLfo(false); setOpen(true); }
    } finally { setBusy(false); }
  };
  const applyFollow = async () => {
    setBusy(true);
    try {
      const cmd = mode === "beats"
        ? { type: "animate_from_beats" as const, clip: clip.id, param: spec.param, source: null, low, high, decay }
        : { type: "animate_from_audio" as const, clip: clip.id, param: spec.param, source: null, low, high, smooth, band };
      if (await dispatch(cmd)) { setFollow(false); setOpen(true); }
    } finally { setBusy(false); }
  };
  useEffect(() => { if (!animated) setOpen(false); }, [animated]);

  const key = (time: number, value: number, interp?: Interp) => dispatch({ type: "set_keyframe", clip: clip.id, param: spec.param, time: fromSec(Math.min(Math.max(time, 0), dur)), value, interp: interp ?? null });
  const commit = (v: number) => (animated ? key(rel, v) : dispatch({ type: "set_clip_param", clip: clip.id, param: spec.param, value: v }));
  const toggle = () => (near ? dispatch({ type: "remove_keyframe", clip: clip.id, param: spec.param, time: near.t }) : key(rel, shown));

  return (
    <div className="kf-field" data-param={spec.param} data-animated={animated}>
      <div className="row kf-row">
        <div className="grow">
          <CommitSlider label={spec.label} unit={spec.unit} value={Number(shown.toFixed(4))} min={spec.min} max={spec.max} step={spec.step} onCommit={commit} />
        </div>
        {spec.animatable && (
          <button
            className={`small kf-btn ${near ? "on" : animated ? "has" : ""}`}
            aria-label={`${near ? "Remove" : "Add"} keyframe for ${spec.label}`}
            aria-pressed={!!near}
            disabled={!inside}
            title={!inside ? "Move the playhead inside this clip to set keyframes" : near ? "Remove the keyframe at the playhead" : "Add a keyframe at the playhead"}
            onClick={() => void toggle()}
          >◆</button>
        )}
        {spec.animatable && (
          <button className={`small ${follow ? "on" : ""}`} aria-label={`Follow audio for ${spec.label}`} aria-pressed={follow} title="Make this parameter follow the loudness of the clip's audio (creates keyframes)" onClick={() => { setFollow(!follow); setLfo(false); }}>♪</button>
        )}
        {spec.animatable && (
          <button className={`small ${lfo ? "on" : ""}`} aria-label={`LFO for ${spec.label}`} aria-pressed={lfo} title="Make this parameter oscillate (sine, triangle, saw, square, random); creates keyframes" onClick={() => { setLfo(!lfo); setFollow(false); setFormula(false); }}>∿</button>
        )}
        {spec.animatable && (
          <button className={`small ${formula ? "on" : ""}`} aria-label={`Formula for ${spec.label}`} aria-pressed={formula} title="Drive this parameter with a formula in time (t, p, n, d, fps, v, sin, noise…), optionally following another parameter; creates keyframes" onClick={() => { setFormula(!formula); setLfo(false); setFollow(false); }}>ƒ</button>
        )}
        {animated && <button className="small" aria-label={`${open ? "Hide" : "Show"} keyframes for ${spec.label}`} title="Keyframe list" onClick={() => setOpen(!open)}>{kfs.length}</button>}
      </div>
      {formula && (
        <div className="kf-follow" aria-label={`Formula for ${spec.label}`}>
          <label>{spec.label} = <input aria-label="Formula" className="wide" type="text" spellCheck={false} maxLength={500} value={expr} onChange={(e) => setExpr(e.currentTarget.value)} /></label>
          <label>v is <select aria-label="Value of v" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">this parameter now</option>
            {sources.filter(([id]) => id !== spec.param).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select></label>
          <label><input aria-label="Clamp to the allowed range" type="checkbox" checked={clamp} onChange={(e) => setClamp(e.currentTarget.checked)} /> clamp to {spec.min}…{spec.max}</label>
          <span className="muted">t seconds · p progress 0–1 · n frame · d length · v value · sin cos abs min max noise(x) pi()</span>
          <button className="small primary" disabled={busy || !expr.trim()} onClick={() => void applyFormula()}>{animated ? "Replace keyframes" : "Apply"}</button>
        </div>
      )}
      {lfo && (
        <div className="kf-follow" aria-label={`LFO for ${spec.label}`}>
          <select aria-label="LFO shape" value={shape} onChange={(e) => setShape(e.target.value)}>
            <option value="sine">sine</option>
            <option value="triangle">triangle</option>
            <option value="saw">saw (rises, then drops)</option>
            <option value="square">square</option>
            <option value="random">random (smooth)</option>
          </select>
          <label>rate <input aria-label="LFO rate in Hz" className="num" type="number" min={0.05} max={10} step={0.05} value={rate} onChange={(e) => setRate(e.currentTarget.valueAsNumber)} /> Hz</label>
          <label>low <input aria-label="LFO low value" className="num" type="number" min={spec.min} max={spec.max} step={spec.step} value={low} onChange={(e) => setLow(e.currentTarget.valueAsNumber)} /></label>
          <label>high <input aria-label="LFO high value" className="num" type="number" min={spec.min} max={spec.max} step={spec.step} value={high} onChange={(e) => setHigh(e.currentTarget.valueAsNumber)} /></label>
          <label>start at <input aria-label="LFO phase" className="num" type="number" min={0} max={0.95} step={0.05} value={phase} onChange={(e) => setPhase(e.currentTarget.valueAsNumber)} /> of a cycle</label>
          <button className="small primary" disabled={busy || ![rate, low, high, phase].every(Number.isFinite)} onClick={() => void applyLfo()}>{animated ? "Replace keyframes" : "Apply"}</button>
        </div>
      )}
      {follow && (
        <div className="kf-follow" aria-label={`Follow audio for ${spec.label}`}>
          <span className="muted">{clip.kind === "audio" ? "Follow this clip's" : "Follow the linked audio's"}</span>
          <select aria-label="Follow what" value={mode} onChange={(e) => setMode(e.target.value as "loudness" | "beats")}>
            <option value="loudness">loudness</option>
            <option value="beats">beats (pulse)</option>
          </select>
          <label>{mode === "beats" ? "between beats" : "quiet"} <input aria-label="Value when quiet" className="num" type="number" min={spec.min} max={spec.max} step={spec.step} value={low} onChange={(e) => setLow(e.currentTarget.valueAsNumber)} /></label>
          <label>{mode === "beats" ? "on the beat" : "loud"} <input aria-label="Value when loud" className="num" type="number" min={spec.min} max={spec.max} step={spec.step} value={high} onChange={(e) => setHigh(e.currentTarget.valueAsNumber)} /></label>
          {mode === "beats" && <label>fall back over <input aria-label="Decay in seconds" className="num" type="number" min={0} max={10} step={0.05} value={decay} onChange={(e) => setDecay(e.currentTarget.valueAsNumber)} />s</label>}
          {mode === "loudness" && <label>listen to <select aria-label="Frequency band" value={band} onChange={(e) => setBand(e.target.value)}>
            <option value="all">everything</option>
            <option value="bass">bass (below 150 Hz)</option>
            <option value="mid">mids (300 Hz – 3 kHz)</option>
            <option value="treble">treble (above 5 kHz)</option>
          </select></label>}
          {mode === "loudness" && <label>smooth <input aria-label="Smoothing in seconds" className="num" type="number" min={0} max={10} step={0.05} value={smooth} onChange={(e) => setSmooth(e.currentTarget.valueAsNumber)} />s</label>}
          <button className="small primary" disabled={busy || !Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(mode === "beats" ? decay : smooth)} onClick={() => void applyFollow()}>{busy ? "Measuring…" : animated ? "Replace keyframes" : "Apply"}</button>
        </div>
      )}
      {animated && open && (
        <div className="kf-list" aria-label={`Keyframes for ${spec.label}`}>
          {kfs.map((k) => (
            <div key={k.t} className="kf-item" data-kf-time={k.t}>
              <span className="mono">{toSec(k.t).toFixed(2)}s</span>
              <input aria-label={`Value at ${toSec(k.t).toFixed(2)} s`} className="num" type="number" min={spec.min} max={spec.max} step={spec.step} defaultValue={Number(k.v.toFixed(4))} key={k.v}
                onBlur={(e) => { const v = e.currentTarget.valueAsNumber; if (Number.isFinite(v) && v !== k.v) void dispatch({ type: "set_keyframe", clip: clip.id, param: spec.param, time: k.t, value: v, interp: null }); }} />
              <select aria-label={`Interpolation after ${toSec(k.t).toFixed(2)} s`} value={k.interp} onChange={(e) => void dispatch({ type: "set_keyframe", clip: clip.id, param: spec.param, time: k.t, value: k.v, interp: e.target.value as Interp })}>
                {interps.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
              <button className="small" aria-label={`Delete keyframe at ${toSec(k.t).toFixed(2)} s`} onClick={() => void dispatch({ type: "remove_keyframe", clip: clip.id, param: spec.param, time: k.t })}>✕</button>
            </div>
          ))}
          <button className="small" onClick={() => void dispatch({ type: "clear_keyframes", clip: clip.id, param: spec.param })}>Remove all (keep first value)</button>
        </div>
      )}
    </div>
  );
}
