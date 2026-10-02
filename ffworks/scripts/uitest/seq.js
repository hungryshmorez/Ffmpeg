// In-webview test for image sequences. __FRAMES__ is substituted by seq.sh.
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
    
    const r = await inv("import_image_sequence", { path: "__FRAMES__/f_025.png", fps: 25 });
    P().setView(r.state); await sleep(500);
    const media = view().project.media;
    step("one media item for the 50 frames", media.length === 1 && /50 frames/.test(media[0].name) && /f_%03d\.png$/.test(media[0].path), JSON.stringify(media.map((m) => m.name)));
    step("it is listed in the media browser", $$(".media-item").length === 1 && /50 frames/.test($(".media-item").textContent), $$(".media-item").map((e) => e.textContent).join("|"));
    step("it lasts 2 s and is not marked offline", rat(media[0].info.duration) === 2 && !/offline|missing/i.test($(".media-item").textContent), String(media[0].info.duration));
    const v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: media[0].id, track: v1, start: "0", source_in: "0", duration: "2", with_audio: false }); await sleep(400);
    step("it can be placed on the timeline", $$(".track.video .clip").length === 1);
    let err = "";
    try { await inv("import_image_sequence", { path: "__FRAMES__/f_025.png", fps: 0 }); } catch (e) { err = String(e); }
    step("a frame rate of 0 is refused", /between 1 and 240/.test(err), err);
    P().setView(await inv("undo")); await sleep(200); P().setView(await inv("undo")); await sleep(300);
    step("undo removes the clip and then the media item", view().project.media.length === 0);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
