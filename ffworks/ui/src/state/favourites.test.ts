import { describe, expect, it } from "vitest";
import type { Favourites } from "../types";
import { addGroup, poolIds, removeGroup, toggleInGroup, toggleStar } from "./favourites";

const empty: Favourites = { starred: { effects: [], transitions: [] }, groups: {} };

describe("favourites", () => {
  it("stars and unstars without touching the other kind", () => {
    const a = toggleStar(empty, "effects", "blur");
    expect(a.starred).toEqual({ effects: ["blur"], transitions: [] });
    expect(toggleStar(a, "effects", "blur").starred.effects).toEqual([]);
    expect(toggleStar(a, "transitions", "fade").starred).toEqual({ effects: ["blur"], transitions: ["fade"] });
  });
  it("creates groups once, toggles members, removes groups", () => {
    let f = addGroup(empty, "  Glitchy ");
    expect(Object.keys(f.groups)).toEqual(["Glitchy"]);
    expect(addGroup(f, "Glitchy")).toBe(f);
    expect(addGroup(f, "  ")).toBe(f);
    f = toggleInGroup(f, "Glitchy", "effects", "noise");
    f = toggleInGroup(f, "Glitchy", "transitions", "pixelize");
    expect(f.groups.Glitchy).toEqual({ effects: ["noise"], transitions: ["pixelize"] });
    expect(removeGroup(f, "Glitchy").groups).toEqual({});
  });
  it("pools: all is unrestricted, favourites/groups are lists, a missing group is empty", () => {
    let f = toggleStar(empty, "effects", "hue");
    f = toggleInGroup(f, "Clean", "effects", "contrast");
    expect(poolIds(f, "all", "effects")).toBeNull();
    expect(poolIds(f, "favourites", "effects")).toEqual(["hue"]);
    expect(poolIds(f, "Clean", "effects")).toEqual(["contrast"]);
    expect(poolIds(f, "Clean", "transitions")).toEqual([]);
    expect(poolIds(f, "Gone", "effects")).toEqual([]);
  });
});
