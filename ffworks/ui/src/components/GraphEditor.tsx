import "@xyflow/react/dist/style.css";
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, type NodeProps } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { canConnect, fromFlow, newNodeId, padCounts, pruneEdges, toFlow, type FlowEdge, type FlowNode } from "../graph/flow";
import { useProject, useUi } from "../state/stores";
import type { FilterHelp, FilterInfo } from "../types";

function FNode({ id, data, selected }: NodeProps<FlowNode>) {
  const label = id === "in" ? "Clip picture (in)" : id === "out" ? "Result (out)" : data.filter;
  const pad = (n: number, i: number) => `${((i + 1) / (n + 1)) * 100}%`;
  return (
    <div className={`gnode ${selected ? "sel" : ""} ${id === "in" || id === "out" ? "fixed" : ""}`} data-node={id}>
      {Array.from({ length: data.ins }, (_, i) => <Handle key={`i${i}`} id={`i${i}`} type="target" position={Position.Left} style={{ top: pad(data.ins, i) }} />)}
      <b>{label}</b>
      {id !== "in" && id !== "out" && <div className="muted">{data.options.map(([k, v]) => `${k}=${v}`).join(" ") || "defaults"}</div>}
      {Array.from({ length: data.outs }, (_, i) => <Handle key={`o${i}`} id={`o${i}`} type="source" position={Position.Right} style={{ top: pad(data.outs, i) }} />)}
    </div>
  );
}
const nodeTypes = { fnode: FNode };

/** Visual editor for a `graph` effect: pick filters, wire pads, edit options; Apply is one undoable command. */
export function GraphEditor() {
  const edit = useUi((s) => s.graphEdit);
  if (!edit) return null;
  return <ReactFlowProvider><Inner key={`${edit.clip}/${edit.fx}`} clip={edit.clip} fx={edit.fx} /></ReactFlowProvider>;
}

