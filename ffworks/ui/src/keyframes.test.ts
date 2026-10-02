import { describe, expect, it } from "vitest";
import { evalKeyframes, keyNear } from "./keyframes";
import type { Keyframe } from "./types";

const k = (t: number, v: number, interp: Keyframe["interp"] = "linear"): Keyframe => ({ t: String(t), v, interp });

// These vectors are the same ones asserted in ffworks-core/src/keyframes.rs (`evaluates_each_interpolation`).
describe("evalKeyframes matches the engine", () => {
  it("linear with clamped ends", () => {
    const lin = [k(0, 0), k(2, 10)];
    expect(evalKeyframes(lin, -1)).toBe(0);
    expect(evalKeyframes(lin, 1)).toBe(5);
    expect(evalKeyframes(lin, 5)).toBe(10);
  });
  it("hold steps at the next key", () => {
    const hold = [k(0, 1, "hold"), k(2, 9)];
    expect(evalKeyframes(hold, 1.99)).toBe(1);
    expect(evalKeyframes(hold, 2)).toBe(9);
  });
  it("easing curves", () => {
    expect(evalKeyframes([k(0, 0, "ease_in"), k(2, 8)], 1)).toBe(2);
    expect(evalKeyframes([k(0, 0, "ease_out"), k(2, 8)], 1)).toBe(6);
    expect(evalKeyframes([k(0, 0, "ease_in_out"), k(2, 8)], 1)).toBe(4);
  });
  it("no keys / single key", () => {
    expect(evalKeyframes([], 1)).toBeUndefined();
    expect(evalKeyframes([k(3, 7)], 0)).toBe(7);
  });
  it("finds a key within half a frame", () => {
    expect(keyNear([k(1, 0)], 1.01, 30)?.v).toBe(0);
    expect(keyNear([k(1, 0)], 1.05, 30)).toBeUndefined();
  });
});
