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
  const shape = (i, p) => (i === "hold" ? 0 : i === "ease_in" ? p * p : i === "ease_out" ? p * (2 - p) : i === "ease_in_out" ? p * p * (3 - 2 * p) : p);
  const evalK = (ks, t) => { if (t <= rat(ks[0].t)) return ks[0].v; for (let i = 1; i < ks.length; i++) { const a = ks[i - 1], b = ks[i]; if (t < rat(b.t)) return a.v + (b.v - a.v) * shape(a.interp, (t - rat(a.t)) / (rat(b.t) - rat(a.t))); } return ks[ks.length - 1].v; };
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
    step("a frequency band can be chosen (default: everything)", form.querySelector("[aria-label='Frequency band']").value === "all" && form.querySelectorAll("[aria-label='Frequency band'] option").length === 4);
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
    // beats: a second clip whose sound is a click every second at x.4 s
    await window.__ffworks.importPaths(["__CLICKS__"]); await waitFor(() => $$(".media-item").length === 2);
    const m2 = view().project.media[1].id;
    await P().dispatch({ type: "place_clip", media: m2, track: v1, start: "4", source_in: "0", duration: "4", with_audio: true }); await sleep(400);
    const c2 = () => view().project.sequences[0].tracks.find((t) => t.kind === "video").clips.find((c) => c.media === m2);
    window.__ffworks.useUi.getState().select(c2().id); window.__ffworks.usePlayhead.getState().setT(5); await sleep(400);
    const of = await waitFor(() => $("[data-param='opacity'] button[aria-label^='Follow audio']"));
    of.click(); await sleep(300);
    const f2 = $("[data-param='opacity'] .kf-follow");
    const sel = f2.querySelector("[aria-label='Follow what']");
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, "beats"); sel.dispatchEvent(new Event("change", { bubbles: true })); await sleep(200);
    step("beats mode swaps smoothing/band for a decay time", !!f2.querySelector("[aria-label='Decay in seconds']") && !f2.querySelector("[aria-label='Frequency band']") && !f2.querySelector("[aria-label='Smoothing in seconds']"));
    setNum(f2.querySelector("[aria-label='Value when quiet']"), 0.1);
    setNum(f2.querySelector("[aria-label='Value when loud']"), 1);
    setNum(f2.querySelector("[aria-label='Decay in seconds']"), 0.3); await sleep(150);
    [...f2.querySelectorAll("button")].find((b) => /Apply/.test(b.textContent)).click();
    const pk = await waitFor(() => c2().keyframes.opacity, 30000);
    const peak = (b) => Math.max(...[-3, -2, -1, 0, 1, 2, 3].map((f) => evalK(pk, b + f * 0.04)));
    step("opacity pulses on the clicks and falls back between them", pk && peak(1.4) > 0.95 && peak(2.4) > 0.95 && evalK(pk, 2.0) < 0.15, pk && `${peak(1.4)} ${peak(2.4)} ${evalK(pk, 2.0)}`);
    step("it is one undo step", /Pulse opacity on beats/.test(view().undoLabel || ""), view().undoLabel);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await window.__TAURI_INTERNALS__.invoke("uitest_report", { report: JSON.stringify(R) });
})();
