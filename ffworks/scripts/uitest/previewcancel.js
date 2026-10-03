// In-webview test: cancel a slow preview. __SRC__ is substituted by previewcancel.sh (12 s of 1080p noise).
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const U = () => window.__ffworks.useUi.getState();
  const btn = (re) => $$("button").find((b) => re.test(b.textContent || b.getAttribute("aria-label") || ""));
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "0", duration: "10", with_audio: false }); await sleep(400);
    const clip = view().project.sequences[0].tracks[0].clips[0];
    await P().dispatch({ type: "add_effect", clip: clip.id, effect: "pixel_sort", params: { mode: 1 }, index: null }); await sleep(300);
    step("nothing to cancel before a preview runs", (await inv("cancel_preview")) === false);

    btn(/^Render preview/).click();
    const cancel = await waitFor(() => $("button[aria-label='Cancel preview']"), 20000);
    step("while a preview renders there is a Cancel button", !!cancel && U().previewBusy === true);
    const J = () => Object.values(window.__ffworks.useJobs.getState().jobs);
    step("the preview is also a job in the queue, with a description instead of a file name", J().some((j) => j.operation === "preview" && j.state === "rendering" && /^Preview \d+ s to \d+ s$/.test(j.output)), JSON.stringify(J().map((j) => [j.operation, j.state, j.output])));
    await sleep(1500);
    const t0 = Date.now();
    cancel.click();
    const stopped = await waitFor(() => U().previewBusy === false, 15000);
    step("cancelling stops it within a few seconds", !!stopped && Date.now() - t0 < 12000, `${Date.now() - t0} ms`);
    step("no preview was produced and the old one is not replaced", U().preview === null);
    step("the queue shows the preview job as canceled", !!(await waitFor(() => J().some((j) => j.operation === "preview" && j.state === "canceled"), 5000)), JSON.stringify(J().map((j) => [j.operation, j.state])));
    step("the user is told it was canceled, not that it failed", $$(".toast").some((t) => /canceled/i.test(t.textContent)) && !$$(".toast").some((t) => /Preview failed/i.test(t.textContent)), $$(".toast").map((t) => t.textContent).join(" | "));
    step("the Render preview button is available again", !!btn(/^Render preview/) && !btn(/^Render preview/).disabled);

    // cancel a second preview from the Queue panel itself
    btn(/^Render preview/).click();
    await waitFor(() => J().some((j) => j.operation === "preview" && j.state === "rendering"), 20000);
    window.__ffworks.useJobs.getState().setQueueOpen(true);
    const row = await waitFor(() => $$(".job-row.rendering").find((r) => /Preview/.test(r.textContent)), 5000);
    step("the Queue panel lists the running preview with a Cancel button and no Log button", !!row && !!([...row.querySelectorAll("button")].find((b) => b.textContent === "Cancel")) && ![...row.querySelectorAll("button")].some((b) => /Log/.test(b.textContent)));
    await sleep(800);
    [...row.querySelectorAll("button")].find((b) => b.textContent === "Cancel").click();
    step("cancelling from the Queue stops the preview too", !!(await waitFor(() => U().previewBusy === false, 15000)) && U().preview === null);
    window.__ffworks.useJobs.getState().setQueueOpen(false);

    // an analysis is a job as well, and a failing one says why (this clip has no audio)
    let err = "";
    try { await inv("measure_loudness", { mediaId: m }); } catch (e) { err = String(e); }
    const an = J().find((j) => j.operation === "analysis:loudness");
    step("an analysis shows up in the queue", !!an && /^Loudness of big\.mkv$/.test(an.output), JSON.stringify(an));
    step("and when it fails the queue and the caller both carry the reason", !!err && an.state === "failed" && /audio/.test(an.message || ""), err + " | " + (an && an.message));

    // the next preview works (a short one: only 2 s of the clip)
    P().setView(await inv("undo")); await sleep(300);
    step("the effect was removed again to make the next preview quick", view().project.sequences[0].tracks[0].clips[0].effects.length === 0);
    btn(/^Render preview/).click();
    const ok = await waitFor(() => $(".bypass-badge.ok"), 120000);
    step("a later preview renders normally", !!ok);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
