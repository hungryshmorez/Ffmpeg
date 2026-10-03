// In-webview test for Rhai scripting. __GOOD__ / __BAD__ / __LOOP__ are substituted by script.sh.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const seq = () => view().project.sequences[0];
  const vclips = () => seq().tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips).sort((a, b) => Number(a.start.split("/")[0]) / Number(a.start.split("/")[1] || 1) - Number(b.start.split("/")[0]) / Number(b.start.split("/")[1] || 1));
  try {
    await waitFor(() => $(".app") && view());
    const v1 = seq().tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "add_solid", track: v1, start: "0", duration: "5", color: "#ff0000" });
    await P().dispatch({ type: "add_solid", track: v1, start: "5", duration: "2", color: "#00ff00" });
    await P().dispatch({ type: "add_solid", track: v1, start: "7", duration: "6", color: "#0000ff" });
    await sleep(300);
    step("three solid clips (5 s, 2 s, 6 s)", vclips().length === 3);
    const undoDepth = () => view().undoLabel;
    const r = await inv("run_script", { path: "__GOOD__", selected: null, allowAnalysis: false });
    P().setView(r.view); await sleep(300);
    step("the script's loop and condition picked the long clips", vclips()[0].effects.length === 1 && vclips()[2].effects.length === 1 && vclips()[1].effects.length === 0, JSON.stringify(vclips().map((c) => c.effects.length)));
    step("the short clip got half opacity", vclips()[1].opacity === 0.5, vclips()[1].opacity);
    step("it printed and counted", r.log.join("|") === "long clips: 2" && r.commands === 4, JSON.stringify(r));
    step("the marker was added by the script", seq().markers.some((m) => m.name === "script ran: 2 long"));
    P().setView(await inv("undo")); await sleep(300);
    step("the whole script is ONE undo step", vclips().every((c) => c.effects.length === 0 && c.opacity === 1) && seq().markers.length === 0, JSON.stringify(vclips().map((c) => [c.effects.length, c.opacity])));
    let err = "";
    try { await inv("run_script", { path: "__BAD__", selected: null, allowAnalysis: false }); } catch (e) { err = String(e); }
    step("a script that tries to read a file is refused", /read_file|Function not found/.test(err), err);
    step("and what it did before failing was rolled back", seq().markers.length === 0, seq().markers.length);
    err = "";
    const t0 = Date.now();
    try { await inv("run_script", { path: "__LOOP__", selected: null, allowAnalysis: false }); } catch (e) { err = String(e); }
    step("an endless loop is stopped by the limits", /operations|too many|limit/i.test(err), err);
    step("and the app is still usable afterwards", (await inv("run_script", { path: "__GOOD__", selected: null, allowAnalysis: false })).commands === 4);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
