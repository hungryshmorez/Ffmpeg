// In-webview test for adding a filter from the browser. __SRC__ is substituted by addfilter.sh.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const setNum = (input, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(v)); input.dispatchEvent(new Event("input", { bubbles: true })); };
  const setSel = (sel, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, v); sel.dispatchEvent(new Event("change", { bubbles: true })); };
  const select = async (el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: r.left + 20, clientY: r.top + 10 })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 })); await sleep(250); };
  const clipsOf = (kind) => view().project.sequences[0].tracks.filter((t) => t.kind === kind).flatMap((t) => t.clips);
  const vclip = () => clipsOf("video")[0];
  const aclip = () => clipsOf("audio")[0];
  const rat = (x) => { const [n, d] = String(x).split("/"); return Number(n) / (d === undefined ? 1 : Number(d)); };
  const setT = (t) => window.__ffworks.usePlayhead.getState().setT(t);
  const field = (param) => $(`[data-param="${param}"]`);
  const numIn = (param) => field(param).querySelector("input[type=number]");
  const undo = async () => { P().setView(await inv("undo")); await sleep(200); };
  const typeInto = async (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); await sleep(150); };
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "0", duration: "4", with_audio: true }); await sleep(400);
    step("one clip placed", $$(".track.video .clip").length === 1);
    await select($$(".track.video .clip")[0]);
    window.__ffworks.useUi.getState().setFiltersOpen(true);
    await waitFor(() => $$(".filter-list li").length > 100);
    await typeInto($("[aria-label='Search filters']"), "negate"); await sleep(200);
    $$(".filter-list li button")[0].click();
    await waitFor(() => $(".filter-detail h3") && $(".filter-detail h3").textContent === "negate");
    const add = await waitFor(() => $$("button").find((b) => b.textContent.trim() === "Add to selected clip"));
    step("a one-in one-out video filter offers Add to selected clip", !!add);
    add.click(); await sleep(500);
    const fx = view().project.sequences[0].tracks.find((t) => t.kind === "video").clips[0].effects;
    step("the clip gained one graph effect holding exactly that filter", fx.length === 1 && fx[0].effect === "graph" && fx[0].graph.nodes.some((n) => n.filter === "negate") && fx[0].graph.edges.length === 2, JSON.stringify(fx));
    P().setView(await inv("undo")); await sleep(300);
    step("it is ONE undo step", view().project.sequences[0].tracks.find((t) => t.kind === "video").clips[0].effects.length === 0);
    await typeInto($("[aria-label='Search filters']"), "overlay"); await sleep(200);
    $$(".filter-list li button").find((b) => b.textContent.startsWith("overlay")).click();
    await waitFor(() => $(".filter-detail h3") && $(".filter-detail h3").textContent === "overlay"); await sleep(300);
    step("a two-input filter (overlay) does not offer the button", !$$("button").some((b) => b.textContent.trim() === "Add to selected clip"));
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
