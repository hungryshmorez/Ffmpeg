import { describe, expect, it } from "vitest";
import { filterActions, scoreMatch, type PaletteAction } from "./palette";

const act = (label: string, keywords = ""): PaletteAction => ({ id: label, label, keywords, run: () => undefined });

describe("command palette ranking", () => {
  const all = [act("Save project"), act("Save As…"), act("Split at playhead", "cut razor"), act("Open filters browser"), act("Export…", "render")];
  it("keeps the order for an empty query", () => expect(filterActions(all, "  ").map((a) => a.label)).toEqual(all.map((a) => a.label)));
  it("prefers prefix matches, then in-order letters, and drops non-matches", () => {
    expect(filterActions(all, "sav").map((a) => a.label)).toEqual(["Save project", "Save As…"]);
    expect(filterActions(all, "spl")[0]!.label).toBe("Split at playhead");
    expect(filterActions(all, "zzz")).toEqual([]);
  });
  it("finds actions by their keywords", () => {
    expect(filterActions(all, "razor")[0]!.label).toBe("Split at playhead");
    expect(filterActions(all, "render")[0]!.label).toBe("Export…");
  });
  it("subsequence matching works across words", () => {
    expect(scoreMatch("sap", "split at playhead")).toBeGreaterThan(0);
    expect(scoreMatch("xyz", "split at playhead")).toBe(-1);
  });
});
