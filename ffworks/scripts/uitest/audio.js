// In-webview test for audio pan/fades/envelope/effects and the mixer. Placeholders __SRC__ __OUT__ are substituted by audio.sh.
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
  const rat = (x) => { const [n, d] = String(x).split("/"); return Number(n) / (d === undefined ? 1 : Number(d)); };
  const tracks = () => view().project.sequences[0].tracks;
  const aclip = () => tracks().filter((t) => t.kind === "audio").flatMap((t) => t.clips)[0];
  const atrack = () => tracks().find((t) => t.kind === "audio");
  const inAudio = (label) => $(`[aria-label='Audio properties'] input[aria-label='${label}']`);
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = tracks().find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "0", duration: "4", with_audio: true }); await sleep(400);
    step("the Mixer lists the audio track with mute and solo", !!$("[aria-label='Mixer'] [aria-label='Mixer strip A1']") && !!$("[aria-label='Solo A1']") && !!$("[aria-label='Mute A1']"));
    await select($$(".track.video .clip")[0]);
    const panel = await waitFor(() => $("[aria-label='Audio properties']") && $("[aria-label='Audio properties'] [data-param='gain_db']") && $("[aria-label='Audio properties']"));
    step("selecting the video clip shows the linked audio's properties", !!panel && /Volume/.test(panel.textContent) && /Fade in/.test(panel.textContent) && /Pan/.test(panel.textContent));
    step("volume has a keyframe button, pan does not (a fixed filter coefficient)", !!panel.querySelector("[data-param='gain_db'] .kf-btn") && !panel.querySelector("[data-param='pan']"));

    setNum(inAudio("Pan (balance)"), 1); await waitFor(() => aclip().pan === 1);
    step("Pan slider sets the clip balance in the engine", aclip().pan === 1);
    setNum(inAudio("Fade in"), 1); await waitFor(() => rat(aclip().fade_in) === 1);
    setNum(inAudio("Fade out"), 0.5); await waitFor(() => rat(aclip().fade_out) === 0.5);
    step("Fade in / out sliders set the fades (seconds)", rat(aclip().fade_in) === 1 && rat(aclip().fade_out) === 0.5, `${aclip().fade_in} ${aclip().fade_out}`);
    step("the audio clip's label shows pan and fade badges", /pan R100/.test($(".track.audio .clip .clip-name").textContent) && /fade/.test($(".track.audio .clip .clip-name").textContent), $(".track.audio .clip .clip-name").textContent);
    step("the monitor warns pan/fades are only heard in a rendered preview", /pan and fades/.test($(".bypass-badge")?.textContent ?? ""), $(".bypass-badge")?.textContent);

    // effects: only audio effects are offered for an audio clip
    const effPanel = $("[aria-label='Audio properties'] [aria-label='Effects']");
    const options = [...effPanel.querySelectorAll("select option")].map((o) => o.textContent);
    step("the audio effect list offers audio effects only", options.includes("Compressor") && options.includes("Equalizer (3-band)") && !options.includes("Gaussian blur"), options.join(", "));
    const sel = effPanel.querySelector("select"); setSel(sel, "limiter");
    [...effPanel.querySelectorAll("button")].find((b) => b.textContent === "Add").click(); await waitFor(() => aclip().effects.length === 1);
    step("adding an audio effect from the Inspector updates the engine", aclip().effects[0].effect === "limiter");
    const slider = $("[data-effect='limiter'] input[aria-label='Ceiling']"); setNum(slider, -9); await waitFor(() => aclip().effects[0].params.ceiling === -9);
    step("its parameter slider is a command", aclip().effects[0].params.ceiling === -9);
    // volume envelope via the diamond
    window.__ffworks.usePlayhead.getState().setT(0); await sleep(200);
    $("[aria-label='Audio properties'] [data-param='gain_db'] .kf-btn").click(); await waitFor(() => (aclip().keyframes.gain_db || []).length === 1);
    step("the volume diamond adds an envelope keyframe", (aclip().keyframes.gain_db || []).length === 1);
    const refused = await P().dispatch({ type: "set_clip_gain", clip: aclip().id, gain_db: -3, relative: false });
    step("static gain edits are refused while the envelope exists", refused === false && P().toasts.some((t) => /animated/.test(t.text)));
    await P().dispatch({ type: "clear_keyframes", clip: aclip().id, param: "gain_db" });

    // mixer: solo / track gain / pan are commands; meter reads the analysed waveform
    window.__ffworks.usePlayhead.getState().setT(2); await sleep(300);
    const meter = await waitFor(() => { const e = $("[aria-label='A1 right level']"); return e && Number(e.getAttribute("aria-valuenow")) > -60 ? e : null; }, 20000);
    step("the A1 right meter shows a level at the playhead (from the analysed waveform)", !!meter, $("[aria-label='A1 right level']")?.getAttribute("aria-valuenow"));
    step("with the clip panned hard right, the left meter is far below the right one", Number($("[aria-label='A1 left level']").getAttribute("aria-valuenow")) < Number($("[aria-label='A1 right level']").getAttribute("aria-valuenow")) - 20, `${$("[aria-label='A1 left level']").getAttribute("aria-valuenow")} vs ${$("[aria-label='A1 right level']").getAttribute("aria-valuenow")}`);
    $("[aria-label='Solo A1']").click(); await waitFor(() => atrack().solo);
    step("Solo in the mixer sets the track's solo flag", atrack().solo === true && $("[aria-label='Solo A1']").getAttribute("aria-pressed") === "true");
    $("[aria-label='Solo A1']").click(); await waitFor(() => !atrack().solo);
    const g = $("[aria-label='Mixer strip A1'] input[aria-label='Gain']"); setNum(g, -6); await waitFor(() => atrack().gain_db === -6);
    step("the strip's Gain slider sets the track gain", atrack().gain_db === -6);
    setNum($("[aria-label='Mixer strip A1'] input[aria-label='Gain']"), 0); await waitFor(() => atrack().gain_db === 0);
    $("[aria-label='Mute A1']").click(); await waitFor(() => atrack().muted);
    await sleep(300);
    step("a muted track's meter drops to the floor", Number($("[aria-label='A1 left level']").getAttribute("aria-valuenow")) <= -60);
    $("[aria-label='Mute A1']").click(); await waitFor(() => !atrack().muted);

    // remove the limiter so the export is pan 1 + fades only, then export
    await P().dispatch({ type: "remove_effect", clip: aclip().id, effect_id: aclip().effects[0].id });
    await inv("start_export", { preset: "h264_mp4", output: "__OUT__" });
    let ver = null;
    for (let i = 0; i < 120 && !ver; i++) { await sleep(500); try { ver = await inv("verify_output", { path: "__OUT__" }); } catch (_) {} }
    step("export completes", ver && !/WARNING/.test(ver), ver);
    // undo steps back through the audio edits: the last command was removing the limiter, so undoing it brings it back
    step("before undo the limiter is gone", aclip().effects.length === 0);
    P().setView(await inv("undo")); await sleep(300);
    step("undo restores the removed audio effect", aclip().effects.length === 1 && aclip().effects[0].effect === "limiter" && aclip().effects[0].params.ceiling === -9, JSON.stringify(aclip().effects));
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
