// In-webview test for adjustment layers: add one at the playhead, give it an effect, render a preview. adjustment.sh measures it.
(async () => {
  const R = { ok: true, steps: [], preview: "" };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const setSel = (sel, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, v); sel.dispatchEvent(new Event("change", { bubbles: true })); };
  const select = async (el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: r.left + 20, clientY: r.top + 10 })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 })); await sleep(250); };
  const btn = (name) => $$("button").find((b) => b.textContent.trim().startsWith(name));
  const clips = () => view().project.sequences[0].tracks.flatMap((t) => t.clips.map((c) => ({ ...c, track: t })));
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "0", duration: "4", with_audio: false }); await sleep(400);
    window.__ffworks.usePlayhead.getState().setT(1); await sleep(200);
    btn("+ Adjustment").click();
    const adj = await waitFor(() => clips().find((c) => c.adjustment));
    step("+ Adjustment puts an adjustment layer at the playhead", !!adj && adj.start === "1" && adj.duration === "5", adj && JSON.stringify([adj.start, adj.duration, adj.name]));
    step("it is on its own track above the footage", adj && adj.track.id !== v1);
    const el = await waitFor(() => $(".clip.adjustment"));
    step("the timeline draws it differently (adjustment style)", !!el);
    window.__ffworks.usePlayhead.getState().setT(2); await sleep(400);
    const mv = await waitFor(() => $(".monitor video") && $(".monitor video").src);
    step("the monitor's source view still shows the footage, not the layer", !!mv && /halves\.mp4/.test(decodeURIComponent(mv)), mv);
    await select(el);
    const pick = await waitFor(() => $("select[aria-label='Effect to add']"));
    setSel(pick, "grayscale"); await sleep(100);
    btn("Add").click();
    await waitFor(() => clips().find((c) => c.adjustment).effects.length === 1);
    step("an effect can be added to the layer", clips().find((c) => c.adjustment).effects[0].effect === "grayscale");
    // transform and blend are not offered / refused
    let refused = null;
    try { await inv("dispatch", { command: { type: "set_clip_blend", clip: adj.id, blend: "multiply" } }); } catch (e) { refused = String(e); }
    step("blend mode is refused with a reason", refused && /adjustment layer/.test(refused), refused);

    btn("Render preview").click();
    const ok = await waitFor(() => $(".bypass-badge.ok"), 120000);
    step("a processed preview renders", !!ok);
    const prev = window.__ffworks.useUi.getState().preview;
    R.preview = prev ? prev.path : "";
    P().setView(await inv("undo")); await sleep(300);
    P().setView(await inv("undo")); await sleep(300);
    step("two undo steps remove the effect and the layer", !clips().some((c) => c.adjustment), JSON.stringify(clips().map((c) => c.name)));
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
