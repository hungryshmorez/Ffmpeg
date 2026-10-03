// In-webview test for the datamosh lab (needs FFglitch: mosh.sh sets FFWORKS_FFGLITCH). __SRC__ comes from the .sh.
(async () => {
  const R = { ok: true, steps: [], media: "" };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const select = async (el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: r.left + 20, clientY: r.top + 10 })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 })); await sleep(250); };
  const btn = (name) => $$("button").find((b) => b.textContent.trim().startsWith(name));
  const tracks = () => view().project.sequences[0].tracks;
  const setSelect = (el, v) => { const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(el, v); el.dispatchEvent(new Event("change", { bubbles: true })); };
  const setNum = (el, v) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, String(v)); el.dispatchEvent(new Event("input", { bubbles: true })); };
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = tracks().find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "1", duration: "2", with_audio: false }); await sleep(400);
    await select($$(".track.video .clip")[0]);
    const open = await waitFor(() => btn("Datamosh lab"));
    step("the Effects panel offers the Datamosh lab for a video clip", !!open);
    open.click();
    const dlg = await waitFor(() => $("[aria-label='Datamosh lab']"));
    step("the lab opens", !!dlg);
    const make = await waitFor(() => btn("Make datamosh clip"));
    step("FFglitch is found, so the controls and Make button are offered", !!make && !!$("select[aria-label='Kind of mosh']") && !$("input[aria-label='FFglitch folder']"));
    await waitFor(() => !make.disabled);
    step("Make is enabled for the amplify mode", !make.disabled);
    let bad = null;
    try { await inv("set_ffglitch_dir", { dir: "/definitely/not/here" }); } catch (e) { bad = String(e); }
    step("a folder without the tools is refused with a reason", bad && /ffedit and ffgac/.test(bad), bad);
    make.click();
    const added = await waitFor(() => tracks().find((t) => t.name === "Datamosh" && t.clips.length === 1), 120000);
    step("a Datamosh track appears holding the new clip", !!added, JSON.stringify(tracks().map((t) => [t.name, t.clips.length])));
    const c = added && added.clips[0];
    step("it sits where the original is and lasts as long", c && c.start === "0" && c.duration === "2", c && JSON.stringify([c.start, c.duration]));
    step("the original clip is untouched", tracks().find((t) => t.id === v1).clips.length === 1);
    const media = view().project.media.find((x) => x.id === (c && c.media));
    R.media = media ? media.path : "";
    step("the result is a new media file in the project", /mosh_.*\.mkv$/.test(R.media), R.media);
    step("the dialog closed", !$("[aria-label='Datamosh lab']"));
    for (let i = 0; i < 3; i++) { P().setView(await inv("undo")); await sleep(250); }
    step("three undo steps remove the new clip, track and media", !tracks().some((t) => t.name === "Datamosh") && view().project.media.length === 1, JSON.stringify(tracks().map((t) => t.name)));

    // the motion effects (mirror, noise, zoom, fluid ...)
    await select($$(".track.video .clip")[0]);
    (await waitFor(() => btn("Datamosh lab"))).click();
    await waitFor(() => $("[aria-label='Datamosh lab']"));
    setSelect($("select[aria-label='Kind of mosh']"), "fx"); await sleep(300);
    const fxSel = await waitFor(() => $("select[aria-label='Motion effect']"));
    step("the motion-effect kind lists all fifteen effects from the engine", !!fxSel && fxSel.querySelectorAll("option").length === 15, fxSel && fxSel.innerText);
    setSelect(fxSel, "zoom"); await sleep(200);
    const zoom = $("input[aria-label='Zoom (half-pixels at the edge)']");
    step("Zoom shows its own number", !!zoom && zoom.value === "3");
    const make2 = btn("Make datamosh clip");
    setNum(zoom, 99); await sleep(200);
    step("a number outside its range disables Make", make2.disabled);
    setNum(zoom, 4); await sleep(200);
    step("a number inside enables it again", !make2.disabled);
    setSelect(fxSel, "mirror"); await sleep(200);
    step("Mirror has no numbers", !$("input.num[aria-label]") || !$$("[aria-label='Datamosh lab'] input.num").length);
    setSelect(fxSel, "noise"); await sleep(200);
    step("Noise has a push and a seed", !!$("input[aria-label='Push (half-pixels)']") && !!$("input[aria-label='Random seed']"));
    make2.click();
    const added2 = await waitFor(() => tracks().find((t) => t.name === "Datamosh" && t.clips.length === 1), 120000);
    step("a motion effect makes a Datamosh track like the other kinds", !!added2, JSON.stringify(tracks().map((t) => [t.name, t.clips.length])));
    let refused = "";
    try { await inv("make_mosh", { clip: tracks().find((t) => t.id === v1).clips[0].id, kind: "fx", fx: "noise", params: { amount: 5000 } }); } catch (e) { refused = String(e); }
    step("an out-of-range effect number is refused by the engine with the range", /must be from 1 to 64/.test(refused), refused);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