function Inner({ clip, fx }: { clip: string; fx: string }) {
  const close = () => useUi.getState().setGraphEdit(null);
  const view = useProject((s) => s.view)!;
  const dispatch = useProject((s) => s.dispatch);
  const toast = useProject((s) => s.toast);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const helps = useRef<Record<string, FilterHelp>>({});
  const [all, setAll] = useState<FilterInfo[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  const ensureHelp = useCallback(async (f: string) => {
    if (!helps.current[f]) helps.current[f] = await api.filterHelp(f);
    return helps.current[f];
  }, []);

  useEffect(() => {
    void api.listFilters().then((l) => setAll(l.filter((f) => !["movie", "amovie"].includes(f.name))));
    const c = view.project.sequences.flatMap((s) => s.tracks.flatMap((t) => t.clips)).find((x) => x.id === clip);
    const g = c?.effects.find((e) => e.id === fx)?.graph;
    if (!g) return;
    void Promise.all([...new Set(g.nodes.map((n) => n.filter).filter(Boolean))].map(ensureHelp)).then(() => {
      const f = toFlow(g, helps.current);
      setNodes(f.nodes);
      setEdges(f.edges);
      setReady(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return all.filter((f) => f.io.startsWith("V") || f.io.startsWith("|") || f.io.startsWith("N")).filter((f) => f.io.includes("V")).filter((f) => !n || f.name.includes(n) || f.description.toLowerCase().includes(n)).slice(0, 80);
  }, [all, q]);

  const addNode = async (f: string) => {
    const h = await ensureHelp(f);
    setNodes((ns) => {
      const id = newNodeId(ns, f);
      const { ins, outs } = padCounts(h, f, []);
      return [...ns, { id, type: "fnode", position: { x: 160 + (ns.length % 5) * 40, y: 40 + ns.length * 36 }, data: { filter: f, options: [], ins, outs } }];
    });
    setProblems([]);
  };

  const selected = nodes.find((n) => n.id === sel && n.id !== "in" && n.id !== "out");
  const selHelp = selected ? helps.current[selected.data.filter] : undefined;
  const setOptions = (id: string, options: [string, string][]) => {
    setNodes((ns) => {
      const next = ns.map((n) => {
        if (n.id !== id) return n;
        const { ins, outs } = padCounts(helps.current[n.data.filter], n.data.filter, options);
        return { ...n, data: { ...n.data, options, ins, outs } };
      });
      setEdges((es) => pruneEdges(next, es));
      return next;
    });
    setProblems([]);
  };

  const apply = async () => {
    const graph = fromFlow(nodes, edges);
    try {
      const p = await api.checkFilterGraph(graph);
      if (p.length) { setProblems(p); return; }
      await dispatch({ type: "set_effect_graph", clip, effect_id: fx, graph });
      close();
    } catch (e) { setProblems([String(e)]); toast("error", String(e)); }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Filter graph editor">
      <div className="modal graph-editor">
        <h2>Custom filter graph</h2>
        <div className="graph-cols">
          <div className="graph-palette" aria-label="Add a filter">
            <input type="search" aria-label="Search filters to add" placeholder="Search filters" value={q} onChange={(e) => setQ(e.target.value)} />
            <ul>
              {shown.map((f) => <li key={f.name}><button title={f.description} onClick={() => void addNode(f.name)}><b>{f.name}</b> <span className="muted">{f.io}</span></button></li>)}
            </ul>
          </div>
          <div className="graph-canvas" aria-label="Graph canvas">
            {ready && (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={(c) => setEdges((es) => (canConnect(es, c) ? [...es, { id: `e${Date.now()}`, source: c.source, sourceHandle: c.sourceHandle ?? "o0", target: c.target, targetHandle: c.targetHandle ?? "i0" }] : es))}
                isValidConnection={(c) => canConnect(edges, c)}
                onNodeClick={(_, n) => setSel(n.id)}
                onPaneClick={() => setSel(null)}
                colorMode="dark"
                fitView
                deleteKeyCode={["Backspace", "Delete"]}
              >
                <Background />
                <Controls showInteractive={false} />
              </ReactFlow>
            )}
          </div>
          <div className="graph-props" aria-label="Node options">
            {!selected && <p className="muted">Select a filter node to edit its options. Drag from a dot on the right of one node to a dot on the left of another to connect them. Each dot takes one connection; use a <b>split</b> node to use a picture twice.</p>}
            {selected && (
              <>
                <h3>{selected.data.filter}</h3>
                <p className="muted">{selHelp?.description}</p>
                {selected.data.options.map(([k, v], i) => (
                  <div key={i} className="row gopt">
                    <b>{k}</b>
                    <input aria-label={`Value of ${k}`} value={v} onChange={(e) => setOptions(selected.id, selected.data.options.map((o, j): [string, string] => (j === i ? [k, e.target.value] : o)))} />
                    <button className="small" aria-label={`Remove ${k}`} onClick={() => setOptions(selected.id, selected.data.options.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
                <select aria-label="Add option" value="" onChange={(e) => { const o = selHelp?.options.find((x) => x.name === e.target.value); if (o) setOptions(selected.id, [...selected.data.options, [o.name, o.default ?? ""]]); }}>
                  <option value="">Add option…</option>
                  {selHelp?.options.filter((o) => !selected.data.options.some(([k]) => k === o.name)).map((o) => <option key={o.name} value={o.name} title={o.description}>{o.name}</option>)}
                </select>
                {selHelp?.options.find((o) => selected.data.options.length && selected.data.options.some(([k]) => k === o.name)) && <p className="muted">Hover an option in the list for its description; the Filters browser shows ranges and choices.</p>}
              </>
            )}
          </div>
        </div>
        {problems.length > 0 && <ul className="err" aria-label="Problems">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
        <p className="muted">Filters that read files, load plugins or use the network are refused. Changing the picture size is fine: the result is refitted to the project frame. Not available together with transitions.</p>
        <div className="row end"><button onClick={close}>Cancel</button><button className="primary" onClick={() => void apply()}>Apply</button></div>
      </div>
    </div>
  );
}
