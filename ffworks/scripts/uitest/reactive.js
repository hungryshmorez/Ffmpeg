// In-webview test for "Follow audio" (audio-reactive keyframes). __SRC__ is substituted by reactive.sh: 4 s grey video
// whose tone is quiet for 2 s and loud for 2 s.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const setNum = (input, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(v)); input.dispatchEvent(new Event("input", { bubbles: true })); };
  const vclip = () => view().project.sequences[0].tracks.find((t) => t.kind === "video").clips[0];
  const rat = (x) => { const [n, d] = String(x).split("/"); return Number(n) / (d === undefined ? 1 : Number(d)); };
  const evalK = (ks, t) => { if (t <= rat(ks[0].t)) return ks[0].v; for (let i = 1; i < ks.length; i++) { const a = ks[i - 1], b = ks[i]; if (t <= rat(b.t)) return a.v + (b.v - a.v) * (t - rat(a.t)) / (rat(b.t) - rat(a.t)); } return ks[ks.length - 1].v; };
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "0", duration: "4", with_audio: true }); await sleep(400);
    await P().dispatch({ type: "add_effect", clip: vclip().id, effect: "brightness", params: {}, index: null }); await sleep(300);
    window.__ffworks.useUi.getState().select(vclip().id); await sleep(400);
    const fx = vclip().effects[0].id, param = `fx:${fx}:amount`;
    const field = await waitFor(() => $(`[data-param="${param}"]`));
    step("the brightness slider shows a Follow audio button", !!field && !!field.querySelector("button[aria-label^='Follow audio']"));
    field.querySelector("button[aria-label^='Follow audio']").click(); await sleep(300);
    const form = $(`[data-param="${param}"] .kf-follow`);
    step("it opens quiet/loud/smooth fields", !!form && !!form.querySelector("[aria-label='Value when quiet']"));
    setNum(form.querySelector("[aria-label='Value when quiet']"), -0.4);
    setNum(form.querySelector("[aria-label='Value when loud']"), 0.4);
    setNum(form.querySelector("[aria-label='Smoothing in seconds']"), 0);
    await sleep(200);
    [...form.querySelectorAll("button")].find((b) => /Apply/.test(b.textContent)).click();
    const ks = await waitFor(() => vclip().keyframes[param], 30000);
    step("Apply measures the audio and writes keyframes", !!ks && ks.length >= 2 && ks.length <= 200, ks && ks.length);
    step("quiet part is low, loud part is high", ks && evalK(ks, 1.0) < -0.35 && evalK(ks, 3.0) > 0.35, ks && `${evalK(ks, 1)} / ${evalK(ks, 3)}`);
    const closed = await waitFor(() => $(`[data-param="${param}"]`).dataset.animated === "true" && !$(`[data-param="${param}"] .kf-follow`), 5000);
    step("the field is now animated and the form closed", closed, $(`[data-param="${param}"]`).outerHTML.slice(0, 300));
    step("it is one undo step named after the action", /Animate .* from audio/.test(view().undoLabel || ""), view().undoLabel);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })); await sleep(600);
    step("Ctrl+Z removes the curve", !vclip().keyframes[param]);
    const err = await P().dispatch({ type: "animate_from_audio", clip: vclip().id, param, source: null, low: -5, high: 0.4, smooth: 0 }); await sleep(300);
    step("an out-of-range value is refused with a message", err === false && $$(".toast").some((t) => /outside/.test(t.textContent)), $$(".toast").map((t) => t.textContent).join(" | "));
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await window.__TAURI_INTERNALS__.invoke("uitest_report", { report: JSON.stringify(R) });
})();
