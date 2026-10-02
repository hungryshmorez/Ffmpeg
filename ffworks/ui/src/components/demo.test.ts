import { describe, expect, it } from "vitest";
import { prettyKind, stepAt } from "./demo";

const steps = [0, 1, 2].map((i) => ({ index: i, start: i * 3, transition: null, effects: [], fx: [] }));

describe("demo helpers", () => {
  it("finds the segment playing at a time", () => {
    expect(stepAt(steps, 0)).toBe(0);
    expect(stepAt(steps, 2.99)).toBe(0);
    expect(stepAt(steps, 3)).toBe(1);
    expect(stepAt(steps, 100)).toBe(2);
    expect(stepAt([], 5)).toBe(0);
  });
  it("names transitions", () => {
    expect(prettyKind("wipeleft")).toBe("Wipeleft");
    expect(prettyKind("gl_polka_dots")).toBe("GL Polka Dots");
  });
});
