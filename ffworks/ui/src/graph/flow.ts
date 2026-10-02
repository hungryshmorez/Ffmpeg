import type { Node } from "@xyflow/react";
import type { FilterGraph, FilterHelp, GEdge } from "../types";

export const IN = "in";
export const OUT = "out";

export interface FNodeData extends Record<string, unknown> {
  filter: string;
  options: [string, string][];
  ins: number;
  outs: number;
}
export type FlowNode = Node<FNodeData, "fnode">;
export interface FlowEdge { id: string; source: string; sourceHandle: string; target: string; targetHandle: string }

const opt = (o: [string, string][], k: string) => o.find(([key]) => key === k)?.[1];

/** Input/output pad counts of a filter node: from FFmpeg's pad list, or the `inputs`/`outputs` option for dynamic-pad filters. */
export function padCounts(help: FilterHelp | undefined, filter: string, options: [string, string][]): { ins: number; outs: number } {
  const count = (pads: string[], key: string, fallback: number) => {
    if (pads.some((p) => p.startsWith("dynamic"))) {
      const n = parseInt(opt(options, key) ?? "", 10);
      return Number.isFinite(n) && n >= 1 && n <= 16 ? n : fallback;
    }
    return pads.length;
  };
  if (!help) return { ins: filter === "split" ? 1 : 1, outs: filter === "split" ? 2 : 1 };
  return { ins: count(help.inputs, "inputs", 2), outs: filter === "split" ? count(["dynamic"], "outputs", 2) : count(help.outputs, "outputs", 1) };
}

export function toFlow(g: FilterGraph, helps: Record<string, FilterHelp>): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = g.nodes.map((n) => {
    const fixed = n.id === IN || n.id === OUT;
    const { ins, outs } = fixed ? { ins: n.id === OUT ? 1 : 0, outs: n.id === IN ? 1 : 0 } : padCounts(helps[n.filter], n.filter, n.options);
    return { id: n.id, type: "fnode", position: { x: n.x, y: n.y }, data: { filter: n.filter, options: n.options, ins, outs }, deletable: !fixed };
  });
  const edges: FlowEdge[] = g.edges.map((e, i) => ({ id: `e${i}-${e.from}-${e.to}`, source: e.from, sourceHandle: `o${e.from_pad}`, target: e.to, targetHandle: `i${e.to_pad}` }));
  return { nodes, edges };
}

export function fromFlow(nodes: FlowNode[], edges: FlowEdge[]): FilterGraph {
  const pad = (h: string) => parseInt(h.slice(1), 10) || 0;
  return {
    nodes: nodes.map((n) => ({ id: n.id, filter: n.data.filter, options: n.data.options, x: Math.round(n.position.x), y: Math.round(n.position.y) })),
    edges: edges.map((e): GEdge => ({ from: e.source, from_pad: pad(e.sourceHandle), to: e.target, to_pad: pad(e.targetHandle) })),
  };
}

/** A connection is allowed when both pads are free and it does not join a node to itself. */
export function canConnect(edges: FlowEdge[], c: { source: string; sourceHandle: string | null; target: string; targetHandle: string | null }): boolean {
  if (c.source === c.target) return false;
  return !edges.some((e) => (e.source === c.source && e.sourceHandle === c.sourceHandle) || (e.target === c.target && e.targetHandle === c.targetHandle));
}

/** Drop connections that point at pads a node no longer has (after an `outputs`/`inputs` option change). */
export function pruneEdges(nodes: FlowNode[], edges: FlowEdge[]): FlowEdge[] {
  const by = new Map(nodes.map((n) => [n.id, n]));
  return edges.filter((e) => {
    const s = by.get(e.source), t = by.get(e.target);
    return !!s && !!t && pad(e.sourceHandle) < s.data.outs && pad(e.targetHandle) < t.data.ins;
  });
}
const pad = (h: string) => parseInt(h.slice(1), 10) || 0;

/** Next unused node id for a filter: `hue`, `hue2`, … */
export function newNodeId(nodes: FlowNode[], filter: string): string {
  const used = new Set(nodes.map((n) => n.id));
  if (!used.has(filter)) return filter;
  let i = 2;
  while (used.has(`${filter}${i}`)) i++;
  return `${filter}${i}`;
}
