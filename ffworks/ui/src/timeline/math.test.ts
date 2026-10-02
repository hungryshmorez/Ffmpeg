import { describe, expect, it } from "vitest";
import { cutsInsideClip } from "../components/AnalysisPanel";
import { beatPoints, dbToGain, linkedIds, snap, snapPoints, sourceTime, tickStep, visibleVideoAt } from "./math";
import { fromSec, snapToFrame, timecode, toSec } from "../time";
import type { Clip, Sequence } from "../types";

const clip = (id: string, start: string, dur: string, kind: "video" | "audio", link: string | null = null, sourceIn = "0"): Clip => ({
  id, media: "m", name: id, kind, start, source_in: sourceIn, duration: dur, link, gain_db: 0, opacity: 1, effects: [],
  pan: 0, fade_in: "0", fade_out: "0", speed: "1", reverse: false, freeze: null, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, blend: "normal", keyframes: {},
});
const seq: Sequence = {
  id: "s", name: "Main",
  tracks: [
    { id: "v1", name: "V1", kind: "video", muted: false, locked: false, gain_db: 0, pan: 0, solo: false, transitions: [], clips: [clip("a", "0", "4", "video", "L1"), clip("b", "6", "2", "video")] },
    { id: "v2", name: "V2", kind: "video", muted: false, locked: false, gain_db: 0, pan: 0, solo: false, transitions: [], clips: [clip("top", "1", "1", "video")] },
    { id: "a1", name: "A1", kind: "audio", muted: false, locked: false, gain_db: 0, pan: 0, solo: false, transitions: [], clips: [clip("aa", "0", "4", "audio", "L1")] },
  ],
};

describe("time", () => {
  it("parses rationals", () => {
    expect(toSec("30000/1001")).toBeCloseTo(29.97, 2);
    expect(toSec("5")).toBe(5);
    expect(toSec("1/0")).toBe(0);
  });
  it("round-trips seconds", () => expect(toSec(fromSec(1.234567))).toBeCloseTo(1.234567, 6));
  it("formats non-drop timecode", () => expect(timecode(3661.5, 30)).toBe("01:01:01:15"));
  it("snaps to frames", () => expect(snapToFrame(1.02, 30)).toBeCloseTo(1 + 1 / 30, 6));
});

describe("beat points", () => {
  it("maps source-relative beats into timeline time, honouring the clip range", () => {
    const c = { ...clip("aa", "10", "2", "audio", null, "1"), media: "m" };
    const sq: Sequence = { id: "s", name: "s", tracks: [{ id: "a1", name: "A1", kind: "audio", muted: false, locked: false, gain_db: 0, pan: 0, solo: false, transitions: [], clips: [c] }] };
    // source beats at 0.5 (before range), 1.0, 2.0, 3.0 (== end of range), 3.5 (after)
    expect(beatPoints(sq, { m: [0.5, 1, 2, 3, 3.5] })).toEqual([10, 11, 12]);
    expect(beatPoints(sq, {})).toEqual([]);
    expect(beatPoints(sq, { m: [1, 2] }, new Set(["aa"]))).toEqual([]);
  });
});

describe("timeline math", () => {
  it("picks the topmost visible video clip", () => {
    expect(visibleVideoAt(seq, 1.5)?.clip.id).toBe("top");
    expect(visibleVideoAt(seq, 0.5)?.clip.id).toBe("a");
    expect(visibleVideoAt(seq, 5)).toBeNull();
  });
  it("hidden tracks are skipped", () => {
    const hidden: Sequence = { ...seq, tracks: seq.tracks.map((t) => (t.id === "v2" ? { ...t, muted: true } : t)) };
    expect(visibleVideoAt(hidden, 1.5)?.clip.id).toBe("a");
  });
  it("maps timeline time to source time", () => {
    expect(sourceTime(clip("x", "10", "5", "video", null, "3"), 12)).toBe(5);
  });
  it("maps timeline time to source time with speed, reverse and freeze", () => {
    const base = clip("x", "10", "4", "video", null, "2");
    expect(sourceTime({ ...base, speed: "2" }, 11)).toBe(4); // 1 s in at 2x = 2 s of source
    expect(sourceTime({ ...base, speed: "1/2" }, 12)).toBe(3);
    // reversed: the first timeline instant shows the END of the source range (2 + 4 = 6)
    expect(sourceTime({ ...base, reverse: true }, 10)).toBe(6);
    expect(sourceTime({ ...base, reverse: true }, 11)).toBe(5);
    expect(sourceTime({ ...base, freeze: "7/2" }, 12)).toBe(3.5);
  });
  it("snaps within threshold only", () => {
    const pts = snapPoints(seq, 2.5, new Set(["top"]));
    expect(snap(3.97, pts, 0.1)).toBe(4);
    expect(snap(5, pts, 0.1)).toBe(5);
    expect(snap(2.52, pts, 0.1)).toBe(2.5);
  });
  it("finds linked groups", () => {
    expect(linkedIds(seq, "a").sort()).toEqual(["a", "aa"]);
    expect(linkedIds(seq, "b")).toEqual(["b"]);
  });
  it("tick spacing grows as zoom shrinks", () => {
    expect(tickStep(200)).toBeLessThan(tickStep(10));
  });
  it("db to gain", () => expect(dbToGain(-6)).toBeCloseTo(0.501, 2));
});

describe("scene cuts", () => {
  it("maps source-relative cuts into the clip, drops edge cuts, orders latest first", () => {
    const c = { ...clip("v", "10", "6", "video", null, "2"), media: "m" }; // timeline 10..16 from source 2..8
    // source cuts at 1 (before), 2.05 (too close to start), 4, 7, 7.95 (too close to end), 9 (after)
    expect(cutsInsideClip(c, [1, 2.05, 4, 7, 7.95, 9])).toEqual([15, 12]);
  });
});
