import { convertFileSrc } from "@tauri-apps/api/core";
import { useState } from "react";
import { api } from "../api";
import { fromSec, toSec } from "../time";
import { usePlayhead, useProject } from "../state/stores";
import type { Clip, Command, DetectKind, Loudness, SceneAnalysis } from "../types";

const TARGET_LUFS = -14;

/** Cut times (timeline seconds) of detected scene cuts that fall strictly inside `clip`, latest first so successive splits keep the left clip's id. */
export function cutsInsideClip(clip: Clip, cuts: readonly number[], minGap = 0.1): number[] {
  const start = toSec(clip.start), sourceIn = toSec(clip.source_in), dur = toSec(clip.duration);
  return cuts.map((c) => start + (c - sourceIn)).filter((t) => t > start + minGap && t < start + dur - minGap).sort((a, b) => b - a);
}

/** Detected source ranges mapped onto the timeline for `clip` (clamped to the clip), earliest first. */
export function rangesOnTimeline(clip: Clip, ranges: readonly (readonly [number, number])[]): [number, number][] {
  const start = toSec(clip.start), sourceIn = toSec(clip.source_in), end = start + toSec(clip.duration);
  return ranges
    .map(([a, b]) => [Math.max(start, start + (a - sourceIn)), Math.min(end, start + (b - sourceIn))] as [number, number])
    .filter(([a, b]) => b - a > 0.01)
    .sort((x, y) => x[0] - y[0]);
}

const DETECTORS: Record<DetectKind, { label: string; unit: string; value: number; min: number; max: number; step: number }> = {
  silence: { label: "silence", unit: "dB", value: -35, min: -90, max: -5, step: 1 },
  black: { label: "black frames", unit: "pixel level", value: 0.1, min: 0, max: 0.5, step: 0.01 },
  freeze: { label: "frozen frames", unit: "dB", value: -60, min: -90, max: -20, step: 1 },
};

