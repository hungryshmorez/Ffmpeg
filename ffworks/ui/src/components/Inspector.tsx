import { fpsOf, timecode, toSec } from "../time";
import { findClip, linkedIds, times } from "../timeline/math";
import { useProject, useUi } from "../state/stores";
import { CommitSlider } from "./CommitSlider";
import { EffectsPanel } from "./EffectsPanel";

export function Inspector() {
  const view = useProject((s) => s.view)!;
  const dispatch = useProject((s) => s.dispatch);
  const selected = useUi((s) => s.selected);
  const seq = view.project.sequences.find((s) => s.id === view.project.active_sequence)!;
  const fps = fpsOf(view.project.settings.fps);
  const found = selected ? findClip(seq, selected) : null;

  if (!found) {
    return (
      <div className="panel inspector" aria-label="Inspector">
        <div className="panel-title">Inspector</div>
        <p className="muted pad">Select a clip to edit its properties.</p>
        <dl className="metadata">
          <div><dt>Project</dt><dd>{view.project.name}</dd></div>
          <div><dt>Resolution</dt><dd>{view.project.settings.width}×{view.project.settings.height}</dd></div>
          <div><dt>Frame rate</dt><dd>{view.project.settings.fps} ({toSec(view.project.settings.fps).toFixed(3)} fps)</dd></div>
          <div><dt>Sample rate</dt><dd>{view.project.settings.sample_rate} Hz</dd></div>
        </dl>
      </div>
    );
  }
  const { clip, track } = found;
  const t = times(clip);
  // Volume lives on the audio clip; a selected video clip edits its linked audio.
  const audioId = clip.kind === "audio" ? clip.id : linkedIds(seq, clip.id).find((id) => findClip(seq, id)?.clip.kind === "audio");
  const audio = audioId ? findClip(seq, audioId)?.clip : undefined;
  const gain = audio?.gain_db ?? 0;
  const set = (db: number, relative = false) => audio && dispatch({ type: "set_clip_gain", clip: audio.id, gain_db: db, relative });

  const videoClip = clip.kind === "video" ? clip : linkedIds(seq, clip.id).map((id) => findClip(seq, id)?.clip).find((c) => c?.kind === "video");
  return (
    <div className="panel inspector" aria-label="Inspector">
      <div className="panel-title">Inspector</div>
      <dl className="metadata">
        <div><dt>Clip</dt><dd>{clip.name}</dd></div>
        <div><dt>Track</dt><dd>{track.name}</dd></div>
        <div><dt>Start</dt><dd>{timecode(t.start, fps)}</dd></div>
        <div><dt>End</dt><dd>{timecode(t.end, fps)}</dd></div>
        <div><dt>Duration</dt><dd>{timecode(t.duration, fps)}</dd></div>
        <div><dt>Source in</dt><dd>{timecode(t.sourceIn, fps)}</dd></div>
        <div><dt>Linked</dt><dd>{clip.link ? `${linkedIds(seq, clip.id).length} clips` : "no"}</dd></div>
      </dl>
      <div className="field">
        <label>{clip.kind === "video" ? "Audio (linked clip)" : "Audio"}</label>
        {audio ? (
          <>
            <CommitSlider label="Volume" unit="dB" value={gain} min={-60} max={12} step={0.5} onCommit={(v) => set(v)} />
            <div className="row">
              <button className="small" onClick={() => set(-1, true)}>−1 dB</button>
              <button className="small" onClick={() => set(1, true)}>+1 dB</button>
              <button className="small" onClick={() => set(0)}>Reset</button>
            </div>
          </>
        ) : (
          <p className="muted">This clip has no audio.</p>
        )}
      </div>
      {videoClip && <EffectsPanel clip={videoClip} />}
    </div>
  );
}
