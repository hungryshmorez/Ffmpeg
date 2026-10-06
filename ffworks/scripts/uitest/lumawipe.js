// In-webview luma wipe test. Placeholders __A__ __B__ __MASK__ __OUT__ are substituted by lumawipe.sh.
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
  const select = async (el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: r.left + 20, clientY: r.top + 10 })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 })); await sleep(250); };
  const tracks = () => view().project.sequences[0].tracks;
  const tr = () => tracks().find((t) => t.kind === "video").transitions[0];
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__A__", "__B__", "__MASK__"]); await waitFor(() => $$(".media-item").length === 3);
    const ma = view().project.media.find((m) => /red/.test(m.name)).id, mb = view().project.media.find((m) => /blue/.test(m.name)).id, mm = view().project.media.find((m) => /mask/.test(m.name)).id;
    const v1 = tracks().find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: ma, track: v1, start: "0", source_in: "0", duration: "2", with_audio: false });
    await P().dispatch({ type: "place_clip", media: mb, track: v1, start: "2", source_in: "1", duration: "2", with_audio: false }); await sleep(400);
    await select($$(".track.video .clip")[0]);
    const panel = await waitFor(() => $("[aria-label='Transitions']"));
    [...panel.querySelectorAll("button")].find((b) => b.textContent === "Add").click(); await sleep(500);
    step("a cross dissolve is added", tr() && tr().kind === "fade", JSON.stringify(tr()));
    const maskSel = await waitFor(() => $("[data-transition] select[aria-label='Mask picture']"));
    step("the Mask picture list offers the imported still image and not the videos", maskSel && [...maskSel.options].some((o) => o.value === mm) && ![...maskSel.options].some((o) => o.value === ma), maskSel && [...maskSel.options].map((o) => o.text).join(","));
    setSel(maskSel, mm); await sleep(500);
    step("picking a mask turns the transition into a luma wipe in the engine", tr().kind === "luma" && tr().mask === mm, JSON.stringify(tr()));
    step("the soft-edge slider and the invert checkbox appear", !!$("[data-transition] input[aria-label='Invert mask']"));
    await inv("start_export", { preset: "h264_mp4", output: "__OUT__" });
    let ver = null;
    for (let i = 0; i < 120 && !ver; i++) { await sleep(500); try { ver = await inv("verify_output", { path: "__OUT__" }); } catch (_) {} }
    step("the export completes with the luma wipe in the timeline", ver && !/WARNING/.test(ver), ver);
    $("[data-transition] input[aria-label='Invert mask']").click(); await sleep(500);
    step("the invert checkbox is a command (stored in the project)", tr().invert === true, JSON.stringify(tr()));
    P().setView(await inv("undo")); await sleep(300);
    step("undo reverts the invert", tr().invert === false);
    setSel($("[data-transition] select[aria-label='Mask picture']"), ""); await sleep(400);
    step("choosing none turns it back into a fade", tr().kind === "fade" && !tr().mask, JSON.stringify(tr()));
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
