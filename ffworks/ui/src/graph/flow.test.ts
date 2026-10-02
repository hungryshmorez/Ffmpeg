import { describe, expect, it } from "vitest";
import type { FilterGraph, FilterHelp } from "../types";
import { canConnect, fromFlow, newNodeId, padCounts, pruneEdges, toFlow } from "./flow";

const help = (inputs: string[], outputs: string[]): FilterHelp => ({ name: "x", description: "", inputs, outputs, options: [], timeline: false });
const g: FilterGraph = {
  nodes: [
    { id: "in", filter: "", options: [], x: 0, y: 0 },
    { id: "sp", filter: "split", options: [["outputs", "3"]], x: 100, y: 10 },
    { id: "out", filter: "", options: [], x: 400, y: 0 },
  ],
  edges: [{ from: "in", from_pad: 0, to: "sp", to_pad: 0 }, { from: "sp", from_pad: 2, to: "out", to_pad: 0 }],
};

describe("padCounts", () => {
  it("uses FFmpeg's pad list", () => expect(padCounts(help(["a", "b"], ["c"]), "overlay", [])).toEqual({ ins: 2, outs: 1 }));
  it("uses the outputs option for split, default 2", () => {
    expect(padCounts(help(["a"], ["dynamic (depending on the options)"]), "split", [["outputs", "3"]]).outs).toBe(3);
    expect(padCounts(help(["a"], ["dynamic"]), "split", []).outs).toBe(2);
  });
  it("uses the inputs option for dynamic inputs (hstack, amix)", () => expect(padCounts(help(["dynamic"], ["o"]), "hstack", [["inputs", "4"]]).ins).toBe(4));
  it("ignores nonsense counts", () => expect(padCounts(help(["dynamic"], ["o"]), "hstack", [["inputs", "999"]]).ins).toBe(2));
});

describe("graph <-> flow", () => {
  const helps = { split: help(["a"], ["dynamic"]) };
  it("round-trips nodes, positions and pads", () => {
    const f = toFlow(g, helps);
    expect(f.nodes.find((n) => n.id === "sp")!.data.outs).toBe(3);
    expect(f.edges[1]).toMatchObject({ sourceHandle: "o2", targetHandle: "i0" });
    expect(fromFlow(f.nodes, f.edges)).toEqual(g);
  });
  it("in and out cannot be deleted and have the right pads", () => {
    const f = toFlow(g, helps);
    const i = f.nodes.find((n) => n.id === "in")!, o = f.nodes.find((n) => n.id === "out")!;
    expect([i.deletable, i.data.ins, i.data.outs]).toEqual([false, 0, 1]);
    expect([o.deletable, o.data.ins, o.data.outs]).toEqual([false, 1, 0]);
  });
  it("prunes connections to pads that no longer exist", () => {
    const f = toFlow(g, helps);
    f.nodes.find((n) => n.id === "sp")!.data.outs = 2;
    expect(pruneEdges(f.nodes, f.edges)).toHaveLength(1);
  });
});

describe("canConnect / newNodeId", () => {
  const f = toFlow(g, { split: help(["a"], ["dynamic"]) });
  it("refuses used pads and self loops", () => {
    expect(canConnect(f.edges, { source: "in", sourceHandle: "o0", target: "sp", targetHandle: "i0" })).toBe(false);
    expect(canConnect(f.edges, { source: "sp", sourceHandle: "o0", target: "sp", targetHandle: "i0" })).toBe(false);
    expect(canConnect(f.edges, { source: "sp", sourceHandle: "o0", target: "out", targetHandle: "i1" })).toBe(true);
  });
  it("numbers repeated filters", () => {
    expect(newNodeId(f.nodes, "hue")).toBe("hue");
    expect(newNodeId(f.nodes, "split")).toBe("split");
    expect(newNodeId([...f.nodes, { ...f.nodes[1]!, id: "hue" }, { ...f.nodes[1]!, id: "hue2" }], "hue")).toBe("hue3");
  });
});
