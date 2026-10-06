// In-webview test for the built-in pixel sort: add it from the Effects panel, set it to sort whole rows, render a processed
// preview (which bakes the sort) and queue an export. pixelsort.sh then measures the pictures. __SRC__ / __OUT__ come from the .sh.
(async () => {
  const R = { ok: true, steps: [], preview: "", out: "" };
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
  const btn = (name) => $$("button").find((b) => b.textContent.trim().startsWith(name));
  const vclip = () => view().project.sequences[0].tracks.find((t) => t.kind === "video").clips[0];
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "0", duration: "3", with_audio: false }); await sleep(400);
    await select($$(".track.video .clip")[0]);
    const pick = await waitFor(() => $("select[aria-label='Effect to add']"));
    step("Pixel sort is offered under Glitch", !!pick && !![...pick.querySelectorAll("optgroup[label='Glitch'] option")].find((o) => o.value === "pixel_sort" && o.textContent.includes("Pixel sort")));
    setSel(pick, "pixel_sort"); await sleep(100);
    btn("Add").click();
    await waitFor(() => vclip().effects.length === 1);
    step("the effect lands on the clip with its defaults", vclip().effects[0].effect === "pixel_sort" && vclip().effects[0].params.mode === 0 && vclip().effects[0].params.mix === 1, JSON.stringify(vclip().effects));
    const mode = await waitFor(() => $("input.num[aria-label^='Which pixels']"));
    step("its settings show as controls", !!mode && !!$("input.num[aria-label^='Sort by']") && !!$("input.num[aria-label='Amount']"));
    setNum(mode, 1); await sleep(300);
    step("choosing whole lines reaches the engine", vclip().effects[0].params.mode === 1, JSON.stringify(vclip().effects[0].params));

    btn("Render preview").click();
    const ok = await waitFor(() => $(".bypass-badge.ok"), 120000);
    step("a processed preview renders (the sort is baked for it)", !!ok, ok && ok.textContent);
    const prev = window.__ffworks.useUi.getState().preview;
    R.preview = prev ? prev.path : "";
    step("the preview file exists in the cache", /previews/.test(R.preview), R.preview);

    const out = "__OUT__";
    const job = await inv("start_export", { preset: "ffv1_mkv", output: out, engine: null, keepExisting: false });
    const jobs = () => window.__ffworks.useJobs.getState().jobs;
    const done = await waitFor(() => ["completed", "failed", "canceled"].includes(jobs()[job]?.state), 120000);
    step("the export finishes", done && jobs()[job].state === "completed", JSON.stringify(jobs()[job]));
    R.out = out;


    P().setView(await inv("undo")); await sleep(300);
    step("undo reverts the last edit (the setting) first", vclip().effects.length === 1 && vclip().effects[0].params.mode === 0);
    P().setView(await inv("undo")); await sleep(300);
    step("a second undo removes the effect", vclip().effects.length === 0);

    // a picture as the mask: import it, switch the mask to "a picture", choose it
    await window.__ffworks.importPaths(["__MASK__"]); await waitFor(() => $$(".media-item").length === 2);
    const pic = view().project.media.find((x) => /mask\.png$/.test(x.path));
    await select($$(".track.video .clip")[0]); await sleep(300);
    await P().dispatch({ type: "add_effect", clip: vclip().id, effect: "pixel_sort", params: {}, index: null }); await sleep(400);
    await P().dispatch({ type: "set_effect_param", clip: vclip().id, effect_id: vclip().effects[0].id, param: "mask", value: 3 }); await sleep(500);
    const picSel = await waitFor(() => $("select[aria-label='Mask picture']"));
    step("choosing mask 3 offers a picture to pick", !!picSel);
    step("only pictures and videos are offered, not the clip's own audio or generated media", !!picSel && [...picSel.querySelectorAll("option")].length === 3, picSel && picSel.innerText);
    setSel(picSel, pic.id); await sleep(400);
    step("picking one reaches the engine and the project", vclip().effects[0].picture === pic.id, JSON.stringify(vclip().effects[0]));
    setSel($("select[aria-label='Mask picture']"), ""); await sleep(300);
    step("choosing 'none' clears it", !vclip().effects[0].picture);
    setSel($("select[aria-label='Mask picture']"), pic.id); await sleep(300);
    const out2 = "__OUT2__";
    const job2 = await inv("start_export", { preset: "ffv1_mkv", output: out2, engine: null, keepExisting: false });
    const jobs2 = () => window.__ffworks.useJobs.getState().jobs;
    const done2 = await waitFor(() => ["completed", "failed", "canceled"].includes(jobs2()[job2]?.state), 120000);
    step("an export with the picture mask finishes", done2 && jobs2()[job2].state === "completed", JSON.stringify(jobs2()[job2]));
    R.out2 = out2;
    P().setView(await inv("undo")); await sleep(300);
    step("undo of the last choice leaves 'none'", !vclip().effects[0].picture);
    P().setView(await inv("undo")); await sleep(300);
    step("a second undo brings the earlier choice back", vclip().effects[0].picture === pic.id);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
