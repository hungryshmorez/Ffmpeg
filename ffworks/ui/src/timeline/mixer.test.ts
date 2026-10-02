import { describe, expect, it } from "vitest";
import { balance, clipGainDb, fadeFactor, meterPos, toDb, trackLevel } from "./mixer";
import type { Clip, Track, Waveform } from "../types";

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: "a", media: "m", name: "a", kind: "audio", start: "2", source_in: "1", duration: "4", link: null, gain_db: 0, opacity: 1, effects: [],
  pan: 0, fade_in: "0", fade_out: "0", speed: "1", reverse: false, freeze: null, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, blend: "normal", keyframes: {}, ...over,
});
const track = (c: Clip, over: Partial<Track> = {}): Track => ({ id: "t", name: "A1", kind: "audio", muted: false, locked: false, gain_db: 0, pan: 0, solo: false, clips: [c], transitions: [], ...over });
// 10 bins per second, a constant 0.5 peak except bin 15 (= 1.5 s) which is 1
const wave: Waveform = { bins_per_sec: 10, peaks: Array.from({ length: 100 }, (_, i) => (i === 15 ? 1 : 0.5)) };

describe("mixer levels", () => {
  it("balance keeps unity on the louder side (same as the engine)", () => {
    expect(balance(0)).toEqual([1, 1]);
    expect(balance(1)).toEqual([0, 1]);
    expect(balance(-0.5)).toEqual([1, 0.5]);
  });
  it("reads the peak at the playhead's source time (source_in 1 s, timeline 3 s -> source 2 s -> bin 20)", () => {
    expect(trackLevel(track(clip()), 3, wave, false)).toEqual({ l: 0.5, r: 0.5 });
    // timeline 2.5 -> source 1.5 -> bin 15 -> 1.0
    expect(trackLevel(track(clip()), 2.5, wave, false)).toEqual({ l: 1, r: 1 });
  });
  it("applies clip gain, track gain, pan and fades", () => {
    const lvl = trackLevel(track(clip({ gain_db: -6.0206, pan: 1 }), { gain_db: 0 }), 3, wave, false)!;
    expect(lvl.l).toBe(0);
    expect(lvl.r).toBeCloseTo(0.25, 3); // 0.5 × 0.5
    const fading = trackLevel(track(clip({ fade_in: "2" })), 3, wave, false)!; // 1 s into a 2 s fade -> ×0.5
    expect(fading.l).toBeCloseTo(0.25, 6);
  });
  it("fade-out ramps over the last seconds only", () => {
    const c = clip({ fade_out: "2" });
    expect(fadeFactor(c, 1)).toBe(1);
    expect(fadeFactor(c, 3)).toBeCloseTo(0.5, 6);
    expect(fadeFactor(c, 4)).toBe(0);
  });
  it("uses the keyframed volume envelope when present", () => {
    const c = clip({ keyframes: { gain_db: [{ t: "0", v: -20, interp: "linear" }, { t: "4", v: 0, interp: "linear" }] } });
    expect(clipGainDb(c, 2)).toBeCloseTo(-10, 6);
    expect(clipGainDb(clip(), 2)).toBe(0);
  });
  it("muted, un-soloed and empty tracks have no level", () => {
    expect(trackLevel(track(clip(), { muted: true }), 3, wave, false)).toBeNull();
    expect(trackLevel(track(clip()), 3, wave, true)).toBeNull(); // another track is soloed
    expect(trackLevel(track(clip(), { solo: true }), 3, wave, true)).not.toBeNull();
    expect(trackLevel(track(clip()), 0.5, wave, false)).toBeNull(); // before the clip
    expect(trackLevel(track(clip()), 3, undefined, false)).toBeNull(); // waveform not analysed yet
  });
  it("meter scale", () => {
    expect(meterPos(1)).toBe(1);
    expect(meterPos(0.001)).toBe(0);
    expect(meterPos(0.1)).toBeCloseTo(2 / 3, 6);
    expect(toDb(0)).toBe(-Infinity);
  });
});
