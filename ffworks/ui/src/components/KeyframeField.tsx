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
        {animated && <button className="small" aria-label={`${open ? "Hide" : "Show"} keyframes for ${spec.label}`} title="Keyframe list" onClick={() => setOpen(!open)}>{kfs.length}</button>}
      </div>
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
