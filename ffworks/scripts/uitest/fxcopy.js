// In-webview test for copying and pasting effect stacks. __SRC__ is substituted by fxcopy.sh.
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
    // second clip right after the first on the same track
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "4", source_in: "0", duration: "2", with_audio: false }); await sleep(400);
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "7", source_in: "0", duration: "2", with_audio: false }); await sleep(400);
    const vs = () => view().project.sequences[0].tracks.find((t) => t.kind === "video").clips.slice().sort((a, b) => rat(a.start) - rat(b.start));
    step("three video clips on the track", vs().length === 3, vs().length);
    await select($$(".track.video .clip")[0]);
    await P().dispatch({ type: "add_effect", clip: vs()[0].id, effect: "blur", params: { sigma: 9 } });
    await P().dispatch({ type: "add_effect", clip: vs()[0].id, effect: "pixelate", params: { size: 40 } });
    await sleep(300);
    const btn = (t) => $$("[aria-label=Effects][data-kind=video] button").find((b) => b.textContent.trim() === t);
    step("Paste is disabled before anything is copied", btn("Paste").disabled);
    step("source clip has two effects and is selected", vs()[0].effects.length === 2 && window.__ffworks.useUi.getState().selected === vs()[0].id, JSON.stringify([vs()[0].effects.length, window.__ffworks.useUi.getState().selected, vs()[0].id, !!btn("Copy effects"), btn("Copy effects") && btn("Copy effects").disabled]));
    btn("Copy effects").click(); await sleep(200);
    step("clipboard store holds the stack", window.__ffworks.useFxClipboard.getState().effects.length === 2, JSON.stringify(window.__ffworks.useFxClipboard.getState()));
    step("Paste becomes available after copying", !btn("Paste").disabled);
    await select($$(".track.video .clip")[1]);
    btn("Paste").click(); await sleep(500);
    const fx1 = vs()[1].effects;
    step("paste put both effects on the second clip in order with their values", fx1.length === 2 && fx1[0].effect === "blur" && fx1[0].params.sigma === 9 && fx1[1].effect === "pixelate" && fx1[1].params.size === 40, JSON.stringify(fx1));
    step("the pasted effects are new instances", fx1[0].id !== vs()[0].effects[0].id);
    P().setView(await inv("undo")); await sleep(300);
    step("paste is ONE undo step", vs()[1].effects.length === 0, vs()[1].effects.length);
    await select($$(".track.video .clip")[1]);
    btn("Paste to track").click(); await sleep(600);
    step("paste to track adds the stack to every clip on the track (source clip gets a second copy too)", vs().map((c) => c.effects.length).join(",") === "4,2,2", vs().map((c) => c.effects.length).join(","));
    P().setView(await inv("undo")); await sleep(300);
    step("the whole paste-to-track is ONE undo step", vs().map((c) => c.effects.length).join(",") === "2,0,0", vs().map((c) => c.effects.length).join(","));
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
