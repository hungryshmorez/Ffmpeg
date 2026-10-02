// In-webview test for export naming. __SRC__ and __OUTDIR__ are substituted by exportname.sh.
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
  const setText = (input, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(v)); input.dispatchEvent(new Event("input", { bubbles: true })); };
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "0", duration: "1", with_audio: true }); await sleep(300);

    U().setExportOpen(true); await sleep(400);
    const tpl = () => $("[aria-label='File name template']"), keep = () => $("[aria-label='Keep earlier exports']");
    step("the dialog has a file name template ({project}) and keep-earlier-exports on by default", tpl() && tpl().value === "{project}" && keep() && keep().checked, tpl() && tpl().value);
    setText(tpl(), "{project}_{res}_{preset}"); await sleep(200);
    keep().click(); await sleep(100);
    U().setExportOpen(false); await sleep(200); U().setExportOpen(true); await sleep(300);
    step("the template and the keep choice are remembered when the dialog reopens", tpl().value === "{project}_{res}_{preset}" && !keep().checked, `${tpl().value} keep=${keep().checked}`);
    keep().click(); await sleep(100);
    U().setExportOpen(false);
    const name = await inv("export_name", { template: "{project}_{res}_{preset}/x:{date}", preset: "h264_mp4", date: "2026-10-02", time: "1200" });
    const s = view().project.settings;
    step("export_name expands tokens and makes the name safe", name === `${view().project.name}_${s.width}x${s.height}_h264_mp4_x_2026-10-02`, name);

    const out = "__OUTDIR__/same.mp4";
    const jobs = () => window.__ffworks.useJobs.getState().jobs;
    const j1 = await inv("start_export", { preset: "h264_mp4", output: out, engine: null, keepExisting: true });
    const j2 = await inv("start_export", { preset: "h264_mp4", output: out, engine: null, keepExisting: true });
    const done = await waitFor(() => jobs()[j1]?.state === "completed" && jobs()[j2]?.state === "completed", 60000);
    step("two exports queued to the same name both complete", !!done, JSON.stringify([jobs()[j1]?.state, jobs()[j2]?.state]));
    step("the second one was renamed _v2 instead of overwriting the first", jobs()[j1]?.output.endsWith("/same.mp4") && jobs()[j2]?.output.endsWith("/same_v2.mp4"), `${jobs()[j1]?.output} | ${jobs()[j2]?.output}`);
    const j3 = await inv("start_export", { preset: "h264_mp4", output: out, engine: null, keepExisting: true });
    await waitFor(() => jobs()[j3]?.state === "completed", 60000);
    step("a third export of the same name becomes _v3", jobs()[j3]?.output.endsWith("/same_v3.mp4"), jobs()[j3]?.output);
    const j4 = await inv("start_export", { preset: "h264_mp4", output: out, engine: null, keepExisting: false });
    await waitFor(() => jobs()[j4]?.state === "completed", 60000);
    step("with keep off the chosen name is used (replaced)", jobs()[j4]?.output.endsWith("/same.mp4"), jobs()[j4]?.output);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
