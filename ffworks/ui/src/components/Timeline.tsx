import { memo, useCallback, useEffect, useRef, useState } from "react";
import { fpsOf, fromSec, snapToFrame, timecode, toSec } from "../time";
import { beatPoints, dbToGain, linkedIds, snap, snapPoints, tickStep, times } from "../timeline/math";
import { useAnalysis } from "../state/analysis";
import { usePlayhead, useProject, useUi } from "../state/stores";
import type { Clip, Sequence, Track, Transition } from "../types";

const HEADER_W = 132;
const ROW_H: Record<string, number> = { video: 54, audio: 48 };
const RULER_H = 26;

/** Displayed top-to-bottom: video tracks with the highest layer first, then audio tracks. */
export function displayTracks(seq: Sequence): Track[] {
  return [...seq.tracks.filter((t) => t.kind === "video").reverse(), ...seq.tracks.filter((t) => t.kind === "audio")];
}

export function Timeline() {
  const view = useProject((s) => s.view)!;
  const seq = view.project.sequences.find((s) => s.id === view.project.active_sequence)!;
  const fps = fpsOf(view.project.settings.fps);
  const px = useUi((s) => s.pxPerSec);
  const setZoom = useUi((s) => s.setZoom);
  const snapBeats = useUi((s) => s.snapBeats);
  const setSnapBeats = useUi((s) => s.setSnapBeats);
  const dispatch = useProject((s) => s.dispatch);
  const duration = toSec(view.duration);
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = Math.max(duration + 15, 30) * px;

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      setZoom(px * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    }
  };

  const scrub = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - HEADER_W;
      usePlayhead.getState().setT(snapToFrame(Math.max(0, x / px), fps));
    },
    [px, fps],
  );

  const tracks = displayTracks(seq);
  return (
    <div className="timeline" aria-label="Timeline">
      <div className="timeline-bar">
        <span className="muted">Zoom</span>
        <input aria-label="Timeline zoom" type="range" min={4} max={600} value={px} onChange={(e) => setZoom(Number(e.target.value))} />
        <button title="Add video track" onClick={() => dispatch({ type: "add_track", kind: "video" })}>+ Video track</button>
        <button title="Add audio track" onClick={() => dispatch({ type: "add_track", kind: "audio" })}>+ Audio track</button>
        <label className="check" title="Snap clip edges and the playhead to detected beats (detect beats in the Inspector first)"><input type="checkbox" checked={snapBeats} onChange={(e) => setSnapBeats(e.target.checked)} /> Snap to beats</label>
        <span className="muted right">Space play · S split · Del delete · ⇧Del ripple · ←/→ frame · Ctrl+wheel zoom</span>
      </div>
      <div className="timeline-scroll" ref={scrollRef} onWheel={onWheel}>
        <div className="timeline-inner" style={{ width: width + HEADER_W }}>
          <Ruler px={px} width={width} fps={fps} onScrub={scrub} />
          {tracks.map((t) => (
            <TrackRow key={t.id} seq={seq} track={t} px={px} fps={fps} width={width} />
          ))}
          <PlayheadLine px={px} height={RULER_H + tracks.reduce((h, t) => h + (ROW_H[t.kind] ?? 48), 0)} />
        </div>
      </div>
    </div>
  );
}

