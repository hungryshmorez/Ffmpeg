import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { fpsOf, timecode, toSec } from "../time";
import { clipAt, dbToGain, sourceTime, times, visibleVideoAt } from "../timeline/math";
import { clipGainDb } from "../timeline/mixer";
import { usePlayhead, useProject, useUi } from "../state/stores";
import { fromSec } from "../time";
import { hasMotion } from "../keyframes";
import type { Sequence, Track } from "../types";

/** Keeps a media element's src/time/volume in step with the timeline clock. */
function useSyncedElement(ref: React.RefObject<HTMLMediaElement | null>, url: string | null, mediaTime: number, playing: boolean, volume: number, muted: boolean, rate = 1) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!url) {
      if (!el.paused) el.pause();
      return;
    }
    if (el.dataset.src !== url) {
      el.src = url;
      el.dataset.src = url;
    }
    el.volume = Math.max(0, Math.min(1, volume));
    el.muted = muted;
    el.playbackRate = rate;
    const drift = Math.abs(el.currentTime - mediaTime);
    if (!playing) {
      if (drift > 0.02) el.currentTime = mediaTime;
      if (!el.paused) el.pause();
    } else {
      if (drift > 0.25) el.currentTime = mediaTime;
      if (el.paused) void el.play().catch(() => undefined);
    }
  });
}

function AudioLane({ track, seq, t, playing, silenced, anySolo }: { track: Track; seq: Sequence; t: number; playing: boolean; silenced: boolean; anySolo: boolean }) {
  const view = useProject((s) => s.view)!;
  const ref = useRef<HTMLAudioElement>(null);
  const clip = clipAt(track, t);
  const media = clip ? view.project.media.find((m) => m.id === clip.media) : undefined;
  const url = clip && media && !silenced ? convertFileSrc(media.path) : null;
  // Preview volume cannot exceed unity; export applies the full gain.
  const vol = clip ? dbToGain(clipGainDb(clip, t - toSec(clip.start)) + track.gain_db) : 0;
  useSyncedElement(ref, url, clip ? sourceTime(clip, t) : 0, playing, vol, track.muted || (anySolo && !track.solo), clip && !clip.reverse ? toSec(clip.speed) : 1);
  void seq;
  return <audio ref={ref} preload="auto" />;
}

