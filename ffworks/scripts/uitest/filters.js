// In-webview test for the filter browser.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const typeInto = async (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); await sleep(150); };
  try {
    await waitFor(() => $(".app") && window.__ffworks.useProject.getState().view);
    $$("button").find((b) => b.textContent.trim() === "Filters").click();
    const dlg = await waitFor(() => $("[aria-label='Filter browser']"));
    step("Filters button opens the browser", !!dlg);
    await waitFor(() => $$(".filter-list li").length > 100);
    const total = $$(".filter-list li").length;
    step("lists every filter of the installed FFmpeg (>100)", total > 100, total);
    const real = await inv("list_filters");
    step("list length matches the backend list", real.length === total, `${real.length} vs ${total}`);
    await typeInto($("[aria-label='Search filters']"), "vignette");
    step("search narrows the list", $$(".filter-list li").length >= 1 && $$(".filter-list li").length < 5, $$(".filter-list li").length);
    $$(".filter-list li button")[0].click();
    await waitFor(() => $(".filter-detail h3"));
    step("selecting shows the filter name", $(".filter-detail h3").textContent === "vignette", $(".filter-detail h3").textContent);
    await waitFor(() => $$(".filter-opts tbody tr").length > 3);
    const names = $$(".filter-opts tbody tr").map((r) => r.querySelector("b").textContent);
    step("option table lists angle, mode and eval", ["angle", "mode", "eval"].every((n) => names.includes(n)), names.join());
    const modeRow = $$(".filter-opts tbody tr").find((r) => r.querySelector("b").textContent === "mode");
    step("enum choices shown (forward, backward)", /forward, backward/.test(modeRow.textContent), modeRow.textContent);
    await typeInto($("[aria-label='Search filters']"), "");
    const sel = $("select[aria-label='Media type']");
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, "audio"); sel.dispatchEvent(new Event("change", { bubbles: true })); await sleep(150);
    const audioN = $$(".filter-list li").length;
    step("audio filter fewer than all and includes volume", audioN > 10 && audioN < total && $$(".filter-list li b").some((b) => b.textContent === "volume"), audioN);
    const bad = await inv("filter_help", { name: "a;b" }).then(() => false, () => true);
    step("a malicious filter name is refused by the backend", bad);
    $$("button").find((b) => b.textContent.trim() === "Close").click();
    await sleep(100);
    step("Close hides the browser", !$("[aria-label='Filter browser']"));
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
