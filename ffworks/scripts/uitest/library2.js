// Phase 2 of the media library test (a second launch of the app, same library file). __W__ is substituted by library.sh.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s);
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const W = "__W__";
  try {
    await waitFor(() => $(".app") && view());
    const remembered = await inv("search_library", { query: "", limit: null });
    step("the library remembered the files across a restart", remembered.length === 3, JSON.stringify(remembered.map((e) => [e.name, e.exists])));
    step("it already knows the original is gone", remembered.find((e) => e.name === "interview.mp4").exists === false);
    P().setView(await inv("open_project", { path: `${W}/p.ffworks` })); await sleep(500);
    step("the project opens with its media offline", view().offlineMedia.length === 1, JSON.stringify(view().offlineMedia));
    // search an unrelated, empty folder: only the library knows where the same content went
    const r = await inv("relink_search", { dir: `${W}/empty` });
    P().setView(r.state); await sleep(300);
    step("relinking finds the archived copy through the library", r.relinked.length === 1 && r.unresolved.length === 0, JSON.stringify(r.relinked) + JSON.stringify(r.unresolved));
    step("the project now points at the archive", view().project.media[0].path.endsWith("/archive/interview_final.mp4") && view().offlineMedia.length === 0, view().project.media[0].path);
    step("forgetting drops the one entry whose file is gone", (await inv("forget_missing_library")) === 1 && (await inv("search_library", { query: "", limit: null })).length === 2);
  } catch (e) { step("exception", false, String(e && e.message) + " " + ((e && e.stack) || e)); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
