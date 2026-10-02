// In-webview test for markers. Placeholders __SRC__ __PROJ__ are substituted by markers.sh.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const T = () => window.__ffworks.usePlayhead.getState();
  const rat = (x) => { const [n, d] = String(x).split("/"); return Number(n) / (d === undefined ? 1 : Number(d)); };
  const markers = () => view().project.sequences[0].markers;
  const key = (k) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  const setSel = (sel, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, v); sel.dispatchEvent(new Event("change", { bubbles: true })); };
  const typeInto = async (el, proto, v) => { el.focus(); Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); await sleep(120); el.blur(); };
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: null, duration: null, with_audio: true }); await sleep(300);
    T().setT(2); await sleep(100); key("m"); await waitFor(() => markers().length === 1);
    step("M adds a marker at the playhead (2 s) named Marker 1", markers().length === 1 && rat(markers()[0].time) === 2 && markers()[0].name === "Marker 1", JSON.stringify(markers()));
    const flag = await waitFor(() => $("[data-marker-flag]"));
    step("the marker is drawn on the ruler at 132 + 2 s × 80 px", !!flag && Math.abs(parseFloat(flag.style.left) - (132 + 160)) < 2, flag && flag.style.left);
    T().setT(5); await sleep(100); $$("button").find((b) => b.textContent.trim() === "+ Marker").click(); await waitFor(() => markers().length === 2);
    step("+ Marker in the timeline bar adds a second marker, kept in time order", markers().length === 2 && rat(markers()[1].time) === 5 && markers()[1].name === "Marker 2");
    T().setT(6); await sleep(100); key("["); await sleep(100);
    step("[ jumps to the previous marker (5 s)", Math.abs(T().t - 5) < 0.01, T().t);
    key("["); await sleep(100);
    step("[ again jumps to 2 s", Math.abs(T().t - 2) < 0.01, T().t);
    key("]"); await sleep(100);
    step("] jumps forward to 5 s", Math.abs(T().t - 5) < 0.01, T().t);
    T().setT(0); await sleep(50);
    $("[data-marker-flag]").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 })); await sleep(100);
    step("clicking a flag moves the playhead to it", Math.abs(T().t - 2) < 0.01, T().t);

    key("Escape"); await sleep(200);
    const panel = await waitFor(() => $("[aria-label='Markers']"));
    step("with nothing selected the Inspector lists the markers", !!panel && $$("[data-marker]").length === 2);
    await typeInto($("[aria-label='Name of Marker 1']"), HTMLInputElement.prototype, "Intro ends");
    await waitFor(() => markers()[0].name === "Intro ends");
    step("renaming a marker commits on blur", markers()[0].name === "Intro ends");
    setSel($("[aria-label='Colour of Intro ends']"), "#3aa0ff"); await waitFor(() => markers()[0].color === "#3aa0ff");
    step("the colour select updates the marker and the ruler flag", markers()[0].color === "#3aa0ff" && $("[data-marker-flag]").style.background.includes("58, 160, 255") || $("[data-marker-flag]").style.background.includes("#3aa0ff"), $("[data-marker-flag]").style.background);
    await typeInto($("[aria-label='Note for Intro ends']"), HTMLTextAreaElement.prototype, "cut the logo here"); await waitFor(() => markers()[0].note === "cut the logo here");
    step("notes are stored", markers()[0].note === "cut the logo here");
    $("[aria-label='Delete Marker 2']").click(); await waitFor(() => markers().length === 1);
    step("delete removes the marker", markers().length === 1);
    P().setView(await inv("undo")); await sleep(200);
    step("undo brings the deleted marker back (in order)", markers().length === 2 && markers()[1].name === "Marker 2", JSON.stringify(markers().map((x) => x.name)));
    await inv("save_project", { path: "__PROJ__" });
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
