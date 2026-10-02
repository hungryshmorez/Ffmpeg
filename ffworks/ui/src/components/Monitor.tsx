import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { fpsOf, timecode, toSec } from "../time";
import { clipAt, dbToGain, sourceTime, times, visibleVideoAt } from "../timeline/math";
import { usePlayhead, useProject } from "../state/stores";
import type { Sequence, Track } from "../types";

/** Keeps a media element's src/time/volume in step with the timeline clock. */
function useSyncedElement(ref: React.RefObject<HTMLMediaElement | null>, url: string | null, mediaTime: number, playing: boolean, volume: number, muted: boolean) {
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

function AudioLane({ track, seq, t, playing }: { track: Track; seq: Sequence; t: number; playing: boolean }) {
  const view = useProject((s) => s.view)!;
  const ref = useRef<HTMLAudioElement>(null);
  const clip = clipAt(track, t);
  const media = clip ? view.project.media.find((m) => m.id === clip.media) : undefined;
  const url = clip && media ? convertFileSrc(media.path) : null;
  // Preview volume cannot exceed unity; export applies the full gain.
  const vol = clip ? dbToGain(clip.gain_db + track.gain_db) : 0;
  useSyncedElement(ref, url, clip ? sourceTime(clip, t) : 0, playing, vol, track.muted);
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
  useSyncedElement(videoRef, vis && media ? convertFileSrc(media.path) : null, vis ? sourceTime(vis.clip, t) : 0, playing, 0, true);

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
  return (
    <div className="monitor" aria-label="Program monitor">
      <div className="monitor-screen" style={{ aspectRatio: `${width} / ${height}` }}>
        <video ref={videoRef} muted playsInline preload="auto" style={{ visibility: vis ? "visible" : "hidden" }} />
        {!vis && <div className="gap-label">{seq.tracks.some((x) => x.clips.length) ? "no video at playhead" : "Import media and add it to the timeline"}</div>}
        <div className="monitor-note">Source preview — edit decisions only (cuts, gaps, volume, mute). No effects exist in this build; export is the authoritative render.</div>
      </div>
      {audioTracks.map((tr) => <AudioLane key={tr.id} track={tr} seq={seq} t={t} playing={playing} />)}
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
      </div>
    </div>
  );
}
