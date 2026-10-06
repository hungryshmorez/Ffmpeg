// In-webview test for the browser app's video workflows (video filter chains). Placeholders __SRC__ __OUT__ are substituted by videowf.sh.
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
  const setText = (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
  const select = async (el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: r.left + 20, clientY: r.top + 10 })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 })); await sleep(250); };
  const tracks = () => view().project.sequences[0].tracks;
  const vclip = () => tracks().find((t) => t.kind === "video").clips[0];
  const panel = () => $("[aria-label='Video workflows']")?.closest("[aria-label='Effects']");
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = tracks().find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "0", duration: "2", with_audio: false }); await sleep(400);
    await select($$(".track.video .clip")[0]);
    const wsel = await waitFor(() => $("select[aria-label='Video workflow']"));
    step("a video clip's Effects panel offers the 42 video workflows", !!wsel && wsel.options.length === 43, wsel && wsel.options.length);
    step("they are grouped by the browser app's categories", ["color-grading", "retro-analog", "artistic-stylize", "glitch"].every((c) => [...wsel.querySelectorAll("optgroup")].some((g) => g.label === c)));
    setSel(wsel, "sepia-tone"); await sleep(200);
    [...$("[aria-label='Video workflows']").querySelectorAll("button")].find((b) => b.textContent === "Apply").click(); await sleep(500);
    step("Apply adds a video filter chain effect with the workflow's chain", vclip().effects.length === 1 && vclip().effects[0].effect === "vfilterchain" && /colorchannelmixer=rr=0.393/.test(vclip().effects[0].text), JSON.stringify(vclip().effects));
    const ta = await waitFor(() => $("textarea[aria-label='Video filter chain']"));
    step("the chain text is editable in the panel", !!ta);
    setText(ta, "movie=/etc/passwd"); await sleep(100);
    [...ta.closest(".field").querySelectorAll("button")].find((b) => b.textContent === "Apply text").click(); await sleep(500);
    step("an unsafe chain is refused with a message and nothing changes", /colorchannelmixer/.test(vclip().effects[0].text) && P().toasts.some((t) => /not a video filter/.test(t.text)), P().toasts.map((t) => t.text).join(" | "));
    await inv("start_export", { preset: "h264_mp4", output: "__OUT__" });
    let ver = null;
    for (let i = 0; i < 120 && !ver; i++) { await sleep(500); try { ver = await inv("verify_output", { path: "__OUT__" }); } catch (_) {} }
    step("the export completes with the sepia chain applied", ver && !/WARNING/.test(ver), ver);
    P().setView(await inv("undo")); await sleep(300);
    step("undo removes the effect", vclip().effects.length === 0);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