export function Monitor() {
  const view = useProject((s) => s.view)!;
  const seq = view.project.sequences.find((s) => s.id === view.project.active_sequence)!;
  const fps = fpsOf(view.project.settings.fps);
  const t = usePlayhead((s) => s.t);
  const playing = usePlayhead((s) => s.playing);
  const duration = toSec(view.duration);
  const loop = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const vis = visibleVideoAt(seq, t);
  const media = vis ? view.project.media.find((m) => m.id === vis.clip.media) : undefined;

  // A processed preview is only used while it matches the project's current content hash and covers the playhead.
  const preview = useUi((s) => s.preview);
  const busy = useUi((s) => s.previewBusy);
  const [div, setDiv] = useState(2);
  const previewCurrent = preview !== null && preview.renderHash === view.renderHash;
  const usePreview = previewCurrent && t >= toSec(preview.start) && t < toSec(preview.end);
  const videoUrl = usePreview ? convertFileSrc(preview.path) : vis && media && !media.generator ? convertFileSrc(media.path) : null;
  const videoTime = usePreview ? t - toSec(preview.start) : vis ? sourceTime(vis.clip, t) : 0;
  // The preview file carries the mixed audio, so it plays unmuted and the per-track source audio is silenced.
  useSyncedElement(videoRef, videoUrl, videoTime, playing, 1, !usePreview, usePreview || !vis || vis.clip.reverse || vis.clip.freeze ? 1 : toSec(vis.clip.speed));

  const renderPreview = async () => {
    const dur = toSec(view.duration);
    if (dur <= 0) return useProject.getState().toast("error", "Nothing on the timeline to preview");
    const span = 10;
    const start = Math.max(0, Math.min(t, dur - span));
    useUi.getState().setPreviewBusy(true);
    try {
      useUi.getState().setPreview(await api.renderPreview(fromSec(start), fromSec(Math.min(dur, start + span)), div));
    } catch (e) {
      useProject.getState().toast("error", `Preview failed: ${e}`);
    } finally {
      useUi.getState().setPreviewBusy(false);
    }
  };
  const c0 = vis?.clip;
  const audioActive = seq.tracks.some((tr) => tr.kind === "audio" && !tr.muted && ((clipAt(tr, t)?.effects.some((e) => e.enabled) ?? false) || tr.pan !== 0 || (() => { const c = clipAt(tr, t); return !!c && (c.pan !== 0 || toSec(c.fade_in) > 0 || toSec(c.fade_out) > 0); })()));
  const effectsActive = audioActive || !!c0 && (c0.opacity < 1 || c0.effects.some((e) => e.enabled) || c0.blend !== "normal" || c0.speed !== "1" || c0.reverse || c0.freeze !== null || hasMotion(c0.keyframes) || c0.transform.x !== 0 || c0.transform.y !== 0 || c0.transform.scale !== 1 || c0.transform.rotation !== 0);

  // Playback clock: wall-clock driven so audio/video drift is corrected against it, not the other way round.
  const durRef = useRef(duration);
  durRef.current = duration;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const next = usePlayhead.getState().t + dt;
      if (next >= durRef.current) {
        if (loop.current && durRef.current > 0) usePlayhead.getState().setT(0);
        else {
          usePlayhead.getState().setT(durRef.current);
          usePlayhead.getState().setPlaying(false);
          return;
        }
      } else usePlayhead.getState().setT(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const edges = () => {
    const pts = new Set<number>([0, duration]);
    for (const tr of seq.tracks) for (const c of tr.clips) { const x = times(c); pts.add(x.start); pts.add(x.end); }
    return [...pts].sort((a, b) => a - b);
  };
  const step = (frames: number) => usePlayhead.getState().setT(Math.max(0, Math.round(usePlayhead.getState().t * fps) / fps + frames / fps));
  const prevEdit = () => { const e = edges().filter((x) => x < t - 1e-6); usePlayhead.getState().setT(e.length ? (e[e.length - 1] as number) : 0); };
  const nextEdit = () => { const e = edges().find((x) => x > t + 1e-6); usePlayhead.getState().setT(e ?? duration); };

  const { width, height } = view.project.settings;
  const audioTracks = seq.tracks.filter((x) => x.kind === "audio");
  const anySolo = audioTracks.some((x) => x.solo && !x.muted);
  return (
    <div className="monitor" aria-label="Program monitor">
      <div className="monitor-screen" style={{ aspectRatio: `${width} / ${height}` }}>
        <video ref={videoRef} playsInline preload="auto" style={{ visibility: vis || usePreview ? "visible" : "hidden" }} />
        {vis && media?.generator && !usePreview && <div className="gap-label">Generated clip ({vis.clip.title ? "title" : "solid colour"}) — render a preview to see it</div>}
        {!vis && !usePreview && <div className="gap-label">{seq.tracks.some((x) => x.clips.length) ? "no video at playhead" : "Import media and add it to the timeline"}</div>}
        {usePreview && <div className="bypass-badge ok" role="status">Processed preview · 1/{preview.scaleDiv} resolution</div>}
        {!usePreview && preview !== null && !previewCurrent && <div className="bypass-badge" role="status">Preview out of date — render again</div>}
        {!usePreview && effectsActive && (preview === null || previewCurrent) && <div className="bypass-badge" role="status">Effects, transform, retiming, pan and fades bypassed — render a preview or export to hear/see them</div>}
        <div className="monitor-note">Source preview — edit decisions only (cuts, gaps, volume, mute). Effects, opacity, transform, blend and retiming appear only in a rendered preview; export is the authoritative render.</div>
      </div>
      {audioTracks.map((tr) => <AudioLane key={tr.id} track={tr} seq={seq} t={t} playing={playing} silenced={usePreview} anySolo={anySolo} />)}
      <div className="transport" role="toolbar" aria-label="Transport">
        <span className="timecode" aria-live="off">{timecode(t, fps)}</span>
        <button title="Previous edit" onClick={prevEdit}>⏮</button>
        <button title="Previous frame (←)" onClick={() => step(-1)}>◂</button>
        <button title={playing ? "Pause (Space)" : "Play (Space)"} className="primary" onClick={() => usePlayhead.getState().setPlaying(!playing)}>{playing ? "⏸" : "▶"}</button>
        <button title="Stop" onClick={() => { usePlayhead.getState().setPlaying(false); usePlayhead.getState().setT(0); }}>⏹</button>
        <button title="Next frame (→)" onClick={() => step(1)}>▸</button>
        <button title="Next edit" onClick={nextEdit}>⏭</button>
        <label className="check"><input type="checkbox" onChange={(e) => (loop.current = e.target.checked)} /> Loop</label>
        <span className="timecode dim">{timecode(duration, fps)}</span>
        <span className="sep" />
        <select aria-label="Preview quality" value={div} onChange={(e) => setDiv(Number(e.target.value))}>
          <option value={1}>Full</option><option value={2}>1/2</option><option value={4}>1/4</option><option value={8}>1/8</option>
        </select>
        <button disabled={busy} onClick={() => void renderPreview()} title="Render a processed preview of the next 10 seconds from the playhead">{busy ? "Rendering preview…" : "Render preview"}</button>
      </div>
    </div>
  );
}
