import { useEffect, useState } from "react";
import { api } from "../api";
import { toSec } from "../time";
import { sourceTime } from "../timeline/math";
import { usePlayhead, useProject } from "../state/stores";
import type { Clip, ClipProps } from "../types";
import { KeyframeField } from "./KeyframeField";

let cache: ClipProps | null = null;
export function useClipProps(): ClipProps | null {
  const [p, setP] = useState<ClipProps | null>(cache);
  useEffect(() => { if (!cache) void api.listClipProps().then((v) => { cache = v; setP(v); }); }, []);
  return p;
}

const SPEEDS = [25, 50, 100, 200, 400];

/** Transform, opacity, blend mode and timing (speed / reverse / freeze) of a video clip. Everything is a command. */
export function ClipPropsPanel({ clip }: { clip: Clip }) {
  const props = useClipProps();
  const dispatch = useProject((s) => s.dispatch);
  const pct = Math.round(toSec(clip.speed) * 1000) / 10;
  const [speedText, setSpeedText] = useState(String(pct));
  useEffect(() => setSpeedText(String(pct)), [pct]);
  if (!props) return null;
  const commitSpeed = (p: number) => {
    if (!Number.isFinite(p) || p < 10 || p > 1000 || p === pct) return setSpeedText(String(pct));
    void dispatch({ type: "set_clip_speed", clip: clip.id, speed: `${Math.round(p * 10)}/1000` });
  };
  const frozen = clip.freeze !== null;
  const field = (id: string, value: number) => {
    const d = props.params.find((x) => x.id === id)!;
    return <KeyframeField key={id} clip={clip} interps={props.interps} spec={{ param: id, label: d.name, unit: d.unit, min: d.min, max: d.max, step: d.step, value, animatable: true }} />;
  };

  return (
    <div className="effects" aria-label="Video properties">
      <div className="panel-title sub">Transform</div>
      {field("x", clip.transform.x)}
      {field("y", clip.transform.y)}
      {field("scale", clip.transform.scale)}
      {field("rotation", clip.transform.rotation)}
      <p className="muted pad">Pivot is the frame centre. Position/scale/rotation show in a rendered preview or export.</p>
      <div className="panel-title sub">Compositing</div>
      {field("opacity", clip.opacity)}
      <div className="field compact">
        <label>Blend mode</label>
        <select aria-label="Blend mode" value={clip.blend} onChange={(e) => void dispatch({ type: "set_clip_blend", clip: clip.id, blend: e.target.value })}>
          {props.blendModes.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </div>
      <div className="panel-title sub">Timing</div>
      <div className="field compact">
        <label>Speed (%) — linked audio follows; the clip gets shorter/longer</label>
        <div className="row">
          <input aria-label="Speed percent" className="num" type="number" min={10} max={1000} step={5} disabled={frozen} value={speedText}
            onChange={(e) => setSpeedText(e.target.value)} onBlur={(e) => commitSpeed(e.currentTarget.valueAsNumber)} onKeyDown={(e) => { if (e.key === "Enter") commitSpeed(Number((e.target as HTMLInputElement).value)); }} />
          {SPEEDS.map((s) => <button key={s} className="small" disabled={frozen} onClick={() => commitSpeed(s)}>{s}%</button>)}
        </div>
      </div>
      <div className="field compact">
        <label className="check"><input type="checkbox" aria-label="Reverse" checked={clip.reverse} disabled={frozen} onChange={(e) => void dispatch({ type: "set_clip_reverse", clip: clip.id, reverse: e.target.checked })} /> Reverse (video is buffered in memory while rendering)</label>
      </div>
      <div className="field compact">
        {frozen ? (
          <div className="row"><span className="muted grow">Frozen at source {toSec(clip.freeze!).toFixed(2)} s</span><button onClick={() => void dispatch({ type: "set_clip_freeze", clip: clip.id, at: null })}>Unfreeze</button></div>
        ) : (
          <button title="Hold the frame under the playhead for this whole clip (detaches its audio so you can lengthen it)" onClick={() => void dispatch({ type: "set_clip_freeze", clip: clip.id, at: fromSecSafe(sourceTime(clip, usePlayhead.getState().t)) })}>Freeze frame at playhead</button>
        )}
      </div>
    </div>
  );
}

function fromSecSafe(s: number): string {
  return `${Math.round(Math.max(0, s) * 1_000_000)}/1000000`;
}
