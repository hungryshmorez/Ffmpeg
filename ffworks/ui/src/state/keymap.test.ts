import { describe, expect, it } from "vitest";
import { actionFor, bindings, chordOf, clear, hintFor, parseOverrides, rebind, reset, SHORTCUT_ACTIONS } from "./keymap";

const ev = (key: string, mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {}) => ({
  key,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe("chordOf", () => {
  it("names keys with modifiers in a fixed order and treats Cmd as Ctrl", () => {
    expect(chordOf(ev("s", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+S");
    expect(chordOf(ev("z", { meta: true }))).toBe("Ctrl+Z");
    expect(chordOf(ev(" "))).toBe("Space");
    expect(chordOf(ev("ArrowLeft", { shift: true }))).toBe("Shift+ArrowLeft");
    expect(chordOf(ev("k", { alt: true, ctrl: true }))).toBe("Ctrl+Alt+K");
  });
  it("ignores a lone modifier", () => {
    expect(chordOf(ev("Shift", { shift: true }))).toBeNull();
    expect(chordOf(ev("Control", { ctrl: true }))).toBeNull();
  });
});

describe("bindings", () => {
  it("defaults match the old fixed shortcuts", () => {
    expect(actionFor({}, "Ctrl+Z")).toBe("undo");
    expect(actionFor({}, "Ctrl+Shift+Z")).toBe("redo");
    expect(actionFor({}, "Shift+Delete")).toBe("ripple");
    expect(actionFor({}, "S")).toBe("split");
    expect(actionFor({}, "Q")).toBeNull();
  });
  it("no default key is used by two actions", () => {
    const all = SHORTCUT_ACTIONS.flatMap((a) => a.defaults);
    expect(new Set(all).size).toBe(all.length);
  });
  it("rebinding takes the key away from its old owner", () => {
    const { overrides, took } = rebind({}, "marker", "S");
    expect(took).toEqual(["split"]);
    expect(actionFor(overrides, "S")).toBe("marker");
    expect(bindings(overrides).split).toEqual([]);
    expect(actionFor(overrides, "M")).toBeNull();
  });
  it("reset restores defaults except keys now owned elsewhere", () => {
    let o = rebind({}, "marker", "S").overrides;
    o = reset(o, "split");
    expect(bindings(o).split).toEqual([]); // S belongs to marker now
    o = reset(o, "marker");
    o = reset(o, "split");
    expect(o).toEqual({});
  });
  it("clear removes a shortcut and the hint disappears", () => {
    const o = clear({}, "play");
    expect(actionFor(o, "Space")).toBeNull();
    expect(hintFor(o, "play")).toBeUndefined();
    expect(hintFor({}, "redo")).toBe("Ctrl+Y / Ctrl+Shift+Z");
  });
  it("parses saved overrides defensively", () => {
    expect(parseOverrides(null)).toEqual({});
    expect(parseOverrides("not json")).toEqual({});
    expect(parseOverrides('{"play":["P"],"bogus":["X"],"undo":"Ctrl+Z","split":["S"]}')).toEqual({ play: ["P"] });
  });
});
