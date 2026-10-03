// In-webview test for silence/black detection and cutting ranges out. __VIDEO__ substituted by detect.sh.
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
    const vclips = () => view().project.sequences[0].tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips);
    const aclips = () => view().project.sequences[0].tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips);
    const rat = (r) => { const [n, d] = String(r).split("/"); return Number(n) / Number(d || 1); }; const dur = (c) => rat(c.duration);
    const pick = (label) => { const sel = $("select[aria-label=Detector]"); sel.value = label; sel.dispatchEvent(new Event("change", { bubbles: true })); };
    btn("Find silence").click();
    let sum = await waitFor(() => $("[data-testid=range-summary]"));
    step("silence found at about 2-4 s", sum && /^1 ranges · 2\.[0-1]–3\.[9]|^1 ranges · 2\.0–4\.0|^1 ranges · 1\.9–/.test(sum.textContent), sum && sum.textContent);
    btn("Mark ranges").click(); await sleep(400);
    step("Mark ranges adds one marker", view().project.sequences[0].markers.length === 1, JSON.stringify(view().project.sequences[0].markers.map((m) => m.name)));
    btn("↶ Undo").click(); await sleep(300);
    step("marker undone", view().project.sequences[0].markers.length === 0);
    const before = view().project.sequences[0].tracks.length;
    btn("Cut ranges out").click(); await sleep(600);
    const total = vclips().reduce((a, c) => a + dur(c), 0);
    step("video is about 4 s after the cut", Math.abs(total - 4) < 0.1, total);
    step("audio was cut in step (two audio clips)", aclips().length === 2, aclips().length);
    btn("↶ Undo").click(); await sleep(400);
    step("the whole cut is ONE undo step", vclips().length === 1 && Math.abs(dur(vclips()[0]) - 6) < 0.05, vclips().length);
    await select($$(".track.video .clip")[0]);
    pick("black"); await sleep(100);
    btn("Find black frames").click();
    await waitFor(() => { const e = $("[data-testid=range-summary]"); return e && /^\d+ ranges/.test(e.textContent) && e.textContent !== (sum && sum.textContent); }, 20000);
    sum = $("[data-testid=range-summary]");
    step("black frames found at about 2-4 s", sum && /^1 ranges · [12]\.[0-9]–[34]\.[0-9]/.test(sum.textContent), sum && sum.textContent);

    // audio hits: the tone that starts at 4 s is a sharp attack
    await select($$(".track.video .clip")[0]);
    pick("transients"); await sleep(150);
    const lvl = $("input[aria-label='Detection level']"), gap = $("input[aria-label='Minimum length']");
    step("choosing audio hits sets a sensitivity of 1.5 and a 0.18 s minimum gap", lvl.value === "1.5" && gap.value === "0.18", `${lvl.value} ${gap.value}`);
    btn("Find audio hits").click();
    await waitFor(() => { const e = $("[data-testid=range-summary]"); return e && /^\d+ ranges/.test(e.textContent) && e.textContent !== (sum && sum.textContent); }, 20000);
    sum = $("[data-testid=range-summary]");
    step("a hit is found where the tone starts, about 4 s", sum && /(3\.9|4\.0|4\.1)–/.test(sum.textContent), sum && sum.textContent);
    step("Cut ranges out is disabled for hits (they are points, not stretches)", btn("Cut ranges out").disabled);
    btn("Mark ranges").click(); await sleep(400);
    step("Mark ranges names them hit", view().project.sequences[0].markers.length >= 1 && view().project.sequences[0].markers.every((m) => m.name === "hit"), JSON.stringify(view().project.sequences[0].markers.map((m) => m.name)));
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
