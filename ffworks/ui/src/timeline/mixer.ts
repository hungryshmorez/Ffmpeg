import { evalKeyframes } from "../keyframes";
import { toSec } from "../time";
import type { Clip, Track, Waveform } from "../types";
import { clipAt, dbToGain, sourceTime } from "./math";

/** Balance as left/right gains: unity on the louder side (matches the engine's `pan` filter). */
export function balance(pan: number): [number, number] {
  return pan > 0 ? [1 - pan, 1] : [1, 1 + pan];
}

/** Linear fade factor (0..1) of an audio clip at clip-relative time `rel`. */
export function fadeFactor(clip: Clip, rel: number): number {
  const dur = toSec(clip.duration), fi = toSec(clip.fade_in), fo = toSec(clip.fade_out);
  let f = 1;
  if (fi > 0 && rel < fi) f = Math.min(f, Math.max(0, rel / fi));
  if (fo > 0 && rel > dur - fo) f = Math.min(f, Math.max(0, (dur - rel) / fo));
  return f;
}

/** Clip gain in dB at clip-relative `rel` (the keyframed envelope when there is one). */
export function clipGainDb(clip: Clip, rel: number): number {
  const kfs = clip.keyframes["gain_db"];
  return kfs && kfs.length ? (evalKeyframes(kfs, rel) ?? clip.gain_db) : clip.gain_db;
}

/**
 * Peak level (linear, 0..1+) of one audio track at timeline time `t`, left/right, derived from the media's analysed
 * waveform peaks with clip gain/envelope, track gain, fades, clip and track balance applied. It is a *prediction from analysis data*:
 * audio effects (EQ, compressor…) and the rest of the mix are not included. Null when the track is silent or has no clip there.
 */
export function trackLevel(track: Track, t: number, wave: Waveform | undefined, anySolo: boolean): { l: number; r: number } | null {
  if (track.muted || (anySolo && !track.solo)) return null;
  const clip = clipAt(track, t);
  if (!clip || !wave) return null;
  const rel = t - toSec(clip.start);
  const bin = Math.floor(sourceTime(clip, t) * wave.bins_per_sec);
  const peak = wave.peaks[bin] ?? 0;
  const g = peak * dbToGain(clipGainDb(clip, rel) + track.gain_db) * fadeFactor(clip, rel);
  const [cl, cr] = balance(clip.pan);
  const [tl, tr] = balance(track.pan);
  return { l: g * cl * tl, r: g * cr * tr };
}

/** Map linear amplitude to a 0..1 meter position over a -60..0 dB range. */
export function meterPos(linear: number): number {
  if (linear <= 0) return 0;
  const db = 20 * Math.log10(linear);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

export function toDb(linear: number): number {
  return linear <= 0 ? -Infinity : 20 * Math.log10(linear);
}
