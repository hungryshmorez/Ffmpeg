// In-webview test: per-file "Source colours" override in the media browser. __SRC__ is an SD-looking clip with no colour tags.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const pick = async (sel, value) => {
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    set.call(sel, value);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(300);
  };
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    step("no colour selector until a file is selected", !$("select[aria-label='Source colours']"));
    $(".media-item").click();
    const sel = await waitFor(() => $("select[aria-label='Source colours']"));
    step("selecting a video file offers the Source colours choice, set to trusting the tags", !!sel && sel.value === "", sel && sel.value);
    step("every standard is listed", !!sel && [...sel.options].map((o) => o.value).join(",") === ",rec709,bt601_ntsc,bt601_pal,bt2020,pq,hlg", sel && [...sel.options].map((o) => o.value).join(","));

    await pick(sel, "bt601_ntsc");
    step("choosing BT.601 NTSC is stored on the media", view().project.media[0].color_override === "bt601_ntsc", JSON.stringify(view().project.media[0].color_override));
    step("the selector shows the stored choice", $("select[aria-label='Source colours']").value === "bt601_ntsc");
    await pick($("select[aria-label='Source colours']"), "pq");
    step("changing it replaces the choice", view().project.media[0].color_override === "pq");
    await pick($("select[aria-label='Source colours']"), "");
    step("choosing 'trust the tags' clears it", !view().project.media[0].color_override);

    P().setView(await inv("undo")); await sleep(300);
    step("undo steps back to the previous choice", view().project.media[0].color_override === "pq", JSON.stringify(view().project.media[0].color_override));
    await P().undo(); P().setView(await inv("undo")); await sleep(300);
    step("and back to nothing", !view().project.media[0].color_override);

    let refused = "";
    try { await inv("dispatch", { command: { type: "set_media_color", media: "nope", color: "pq" } }); } catch (e) { refused = String(e); }
    step("an unknown media id is refused", refused.length > 0, refused);
  } catch (e) {
    step("script error", false, e && e.stack || e);
  }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
