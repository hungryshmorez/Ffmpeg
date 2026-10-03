// In-webview test for the corruption lab. __SRC__ and __LONG__ come from corrupt.sh.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const J = () => Object.values(window.__ffworks.useJobs.getState().jobs);
  const select = async (el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: r.left + 20, clientY: r.top + 10 })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 })); await sleep(250); };
  const btn = (name) => $$("button").find((b) => b.textContent.trim().startsWith(name));
  const setCheck = (el, v) => { if (el.checked !== v) el.click(); };
  const tracks = () => view().project.sequences[0].tracks;
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = tracks().find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "1", source_in: "1", duration: "2", with_audio: false }); await sleep(400);
    await select($$(".track.video .clip")[0]);
    const open = await waitFor(() => btn("Corruption lab"));
    step("the Effects panel offers the Corruption lab for a video clip", !!open);
    open.click();
    const dlg = await waitFor(() => $("[aria-label='Corruption lab']"));
    step("the lab opens with the codec, bit, packet and keyframe controls", !!dlg && ["Codec", "Damage bits", "Bit damage level", "Drop packets", "Drop one packet in", "Keyframe spacing in frames"].every((l) => dlg.querySelector(`[aria-label='${l}']`)));
    const make = btn("Make corrupted clip");
    step("Make is on by default (bit damage is ticked)", !!make && !make.disabled);
    setCheck($("[aria-label='Damage bits']"), false); await sleep(150);
    step("with nothing to break Make is disabled", make.disabled);
    setCheck($("[aria-label='Damage bits']"), true); await sleep(150);
    step("ticking a damage again enables it", !make.disabled);
    make.click();
    const added = await waitFor(() => tracks().find((t) => t.name === "Corruption" && t.clips.length === 1), 120000);
    step("a Corruption track appears holding the new clip", !!added, JSON.stringify(tracks().map((t) => [t.name, t.clips.length])));
    const c = added && added.clips[0];
    step("it sits where the original is and lasts as long", c && c.start === "1" && c.duration === "2", c && JSON.stringify([c.start, c.duration]));
    step("the original clip is untouched", tracks().find((t) => t.id === v1).clips.length === 1);
    const media = view().project.media.find((x) => x.id === (c && c.media));
    step("the result is a new media file in the project", !!media && /corrupt_.*\.mkv$/.test(media.path), media && media.path);
    step("the dialog closed", !$("[aria-label='Corruption lab']"));
    const job = J().find((j) => j.operation === "lab:corruption");
    step("the run was a queue job, now completed", !!job && job.state === "completed" && /^Corruption lab:/.test(job.output), JSON.stringify(job));
    for (let i = 0; i < 3; i++) { P().setView(await inv("undo")); await sleep(250); }
    step("three undo steps remove the new clip, track and media", !tracks().some((t) => t.name === "Corruption") && view().project.media.length === 1, JSON.stringify(tracks().map((t) => t.name)));

    // a refusal and a cancel, through the command
    let err = "";
    try { await inv("make_corruption", { clip: v1, codec: "mpeg4", bits: null, dropEvery: null, keyframeEvery: 30 }); } catch (e) { err = String(e); }
    step("a request that breaks nothing is refused with the reason", /choose something to break|not found|clip/i.test(err), err);
    await window.__ffworks.importPaths(["__LONG__"]); await waitFor(() => $$(".media-item").length === 2);
    const m2 = view().project.media.find((x) => /long\.mkv$/.test(x.path)).id;
    await P().dispatch({ type: "place_clip", media: m2, track: v1, start: "10", source_in: "0", duration: "30", with_audio: false }); await sleep(400);
    const long = tracks().find((t) => t.id === v1).clips.find((x) => x.media === m2);
    const run = inv("make_corruption", { clip: long.id, codec: "mpeg4", bits: 5, dropEvery: null, keyframeEvery: 30 }).then(() => "done", (e) => String(e));
    await sleep(300);
    const t0 = Date.now();
    const cancelled = await inv("cancel_corruption");
    const outcome = await run;
    step("a long run is cancelled quickly and reports the cancel", cancelled === true && /cancel/i.test(outcome) && Date.now() - t0 < 10000, `${cancelled} ${outcome} ${Date.now() - t0} ms`);
    step("a cancelled run adds nothing", !tracks().some((t) => t.name === "Corruption"));
    step("the queue shows it as canceled", J().some((j) => j.operation === "lab:corruption" && j.state === "canceled"), JSON.stringify(J().map((j) => [j.operation, j.state])));
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
