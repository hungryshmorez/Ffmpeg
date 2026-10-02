import { fromSec, toSec } from "../time";
import { useProject } from "../state/stores";
import type { Clip } from "../types";
import { CommitSlider } from "./CommitSlider";
import { EffectsPanel } from "./EffectsPanel";
import { KeyframeField } from "./KeyframeField";
import { useClipProps } from "./ClipPropsPanel";

/** Volume (with envelope keyframes), balance, fades and audio effects for an audio clip. Everything is a command. */
export function AudioPanel({ audio }: { audio: Clip }) {
  const props = useClipProps();
  const dispatch = useProject((s) => s.dispatch);
  const dur = toSec(audio.duration);
  const maxFade = Math.max(0.04, Math.min(30, dur));
  const animated = (audio.keyframes["gain_db"]?.length ?? 0) > 0;
  const nudge = (db: number) => void dispatch({ type: "set_clip_gain", clip: audio.id, gain_db: db, relative: true });
  return (
    <div className="effects" aria-label="Audio properties">
      <div className="panel-title sub">Audio</div>
      {props && (
        <KeyframeField
          clip={audio}
          interps={props.interps}
          spec={{ param: "gain_db", label: "Volume", unit: "dB", min: -60, max: 12, step: 0.5, value: audio.gain_db, animatable: true }}
        />
      )}
      {!animated && (
        <div className="row pad">
          <button className="small" onClick={() => nudge(-1)}>−1 dB</button>
          <button className="small" onClick={() => nudge(1)}>+1 dB</button>
          <button className="small" onClick={() => void dispatch({ type: "set_clip_gain", clip: audio.id, gain_db: 0, relative: false })}>Reset</button>
        </div>
      )}
      <CommitSlider label="Pan (balance)" value={audio.pan} min={-1} max={1} step={0.05} onCommit={(v) => void dispatch({ type: "set_clip_param", clip: audio.id, param: "pan", value: v })} />
      <CommitSlider label="Fade in" unit="s" value={Number(toSec(audio.fade_in).toFixed(3))} min={0} max={maxFade} step={0.04} onCommit={(v) => void dispatch({ type: "set_clip_fades", clip: audio.id, fade_in: fromSec(v) })} />
      <CommitSlider label="Fade out" unit="s" value={Number(toSec(audio.fade_out).toFixed(3))} min={0} max={maxFade} step={0.04} onCommit={(v) => void dispatch({ type: "set_clip_fades", clip: audio.id, fade_out: fromSec(v) })} />
      <p className="muted pad">Pan, fades and effects are heard in a rendered preview or export. Source playback applies volume and mute/solo only.</p>
      <EffectsPanel clip={audio} />
    </div>
  );
}
