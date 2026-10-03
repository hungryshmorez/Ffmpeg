// In-webview half of the local API test. __PORT__ and __TOKEN__ are substituted by localapi.sh.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  try {
    await waitFor(() => $(".app") && view());
    const st = await inv("local_api_status");
    step("the API started from the saved settings", st.enabled === true && st.url === "http://127.0.0.1:__PORT__" && st.token === "__TOKEN__", JSON.stringify(st));
    const clip = await waitFor(() => view().project.sequences[0].tracks[0].clips[0], 30000);
    step("an edit made by another program shows up in the editor without any click", !!clip && view().project.media.some((m) => m.generator?.color === "#ff0000"), JSON.stringify(view().project.sequences[0].tracks[0].clips.length));
    step("it is an ordinary undo step", /Add solid colour/.test(view().undoLabel || ""), view().undoLabel);
    let blocked = false;
    try { const r = await fetch("http://127.0.0.1:__PORT__/v1/status", { headers: { Authorization: "Bearer __TOKEN__" } }); blocked = r.status === 403; } catch (e) { blocked = true; }
    step("the editor's own web page cannot read the API (web pages are refused)", blocked);
    // Diagnostics shows the address and token and has the switch
    window.__ffworks.useUi.getState().setDiagOpen(true);
    const sw = await waitFor(() => $("input[aria-label='Local API']"));
    step("Diagnostics has the switch, on", !!sw && sw.checked);
    await waitFor(() => $("[aria-label='Local API address']"));
    step("it shows the address and the token", $("[aria-label='Local API address']")?.textContent === "http://127.0.0.1:__PORT__" && /__TOKEN__/.test($("[aria-label='Local API token']")?.textContent || ""));
    sw.click();
    await waitFor(() => !$("[aria-label='Local API address']"), 10000);
    const off = await inv("local_api_status");
    step("switching it off in Diagnostics turns it off", off.enabled === false, JSON.stringify(off));
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
