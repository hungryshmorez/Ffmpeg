import { describe, expect, it } from "vitest";
import { pasteCommands, useFxClipboard } from "./fxClipboard";
import type { Clip, EffectInstance } from "../types";

const fx = (id: string, effect: string, params: Record<string, number> = {}): EffectInstance => ({ id, effect, enabled: true, params });
const clip = (id: string, effects: EffectInstance[], kind: "video" | "audio" = "video") => ({ id, kind, effects } as unknown as Clip);

describe("effect clipboard", () => {
  it("copies by value and builds add_effect commands in order, skipping graph effects", () => {
    const src = clip("a", [fx("1", "blur", { sigma: 9 }), fx("2", "graph"), fx("3", "hue", { degrees: 30 })]);
    useFxClipboard.getState().copy(src);
    src.effects[0].params.sigma = 1; // later edits to the source do not follow
    const { commands, skipped } = pasteCommands(useFxClipboard.getState().effects, clip("b", []));
    expect(skipped).toBe(1);
    expect(commands).toEqual([
      { type: "add_effect", clip: "b", effect: "blur", params: { sigma: 9 } },
      { type: "add_effect", clip: "b", effect: "hue", params: { degrees: 30 } },
    ]);
    expect(useFxClipboard.getState().kind).toBe("video");
  });
});
