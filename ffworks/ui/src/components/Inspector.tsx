import { fpsOf, timecode, toSec } from "../time";
import { findClip, linkedIds, times } from "../timeline/math";
import { useAnalysis } from "../state/analysis";
import { useProject, useUi } from "../state/stores";
import { AudioPanel } from "./AudioPanel";
import { MarkerPanel } from "./MarkerPanel";
import { ClipPropsPanel } from "./ClipPropsPanel";
import { SolidPanel, TitlePanel } from "./GeneratedPanel";
import { EffectsPanel } from "./EffectsPanel";
import { TransitionPanel } from "./TransitionPanel";
import { AnalysisPanel } from "./AnalysisPanel";

export function Inspector() {
  const beats = useAnalysis((s) => s.beats);
  const ensureBeats = useAnalysis((s) => s.ensureBeats);
  const view = useProject((s) => s.view)!;
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
        <MarkerPanel seq={seq} />
      </div>
    );
  }
  const { clip, track } = found;
  const t = times(clip);
  // Volume lives on the audio clip; a selected video clip edits its linked audio.
  const audioId = clip.kind === "audio" ? clip.id : linkedIds(seq, clip.id).find((id) => findClip(seq, id)?.clip.kind === "audio");
  const audio = audioId ? findClip(seq, audioId)?.clip : undefined;

  const mediaOf = (c?: typeof clip) => (c ? view.project.media.find((m) => m.id === c.media) : undefined);
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
        {(t.speed !== 1 || clip.reverse || clip.freeze) && <div><dt>Timing</dt><dd>{clip.freeze ? "frozen frame" : `${Math.round(t.speed * 1000) / 10}%${clip.reverse ? " reversed" : ""}`}</dd></div>}
        <div><dt>Linked</dt><dd>{clip.link ? `${linkedIds(seq, clip.id).length} clips` : "no"}</dd></div>
      </dl>
      {audio ? <AudioPanel audio={audio} /> : <div className="field"><label>Audio</label><p className="muted">This clip has no audio.</p></div>}
      {audio && (
        <div className="field">
          <label>Beats</label>
          {(() => {
            const b = beats[audio.media];
            if (typeof b === "object") return <p className="muted" data-testid="beat-summary">{b.beats.length} beats · {b.bpm ? `${b.bpm} BPM` : "BPM unclear"} (ticks shown on the audio clip; enable “Snap to beats” in the timeline)</p>;
            if (b === "loading") return <p className="muted">Detecting beats…</p>;
            return <button onClick={() => ensureBeats(audio.media)}>{b === "failed" ? "Detection failed — retry" : "Detect beats"}</button>;
          })()}
        </div>
      )}
      {videoClip?.title && <TitlePanel clip={videoClip} />}
      {videoClip && !videoClip.title && mediaOf(videoClip)?.generator && <SolidPanel clip={videoClip} media={mediaOf(videoClip)!} />}
      <AnalysisPanel video={mediaOf(videoClip)?.info.still ? undefined : videoClip} audio={audio} />
      {videoClip && <TransitionPanel clip={videoClip} track={findClip(seq, videoClip.id)!.track} seq={seq} />}
      {videoClip && <ClipPropsPanel clip={videoClip} />}
      {videoClip && <EffectsPanel clip={videoClip} />}
    </div>
  );
}
