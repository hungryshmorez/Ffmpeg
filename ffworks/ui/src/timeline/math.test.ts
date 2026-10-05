import { describe, expect, it } from "vitest";
import { cutsInsideClip, rangesOnTimeline } from "../components/AnalysisPanel";
import { beatPoints, dbToGain, groupEdit, keyEdit, linkedIds, neighbourMarkers, snap, snapPoints, sourceTime, tickStep, visibleVideoAt } from "./math";
import { fromSec, snapToFrame, timecode, toSec } from "../time";
import type { Clip, Sequence } from "../types";

const clip = (id: string, start: string, dur: string, kind: "video" | "audio", link: string | null = null, sourceIn = "0"): Clip => ({
  id, media: "m", name: id, kind, start, source_in: sourceIn, duration: dur, link, gain_db: 0, opacity: 1, effects: [],
  pan: 0, fade_in: "0", fade_out: "0", title: null, speed: "1", reverse: false, freeze: null, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, blend: "normal", keyframes: {},
});
const seq: Sequence = {
  id: "s", name: "Main", markers: [{ id: "mk", time: "3", name: "m", color: "#ffb020", note: "" }],
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
    const sq: Sequence = { id: "s", name: "s", markers: [], tracks: [{ id: "a1", name: "A1", kind: "audio", muted: false, locked: false, gain_db: 0, pan: 0, solo: false, transitions: [], clips: [c] }] };
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
  it("an adjustment layer is never the picture shown: the footage beneath it is", () => {
    const adj: Sequence = { ...seq, tracks: seq.tracks.map((t) => (t.id === "v2" ? { ...t, clips: t.clips.map((c) => ({ ...c, adjustment: true })) } : t)) };
    expect(visibleVideoAt(adj, 1.5)?.clip.id).toBe("a");
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
  it("markers are snap points and can be jumped between", () => {
    expect(snapPoints(seq, 10, new Set())).toContain(3);
    expect(neighbourMarkers(seq, 5)).toEqual({ prev: 3, next: null });
    expect(neighbourMarkers(seq, 1)).toEqual({ prev: null, next: 3 });
    expect(neighbourMarkers(seq, 3)).toEqual({ prev: null, next: null });
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

describe("detected ranges", () => {
  it("maps source ranges onto the timeline, clamps to the clip, drops outside ones", () => {
    const c = { ...clip("v", "10", "6", "video", null, "2"), media: "m" }; // timeline 10..16 from source 2..8
    expect(rangesOnTimeline(c, [[0, 1], [1, 3], [5, 6], [7, 12]])).toEqual([[10, 11], [13, 14], [15, 16]]);
  });
});

describe("keyEdit", () => {
  it("Alt+Up / Alt+Down move the clip to the track above / below, and nothing else does", () => {
    expect(keyEdit(k("ArrowUp", { altKey: true }), 2, 3, 25)).toEqual({ kind: "track", up: true });
    expect(keyEdit(k("ArrowDown", { altKey: true }), 2, 3, 25)).toEqual({ kind: "track", up: false });
    expect(keyEdit(k("ArrowUp", {}), 2, 3, 25)).toBeNull();
    expect(keyEdit(k("ArrowUp", { altKey: true, shiftKey: true }), 2, 3, 25)).toBeNull();
    expect(keyEdit(k("ArrowUp", { ctrlKey: true }), 2, 3, 25)).toBeNull();
  });
  const k = (key: string, mods: Partial<{ altKey: boolean; ctrlKey: boolean; shiftKey: boolean }>) => ({ key, altKey: false, ctrlKey: false, shiftKey: false, ...mods });
  it("moves by a frame with Alt and by a second with Alt+Shift", () => {
    expect(keyEdit(k("ArrowRight", { altKey: true }), 2, 3, 25)).toEqual({ kind: "move", start: 2.04 });
    expect(keyEdit(k("ArrowLeft", { altKey: true, shiftKey: true }), 2, 3, 25)).toEqual({ kind: "move", start: 1 });
  });
  it("never moves before zero", () => {
    expect(keyEdit(k("ArrowLeft", { altKey: true }), 0, 3, 25)).toBeNull();
    expect(keyEdit(k("ArrowLeft", { altKey: true, shiftKey: true }), 0.5, 3, 25)).toEqual({ kind: "move", start: 0 });
  });
  it("trims the end with Ctrl and the start with Ctrl+Shift, a frame at a time", () => {
    expect(keyEdit(k("ArrowLeft", { ctrlKey: true }), 2, 3, 25)).toEqual({ kind: "trim-end", end: 4.96 });
    expect(keyEdit(k("ArrowRight", { ctrlKey: true }), 2, 3, 25)).toEqual({ kind: "trim-end", end: 5.04 });
    expect(keyEdit(k("ArrowRight", { ctrlKey: true, shiftKey: true }), 2, 3, 25)).toEqual({ kind: "trim-start", start: 2.04 });
    expect(keyEdit(k("ArrowLeft", { ctrlKey: true, shiftKey: true }), 2, 3, 25)).toEqual({ kind: "trim-start", start: 1.96 });
  });
  it("keeps at least one frame", () => {
    expect(keyEdit(k("ArrowLeft", { ctrlKey: true }), 2, 0.04, 25)).toBeNull();
    expect(keyEdit(k("ArrowRight", { ctrlKey: true, shiftKey: true }), 2, 0.04, 25)).toBeNull();
  });
  it("ignores other keys, no modifier and both modifiers", () => {
    expect(keyEdit(k("a", { altKey: true }), 2, 3, 25)).toBeNull();
    expect(keyEdit(k("ArrowLeft", {}), 2, 3, 25)).toBeNull();
    expect(keyEdit(k("ArrowLeft", { altKey: true, ctrlKey: true }), 2, 3, 25)).toBeNull();
  });
});

describe("groupEdit", () => {
  const k = (key: string, mods: Partial<{ altKey: boolean; ctrlKey: boolean; shiftKey: boolean }>) => ({ key, altKey: false, ctrlKey: false, shiftKey: false, ...mods });
  const items = [{ id: "a", start: 1, duration: 2 }, { id: "b", start: 3, duration: 2 }, { id: "c", start: 8, duration: 1 }];
  it("moves every clip by the focused clip's step, latest first when going right so they do not collide", () => {
    const edit = keyEdit(k("ArrowRight", { altKey: true }), 1, 2, 25)!;
    expect(groupEdit(edit, { start: 1, duration: 2 }, items, 25)).toEqual([
      { clip: "c", op: "move", to: 8.04 },
      { clip: "b", op: "move", to: 3.04 },
      { clip: "a", op: "move", to: 1.04 },
    ]);
  });
  it("goes earliest first when moving left", () => {
    const edit = keyEdit(k("ArrowLeft", { altKey: true }), 1, 2, 25)!;
    expect(groupEdit(edit, { start: 1, duration: 2 }, items, 25)!.map((s) => s.clip)).toEqual(["a", "b", "c"]);
  });
  it("refuses the whole move when one clip would go before zero", () => {
    const edit = keyEdit(k("ArrowLeft", { altKey: true, shiftKey: true }), 3, 2, 25)!;
    expect(edit).toEqual({ kind: "move", start: 2 });
    expect(groupEdit(edit, { start: 3, duration: 2 }, [{ id: "a", start: 0.5, duration: 2 }, items[1]!, items[2]!], 25)).toBeNull();
  });
  it("trims every end the same amount and refuses if one clip would vanish", () => {
    const edit = keyEdit(k("ArrowLeft", { ctrlKey: true }), 1, 2, 25)!;
    const steps = groupEdit(edit, { start: 1, duration: 2 }, items, 25)!;
    expect(steps.map((s) => [s.clip, s.op, s.to])).toEqual([["a", "trim-end", 2.96], ["b", "trim-end", 4.96], ["c", "trim-end", 8.96]]);
    expect(groupEdit({ kind: "trim-end", end: 0.5 }, { start: 1, duration: 2 }, items, 25)).toBeNull();
  });
  it("trims starts, and leaves track moves to the caller", () => {
    const edit = keyEdit(k("ArrowRight", { ctrlKey: true, shiftKey: true }), 1, 2, 25)!;
    expect(groupEdit(edit, { start: 1, duration: 2 }, items, 25)!.every((s) => s.op === "trim-start")).toBe(true);
    expect(groupEdit({ kind: "track", up: true }, { start: 1, duration: 2 }, items, 25)).toBeNull();
  });
});
