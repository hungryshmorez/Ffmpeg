/* =============================================================================
   nodegraph.js — VISUAL filter_complex EDITOR
   -----------------------------------------------------------------------------
   FFmpeg's `filter_complex` IS a node graph. It has named inputs, named outputs,
   branches ([a][b]), and merges. We've been hiding that behind 32 accordion
   sections and a hardcoded 6-step "Lagfun Massacre".

   Expose it as what it is: drag filter nodes onto a canvas, wire outputs to
   inputs, branch, merge — and compile the canvas straight to a filter_complex
   string. Save any graph as a named custom workflow.

   This turns the Lagfun Massacre from a thing you HARDCODE into a thing you
   BUILD.
   ========================================================================== */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // NODE LIBRARY — name, ffmpeg filter, params, arity
  // ---------------------------------------------------------------------------

  const LIB = {
    // sources / sinks
    input:  { label: 'Input',  color: '#44ff88', in: 0, out: 1, filter: null, params: {} },
    output: { label: 'Output', color: '#ff4444', in: 1, out: 0, filter: null, params: {} },

    // colour
    eq:        { label: 'Colour (eq)', color: '#00d4ff', in: 1, out: 1, filter: 'eq',
                 params: { brightness: 0, contrast: 1, saturation: 1, gamma: 1 } },
    hue:       { label: 'Hue',         color: '#00d4ff', in: 1, out: 1, filter: 'hue',
                 params: { h: 0, s: 1 } },
    curves:    { label: 'Curves',      color: '#00d4ff', in: 1, out: 1, filter: 'curves',
                 params: { preset: 'vintage' } },
    lut3d:     { label: 'LUT (3D)',    color: '#00d4ff', in: 1, out: 1, filter: 'lut3d',
                 params: { file: 'lut.cube' } },
    negate:    { label: 'Invert',      color: '#00d4ff', in: 1, out: 1, filter: 'negate', params: {} },

    // geometry
    scale:  { label: 'Scale',  color: '#ffcc00', in: 1, out: 1, filter: 'scale',
              params: { w: 1280, h: -2, flags: 'lanczos' } },
    crop:   { label: 'Crop',   color: '#ffcc00', in: 1, out: 1, filter: 'crop',
              params: { w: 'iw', h: 'ih', x: 0, y: 0 } },
    pad:    { label: 'Pad',    color: '#ffcc00', in: 1, out: 1, filter: 'pad',
              params: { w: 'iw', h: 'ih', x: 0, y: 0, color: 'black' } },
    hflip:  { label: 'H-Flip', color: '#ffcc00', in: 1, out: 1, filter: 'hflip', params: {} },
    rotate: { label: 'Rotate', color: '#ffcc00', in: 1, out: 1, filter: 'rotate',
              params: { a: '0', c: 'black' } },

    // temporal / glitch
    lagfun:      { label: 'Lagfun',       color: '#ff00aa', in: 1, out: 1, filter: 'lagfun',
                   params: { decay: 0.95 } },
    tmix:        { label: 'Frame Mix',    color: '#ff00aa', in: 1, out: 1, filter: 'tmix',
                   params: { frames: 5 } },
    tblend:      { label: 'Temporal Blend', color: '#ff00aa', in: 1, out: 1, filter: 'tblend',
                   params: { all_mode: 'difference' } },
    rgbashift:   { label: 'RGB Shift',    color: '#ff00aa', in: 1, out: 1, filter: 'rgbashift',
                   params: { rh: 4, bh: -4 } },
    noise:       { label: 'Noise',        color: '#ff00aa', in: 1, out: 1, filter: 'noise',
                   params: { alls: 20, allf: 't+u' } },
    geq:         { label: 'Pixel Math (geq)', color: '#ff00aa', in: 1, out: 1, filter: 'geq',
                   params: { lum_expr: 'lum(X,Y)' } },

    // spatial
    gblur:   { label: 'Blur',    color: '#8888ff', in: 1, out: 1, filter: 'gblur', params: { sigma: 3 } },
    unsharp: { label: 'Sharpen', color: '#8888ff', in: 1, out: 1, filter: 'unsharp',
               params: { luma_msize_x: 5, luma_msize_y: 5, luma_amount: 1 } },
    vignette:{ label: 'Vignette',color: '#8888ff', in: 1, out: 1, filter: 'vignette', params: { angle: 0.6 } },
    edgedetect:{label:'Edge Detect', color:'#8888ff', in:1, out:1, filter:'edgedetect',
               params: { mode: 'colormix' } },

    // multi-input
    split:   { label: 'Split',   color: '#aaaaaa', in: 1, out: 2, filter: 'split',   params: {} },
    blend:   { label: 'Blend',   color: '#aaaaaa', in: 2, out: 1, filter: 'blend',
               params: { all_mode: 'screen', all_opacity: 0.5 } },
    overlay: { label: 'Overlay', color: '#aaaaaa', in: 2, out: 1, filter: 'overlay',
               params: { x: 0, y: 0 } },
    hstack:  { label: 'H-Stack', color: '#aaaaaa', in: 2, out: 1, filter: 'hstack', params: { inputs: 2 } },
    vstack:  { label: 'V-Stack', color: '#aaaaaa', in: 2, out: 1, filter: 'vstack', params: { inputs: 2 } },
  };

  const G = { nodes: [], edges: [], nextId: 1, sel: null, drag: null, wire: null, pan: { x: 0, y: 0 }, zoom: 1 };

  let cv, ctx, panel;

  // ---------------------------------------------------------------------------
  // MODEL
  // ---------------------------------------------------------------------------

  function addNode(type, x, y) {
    const def = LIB[type];
    if (!def) return null;
    const n = {
      id: G.nextId++,
      type, x, y, w: 150, h: 34 + Object.keys(def.params).length * 0,
      params: JSON.parse(JSON.stringify(def.params)),
    };
    G.nodes.push(n);
    draw();
    return n;
  }

  function removeNode(id) {
    G.nodes = G.nodes.filter((n) => n.id !== id);
    G.edges = G.edges.filter((e) => e.from.node !== id && e.to.node !== id);
    if (G.sel === id) { G.sel = null; renderInspector(); }
    draw();
  }

  function connect(fromNode, fromPort, toNode, toPort) {
    // One edge per input port. Re-wiring replaces.
    G.edges = G.edges.filter((e) => !(e.to.node === toNode && e.to.port === toPort));
    G.edges.push({ from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } });
    draw();
  }

  // ---------------------------------------------------------------------------
  // COMPILE  →  filter_complex
  // ---------------------------------------------------------------------------

  function paramStr(node) {
    const def = LIB[node.type];
    const kv = Object.entries(node.params)
      .filter(([, v]) => v !== '' && v != null)
      .map(([k, v]) => `${k}=${v}`);
    if (!def.filter) return null;
    return kv.length ? `${def.filter}=${kv.join(':')}` : def.filter;
  }

  /** Topologically sort and emit a filter_complex string. */
  function compile() {
    const inputs  = G.nodes.filter((n) => n.type === 'input');
    const outputs = G.nodes.filter((n) => n.type === 'output');
    if (!inputs.length)  return { error: 'Add an Input node.' };
    if (!outputs.length) return { error: 'Add an Output node.' };

    const incoming = (id, port) => G.edges.find((e) => e.to.node === id && e.to.port === port);
    const label = new Map();          // "nodeId:port" → ffmpeg label
    let counter = 0;
    const chains = [];
    const visiting = new Set();

    // Resolve a node's output-port label, building its chain on the way.
    function resolve(id, port) {
      const key = `${id}:${port}`;
      if (label.has(key)) return label.get(key);
      if (visiting.has(id)) throw new Error('Cycle detected in the graph.');
      visiting.add(id);

      const node = G.nodes.find((n) => n.id === id);
      const def  = LIB[node.type];

      if (node.type === 'input') {
        const idx = inputs.indexOf(node);
        const l = `${idx}:v`;
        label.set(key, l);
        visiting.delete(id);
        return l;
      }

      // Gather this node's inputs.
      const srcs = [];
      for (let p = 0; p < def.in; p++) {
        const e = incoming(id, p);
        if (!e) throw new Error(`"${def.label}" input ${p + 1} is not connected.`);
        srcs.push(resolve(e.from.node, e.from.port));
      }

      const f = paramStr(node);
      const outs = [];
      for (let p = 0; p < def.out; p++) outs.push(`n${counter}_${p}`);
      counter++;

      chains.push(
        srcs.map((s) => `[${s}]`).join('') +
        f +
        outs.map((o) => `[${o}]`).join('')
      );

      outs.forEach((o, p) => label.set(`${id}:${p}`, o));
      visiting.delete(id);
      return label.get(key);
    }

    try {
      const outNode = outputs[0];
      const e = incoming(outNode.id, 0);
      if (!e) return { error: 'The Output node is not connected.' };
      const final = resolve(e.from.node, e.from.port);

      const fc = chains.join(';');
      return {
        filterComplex: fc,
        outLabel: final,
        args: ['-filter_complex', fc, '-map', `[${final}]`],
        chains,
      };
    } catch (err) {
      return { error: err.message };
    }
  }

  // ---------------------------------------------------------------------------
  // DRAW
  // ---------------------------------------------------------------------------

  const PORT_R = 6;
  const portPos = (n, kind, i) => {
    const def = LIB[n.type];
    const count = kind === 'in' ? def.in : def.out;
    const y = n.y + (n.h / (count + 1)) * (i + 1);
    return { x: kind === 'in' ? n.x : n.x + n.w, y };
  };

  function draw() {
    if (!ctx) return;
    const w = cv.clientWidth, h = cv.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    // grid
    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 24) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 24) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

    // edges
    ctx.lineWidth = 2;
    for (const e of G.edges) {
      const a = G.nodes.find((n) => n.id === e.from.node);
      const b = G.nodes.find((n) => n.id === e.to.node);
      if (!a || !b) continue;
      const p1 = portPos(a, 'out', e.from.port);
      const p2 = portPos(b, 'in',  e.to.port);
      ctx.strokeStyle = LIB[a.type].color;
      bezier(p1, p2);
    }

    // in-flight wire
    if (G.wire) {
      ctx.strokeStyle = '#666'; ctx.setLineDash([4, 4]);
      bezier(G.wire.from, G.wire.to);
      ctx.setLineDash([]);
    }

    // nodes
    for (const n of G.nodes) {
      const def = LIB[n.type];
      ctx.fillStyle = G.sel === n.id ? '#232323' : '#1a1a1a';
      ctx.strokeStyle = G.sel === n.id ? def.color : '#333';
      ctx.lineWidth = G.sel === n.id ? 2 : 1;
      round(n.x, n.y, n.w, n.h, 6);
      ctx.fill(); ctx.stroke();

      ctx.fillStyle = def.color;
      ctx.fillRect(n.x, n.y, 4, n.h);

      ctx.fillStyle = '#e0e0e0';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(def.label, n.x + 12, n.y + 21);

      ctx.fillStyle = def.color;
      for (let i = 0; i < def.in; i++)  dot(portPos(n, 'in', i));
      for (let i = 0; i < def.out; i++) dot(portPos(n, 'out', i));
    }
  }

  function bezier(a, b) {
    const dx = Math.max(30, Math.abs(b.x - a.x) * 0.5);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(a.x + dx, a.y, b.x - dx, b.y, b.x, b.y);
    ctx.stroke();
  }
  function dot(p) { ctx.beginPath(); ctx.arc(p.x, p.y, PORT_R, 0, Math.PI * 2); ctx.fill(); }
  function round(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------------------------------------------------------------------------
  // INTERACTION
  // ---------------------------------------------------------------------------

  function hitPort(x, y) {
    for (const n of G.nodes) {
      const def = LIB[n.type];
      for (let i = 0; i < def.out; i++) {
        const p = portPos(n, 'out', i);
        if (Math.hypot(x - p.x, y - p.y) < PORT_R + 4) return { node: n.id, port: i, kind: 'out', pos: p };
      }
      for (let i = 0; i < def.in; i++) {
        const p = portPos(n, 'in', i);
        if (Math.hypot(x - p.x, y - p.y) < PORT_R + 4) return { node: n.id, port: i, kind: 'in', pos: p };
      }
    }
    return null;
  }

  const hitNode = (x, y) =>
    [...G.nodes].reverse().find((n) => x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h);

  function bindCanvas() {
    cv.addEventListener('pointerdown', (e) => {
      const x = e.offsetX, y = e.offsetY;
      const port = hitPort(x, y);
      if (port && port.kind === 'out') {
        G.wire = { fromPort: port, from: port.pos, to: { x, y } };
        return;
      }
      const n = hitNode(x, y);
      if (n) {
        G.sel = n.id;
        G.drag = { id: n.id, dx: x - n.x, dy: y - n.y };
        renderInspector();
      } else { G.sel = null; renderInspector(); }
      draw();
    });

    cv.addEventListener('pointermove', (e) => {
      const x = e.offsetX, y = e.offsetY;
      if (G.wire) { G.wire.to = { x, y }; draw(); return; }
      if (G.drag) {
        const n = G.nodes.find((v) => v.id === G.drag.id);
        n.x = x - G.drag.dx; n.y = y - G.drag.dy;
        draw();
      }
    });

    cv.addEventListener('pointerup', (e) => {
      if (G.wire) {
        const t = hitPort(e.offsetX, e.offsetY);
        if (t && t.kind === 'in' && t.node !== G.wire.fromPort.node) {
          connect(G.wire.fromPort.node, G.wire.fromPort.port, t.node, t.port);
        }
        G.wire = null;
      }
      G.drag = null;
      draw();
    });

    cv.addEventListener('dblclick', (e) => {
      const n = hitNode(e.offsetX, e.offsetY);
      if (n && n.type !== 'input' && n.type !== 'output') removeNode(n.id);
    });
  }

  // ---------------------------------------------------------------------------
  // INSPECTOR
  // ---------------------------------------------------------------------------

  function renderInspector() {
    const el = document.getElementById('ng-inspector');
    if (!el) return;
    const n = G.nodes.find((v) => v.id === G.sel);
    if (!n) { el.innerHTML = '<p class="dim">Select a node to edit its parameters.</p>'; return; }

    const def = LIB[n.type];
    el.innerHTML = `<h4 style="color:${def.color}">${def.label}</h4>` +
      (Object.keys(n.params).length
        ? Object.entries(n.params).map(([k, v]) => `
            <label class="ng-field">
              <span>${k}</span>
              <input data-k="${k}" value="${v}" class="ctrl">
            </label>`).join('')
        : '<p class="dim">No parameters.</p>') +
      (n.type !== 'input' && n.type !== 'output'
        ? `<button type="button" class="mini-btn danger" id="ng-del">Delete node</button>` : '');

    el.querySelectorAll('input[data-k]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const raw = inp.value;
        const num = parseFloat(raw);
        n.params[inp.dataset.k] = (raw !== '' && !isNaN(num) && String(num) === raw.trim()) ? num : raw;
        refreshPreview();
      });
    });
    el.querySelector('#ng-del')?.addEventListener('click', () => removeNode(n.id));
  }

  function refreshPreview() {
    const out = document.getElementById('ng-output');
    if (!out) return;
    const r = compile();
    out.className = r.error ? 'ng-output err' : 'ng-output';
    out.textContent = r.error ? `⚠ ${r.error}` : r.filterComplex;
  }

  // ---------------------------------------------------------------------------
  // MOUNT
  // ---------------------------------------------------------------------------

  function mount(container) {
    const el = container || document.getElementById('nodegraph-panel');
    if (!el) return;

    el.innerHTML = `
      <div class="ng-wrap">
        <aside class="ng-lib">
          <h4>Nodes</h4>
          <div id="ng-lib-list"></div>
        </aside>
        <div class="ng-canvas-wrap">
          <canvas id="ng-canvas"></canvas>
          <div class="ng-hint">Drag a node from the left · drag port→port to wire · double-click a node to delete</div>
        </div>
        <aside class="ng-side">
          <div id="ng-inspector"><p class="dim">Select a node.</p></div>
          <h4>filter_complex</h4>
          <pre id="ng-output" class="ng-output">—</pre>
          <button type="button" class="mini-btn wide" id="ng-run">▶ Run this graph</button>
          <button type="button" class="mini-btn wide" id="ng-save">💾 Save as workflow</button>
          <button type="button" class="mini-btn wide" id="ng-clear">✕ Clear</button>
        </aside>
      </div>`;

    document.getElementById('ng-lib-list').innerHTML = Object.entries(LIB)
      .map(([k, d]) => `<button type="button" class="ng-node-btn" data-t="${k}"
        style="border-left-color:${d.color}">${d.label}</button>`).join('');

    cv = document.getElementById('ng-canvas');
    ctx = cv.getContext('2d');
    bindCanvas();

    document.getElementById('ng-lib-list').addEventListener('click', (e) => {
      const b = e.target.closest('.ng-node-btn');
      if (!b) return;
      addNode(b.dataset.t, 60 + Math.random() * 120, 60 + Math.random() * 160);
      refreshPreview();
    });

    document.getElementById('ng-run').addEventListener('click', async () => {
      const r = compile();
      if (r.error) return window.logToConsole?.('error', `[graph] ${r.error}`);
      const m = window.state?.inputFile;
      if (!m) return window.logToConsole?.('warn', 'No file selected.');

      window.logToConsole?.('', `[graph] -filter_complex "${r.filterComplex}"`);
      await window.executeFFmpeg?.([
        '-i', m.virtualName, ...r.args,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1',
        '-pix_fmt', 'yuv420p', '-y', 'graph_out.mp4',
      ]);
    });

    document.getElementById('ng-save').addEventListener('click', () => {
      const r = compile();
      if (r.error) return window.logToConsole?.('error', `[graph] ${r.error}`);
      const name = prompt('Name this workflow:', 'My Graph');
      if (!name) return;
      const key = window.FFStorage?.KEY_CUSTOM || 'ffs.customWorkflows.v1';
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      list.push({
        id: `graph-${Date.now()}`, name, category: 'my-custom', icon: '⛓️',
        description: 'Built in the node graph editor.',
        tags: ['graph', 'custom', 'filter_complex'],
        filterComplex: r.filterComplex, outLabel: r.outLabel,
        graph: { nodes: G.nodes, edges: G.edges },
        settings: {},
      });
      localStorage.setItem(key, JSON.stringify(list));
      window.logToConsole?.('ok', `[graph] saved "${name}" to My Custom.`);
      window.renderWorkflows?.();
    });

    document.getElementById('ng-clear').addEventListener('click', () => {
      G.nodes = []; G.edges = []; G.sel = null; G.nextId = 1;
      draw(); renderInspector(); refreshPreview();
    });

    // Start with a usable skeleton.
    const i = addNode('input',  40, 120);
    const e = addNode('eq',     240, 120);
    const o = addNode('output', 460, 120);
    connect(i.id, 0, e.id, 0);
    connect(e.id, 0, o.id, 0);

    window.addEventListener('resize', draw);
    draw(); renderInspector(); refreshPreview();
  }

  window.FFNodeGraph = { mount, compile, addNode, connect, LIB, G };
})();

// Mount lazily when the Graph tab is first opened.
document.addEventListener('DOMContentLoaded', () => {
  let mounted = false;
  document.querySelector('[data-tab="graph"]')?.addEventListener('click', () => {
    if (!mounted) { mounted = true; setTimeout(() => window.FFNodeGraph.mount(), 60); }
  });
});
