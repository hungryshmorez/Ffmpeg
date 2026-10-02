import type { DemoStep } from "../types";

/** Index of the segment playing at `t` seconds (the last one whose start is not after `t`). */
export function stepAt(steps: DemoStep[], t: number): number {
  let cur = 0;
  for (const s of steps) if (s.start <= t + 1e-6) cur = s.index;
  return cur;
}

/** A readable name for a transition id: `wipeleft` -> `Wipeleft`, `gl_angular` -> `GL Angular`. */
export function prettyKind(k: string): string {
  if (k.startsWith("gl_")) return "GL " + k.slice(3).split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return k.charAt(0).toUpperCase() + k.slice(1);
}