/** Scene detection and loudness for the selected clip: analysis results turn into undoable commands. */
export function AnalysisPanel({ video, audio }: { video?: Clip; audio?: Clip }) {
  const dispatch = useProject((s) => s.dispatch);
  const toast = useProject((s) => s.toast);
  const [scenes, setScenes] = useState<SceneAnalysis | null>(null);
  const [loud, setLoud] = useState<Loudness | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(27);
  const [kind, setKind] = useState<DetectKind>("silence");
  const [level, setLevel] = useState<Record<DetectKind, number>>({ silence: -35, black: 0.1, freeze: -60 });
  const [minLen, setMinLen] = useState(0.5);
  const [found, setFound] = useState<{ kind: DetectKind; ranges: [number, number][] } | null>(null);

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

  const view = useProject((s) => s.view);
  const [scope, setScope] = useState<"waveform" | "vectorscope" | "histogram" | "spectrogram">("waveform");
  const [scopeImg, setScopeImg] = useState<string | null>(null);
  const showScope = async () => {
    const c = scope === "spectrogram" ? audio ?? video : video ?? audio;
    if (!c) return;
    // source time under the playhead (clamped into the clip), ignoring speed changes
    const t = usePlayhead.getState().t;
    const src = Math.max(0, toSec(c.source_in) + Math.min(Math.max(t - toSec(c.start), 0), toSec(c.duration)) * toSec(c.speed));
    setScopeImg(convertFileSrc(await api.renderScope(c.media, src, scope)));
  };
  const [syncRef, setSyncRef] = useState("");
  const [sync, setSync] = useState<{ lag: number; confidence: number; start: number } | null>(null);
  const others = audio ? (view?.project.sequences[0]?.tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips).filter((c) => c.id !== audio.id) ?? []) : [];
  const target = kind === "silence" ? audio ?? video : video ?? audio;
  const markRanges = () => {
    if (!target || !found) return;
    const onTl = rangesOnTimeline(target, found.ranges);
    if (!onTl.length) return toast("info", "Nothing found inside this clip");
    const commands: Command[] = onTl.map(([a, b]) => ({ type: "add_marker", time: fromSec(a), name: `${found.kind} ${(b - a).toFixed(1)}s`, color: null, note: null }));
    void dispatch({ type: "batch", label: `Mark ${onTl.length} ${found.kind} ranges`, commands });
  };
  const cutRanges = () => {
    if (!target || !found) return;
    const onTl = rangesOnTimeline(target, found.ranges);
    if (!onTl.length) return toast("info", "Nothing found inside this clip");
    void dispatch({ type: "remove_ranges", clip: target.id, ranges: onTl.map(([a, b]) => [fromSec(a), fromSec(b)] as [ReturnType<typeof fromSec>, ReturnType<typeof fromSec>]) });
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
      {(video || audio) && (
        <div className="field" aria-label="Find silence, black or frozen frames">
          <label>Find</label>
          <div className="row">
            <select aria-label="Detector" value={kind} onChange={(e) => { setKind(e.target.value as DetectKind); setFound(null); }}>
              {(Object.keys(DETECTORS) as DetectKind[]).map((k) => <option key={k} value={k}>{DETECTORS[k].label}</option>)}
            </select>
            <input aria-label="Detection level" className="num" type="number" min={DETECTORS[kind].min} max={DETECTORS[kind].max} step={DETECTORS[kind].step} value={level[kind]} onChange={(e) => setLevel({ ...level, [kind]: Number(e.target.value) })} title={`Level (${DETECTORS[kind].unit})`} />
            <input aria-label="Minimum length" className="num" type="number" min={0.1} max={60} step={0.1} value={minLen} onChange={(e) => setMinLen(Number(e.target.value))} title="Shortest range to report (seconds)" />
          </div>
          <button disabled={busy !== null || !target} onClick={() => target && void run("find", async () => setFound({ kind, ranges: await api.detectRanges(target.media, kind, level[kind], minLen) }))}>{busy === "find" ? "Searching…" : `Find ${DETECTORS[kind].label}`}</button>
          {found && (
            <>
              <p className="muted" data-testid="range-summary">{found.ranges.length} ranges · {found.ranges.slice(0, 6).map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)}`).join(", ")}{found.ranges.length > 6 ? "…" : ""} s</p>
              <button onClick={markRanges} title="Put a marker at the start of every range (one undo step)">Mark ranges</button>
              <button onClick={cutRanges} title="Cut every range out of this clip and its linked clips and close the gaps (one undo step)">Cut ranges out</button>
            </>
          )}
        </div>
      )}
      {(video || audio) && (
        <div className="field" aria-label="Scopes">
          <label>Scopes</label>
          <div className="row">
            <select aria-label="Scope type" value={scope} onChange={(e) => { setScope(e.target.value as typeof scope); setScopeImg(null); }}>
              <option value="waveform">Waveform</option>
              <option value="vectorscope">Vectorscope</option>
              <option value="histogram">Histogram</option>
              <option value="spectrogram">Audio spectrogram</option>
            </select>
            <button disabled={busy !== null} title="Draw it for the picture under the playhead (the spectrogram covers the whole file)" onClick={() => void run("scope", showScope)}>{busy === "scope" ? "Drawing…" : "Show"}</button>
          </div>
          {scopeImg && <img data-testid="scope-image" alt={`${scope} of the selected clip`} src={scopeImg} style={{ width: "100%", imageRendering: "auto", background: "#000" }} />}
        </div>
      )}
      {audio && others.length > 0 && (
        <div className="field" aria-label="Auto-sync">
          <label>Auto-sync to</label>
          <div className="row">
            <select aria-label="Reference clip" value={syncRef} onChange={(e) => { setSyncRef(e.target.value); setSync(null); }}>
              <option value="">choose a clip…</option>
              {others.map((c) => <option key={c.id} value={c.id}>{c.name} @ {toSec(c.start).toFixed(1)} s</option>)}
            </select>
            <button disabled={busy !== null || !syncRef} onClick={() => void run("sync", async () => setSync(await api.syncOffset(syncRef, audio.id)))}>{busy === "sync" ? "Matching…" : "Match"}</button>
          </div>
          {sync && (
            <>
              <p className="muted" data-testid="sync-summary">{sync.lag >= 0 ? "later" : "earlier"} by {Math.abs(sync.lag).toFixed(3)} s · confidence {(sync.confidence * 100).toFixed(0)}%{sync.confidence < 0.1 ? " (weak: the recordings may not share sound)" : ""}</p>
              <button onClick={() => void dispatch({ type: "move_clip", clip: audio.id, start: fromSec(sync.start) })} title="Move this clip (and its linked video) so both recordings line up">Move into sync</button>
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
