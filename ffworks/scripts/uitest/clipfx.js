// In-webview test for transform / keyframes / blend / timing in the Inspector. Placeholders __SRC__ __OUT__ are substituted by clipfx.sh.
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
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "0", duration: "4", with_audio: true }); await sleep(400);
    await select($$(".track.video .clip")[0]);
    const panel = await waitFor(() => $("[aria-label='Video properties']"));
    step("selecting a video clip shows Transform / Compositing / Timing", !!panel && /Transform/.test(panel.textContent) && /Compositing/.test(panel.textContent) && /Timing/.test(panel.textContent));
    step("all five animatable clip parameters have a keyframe button", ["x", "y", "scale", "rotation", "opacity"].every((p) => field(p)?.querySelector(".kf-btn")));

    // static edit through the number box -> engine
    setNum(numIn("x"), 80); await waitFor(() => vclip().transform.x === 80);
    step("typing Position X = 80 updates the engine", vclip().transform.x === 80, JSON.stringify(vclip().transform));
    step("the bypass badge warns that transform is only visible in a rendered preview", /transform/i.test($(".bypass-badge")?.textContent ?? ""), $(".bypass-badge")?.textContent);

    // keyframes on scale: add at 1 s via the diamond, then change the value at 2 s (auto-key)
    setT(1); await sleep(200);
    field("scale").querySelector(".kf-btn").click(); await waitFor(() => (vclip().keyframes.scale || []).length === 1);
    let kf = vclip().keyframes.scale;
    step("the diamond adds a keyframe at the playhead (1 s) with the current value", kf.length === 1 && Math.abs(rat(kf[0].t) - 1) < 1e-9, JSON.stringify(kf));
    step("the diamond is shown as active at a key", field("scale").querySelector(".kf-btn").classList.contains("on"));
    setT(2); await sleep(200);
    setNum(numIn("scale"), 0.5); await waitFor(() => (vclip().keyframes.scale || []).length === 2);
    kf = vclip().keyframes.scale;
    step("editing an animated parameter writes a keyframe at the playhead (2 s = 0.5)", kf.length === 2 && Math.abs(rat(kf[1].t) - 2) < 1e-9 && kf[1].v === 0.5, JSON.stringify(kf));
    step("the static scale was left alone", vclip().transform.scale === 1);
    setT(1.5); await sleep(250);
    step("at 1.5 s the slider shows the interpolated value 0.75", Math.abs(Number(numIn("scale").value) - 0.75) < 0.01, numIn("scale").value);
    // keyframe list: change interpolation of the first key, then delete+undo
    $$("button").find((b) => /Show keyframes for Scale/.test(b.getAttribute("aria-label") || "")).click(); await sleep(200);
    const interpSel = $("[data-param='scale'] .kf-list select");
    setSel(interpSel, "ease_in_out"); await waitFor(() => vclip().keyframes.scale[0].interp === "ease_in_out");
    step("keyframe interpolation can be changed in the list", vclip().keyframes.scale[0].interp === "ease_in_out");
    // the static setter is refused while animated, with an explanation
    const ok = await P().dispatch({ type: "set_clip_param", clip: vclip().id, param: "scale", value: 2 });
    step("a static edit of an animated parameter is refused and explained", ok === false && P().toasts.some((t) => /animated/.test(t.text)), P().toasts.map((t) => t.text).join(" | "));
    // effect parameter keyframes: brightness is animatable, blur sigma is not
    await P().dispatch({ type: "add_effect", clip: vclip().id, effect: "blur" }); await P().dispatch({ type: "add_effect", clip: vclip().id, effect: "brightness" }); await sleep(300);
    const bright = $("[data-effect='brightness']"), blur = $("[data-effect='blur']");
    step("animatable effect parameters get a keyframe button, fixed ones do not", !!bright.querySelector(".kf-btn") && !blur.querySelector(".kf-btn"));

    // blend mode
    setSel($("select[aria-label='Blend mode']"), "multiply"); await waitFor(() => vclip().blend === "multiply");
    step("blend mode select updates the engine and the clip label", vclip().blend === "multiply" && /multiply/.test($(".track.video .clip .clip-name").textContent), $(".track.video .clip .clip-name").textContent);
    setSel($("select[aria-label='Blend mode']"), "normal"); await waitFor(() => vclip().blend === "normal");

    // render a processed preview and export with the animated transform in the timeline
    setT(0);
    $$("button").find((b) => b.textContent.includes("Render preview")).click();
    step("render preview works with transform + keyframes", !!(await waitFor(() => $(".bypass-badge.ok"), 90000)));
    // remove the helper effects so the export is exactly: x=80, scale 1 -> 0.5 between 1 s and 2 s
    for (const fx of vclip().effects) await P().dispatch({ type: "remove_effect", clip: vclip().id, effect_id: fx.id });
    await inv("start_export", { preset: "h264_mp4", output: "__OUT__" });
    let ver = null;
    for (let i = 0; i < 120 && !ver; i++) { await sleep(500); try { ver = await inv("verify_output", { path: "__OUT__" }); } catch (_) {} }
    step("export completes", ver && !/WARNING/.test(ver), ver);

    // timing: speed 200% via the box, reverse, freeze (then undo them all)
    const dur0 = rat(vclip().duration);
    const sp = $("input[aria-label='Speed percent']"); setNum(sp, 200); sp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitFor(() => vclip().speed !== "1");
    step("speed 200% halves the clip on the timeline, linked audio included, and the label shows ×2", Math.abs(rat(vclip().duration) - dur0 / 2) < 0.05 && Math.abs(rat(aclip().duration) - dur0 / 2) < 0.05 && /×2/.test($(".track.video .clip .clip-name").textContent), `${vclip().speed} ${vclip().duration} ${aclip().duration}`);
    await undo();
    step("undo restores the speed and duration", vclip().speed === "1" && Math.abs(rat(vclip().duration) - dur0) < 0.001, `${vclip().speed} ${vclip().duration}`);
    $("input[aria-label='Reverse']").click(); await waitFor(() => vclip().reverse);
    step("Reverse checkbox reverses video and audio clips", vclip().reverse && aclip().reverse);
    await undo();
    setT(1); await sleep(200);
    [...$$("button")].find((b) => /Freeze frame at playhead/.test(b.textContent)).click(); await waitFor(() => vclip().freeze);
    step("Freeze frame holds the source frame at the playhead and detaches the audio", /^1(\/1)?$|^1000000\/1000000$/.test(vclip().freeze) && aclip().link === null && /Unfreeze/.test($("[aria-label='Video properties']").textContent), `${vclip().freeze} link=${aclip().link}`);
    step("speed controls are disabled while frozen", $("input[aria-label='Speed percent']").disabled);
    await undo();
    step("undo unfreezes", vclip().freeze === null);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
