// In-webview test for the browser app's audio workflows (audio filter chains). Placeholders __SRC__ __OUT__ are substituted by workflows.sh.
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
  const aclip = () => tracks().filter((t) => t.kind === "audio").flatMap((t) => t.clips)[0];
  const effPanel = () => $("[aria-label='Audio properties'] [aria-label='Effects']");
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = tracks().find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "0", duration: "4", with_audio: true }); await sleep(400);
    await select($$(".track.video .clip")[0]);
    const wsel = await waitFor(() => effPanel() && effPanel().querySelector("select[aria-label='Audio workflow']"));
    step("the audio clip's Effects panel offers the 19 audio workflows", !!wsel && wsel.options.length === 20, wsel && wsel.options.length);
    step("they carry the original names", [...wsel.options].some((o) => /Lo-Fi Tape Decay/.test(o.text)) && [...wsel.options].some((o) => /Slushwave/.test(o.text)));
    setSel(wsel, "am-lofi-tape"); await sleep(200);
    step("choosing one shows its description", /./.test(effPanel().querySelector("[aria-label='Audio workflows'] p")?.textContent ?? ""));
    [...effPanel().querySelectorAll("button")].find((b) => b.textContent === "Apply" && b.closest("[aria-label='Audio workflows']")).click(); await sleep(500);
    step("Apply adds an audio filter chain effect holding the workflow's chain", aclip().effects.length === 1 && aclip().effects[0].effect === "afilterchain" && /vibrato/.test(aclip().effects[0].text), JSON.stringify(aclip().effects));
    const ta = await waitFor(() => effPanel().querySelector("textarea[aria-label='Audio filter chain']"));
    step("its text is editable in the panel", !!ta && /vibrato/.test(ta.value));
    setText(ta, "amovie=/etc/passwd"); await sleep(100);
    [...effPanel().querySelectorAll("button")].find((b) => b.textContent === "Apply text").click(); await sleep(500);
    step("a chain with an unknown or file-reading filter is refused with a message and nothing changes", /vibrato/.test(aclip().effects[0].text) && P().toasts.some((t) => /not an audio filter/.test(t.text)), P().toasts.map((t) => t.text).join(" | "));
    setText(effPanel().querySelector("textarea[aria-label='Audio filter chain']"), "volume=0.1"); await sleep(100);
    [...effPanel().querySelectorAll("button")].find((b) => b.textContent === "Apply text").click(); await sleep(500);
    step("a valid chain is applied through a command", aclip().effects[0].text === "volume=0.1", aclip().effects[0].text);
    await inv("start_export", { preset: "wav", output: "__OUT__" });
    let ver = null;
    for (let i = 0; i < 120 && !ver; i++) { await sleep(500); try { ver = await inv("verify_output", { path: "__OUT__" }); } catch (_) {} }
    step("the export completes with the chain applied", ver && !/WARNING/.test(ver), ver);
    P().setView(await inv("undo")); await sleep(300);
    step("undo restores the earlier chain text", aclip().effects[0].text !== "volume=0.1", aclip().effects[0].text);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
