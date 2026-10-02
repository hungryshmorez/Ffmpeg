// In-webview test for titles, solid colours and still images. Placeholders __PNG__ __OUT__ are substituted by generated.sh.
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
  // type into a textarea like a user: focus, input, then blur (React commits on focusout)
  const typeInto = async (el, v) => { el.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); await sleep(120); el.blur(); };
  const setSel = (sel, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, v); sel.dispatchEvent(new Event("change", { bubbles: true })); };
  const rat = (x) => { const [n, d] = String(x).split("/"); return Number(n) / (d === undefined ? 1 : Number(d)); };
  const clips = () => view().project.sequences[0].tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips);
  const titleClip = () => clips().find((c) => c.title);
  const solidClip = () => clips().find((c) => !c.title && view().project.media.find((m) => m.id === c.media)?.generator);
  const btn = (txt) => $$("button").find((b) => b.textContent.trim() === txt);
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__PNG__"]); await waitFor(() => $$(".media-item").length === 1);
    step("a PNG imports as a still image", view().project.media[0].info.still === true && /still image/.test($(".media-item").textContent), $(".media-item").textContent);

    // + Solid then + Title: the title needs a second track because the solid occupies V1 at the playhead
    btn("+ Solid").click(); await waitFor(() => solidClip());
    step("+ Solid adds a 5 s solid-colour clip on V1", !!solidClip() && rat(solidClip().duration) === 5, JSON.stringify(solidClip()?.duration));
    step("generated media is not listed in the media browser", $$(".media-item").length === 1);
    const solidPanel = await waitFor(() => $("[aria-label='Solid colour properties']"));
    step("the new solid is selected and its colour panel is shown", !!solidPanel);
    const col = solidPanel.querySelector("input[type=color][aria-label='Colour']");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(col, "#00ff00"); col.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => view().project.media.some((m) => m.generator?.color === "#00ff00ff"), 5000);
    step("changing the colour swaps the clip to a #00ff00 solid", view().project.media.some((m) => m.generator?.color === "#00ff00ff") && view().project.media.find((m) => m.id === solidClip().media).generator.color === "#00ff00ff", JSON.stringify(view().project.media.map((m) => m.generator)));

    btn("+ Title").click(); await waitFor(() => titleClip());
    const vtracks = view().project.sequences[0].tracks.filter((t) => t.kind === "video");
    step("+ Title adds a title on a NEW track because V1 is busy at the playhead", vtracks.length === 2 && vtracks[1].clips.length === 1 && !!vtracks[1].clips[0].title, vtracks.map((t) => t.clips.length).join("/"));
    const tp = await waitFor(() => $("[aria-label='Title properties']"));
    step("the new title is selected and its panel is shown", !!tp && /Title/.test(tp.textContent));
    step("the timeline clip shows the title text instead of a filmstrip", /Title/.test($$(".track.video .clip").map((c) => c.textContent).join("|")) && !!$(".gen-fill.title"));

    const ta = tp.querySelector("textarea[aria-label='Title text']");
    await typeInto(ta, "HELLO");
    await waitFor(() => titleClip().title.text === "HELLO");
    step("editing the text commits on blur and renames the clip", titleClip().title.text === "HELLO" && titleClip().name === "HELLO", JSON.stringify(titleClip().title));
    const fontSel = $("select[aria-label='Title font']");
    const fonts = [...fontSel.options].map((o) => o.textContent);
    step("the font list offers the built-in fonts", fonts.some((f) => /DejaVu Sans \(built in\)/.test(f)) && fonts.some((f) => /Bold \(built in\)/.test(f)), fonts.slice(0, 4).join(" | "));
    setSel(fontSel, "DejaVu Sans"); await waitFor(() => titleClip().title.font === "DejaVu Sans");
    step("choosing a font updates the title", titleClip().title.font === "DejaVu Sans");
    setNum($("[aria-label='Title properties'] input[aria-label='Size']"), 14); await waitFor(() => titleClip().title.size === 14);
    step("the size slider is a command", titleClip().title.size === 14);
    $("button[aria-label='Align left']").click(); await waitFor(() => titleClip().title.align === "left");
    step("alignment buttons update the title", titleClip().title.align === "left");
    $("button[aria-label='Align center']").click(); await waitFor(() => titleClip().title.align === "center");
    const tcol = $("[aria-label='Title properties'] input[type=color][aria-label='Text colour']");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(tcol, "#ff0000"); tcol.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => titleClip().title.color === "#ff0000", 5000);
    step("the colour picker commits (debounced) as one command", titleClip().title.color === "#ff0000");
    setNum($("[aria-label='Title properties'] input[aria-label='Outline']"), 0); await waitFor(() => titleClip().title.outline_width === 0);
    // title position uses the generic Transform panel (title is a normal video clip)
    step("the title also has Transform / Compositing controls", !!$("[aria-label='Video properties'] [data-param='y']") && !!$("[aria-label='Video properties'] [data-param='opacity'] .kf-btn"));

    // a hostile text edit goes through the engine untouched
    const nasty = "It's 5:00, [ok]; 100% %{localtime}";
    await typeInto($("textarea[aria-label='Title text']"), nasty);
    await waitFor(() => titleClip().title.text === nasty);
    step("quotes, colons, brackets and %{…} survive the UI → engine round trip", titleClip().title.text === nasty, titleClip().title.text);
    await typeInto($("textarea[aria-label='Title text']"), "HELLO"); await waitFor(() => titleClip().title.text === "HELLO");

    // a still image placed on a third track later in the timeline
    await P().dispatch({ type: "add_track", kind: "video" });
    const v3 = view().project.sequences[0].tracks.filter((t) => t.kind === "video")[2].id;
    const png = view().project.media.find((m) => m.info.still && !m.generator).id;
    const ok = await P().dispatch({ type: "place_clip", media: png, track: v3, start: "6", source_in: null, duration: null, with_audio: true });
    const pc = clips().find((c) => c.media === png);
    step("placing a still gives it 5 s and no audio", ok && rat(pc.duration) === 5 && pc.link === null, JSON.stringify(pc?.duration));
    await sleep(500);
    step("the still's timeline clip shows its picture", $$(".track.video .clip").some((c) => c.querySelector("img")));
    // export for the independent check
    await inv("start_export", { preset: "h264_mp4", output: "__OUT__" });
    let ver = null;
    for (let i = 0; i < 160 && !ver; i++) { await sleep(500); try { ver = await inv("verify_output", { path: "__OUT__" }); } catch (_) {} }
    step("export completes", ver && !/WARNING/.test(ver), ver);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