function Ruler({ px, width, fps, onScrub }: { px: number; width: number; fps: number; onScrub: (x: number) => void }) {
  const step = tickStep(px);
  const ticks: number[] = [];
  for (let t = 0; t * px <= width; t += step) ticks.push(t);
  const dragging = useRef(false);
  return (
    <div
      className="ruler"
      style={{ height: RULER_H, paddingLeft: HEADER_W }}
      onPointerDown={(e) => {
        dragging.current = true;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
        onScrub(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && onScrub(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
    >
      <div className="ruler-corner" style={{ width: HEADER_W }} />
      {ticks.map((t) => (
        <div key={t} className="tick" style={{ left: HEADER_W + t * px }}>
          <span>{timecode(t, fps)}</span>
        </div>
      ))}
    </div>
  );
}

function PlayheadLine({ px, height }: { px: number; height: number }) {
  const t = usePlayhead((s) => s.t);
  return <div className="playhead" style={{ left: HEADER_W + t * px, height }} aria-hidden />;
}

function TrackRow({ seq, track, px, fps, width }: { seq: Sequence; track: Track; px: number; fps: number; width: number }) {
  const dispatch = useProject((s) => s.dispatch);
  const h = ROW_H[track.kind] ?? 48;
  return (
    <div className={`track ${track.kind}`} style={{ height: h }}>
      <div className="track-header" style={{ width: HEADER_W }}>
        <strong>{track.name}</strong>
        <button
          aria-pressed={track.muted}
          title={track.kind === "video" ? "Hide track" : "Mute track"}
          className={track.muted ? "on" : ""}
          onClick={() => dispatch({ type: "set_track", track: track.id, muted: !track.muted })}
        >
          {track.kind === "video" ? "👁" : "M"}
        </button>
        {track.kind === "audio" && (
          <button aria-pressed={track.solo} title="Solo track" className={track.solo ? "on" : ""} onClick={() => dispatch({ type: "set_track", track: track.id, solo: !track.solo })}>S</button>
        )}
        <button aria-pressed={track.locked} title="Lock track" className={track.locked ? "on" : ""} onClick={() => dispatch({ type: "set_track", track: track.id, locked: !track.locked })}>
          🔒
        </button>
      </div>
      <div className="track-clips" data-track-id={track.id} data-track-kind={track.kind} style={{ width, marginLeft: HEADER_W, opacity: track.muted ? 0.45 : 1 }}>
        {track.transitions.map((t) => <TransitionMark key={t.id} t={t} track={track} px={px} />)}
        {track.clips.map((c) => (
          <ClipView key={c.id} clip={c} track={track} seq={seq} px={px} fps={fps} height={h - 4} />
        ))}
      </div>
    </div>
  );
}

type DragMode = "move" | "trim-start" | "trim-end";

const ClipView = memo(
  function ClipView({ clip, track, seq, px, fps, height }: { clip: Clip; track: Track; seq: Sequence; px: number; fps: number; height: number }) {
    const selected = useUi((s) => s.selected);
    const select = useUi((s) => s.select);
    const dispatch = useProject((s) => s.dispatch);
    const { start, duration, sourceIn, speed } = times(clip);
    const [ghost, setGhost] = useState<{ start: number; duration: number; sourceIn: number } | null>(null);
    const group = linkedIds(seq, clip.id);
    const isSel = selected !== null && group.includes(selected);

    const begin = (mode: DragMode) => (e: React.PointerEvent) => {
      e.stopPropagation();
      select(clip.id);
      if (track.locked || e.button !== 0) return;
      const el = e.currentTarget as HTMLElement;
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointers have no capture */ }
      const x0 = e.clientX;
      const exclude = new Set(group);
      const pts = snapPoints(seq, usePlayhead.getState().t, exclude);
      if (useUi.getState().snapBeats) {
        const byMedia: Record<string, number[] | undefined> = {};
        for (const [id, v] of Object.entries(useAnalysis.getState().beats)) if (typeof v === "object") byMedia[id] = v.beats;
        pts.push(...beatPoints(seq, byMedia, exclude));
      }
      const thr = 8 / px;
      let current = { start, duration, sourceIn };
      let moved = false;
      let targetTrack: string | null = null;
      const onMove = (ev: PointerEvent) => {
        const dx = (ev.clientX - x0) / px;
        if (Math.abs(ev.clientX - x0) > 2) moved = true;
        if (mode === "move") {
          let s = Math.max(0, start + dx);
          // snap either edge of the clip; an edge that found a snap point beats one that did not
          const a = snap(s, pts, thr);
          const b = snap(s + duration, pts, thr) - duration;
          const aSnapped = a !== s;
          const bSnapped = b !== s;
          if (aSnapped && bSnapped) s = Math.abs(a - s) <= Math.abs(b - s) ? a : b;
          else if (aSnapped) s = a;
          else if (bSnapped) s = b;
          current = { start: Math.max(0, snapToFrame(s, fps)), duration, sourceIn };
          const under = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => (n as HTMLElement).dataset?.trackKind === track.kind) as HTMLElement | undefined;
          targetTrack = under?.dataset.trackId && under.dataset.trackId !== track.id ? under.dataset.trackId : null;
        } else if (mode === "trim-start") {
          const s = snapToFrame(snap(Math.max(0, start + dx), pts, thr), fps);
          const delta = s - start;
          current = { start: s, duration: duration - delta, sourceIn: clip.reverse || clip.freeze ? sourceIn : sourceIn + delta * speed };
        } else {
          const e2 = snapToFrame(snap(start + duration + dx, pts, thr), fps);
          current = { start, duration: e2 - start, sourceIn };
        }
        setGhost(current);
      };
      const onUp = () => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        setGhost(null);
        if (!moved) return;
        if (mode === "move") dispatch({ type: "move_clip", clip: clip.id, start: fromSec(current.start), track: targetTrack });
        else if (mode === "trim-start") dispatch({ type: "trim_clip", clip: clip.id, edge: "start", to: fromSec(current.start) });
        else dispatch({ type: "trim_clip", clip: clip.id, edge: "end", to: fromSec(current.start + current.duration) });
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    };

    const g = ghost ?? { start, duration, sourceIn };
    return (
      <div
        className={`clip ${clip.kind} ${isSel ? "selected" : ""} ${ghost ? "dragging" : ""}`}
        style={{ left: g.start * px, width: Math.max(2, g.duration * px), height }}
        onPointerDown={begin("move")}
        role="button"
        tabIndex={0}
        aria-label={`${clip.kind} clip ${clip.name}`}
        aria-pressed={isSel}
        onFocus={() => select(clip.id)}
        title={`${clip.name}\nstart ${timecode(g.start, fps)}  dur ${timecode(g.duration, fps)}`}
      >
        {clip.kind === "video" ? <Filmstrip mediaId={clip.media} sourceIn={g.sourceIn} duration={g.duration} px={px} speed={speed} reverse={clip.reverse} freeze={clip.freeze ? toSec(clip.freeze) : null} /> : <WaveCanvas mediaId={clip.media} sourceIn={g.sourceIn} duration={g.duration} px={px} speed={speed} reverse={clip.reverse} gainDb={clip.gain_db + track.gain_db} height={height} />}
        {clip.kind === "audio" && speed === 1 && !clip.reverse && <BeatTicks mediaId={clip.media} sourceIn={g.sourceIn} duration={g.duration} px={px} />}
        <span className="clip-name">{clip.name}{clip.gain_db !== 0 ? `  ${clip.gain_db > 0 ? "+" : ""}${clip.gain_db.toFixed(1)} dB` : ""}{badges(clip)}</span>
        <div className="handle left" onPointerDown={begin("trim-start")} />
        <div className="handle right" onPointerDown={begin("trim-end")} />
      </div>
    );
  },
  (a, b) => a.px === b.px && a.fps === b.fps && a.height === b.height && a.track.locked === b.track.locked && a.track.gain_db === b.track.gain_db && JSON.stringify(a.clip) === JSON.stringify(b.clip) && linkKey(a.seq, a.clip) === linkKey(b.seq, b.clip),
);

/** Cheap key capturing only what ClipView reads from the sequence (its link group). */
function linkKey(seq: Sequence, c: Clip): string {
  return linkedIds(seq, c.id).join(",");
}

/** Short status text appended to a clip's label: speed, reverse, freeze, keyframes, blend. */
export function badges(c: Clip): string {
  const out: string[] = [];
  const sp = toSec(c.speed);
  if (c.freeze) out.push("❄");
  else {
    if (sp !== 1) out.push(`×${Math.round(sp * 100) / 100}`);
    if (c.reverse) out.push("◀");
  }
  if (Object.values(c.keyframes).some((k) => k.length)) out.push("◆");
  if (c.blend !== "normal") out.push(c.blend);
  if (c.kind === "audio") {
    if (c.pan !== 0) out.push(`pan ${c.pan > 0 ? "R" : "L"}${Math.round(Math.abs(c.pan) * 100)}`);
    if (toSec(c.fade_in) > 0 || toSec(c.fade_out) > 0) out.push("fade");
    if (c.effects.some((e) => e.enabled)) out.push("fx");
  }
  return out.length ? `  ${out.join(" ")}` : "";
}

function Filmstrip({ mediaId, sourceIn, duration, px, speed, reverse, freeze }: { mediaId: string; sourceIn: number; duration: number; px: number; speed: number; reverse: boolean; freeze: number | null }) {
  const ensure = useAnalysis((s) => s.ensureThumbs);
  const thumbs = useAnalysis((s) => s.thumbs[mediaId]);
  useEffect(() => ensure(mediaId), [mediaId, ensure]);
  if (!Array.isArray(thumbs)) return null;
  const tile = Math.max(1, Math.ceil(80 / px)); // thin the strip when zoomed far out (in source seconds)
  const imgs = [];
  if (freeze !== null) {
    // a held frame: repeat the same thumbnail across the clip
    const src = thumbs[Math.min(thumbs.length - 1, Math.floor(freeze))];
    const w = Math.max(40, px);
    for (let x = 0; src && x < duration * px; x += w) imgs.push(<img key={x} src={src} alt="" draggable={false} style={{ left: x, width: w }} />);
  } else {
    const span = duration * speed;
    const first = Math.floor(sourceIn);
    const last = Math.min(thumbs.length - 1, Math.ceil(sourceIn + span));
    for (let i = first; i <= last; i += tile) {
      const src = thumbs[i];
      if (src) imgs.push(<img key={i} src={src} alt="" draggable={false} style={{ left: ((i - sourceIn) / speed) * px, width: (px * tile) / speed }} />);
    }
  }
  return <div className="filmstrip" aria-hidden style={reverse ? { transform: "scaleX(-1)" } : undefined}>{imgs}</div>;
}

function WaveCanvas({ mediaId, sourceIn, duration, px, speed, reverse, gainDb, height }: { mediaId: string; sourceIn: number; duration: number; px: number; speed: number; reverse: boolean; gainDb: number; height: number }) {
  const ensure = useAnalysis((s) => s.ensureWave);
  const wave = useAnalysis((s) => s.waves[mediaId]);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => ensure(mediaId), [mediaId, ensure]);
  const cssW = Math.max(2, Math.round(duration * px));
  const w = Math.min(cssW, 4096);
  useEffect(() => {
    const c = ref.current;
    if (!c || typeof wave !== "object") return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = "rgba(120, 230, 170, 0.9)";
    const gain = dbToGain(gainDb);
    const mid = height / 2;
    for (let x = 0; x < w; x++) {
      const span = duration * speed;
      const [f0, f1] = reverse ? [1 - (x + 1) / w, 1 - x / w] : [x / w, (x + 1) / w];
      const t0 = sourceIn + f0 * span;
      const t1 = sourceIn + f1 * span;
      const i0 = Math.floor(t0 * wave.bins_per_sec);
      const i1 = Math.max(i0 + 1, Math.ceil(t1 * wave.bins_per_sec));
      let m = 0;
      for (let i = i0; i < i1 && i < wave.peaks.length; i++) m = Math.max(m, wave.peaks[i] ?? 0);
      const hh = Math.min(1, m * gain) * (height - 6);
      ctx.fillRect(x, mid - hh / 2, 1, Math.max(1, hh));
    }
  }, [wave, sourceIn, duration, speed, reverse, w, gainDb, height]);
  if (typeof wave !== "object") return <div className="wave-pending">{wave === "failed" ? "no waveform" : "analyzing…"}</div>;
  return <canvas ref={ref} width={w} height={height} style={{ width: cssW, height }} aria-label="audio waveform" />;
}


function BeatTicks({ mediaId, sourceIn, duration, px }: { mediaId: string; sourceIn: number; duration: number; px: number }) {
  const b = useAnalysis((s) => s.beats[mediaId]);
  if (typeof b !== "object") return null;
  const ticks = b.beats.filter((t) => t >= sourceIn && t <= sourceIn + duration);
  return (
    <div className="beat-ticks" aria-hidden>
      {ticks.map((t) => <i key={t} style={{ left: (t - sourceIn) * px }} />)}
    </div>
  );
}

/** Visual marker centred on the cut: spans the blended region. */
function TransitionMark({ t, track, px }: { t: Transition; track: Track; px: number }) {
  const a = track.clips.find((c) => c.id === t.clip_a);
  if (!a) return null;
  const cut = toSec(a.start) + toSec(a.duration);
  const d = toSec(t.duration);
  return (
    <div className="transition-mark" style={{ left: (cut - d / 2) * px, width: Math.max(4, d * px) }} title={`${t.kind} · ${d.toFixed(2)} s`} data-transition-mark={t.id}>
      <span>{t.kind}</span>
    </div>
  );
}
