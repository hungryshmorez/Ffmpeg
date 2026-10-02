// In-webview test for importing subtitles. __SRC__ and __SUBS__ are substituted by subs.sh.
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
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "0", duration: "4", with_audio: true }); await sleep(400);
    const tracks = () => view().project.sequences[0].tracks;
    const n0 = tracks().length;
    const sv = await inv("import_subtitles", { path: "__SUBS__", offset: 0 });
    P().setView(sv); await sleep(500);
    const st = tracks().find((t) => t.name === "Subtitles");
    step("a Subtitles track appears with two title clips", !!st && st.clips.length === 2 && tracks().length === n0 + 1, JSON.stringify(st && st.clips.map((c) => [c.start, c.duration])));
    step("the first cue starts at 1 s and lasts 1 s, the second starts at 3 s and lasts 1.5 s", st && rat(st.clips[0].start) === 1 && rat(st.clips[0].duration) === 1 && rat(st.clips[1].start) === 3 && rat(st.clips[1].duration) === 1.5);
    step("the clips are title clips carrying the text", st && st.clips[0].title && st.clips[0].title.text === "HELLO" && st.clips[1].title.text === "WORLD", JSON.stringify(st && st.clips.map((c) => c.title && c.title.text)));
    step("the timeline shows the track", $$(".track").some((t) => /Subtitles/.test(t.textContent)));
    P().setView(await inv("undo")); await sleep(300);
    step("undo removes the whole import (track and clips) in one step", !tracks().some((t) => t.name === "Subtitles"));
    let err = "";
    try { await inv("import_subtitles", { path: "__SRC__", offset: 0 }); } catch (e) { err = String(e); }
    step("a file that is not a subtitle file is refused with a reason", /subtitle|cue|utf-8|stream/i.test(err), err);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
