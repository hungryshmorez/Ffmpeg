import { describe, expect, it } from "vitest";
import type { Project } from "../types";
import { activeSequence, compoundOf, mainSequence } from "./sequences";

const clip = (media: string) => ({ id: "c", media }) as never;
const project = {
  media: [
    { id: "m1", generator: { kind: "nested", sequence: "inner" } },
    { id: "m2", generator: { kind: "solid", color: "#ff0000" } },
    { id: "m3", generator: null },
  ],
  sequences: [
    { id: "snap", name: "Snapshot: a", tracks: [], markers: [] },
    { id: "main", name: "Main", tracks: [], markers: [] },
    { id: "inner", name: "Compound 1", tracks: [], markers: [], compound: true },
  ],
  active_sequence: "inner",
} as unknown as Project;

describe("sequences", () => {
  it("finds the sequence being edited", () => expect(activeSequence(project).id).toBe("inner"));
  it("maps a compound clip to its contents and nothing else", () => {
    expect(compoundOf(project, clip("m1"))?.id).toBe("inner");
    expect(compoundOf(project, clip("m2"))).toBeNull();
    expect(compoundOf(project, clip("m3"))).toBeNull();
    expect(compoundOf(project, undefined)).toBeNull();
  });
  it("goes back to the main timeline, not a snapshot or a compound", () => expect(mainSequence(project)?.id).toBe("main"));
});
