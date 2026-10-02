// In-webview transition test. Placeholders __A__ __B__ __OUT__ are substituted by transitions.sh.
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
  const tracks = () => view().project.sequences[0].tracks;
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__A__", "__B__"]); await waitFor(() => $$(".media-item").length === 2);
    const ma = view().project.media.find((m) => /red/.test(m.name)).id, mb = view().project.media.find((m) => /blue/.test(m.name)).id;
    const v1 = tracks().find((t) => t.kind === "video").id;
    // A: timeline 0..2 (source 0..2); B: timeline 2..4 (source 1..3) -> both have handles at the cut
    await P().dispatch({ type: "place_clip", media: ma, track: v1, start: "0", source_in: "0", duration: "2", with_audio: true });
    await P().dispatch({ type: "place_clip", media: mb, track: v1, start: "2", source_in: "1", duration: "2", with_audio: true }); await sleep(400);
    const clipA = $$(".track.video .clip")[0];
    await select(clipA);
    const panel = await waitFor(() => $("[aria-label='Transitions']"));
    step("selecting a clip that touches another shows the Transitions panel", !!panel);
    const addBtn = [...panel.querySelectorAll("button")].find((b) => b.textContent === "Add");
    addBtn.click(); await sleep(500);
    const mark = $("[data-transition-mark]");
    step("Add creates a cross dissolve drawn on the timeline, centred on the cut (1 s = 80 px wide, 120..200 px)", !!mark && Math.abs(parseFloat(mark.style.width) - 80) < 2 && Math.abs(parseFloat(mark.style.left) - 120) < 2, mark && `${mark.style.left} ${mark.style.width}`);
    const tr = tracks().find((t) => t.kind === "video").transitions;
    step("engine stores the transition", tr.length === 1 && tr[0].kind === "fade", JSON.stringify(tr));
    // change type through the UI
    const sel = $("[data-transition] select[aria-label='Transition type']");
    setSel(sel, "wipeleft"); await sleep(400);
    step("changing the type updates the engine and the label", tracks().find((t) => t.kind === "video").transitions[0].kind === "wipeleft" && /wipeleft/.test($("[data-transition-mark]").textContent));
    setSel($("[data-transition] select[aria-label='Transition type']"), "fade"); await sleep(300);
    // moving a clip that is part of a transition is refused with an explanation; project unchanged
    const before = JSON.stringify(view().project);
    const bId = tracks().find((t) => t.kind === "video").clips[1].id;
    const ok = await P().dispatch({ type: "move_clip", clip: bId, start: "3", track: null });
    step("moving a transitioned clip is refused and leaves the project unchanged", ok === false && JSON.stringify(view().project) === before);
    step("the refusal is explained to the user", P().toasts.some((t) => /transition/.test(t.text)), P().toasts.map((t) => t.text).join(" | "));
    // missing handle: a second pair on another track where B starts at source 0
    await P().dispatch({ type: "add_track", kind: "video" }); await P().dispatch({ type: "add_track", kind: "audio" });
    const v2 = tracks().filter((t) => t.kind === "video")[1].id, a2 = tracks().filter((t) => t.kind === "audio")[1].id;
    await P().dispatch({ type: "place_clip", media: ma, track: v2, start: "10", source_in: "0", duration: "1", with_audio: true, audio_track: a2 });
    await P().dispatch({ type: "place_clip", media: mb, track: v2, start: "11", source_in: "0", duration: "1", with_audio: false });
    const t2 = tracks().filter((t) => t.kind === "video")[1].clips;
    const bad = await P().dispatch({ type: "add_transition", clip_a: t2[0].id, clip_b: t2[1].id, kind: "fade", duration: "1" });
    step("a transition without media handles is refused with a clear message", bad === false && P().toasts.some((t) => /no media/.test(t.text)), P().toasts.map((t) => t.text).slice(-2).join(" | "));
    // remove the helper clips so the export is just the first pair
    for (const c of t2) await P().dispatch({ type: "delete_clip", clip: c.id, ripple: false });
    await sleep(300);
    // processed preview contains the blend
    window.__ffworks.usePlayhead.getState().setT(0);
    $$("button").find((b) => b.textContent.includes("Render preview")).click();
    const ok2 = await waitFor(() => $(".bypass-badge.ok"), 90000);
    step("render preview works with a transition in the timeline", !!ok2);
    await inv("start_export", { preset: "h264_mp4", output: "__OUT__" });
    let ver = null;
    for (let i = 0; i < 120 && !ver; i++) { await sleep(500); try { ver = await inv("verify_output", { path: "__OUT__" }); } catch (_) {} }
    step("export completes and its duration matches the timeline (transition did not change length)", ver && !/WARNING/.test(ver), ver);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
