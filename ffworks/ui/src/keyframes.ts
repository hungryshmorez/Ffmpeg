import { toSec } from "./time";
import type { Interp, Keyframe } from "./types";

/** Same curve maths as `ffworks-core::keyframes::eval` (shared test vectors keep them in step). */
function shape(i: Interp, p: number): number {
  switch (i) {
    case "hold": return 0;
    case "ease_in": return p * p;
    case "ease_out": return p * (2 - p);
    case "ease_in_out": return p * p * (3 - 2 * p);
    default: return p;
  }
}

/** Value at clip-relative time `t`; before the first key the first value holds, after the last the last. Undefined without keys. */
export function evalKeyframes(kfs: readonly Keyframe[], t: number): number | undefined {
  const first = kfs[0];
  if (!first) return undefined;
  if (t <= toSec(first.t)) return first.v;
  for (let i = 0; i + 1 < kfs.length; i++) {
    const a = kfs[i] as Keyframe, b = kfs[i + 1] as Keyframe;
    const ta = toSec(a.t), tb = toSec(b.t);
    if (t < tb) return a.v + (b.v - a.v) * shape(a.interp, (t - ta) / (tb - ta));
  }
  return (kfs[kfs.length - 1] as Keyframe).v;
}

/** The key within half a frame of clip-relative time `t`, if any. */
export function keyNear(kfs: readonly Keyframe[], t: number, fps: number): Keyframe | undefined {
  return kfs.find((k) => Math.abs(toSec(k.t) - t) < 0.5 / fps);
}

export function hasMotion(clipKeyframes: Record<string, readonly Keyframe[]>): boolean {
  return Object.values(clipKeyframes).some((k) => k.length > 0);
}
