// In-webview test for audio auto-sync. __A__ and __B__ are substituted by sync.sh.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const setNum = (input, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(v)); input.dispatchEvent(new Event("input", { bubbles: true })); };
  const setSel = (sel, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, v); sel.dispatchEvent(new Event("change", { bubbles: true })); };
  const select = async (el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: r.left + 20, clientY: r.top + 10 })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 })); await sleep(250); };
  const clipsOf = (kind) => view().project.sequences[0].tracks.filter((t) => t.kind === kind).flatMap((t) => t.clips);
  const vclip = () => clipsOf("video")[0];
  const aclip = () => clipsOf("audio")[0];
  const rat = (x) => { const [n, d] = String(x).split("/"); return Number(n) / (d === undefined ? 1 : Number(d)); };
  const setT = (t) => window.__ffworks.usePlayhead.getState().setT(t);
  const field = (param) => $(`[data-param="${param}"]`);
  const numIn = (param) => field(param).querySelector("input[type=number]");
  const undo = async () => { P().setView(await inv("undo")); await sleep(200); };
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__A__", "__B__"]); await waitFor(() => $$(".media-item").length === 2);
    const ms = view().project.media; const ma = ms.find((m) => /a\.mp4$/.test(m.path)).id, mb = ms.find((m) => /b\.mp4$/.test(m.path)).id;
    const v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: ma, track: v1, start: "3", source_in: "0", duration: "8", with_audio: true }); await sleep(400);
    await P().dispatch({ type: "add_track", kind: "video", name: "V2" }); await P().dispatch({ type: "add_track", kind: "audio", name: "A2" }); await sleep(300);
    const v2 = view().project.sequences[0].tracks.find((t) => t.name === "V2").id, a2 = view().project.sequences[0].tracks.find((t) => t.name === "A2").id;
    await P().dispatch({ type: "place_clip", media: mb, track: v2, start: "14", source_in: "0", duration: "8", with_audio: true, audio_track: a2 }); await sleep(400);
    const aud = () => clipsOf("audio").slice().sort((x, y) => rat(x.start) - rat(y.start));
    step("two audio clips placed at 3 s and 14 s", aud().length === 2 && rat(aud()[0].start) === 3 && rat(aud()[1].start) === 14, aud().map((c) => rat(c.start)).join(","));
    const aB = aud()[1], aA = aud()[0];
    // select B's video clip so the panel's audio clip is B's
    const vB = clipsOf("video").find((c) => c.link === aB.link);
    await select($$(".track.video .clip").find((el) => el.closest(".track").textContent.includes("V2")) || $$(".track.video .clip")[1]);
    const sel = await waitFor(() => $("select[aria-label='Reference clip']"));
    step("the Auto-sync control lists the other audio clip", !!sel && sel.options.length === 2, sel && sel.options.length);
    setSel(sel, aA.id); await sleep(200);
    $$("button").find((b) => b.textContent.trim() === "Match").click();
    const sum = await waitFor(() => $("[data-testid=sync-summary]"), 30000);
    step("it reports B is later by 1.37 s", sum && /later by 1\.3[67]\d s/.test(sum.textContent), sum && sum.textContent);
    step("confidence is shown and not weak", sum && !/weak/.test(sum.textContent), sum && sum.textContent);
    $$("button").find((b) => b.textContent.trim() === "Move into sync").click(); await sleep(600);
    const nB = aud().find((c) => c.id === aB.id), nV = clipsOf("video").find((c) => c.id === vB.id);
    step("B's audio now starts at 3 - 1.37 = 1.63 s", Math.abs(rat(nB.start) - 1.63) < 0.05, rat(nB.start));
    step("its linked video moved with it", Math.abs(rat(nV.start) - rat(nB.start)) < 0.001, `${rat(nV.start)} vs ${rat(nB.start)}`);
    P().setView(await inv("undo")); await sleep(300);
    step("the move is one undo step", rat(aud().find((c) => c.id === aB.id).start) === 14);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
