import { describe, expect, it } from "vitest";
import { announcement, escapeLabels, jobName, progressStep, tabTarget } from "./a11y";
import type { JobEvent } from "./types";

const base = { jobId: "j1", operation: "export", output: "out.mp4", priority: 0, enqueuedUnix: 0 };
const rendering = (fraction: number | null): JobEvent => ({ ...base, state: "rendering", fraction, fps: null, elapsed_secs: 1, eta_secs: null });

describe("tabTarget", () => {
  it("wraps from the last control to the first and from the first back to the last", () => {
    expect(tabTarget(4, 3, false)).toBe(0);
    expect(tabTarget(4, 0, true)).toBe(3);
  });
  it("lets the browser move focus inside the dialog", () => {
    expect(tabTarget(4, 1, false)).toBeNull();
    expect(tabTarget(4, 2, true)).toBeNull();
  });
  it("pulls focus in from outside the dialog and holds it when there is nothing to reach", () => {
    expect(tabTarget(4, -1, false)).toBe(0);
    expect(tabTarget(4, -1, true)).toBe(3);
    expect(tabTarget(0, -1, false)).toBeNull();
  });
});

describe("announcement", () => {
  it("speaks every 25 percent once, not on every tick", () => {
    let last: string | undefined;
    const said: string[] = [];
    for (const f of [0, 0.05, 0.2, 0.26, 0.3, 0.5, 0.51, 0.99, 1]) {
      const r = announcement(rendering(f), last);
      last = r.last;
      if (r.say) said.push(r.say);
    }
    expect(said).toEqual(["Export started", "Export 25 percent", "Export 50 percent", "Export 75 percent"]);
  });
  it("says how a job ended, once, with the reason when it failed", () => {
    expect(announcement({ ...base, state: "completed" }, "p75")).toEqual({ say: "Export finished", last: "completed" });
    expect(announcement({ ...base, state: "completed" }, "completed").say).toBeNull();
    expect(announcement({ ...base, state: "failed", message: "disk full" }, "p25").say).toBe("Export failed: disk full");
    expect(announcement({ ...base, state: "canceled" }, undefined).say).toBe("Export canceled");
  });
  it("copes with progress that has no fraction", () => {
    expect(announcement(rendering(null), undefined)).toEqual({ say: "Export started", last: "rendering" });
    expect(announcement(rendering(null), "rendering").say).toBeNull();
  });
});

describe("names and steps", () => {
  it("names the labs and falls back to a readable form", () => {
    expect(jobName("lab:frames")).toBe("Frame lab");
    expect(jobName("lab:something-new")).toBe("Something new");
    expect(jobName("export")).toBe("Export");
  });
  it("steps progress down to the last quarter reached", () => {
    expect([0, 0.24, 0.25, 0.74, 1, 7, -1].map(progressStep)).toEqual([0, 0, 25, 25 + 25, 75, 75, 0]);
    expect(progressStep(null)).toBeNull();
    expect(progressStep(Number.NaN)).toBeNull();
  });
  it("only lets Escape cancel a dialog that is not running something", () => {
    expect(escapeLabels(true)).not.toContain("Cancel");
    expect(escapeLabels(false)).toContain("Cancel");
  });
});
