// In-webview test for the filter-graph node editor. Placeholders __SRC__ __OUT__ are substituted by graph.sh.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const setSel = (sel, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, v); sel.dispatchEvent(new Event("change", { bubbles: true })); };
  const setIn = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
  const select = async (el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: r.left + 20, clientY: r.top + 10 })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 })); await sleep(250); };
  const vclip = () => view().project.sequences[0].tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips)[0];
  const graphOf = () => (vclip().effects.find((e) => e.effect === "graph") || {}).graph;
  const handle = (node, kind, pad) => $(`[data-node='${node}'] .react-flow__handle.${kind}[data-handleid='${pad}']`);
  const centre = (el) => { const r = el.getBoundingClientRect(); return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; };
  // a real drag from an output dot to an input dot, as a user would do it
  const connect = async (from, to) => {
    const a = handle(from, "source", "o0"), b = handle(to, "target", "i0");
    const pa = centre(a), pb = centre(b);
    const ev = (t, el, p) => el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 7, isPrimary: true, button: 0, buttons: t === "pointerup" ? 0 : 1, ...p }));
    const mev = (t, el, p) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, buttons: t === "mouseup" ? 0 : 1, ...p }));
    ev("pointerdown", a, pa); mev("mousedown", a, pa); await sleep(80);
    for (let i = 1; i <= 5; i++) { const p = { clientX: pa.clientX + (pb.clientX - pa.clientX) * i / 5, clientY: pa.clientY + (pb.clientY - pa.clientY) * i / 5 }; ev("pointermove", document, p); mev("mousemove", document, p); await sleep(40); }
    ev("pointerup", b, pb); mev("mouseup", b, pb); await sleep(250);
  };
  const addFilter = async (name) => {
    const box = $("input[aria-label='Search filters to add']"); setIn(box, name); await sleep(200);
    const btn = $$(".graph-palette li button").find((b) => b.querySelector("b").textContent === name); btn.click();
    await waitFor(() => $(`[data-node='${name}']`));
  };
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "0", duration: "3", with_audio: true }); await sleep(400);
    await select($$(".track.video .clip")[0]);
    const sel = await waitFor(() => { const e = $("[data-kind='video'] select[aria-label='Effect to add']"); return e && e.options.length > 3 ? e : null; });
    step("the video effect list offers the custom filter graph", !!sel && [...sel.options].some((o) => o.value === "graph"));
    setSel(sel, "graph"); [...document.querySelectorAll("[data-kind='video'] button")].find((b) => b.textContent === "Add").click();
    await waitFor(() => graphOf());
    step("adding it creates a pass-through graph (in -> out)", graphOf() && graphOf().nodes.length === 2 && graphOf().edges.length === 1, JSON.stringify(graphOf()));
    $$("button").find((b) => b.textContent.startsWith("Edit graph")).click();
    await waitFor(() => $$(".react-flow__node").length === 2);
    step("editor opens with the in and out nodes", $$(".react-flow__node").length === 2 && !!$("[data-node='in']") && !!$("[data-node='out']"));
    step("the pass-through edge is drawn", $$(".react-flow__edge").length === 1, $$(".react-flow__edge").length);

    await addFilter("negate"); await addFilter("hue");
    step("palette adds filter nodes", $$(".react-flow__node").length === 4);
    // remove the direct in->out connection: select its edge and press Delete
    const edgeEl = $(".react-flow__edge");
    edgeEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await sleep(200);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true })); await sleep(100);
    document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "Delete", code: "Delete", bubbles: true }));
    await sleep(300);
    step("Delete removes the selected connection", $$(".react-flow__edge").length === 0, $$(".react-flow__edge").length);
    step("...and does not delete the timeline clip behind the dialog", !!vclip() && !!graphOf(), vclip() ? "clip kept" : "clip was deleted");

    await connect("in", "negate"); await connect("negate", "hue");
    step("dragging between dots creates connections", $$(".react-flow__edge").length === 2, $$(".react-flow__edge").length);
    $$("button").find((b) => b.textContent === "Apply").click();
    const prob = await waitFor(() => $("[aria-label='Problems']"));
    step("Apply with a loose end shows the problem and changes nothing", !!prob && graphOf().nodes.length === 2, prob && prob.textContent);

    await connect("hue", "out");
    step("third connection made", $$(".react-flow__edge").length === 3, $$(".react-flow__edge").length);
    // second drag onto an already-used input must be refused
    await connect("negate", "out");
    step("an input that already has a connection refuses another", $$(".react-flow__edge").length === 3, $$(".react-flow__edge").length);

    $("[data-node='hue']").click(); await sleep(250);
    const add = await waitFor(() => $("select[aria-label='Add option']"));
    step("selecting a node shows its options with FFmpeg's option list", !!add && [...add.options].some((o) => o.value === "s") && [...add.options].some((o) => o.value === "h"), add && add.options.length);
    setSel(add, "s"); await waitFor(() => $("input[aria-label='Value of s']"));
    setIn($("input[aria-label='Value of s']"), "0"); await sleep(200);
    step("an added option keeps FFmpeg's default and can be edited", $("input[aria-label='Value of s']").value === "0");
    $$("button").find((b) => b.textContent === "Apply").click();
    await waitFor(() => !$("[aria-label='Filter graph editor']") && graphOf().nodes.length === 4);
    const g = graphOf();
    step("Apply stores the graph in the project (one command)", g.nodes.length === 4 && g.edges.length === 3, JSON.stringify(g.edges));
    const hue = g.nodes.find((n) => n.filter === "hue");
    step("the hue node carries s=0", JSON.stringify(hue.options) === JSON.stringify([["s", "0"]]), JSON.stringify(hue && hue.options));
    step("the effect row summarises it", /2 filter/.test($("[data-effect='graph']").textContent), $("[data-effect='graph']") && $("[data-effect='graph']").textContent);

    await inv("start_export", { preset: "h264_mp4", output: "__OUT__" });
    let ver = null;
    for (let i = 0; i < 120 && !ver; i++) { await sleep(500); try { ver = await inv("verify_output", { path: "__OUT__" }); } catch (_) {} }
    step("export with the graph completes", ver && !/WARNING/.test(ver), ver);

    P().setView(await inv("undo")); await sleep(300);
    step("undo restores the pass-through graph", graphOf() && graphOf().nodes.length === 2 && graphOf().edges.length === 1, JSON.stringify(graphOf()));
    P().setView(await inv("redo")); await sleep(300);
    step("redo brings the graph back", graphOf() && graphOf().nodes.length === 4);
    await inv("save_project", { path: "__PROJ__" }).catch(() => {});
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
