// In-webview test for macros. __SRC__ and __MACRO__ are substituted by macro.sh.
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
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "5", source_in: "0", duration: "2", with_audio: false }); await sleep(300);
    const vs = () => view().project.sequences[0].tracks.find((t) => t.kind === "video").clips.slice().sort((a, b) => rat(a.start) - rat(b.start));
    step("two video clips", vs().length === 2);
    const [A, B] = [vs()[0].id, vs()[1].id];
    await inv("start_recording");
    window.__ffworks.useUi.getState().setRecording(true); await sleep(200);
    step("the toolbar shows a REC badge while recording", !!$("[aria-label='Recording a macro']"));
    await P().dispatch({ type: "add_effect", clip: A, effect: "blur", params: { sigma: 7 } });
    await P().dispatch({ type: "add_effect", clip: A, effect: "hue", params: { degrees: 50 } });
    const n = await inv("stop_recording", { path: "__MACRO__" });
    window.__ffworks.useUi.getState().setRecording(false); await sleep(200);
    step("stopping reports the two recorded commands", n === 2, n);
    step("the REC badge is gone", !$("[aria-label='Recording a macro']"));
    const sv = await inv("run_macro", { path: "__MACRO__", selected: B });
    P().setView(sv); await sleep(300);
    const fx = vs()[1].effects;
    step("replaying on the other clip gave it the same effects with the same values", fx.length === 2 && fx[0].effect === "blur" && fx[0].params.sigma === 7 && fx[1].effect === "hue" && fx[1].params.degrees === 50, JSON.stringify(fx));
    step("the original clip was not touched again", vs()[0].effects.length === 2);
    P().setView(await inv("undo")); await sleep(300);
    step("the replay is ONE undo step", vs()[1].effects.length === 0 && vs()[0].effects.length === 2);
    let err = "";
    try { await inv("run_macro", { path: "__MACRO__", selected: null }); } catch (e) { err = String(e); }
    step("running it without a selected clip says to select one", /select one/i.test(err), err);
    await inv("start_recording");
    let err2 = "";
    try { await inv("stop_recording", { path: "__MACRO__.x" }); } catch (e) { err2 = String(e); }
    step("a recording that touched no clip is refused", /does not touch any clip/.test(err2), err2);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
