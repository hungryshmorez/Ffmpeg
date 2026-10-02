// In-webview test for multi-clip selection. __SRC__ is substituted by multi.sh.
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
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "0", duration: "4", with_audio: true }); await sleep(400);
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "4", source_in: "0", duration: "2", with_audio: false }); await sleep(300);
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "7", source_in: "0", duration: "2", with_audio: false }); await sleep(300);
    const vs = () => view().project.sequences[0].tracks.find((t) => t.kind === "video").clips.slice().sort((a, b) => rat(a.start) - rat(b.start));
    const clipEls = () => $$(".track.video .clip");
    const shiftClick = async (el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, shiftKey: true, clientX: r.left + 20, clientY: r.top + 10 })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 })); await sleep(250); };
    step("three video clips", vs().length === 3, vs().length);
    await select(clipEls()[0]);
    await shiftClick(clipEls()[1]); await shiftClick(clipEls()[2]);
    const hi = () => clipEls().filter((e) => e.classList.contains("selected")).length;
    step("Shift+click adds clips: three video clips are highlighted", hi() === 3, hi());
    await shiftClick(clipEls()[2]);
    step("Shift+click again removes one", hi() === 2, hi());
    await select(clipEls()[0]);
    step("a plain click goes back to a single selection", hi() === 1 && window.__ffworks.useUi.getState().extra.length === 0, hi());
    // paste to selected
    await P().dispatch({ type: "add_effect", clip: vs()[0].id, effect: "negate" }); await sleep(200);
    const btn = (t) => $$("[aria-label=Effects][data-kind=video] button").find((b) => b.textContent.trim() === t);
    btn("Copy effects").click(); await sleep(150);
    await shiftClick(clipEls()[1]); await shiftClick(clipEls()[2]);
    btn("Paste to selected").click(); await sleep(500);
    step("Paste to selected added the effect to all three (the source gets a second copy)", vs().map((c) => c.effects.length).join(",") === "2,1,1", vs().map((c) => c.effects.length).join(","));
    P().setView(await inv("undo")); await sleep(300);
    step("that was ONE undo step", vs().map((c) => c.effects.length).join(",") === "1,0,0");
    // delete several
    await select(clipEls()[0]); await shiftClick(clipEls()[2]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })); await sleep(500);
    step("Delete removed both selected clips and left the other", vs().length === 1 && rat(vs()[0].start) === 4, vs().map((c) => rat(c.start)).join(","));
    P().setView(await inv("undo")); await sleep(300);
    step("deleting several clips is ONE undo step", vs().length === 3);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
