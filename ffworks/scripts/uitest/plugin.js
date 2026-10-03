// In-webview test for plugins. __PLUGIN__ is substituted by plugin.sh.
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
  const seq = () => view().project.sequences[0];
  try {
    await waitFor(() => $(".app") && view());
    const v1 = seq().tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "add_solid", track: v1, start: "0", duration: "35", color: "#336699" });
    await sleep(300);
    const clip = seq().tracks.find((t) => t.kind === "video").clips[0].id;
    step("a 35 s solid clip", !!clip);
    step("no plugins are installed yet", (await inv("list_plugins")).plugins.length === 0);

    const info = await inv("install_plugin", { folder: "__PLUGIN__" });
    step("installing copies the plugin and reports its actions", info.name === "Example plugin" && info.actions.some((a) => a.id === "markers"), JSON.stringify(info).slice(0, 200));
    const list = await inv("list_plugins");
    step("it is listed afterwards", list.plugins.length === 1 && list.broken.length === 0, JSON.stringify(list).slice(0, 200));

    U().setPaletteOpen(true);
    const item = await waitFor(() => $$('[role="option"]').find((o) => o.textContent.includes("Plugin Example plugin: Add a marker every 10 seconds")));
    step("its actions appear in the command palette", !!item);
    item.click();
    await waitFor(() => seq().markers.length === 3);
    step("choosing one runs it: three markers at 10, 20, 30 s", seq().markers.map((m) => m.time).join(",") === "10,20,30", JSON.stringify(seq().markers.map((m) => m.time)));
    step("the undo label names the plugin", /Plugin Example plugin/.test(view().undoLabel || ""), view().undoLabel);
    P().setView(await inv("undo")); await sleep(300);
    step("the whole run is ONE undo step", seq().markers.length === 0, seq().markers.length);

    const r = await inv("run_plugin", { folder: "example-plugin", action: "half-opacity", selected: clip });
    P().setView(r.view); await sleep(200);
    step("the selected clip reaches the plugin", seq().tracks.find((t) => t.kind === "video").clips[0].opacity === 0.5);

    let err = "";
    try { await inv("run_plugin", { folder: "example-plugin", action: "try-import", selected: null }); } catch (e) { err = String(e); }
    step("a plugin that tries to read a file is refused", /read a file from disk/.test(err), err);
    err = "";
    try { await inv("run_plugin", { folder: "../example-plugin", action: "markers", selected: null }); } catch (e) { err = String(e); }
    step("a folder name that escapes the plugins folder is refused", /not a plugin folder name/.test(err), err);
    err = "";
    try { await inv("run_plugin", { folder: "example-plugin", action: "half-bad", selected: null }); } catch (e) { err = String(e); }
    step("a failing command rolls back the ones before it", /command 2 failed/.test(err) && seq().markers.length === 0, err);
    err = "";
    const t0 = Date.now();
    try { await inv("run_plugin", { folder: "example-plugin", action: "spin", selected: null }); } catch (e) { err = String(e); }
    step("a plugin that never finishes is stopped", /timeout/.test(err) && Date.now() - t0 < 40000, err + " " + (Date.now() - t0));
    step("and the app is still usable", (await inv("run_plugin", { folder: "example-plugin", action: "markers", selected: null })).commands === 3);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
