// In-webview test for scopes. __VIDEO__ substituted by scopes.sh.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const btn = (t) => $$("button").find((b) => b.textContent.trim().startsWith(t));
  const select = async (el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: r.left + 20, clientY: r.top + 10 })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 })); await sleep(300); };
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__VIDEO__"]); await waitFor(() => $$(".media-item").length === 1);
    $$(".media-item")[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); await sleep(400);
    await select($$(".track.video .clip")[0]);
    const pick = (v) => { const sel = $("select[aria-label='Scope type']"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, v); sel.dispatchEvent(new Event("change", { bubbles: true })); };
    const loaded = (img) => img && img.complete && img.naturalWidth > 0;
    const seen = {};
    for (const kind of ["waveform", "vectorscope", "histogram", "spectrogram"]) {
      pick(kind); await sleep(150);
      btn("Show").click();
      const img = await waitFor(() => { const i = $("[data-testid=scope-image]"); return loaded(i) ? i : null; }, 20000);
      step(`${kind}: an image is drawn and actually loads in the webview`, !!img, img ? `${img.naturalWidth}x${img.naturalHeight}` : "no image");
      seen[kind] = img && img.src;
    }
    step("each scope is a different picture", new Set(Object.values(seen)).size === 4, JSON.stringify(Object.values(seen).map((u) => (u || "").split("/").pop())));
    pick("waveform"); await sleep(200);
    step("switching the scope type clears the old image", !$("[data-testid=scope-image]"));
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
