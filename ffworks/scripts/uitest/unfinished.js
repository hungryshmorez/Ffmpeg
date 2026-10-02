// In-webview test for unfinished exports. __SRC__, __OUTDIR__, __PHASE__ substituted by unfinished.sh.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const jobs = () => window.__ffworks.useJobs.getState().jobs;
  try {
    await waitFor(() => $(".app") && view());
    if ("__PHASE__" === "1") {
      step("a first launch offers nothing", !$("[aria-label='Unfinished exports']") && (await inv("unfinished_exports")).length === 0);
      await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
      const m = view().project.media[0].id, v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
      await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "0", duration: "20", with_audio: true }); await sleep(300);
      const a = await inv("start_export", { preset: "h264_mp4", output: "__OUTDIR__/one.mp4", engine: null, keepExisting: false });
      await inv("start_export", { preset: "h264_mp4", output: "__OUTDIR__/two.mp4", engine: null, keepExisting: false });
      const rendering = await waitFor(() => jobs()[a]?.state === "rendering");
      step("phase 1: one export rendering, one waiting, then the app is killed", !!rendering);
      await sleep(1500); // let the autosave happen too, so the recovery question comes first next time
    } else {
      const rec = await waitFor(() => $("[aria-label='Recover unsaved work']"));
      step("after the crash the recovery question comes first, alone", !!rec && !$("[aria-label='Unfinished exports']"));
      [...rec.querySelectorAll("button")].find((b) => b.textContent === "Discard").click();
      const dlg = await waitFor(() => $("[aria-label='Unfinished exports']"), 5000);
      step("then the unfinished exports are listed", !!dlg && /one\.mp4/.test(dlg.textContent) && /two\.mp4/.test(dlg.textContent) && /was rendering/.test(dlg.textContent) && /was waiting/.test(dlg.textContent), dlg && dlg.textContent.slice(0, 300));
      [...dlg.querySelectorAll("button")].find((b) => /Queue them again/.test(b.textContent)).click();
      await sleep(500);
      const ids = Object.keys(jobs());
      const done = await waitFor(() => ids.length === 2 && ids.every((id) => jobs()[id].state === "completed"), 120000);
      step("Queue them again renders both", !!done, JSON.stringify(Object.values(jobs()).map((j) => [j.output, j.state])));
      const v = await inv("verify_output", { path: "__OUTDIR__/one.mp4" }).catch((e) => String(e));
      step("the restarted export is a complete file", /h264/.test(v) && /20\.0/.test(v), v.slice(0, 200));
      step("nothing is offered once resolved", (await inv("unfinished_exports")).length === 0);
    }
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
