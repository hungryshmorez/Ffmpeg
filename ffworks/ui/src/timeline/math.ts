import { toSec } from "../time";
import type { Clip, Sequence, Track } from "../types";

export interface ClipTimes { start: number; end: number; sourceIn: number; duration: number; speed: number; /** Seconds of source media this clip consumes (0 when frozen). */ span: number }

export function times(c: Clip): ClipTimes {
  const start = toSec(c.start);
  const duration = toSec(c.duration);
  const speed = toSec(c.speed);
  return { start, end: start + duration, sourceIn: toSec(c.source_in), duration, speed, span: c.freeze ? 0 : duration * speed };
}

export function clipAt(track: Track, t: number): Clip | null {
  for (const c of track.clips) {
    const { start, end } = times(c);
    if (t >= start && t < end) return c;
  }
  return null;
}

/** Topmost visible video clip at time `t` (later video tracks are on top; muted = hidden). Adjustment layers paint nothing themselves, so they are skipped. */
export function visibleVideoAt(seq: Sequence, t: number): { clip: Clip; track: Track } | null {
  let found: { clip: Clip; track: Track } | null = null;
  for (const track of seq.tracks) {
    if (track.kind !== "video" || track.muted) continue;
    const clip = clipAt(track, t);
    if (clip && !clip.adjustment) found = { clip, track };
  }
  return found;
}

/** Source media time corresponding to timeline time `t` inside `clip` (honours speed, reverse and freeze). */
export function sourceTime(clip: Clip, t: number): number {
  if (clip.freeze) return toSec(clip.freeze);
  const { start, sourceIn, speed, duration } = times(clip);
  const local = Math.min(Math.max(t - start, 0), duration);
  return clip.reverse ? sourceIn + (duration - local) * speed : sourceIn + local * speed;
}

/** Candidate snap points: 0, playhead and every clip edge except those of `exclude`. */
export function snapPoints(seq: Sequence, playhead: number, exclude: ReadonlySet<string>): number[] {
  const pts = [0, playhead, ...(seq.markers ?? []).map((m) => toSec(m.time))];
  for (const tr of seq.tracks)
    for (const c of tr.clips) {
      if (exclude.has(c.id)) continue;
      const { start, end } = times(c);
      pts.push(start, end);
    }
  return pts;
}

/** Marker times strictly before / after `t` (for jump-to-previous/next). */
export function neighbourMarkers(seq: Sequence, t: number): { prev: number | null; next: number | null } {
  const times_ = (seq.markers ?? []).map((m) => toSec(m.time)).sort((a, b) => a - b);
  const prev = [...times_].reverse().find((x) => x < t - 1e-6) ?? null;
  const next = times_.find((x) => x > t + 1e-6) ?? null;
  return { prev, next };
}

/** Snap `t` to the nearest candidate within `thresholdSec`; otherwise return `t` unchanged. */
export function snap(t: number, points: readonly number[], thresholdSec: number): number {
  let best = t;
  let bestD = thresholdSec;
  for (const p of points) {
    const d = Math.abs(p - t);
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** Group of clips that move/trim together (shared link id). */
export function linkedIds(seq: Sequence, clipId: string): string[] {
  let link: string | null = null;
  for (const tr of seq.tracks) for (const c of tr.clips) if (c.id === clipId) link = c.link;
  if (!link) return [clipId];
  const out: string[] = [];
  for (const tr of seq.tracks) for (const c of tr.clips) if (c.link === link) out.push(c.id);
  return out;
}

/** Ruler tick spacing in seconds chosen so labels stay >= ~80px apart. */
export function tickStep(pxPerSec: number): number {
  const steps = [1 / 30, 1 / 10, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s * pxPerSec >= 80) ?? 600;
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function findClip(seq: Sequence, id: string): { clip: Clip; track: Track } | null {
  for (const track of seq.tracks) for (const clip of track.clips) if (clip.id === id) return { clip, track };
  return null;
}

/** Timeline times of detected beats that fall inside audio clips (beat time is relative to the source media). */
export function beatPoints(seq: Sequence, beatsByMedia: Record<string, readonly number[] | undefined>, exclude: ReadonlySet<string> = new Set()): number[] {
  const out: number[] = [];
  for (const tr of seq.tracks)
    for (const c of tr.clips) {
      if (c.kind !== "audio" || exclude.has(c.id)) continue; // a dragged clip must not snap to its own beats
      const beats = beatsByMedia[c.media];
      if (!beats) continue;
      const { start, sourceIn, duration } = times(c);
      for (const b of beats) if (b >= sourceIn && b <= sourceIn + duration) out.push(start + (b - sourceIn));
    }
  return out;
}
