// In-webview test for compound clips, driven through the command palette and the timeline like a user.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const U = () => window.__ffworks.useUi.getState();
  const setNum = (input, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(v)); input.dispatchEvent(new Event("input", { bubbles: true })); };
  const active = () => view().project.sequences.find((s) => s.id === view().project.active_sequence);
  const vclips = () => active().tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips).sort((a, b) => a.start.localeCompare(b.start, undefined, { numeric: true }));
  const key = (k, extra = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...extra }));
  const palette = async (query) => {
    key("k", { ctrlKey: true }); await sleep(300);
    const box = $("input[aria-label='Type a command']");
    setNum(box, query); await sleep(200);
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(600);
  };
  try {
    await waitFor(() => $(".app") && view());
    const v1 = active().tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "add_solid", track: v1, start: "0", duration: "2", color: "#ff0000" });
    await P().dispatch({ type: "add_solid", track: v1, start: "2", duration: "2", color: "#00ff00" });
    await sleep(300);
    const [a, b] = vclips().map((c) => c.id);
    step("two solid clips to start with", !!a && !!b);
    const main = view().project.active_sequence;

    U().select(a); U().toggleExtra(b); await sleep(200);
    await palette("compound clip from");
    step("the palette's 'Make a compound clip' folded the two selected clips into one", vclips().length === 1 && vclips()[0].name.startsWith("Compound"), JSON.stringify(vclips().map((c) => c.name)));
    step("a compound sequence now exists", view().project.sequences.some((s) => s.compound));
    const compound = vclips()[0];

    await new Promise((r) => { const el = $$(".clip").find((c) => c.getAttribute("aria-label")?.includes(compound.name)); el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); setTimeout(r, 600); });
    step("double-clicking the compound clip opens its contents", active().compound === true && vclips().length === 2, active().name);
    step("the timeline says so and offers the way back", !!$(".compound-bar") && /Back to the main timeline/.test($(".compound-bar").textContent));

    const green = vclips()[1].id;
    await P().dispatch({ type: "set_solid_color", clip: green, color: "#0000ff" }); await sleep(300);
    step("an edit inside works like on any timeline", vclips()[1].name !== undefined && !!view().project.media.find((m) => m.generator?.color === "#0000ff"));

    $(".compound-bar button").click(); await sleep(500);
    step("the back button returns to the main timeline", view().project.active_sequence === main && !$(".compound-bar") && vclips().length === 1);

    U().select(vclips()[0].id); await sleep(200);
    await palette("take the selected compound clip apart");
    step("taking it apart puts the two clips back on the timeline", vclips().length === 2 && !view().project.sequences.some((s) => s.compound), JSON.stringify(vclips().map((c) => c.name)));

    P().setView(await inv("undo")); await sleep(300);
    step("undo brings the compound back", view().project.sequences.some((s) => s.compound) && vclips().length === 1);
    P().setView(await inv("undo")); await sleep(300);
    const inner = view().project.sequences.find((s) => s.compound);
    const innerMedia = inner.tracks.find((t) => t.kind === "video").clips.map((c) => c.media);
    step("undoing once more takes back the colour change made inside", innerMedia.length === 2 && innerMedia[1] === "gen_solid_00ff00", JSON.stringify(innerMedia));
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
