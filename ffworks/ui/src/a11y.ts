/** Keyboard and screen-reader helpers that do not need the page (the page wiring is in `components/Accessibility.tsx`). */
import type { JobEvent } from "./types";

/** Selector for what Tab can reach inside a dialog. */
export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab or Shift+Tab goes next inside a dialog whose reachable controls are `count` long and where `index` is the focused one
 * (-1 when focus is outside the dialog). Focus wraps at both ends; with nothing reachable it stays put (null).
 */
export function tabTarget(count: number, index: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (index < 0) return shift ? count - 1 : 0;
  if (shift) return index === 0 ? count - 1 : null;
  return index === count - 1 ? 0 : null;
}

/** Labels of the buttons Escape may press, best first. "Cancel" only counts when nothing in the dialog reports progress. */
export function escapeLabels(busy: boolean): string[] {
  return busy ? ["Close", "Done", "OK", "Dismiss"] : ["Close", "Done", "OK", "Dismiss", "Cancel"];
}

const NAMES: Record<string, string> = { export: "Export", preview: "Preview", "lab:frames": "Frame lab", "lab:corruption": "Corruption lab", "lab:mosh": "Datamosh lab" };

/** What a job is called out loud. */
export function jobName(operation: string): string {
  return NAMES[operation] ?? operation.replace(/^lab:/, "").replace(/[:_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** The 0, 25, 50, 75 step a progress fraction falls in. */
export function progressStep(fraction: number | null): number | null {
  return fraction === null || !Number.isFinite(fraction) ? null : Math.min(75, Math.floor(Math.max(0, fraction) * 4) * 25);
}

/**
 * What to announce when a job event arrives, given what was last announced for it (`last`: a state name or a progress step).
 * Returns the sentence (or null for no news) and the new `last`. Progress is announced every 25 % so a screen reader is not flooded.
 */
export function announcement(e: JobEvent, last: string | undefined): { say: string | null; last: string } {
  const name = jobName(e.operation);
  switch (e.state) {
    case "queued": return { say: last === "queued" ? null : `${name} queued`, last: "queued" };
    case "rendering": {
      const step = progressStep(e.fraction);
      const key = step === null ? "rendering" : `p${step}`;
      if (key === last) return { say: null, last };
      return { say: step === null || step === 0 ? `${name} started` : `${name} ${step} percent`, last: key };
    }
    case "completed": return { say: last === "completed" ? null : `${name} finished`, last: "completed" };
    case "failed": return { say: last === "failed" ? null : `${name} failed: ${e.message}`, last: "failed" };
    case "canceled": return { say: last === "canceled" ? null : `${name} canceled`, last: "canceled" };
  }
}
