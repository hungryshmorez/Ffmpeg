import { describe, expect, it } from "vitest";
import type { EngineInfo } from "../types";
import { summarise } from "./EnginesDialog";

const base: EngineInfo = { id: "a", name: "A", ffmpeg_path: "/x", ffprobe_path: "/y", ok: true, error: null, version: "ffmpeg version 7", license: "GPL", filters: 450, encoders: 200, xfade_custom: false, hwaccels: [], notable: [] };

describe("summarise", () => {
  it("lists licence and filter count", () => expect(summarise(base)).toBe("GPL · 450 filters"));
  it("calls out GL transitions and hardware encoders", () => {
    expect(summarise({ ...base, xfade_custom: true, notable: ["libx265", "h264_nvenc", "h264_qsv", "av1_nvenc"] })).toBe("GPL · 450 filters · GL transitions · NVENC · Quick Sync · x265 · AV1");
  });
});
