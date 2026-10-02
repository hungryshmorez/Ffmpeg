// In-webview test for scene detection + loudness (libraries: scenesdetect, ebur128). __VIDEO__ substituted by analysis.sh.
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
    btn("Detect scenes").click();
    const sum = await waitFor(() => $("[data-testid=scene-summary]"));
    step("scene detection finds 3 scenes", sum && /^3 scenes/.test(sum.textContent), sum && sum.textContent);
    const cuts = (sum.textContent.match(/cuts at (.*) s/) || [])[1]?.split(", ").map(Number) || [];
    step("cuts are near 3 s and 6 s", cuts.length === 2 && Math.abs(cuts[0] - 3) < 0.25 && Math.abs(cuts[1] - 6) < 0.25, cuts.join(","));
    btn("Split clip at scene cuts").click(); await sleep(500);
    const lefts = $$(".track.video .clip").map((c) => Math.round(parseFloat(c.style.left) / 80 * 10) / 10);
    step("splitting at scene cuts yields 3 clips (video and linked audio)", $$(".track.video .clip").length === 3 && $$(".track.audio .clip").length === 3, lefts.join(","));
    btn("↶ Undo").click(); await sleep(400);
    step("the whole split is ONE undo step", $$(".track.video .clip").length === 1);
    await select($$(".track.video .clip")[0]);
    btn("Measure loudness").click();
    const ls = await waitFor(() => $("[data-testid=loudness-summary]"));
    const lufs = ls && parseFloat(ls.textContent);
    step("loudness measured (a number in a plausible range)", Number.isFinite(lufs) && lufs < -10 && lufs > -60, ls && ls.textContent);
    btn("Normalize to -14 LUFS").click(); await sleep(500);
    const gain = view().project.sequences[0].tracks.find((t) => t.kind === "audio").clips[0].gain_db;
    step("normalize sets the clip gain to target minus measured", Math.abs(gain - (-14 - lufs)) < 0.15, `${gain} vs ${-14 - lufs}`);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
