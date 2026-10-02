import { useState } from "react";
import { api } from "../api";
import { fromSec, toSec } from "../time";
import { useProject } from "../state/stores";
import type { Clip, Command, Loudness, SceneAnalysis } from "../types";

const TARGET_LUFS = -14;

/** Cut times (timeline seconds) of detected scene cuts that fall strictly inside `clip`, latest first so successive splits keep the left clip's id. */
export function cutsInsideClip(clip: Clip, cuts: readonly number[], minGap = 0.1): number[] {
  const start = toSec(clip.start), sourceIn = toSec(clip.source_in), dur = toSec(clip.duration);
  return cuts.map((c) => start + (c - sourceIn)).filter((t) => t > start + minGap && t < start + dur - minGap).sort((a, b) => b - a);
}

/** Scene detection and loudness for the selected clip: analysis results turn into undoable commands. */
export function AnalysisPanel({ video, audio }: { video?: Clip; audio?: Clip }) {
  const dispatch = useProject((s) => s.dispatch);
  const toast = useProject((s) => s.toast);
  const [scenes, setScenes] = useState<SceneAnalysis | null>(null);
  const [loud, setLoud] = useState<Loudness | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(27);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try { await fn(); } catch (e) { toast("error", String(e)); } finally { setBusy(null); }
  };
  const splitAtScenes = () => {
    if (!video || !scenes) return;
    const times = cutsInsideClip(video, scenes.cuts);
    if (!times.length) return toast("info", "No scene cuts inside this clip");
    const commands: Command[] = times.map((t) => ({ type: "split_clip", clip: video.id, at: fromSec(t) }));
    void dispatch({ type: "batch", label: `Split at ${times.length} scene cuts`, commands });
  };

  return (
    <div className="effects" aria-label="Analysis">
      <div className="panel-title sub">Analysis</div>
      {video && (
        <div className="field">
          <label>Scenes</label>
          <div className="row">
            <input aria-label="Scene sensitivity" className="num" type="number" min={5} max={60} step={1} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} title="Content score threshold: lower = more cuts" />
            <button disabled={busy !== null} onClick={() => void run("scenes", async () => setScenes(await api.detectScenes(video.media, threshold)))}>{busy === "scenes" ? "Detecting…" : "Detect scenes"}</button>
          </div>
          {scenes && (
            <>
              <p className="muted" data-testid="scene-summary">{scenes.scenes.length} scenes · cuts at {scenes.cuts.map((c) => c.toFixed(2)).join(", ") || "—"} s</p>
              <button onClick={splitAtScenes} title="Split this clip at the detected cuts (one undo step)">Split clip at scene cuts</button>
            </>
          )}
        </div>
      )}
      {audio && (
        <div className="field">
          <label>Loudness</label>
          <button disabled={busy !== null} onClick={() => void run("loud", async () => setLoud(await api.measureLoudness(audio.media)))}>{busy === "loud" ? "Measuring…" : "Measure loudness"}</button>
          {loud && (
            <>
              <p className="muted" data-testid="loudness-summary">{loud.integrated_lufs == null ? "silent" : `${loud.integrated_lufs.toFixed(1)} LUFS`} · range {loud.range_lu.toFixed(1)} LU · true peak {loud.true_peak_dbtp == null ? "—" : `${loud.true_peak_dbtp.toFixed(1)} dBTP`}</p>
              {loud.integrated_lufs != null && (
                <button onClick={() => void dispatch({ type: "set_clip_gain", clip: audio.id, gain_db: Math.round((TARGET_LUFS - loud.integrated_lufs! + audio.gain_db) * 10) / 10, relative: false })} title={`Set this clip's gain so the whole source measures ${TARGET_LUFS} LUFS`}>Normalize to {TARGET_LUFS} LUFS</button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
