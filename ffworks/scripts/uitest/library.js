// In-webview test for the media library. __W__ is substituted by library.sh.
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
  const W = "__W__";
  const setInput = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
  try {
    await waitFor(() => $(".app") && view());
    step("the library starts empty", (await inv("search_library", { query: "", limit: null })).length === 0);

    await window.__ffworks.importPaths([`${W}/a/interview.mp4`, `${W}/a/beach holiday.mp4`]);
    await waitFor(() => $$(".media-item").length === 2);
    const all = await inv("search_library", { query: "", limit: null });
    step("importing remembers both files", all.length === 2 && all.every((e) => e.exists), JSON.stringify(all.map((e) => e.name)));
    const iv = all.find((e) => e.name === "interview.mp4");
    step("with their size, picture size and length", iv.width === 160 && iv.height === 120 && iv.hasVideo && iv.hasAudio && Math.abs(iv.duration - 2) < 0.4 && iv.sizeBytes > 1000, JSON.stringify(iv));

    // the dialog: search by a word of the name, in any case
    U().setLibraryOpen(true);
    const box = await waitFor(() => $("input[aria-label='Search the media library']"));
    setInput(box, "BEACH");
    const row = await waitFor(() => $$("ul[aria-label='Remembered files'] li").length === 1 && $$("ul[aria-label='Remembered files'] li")[0]);
    step("the dialog finds a file by a word of its name", !!row && /beach holiday\.mp4/.test(row.textContent) && /picture · 160×120/.test(row.textContent), row && row.textContent);
    setInput(box, "zzz-no-such-file");
    step("and says so when nothing matches", !!(await waitFor(() => /Nothing matches/.test(document.body.textContent))));

    // a new project: re-import from the library with one click
    P().setView(await inv("new_project", { name: "second" }));
    await sleep(300);
    step("a fresh project has no media", view().project.media.length === 0);
    setInput(box, "interview");
    const imp = await waitFor(() => $("button[aria-label='Import interview.mp4']"));
    imp.click();
    await waitFor(() => view().project.media.length === 1);
    step("Import in the dialog adds the file to the project", view().project.media[0].path.endsWith("interview.mp4"));
    U().setLibraryOpen(false);

    // another project imports a copy that lives in the archive (the library learns where the same content is) ...
    P().setView(await inv("new_project", { name: "other" })); await sleep(300);
    await window.__ffworks.importPaths([`${W}/archive/interview_final.mp4`]);
    await waitFor(() => view().project.media.length === 1);
    // ... and the project that matters only knows the original, then it is saved for phase 2
    P().setView(await inv("new_project", { name: "main" })); await sleep(300);
    await window.__ffworks.importPaths([`${W}/a/interview.mp4`]);
    await waitFor(() => view().project.media.length === 1);
    await inv("save_project", { path: `${W}/p.ffworks` });
    step("three files are remembered, two of them the same content", (await inv("search_library", { query: "interview", limit: null })).length === 2 && (await inv("search_library", { query: "", limit: null })).length === 3);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
