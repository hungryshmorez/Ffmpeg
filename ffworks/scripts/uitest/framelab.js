// In-webview test for the frame lab. __SRC__ and __LONG__ come from framelab.sh.
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
  const tracks = () => view().project.sequences[0].tracks;
  const setSelect = (el, v) => { const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(el, v); el.dispatchEvent(new Event("change", { bubbles: true })); };
  const frames = () => tracks().find((t) => t.name === "Frames");
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = tracks().find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "1", source_in: "1", duration: "2", with_audio: false });
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "4", source_in: "3", duration: "1", with_audio: false }); await sleep(400);
    await select($$(".track.video .clip")[0]);
    const open = await waitFor(() => btn("Frame lab"));
    step("the Effects panel offers the Frame lab for a video clip", !!open);
    open.click();
    const dlg = await waitFor(() => $("[aria-label='Frame lab']"));
    step("the lab opens with the mode and keyframe controls", !!dlg && ["Frame mode", "Full picture every (frames)", "Remove keyframes", "Keep the first frame", "Remove frames with too much data"].every((l) => dlg.querySelector(`[aria-label='${l}']`)));
    const make = btn("Make frame-lab clip");
    step("Classic is the default and can be made at once", !!make && !make.disabled);
    setSelect($("[aria-label='Frame mode']"), "bloom"); await sleep(200);
    step("Bloom asks for a frame number and a repeat count", !!$("[aria-label='Frame number']") && !!$("[aria-label='Repeats']"));
    setSelect($("[aria-label='Frame mode']"), "splice"); await sleep(200);
    step("Splice needs a clip to borrow movement from", make.disabled && !!$("[aria-label='Clip lending its movement']"));
    const donor = $("[aria-label='Clip lending its movement']");
    step("only the other clips are offered", donor.querySelectorAll("option").length === 2, donor.innerHTML);
    setSelect($("[aria-label='Frame mode']"), "classic"); await sleep(200);
    $("[aria-label='Remove keyframes']").click(); await sleep(150);
    step("Classic with keyframes kept would do nothing, so Make is disabled", make.disabled);
    $("[aria-label='Remove keyframes']").click(); await sleep(150);
    step("ticking it again enables Make", !make.disabled);
    setSelect($("[aria-label='Frame mode']"), "bloom"); await sleep(200);
    make.click();
    const added = await waitFor(() => frames() && frames().clips.length === 1 && frames(), 120000);
    step("a Frames track appears holding the new clip", !!added, JSON.stringify(tracks().map((t) => [t.name, t.clips.length])));
    const c = added && added.clips[0];
    step("it sits where the original is and lasts as long", c && c.start === "1" && c.duration === "2", c && JSON.stringify([c.start, c.duration]));
    step("the original clip is untouched", tracks().find((t) => t.id === v1).clips.length === 2);
    const media = view().project.media.find((x) => x.id === (c && c.media));
    step("the result is a new media file in the project", !!media && /frames_.*\.mkv$/.test(media.path), media && media.path);
    step("the dialog closed", !$("[aria-label='Frame lab']"));
    const job = J().find((j) => j.operation === "lab:frames");
    step("the run was a queue job, now completed", !!job && job.state === "completed" && /^Frame lab:/.test(job.output), JSON.stringify(job));
    for (let i = 0; i < 3; i++) { P().setView(await inv("undo")); await sleep(250); }
    step("three undo steps remove the new clip, track and media", !frames() && view().project.media.length === 1, JSON.stringify(tracks().map((t) => t.name)));

    // splice through the command, with the second clip lending its movement
    const clips = tracks().find((t) => t.id === v1).clips;
    const args = { kind: "splice", donor: clips[1].id, spliceAt: 1, keyframeEvery: 15, dropKeyframes: true, keepFirst: true };
    await inv("make_frames", { clip: clips[0].id, args }).then((v) => P().setView(v));
    step("a splice run adds its track too", !!frames() && frames().clips.length === 1);
    for (let i = 0; i < 3; i++) { P().setView(await inv("undo")); await sleep(250); }

    // refusals and a cancel, through the command
    let err = "";
    try { await inv("make_frames", { clip: clips[0].id, args: { kind: "bloom", count: 3, at: 5000, keyframeEvery: 15, dropKeyframes: true, keepFirst: true } }); } catch (e) { err = String(e); }
    step("a frame number beyond the clip is refused with the reason", /beyond|from 0 to/i.test(err), err);
    err = "";
    try { await inv("make_frames", { clip: clips[0].id, args: { kind: "wobble", keyframeEvery: 15, dropKeyframes: true, keepFirst: true } }); } catch (e) { err = String(e); }
    step("an unknown mode is refused", /unknown frame mode/i.test(err), err);
    await window.__ffworks.importPaths(["__LONG__"]); await waitFor(() => $$(".media-item").length === 2);
    const m2 = view().project.media.find((x) => /long\.mkv$/.test(x.path)).id;
    await P().dispatch({ type: "place_clip", media: m2, track: v1, start: "10", source_in: "0", duration: "30", with_audio: false }); await sleep(400);
    const long = tracks().find((t) => t.id === v1).clips.find((x) => x.media === m2);
    const run = inv("make_frames", { clip: long.id, args: { kind: "classic", keyframeEvery: 30, dropKeyframes: true, keepFirst: true } }).then(() => "done", (e) => String(e));
    await sleep(300);
    const t0 = Date.now();
    const cancelled = await inv("cancel_framelab");
    const outcome = await run;
    step("a long run is cancelled quickly and reports the cancel", cancelled === true && /cancel/i.test(outcome) && Date.now() - t0 < 10000, `${cancelled} ${outcome} ${Date.now() - t0} ms`);
    step("a cancelled run adds nothing", !frames());
    step("the queue shows it as canceled", J().some((j) => j.operation === "lab:frames" && j.state === "canceled"), JSON.stringify(J().map((j) => [j.operation, j.state])));
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
