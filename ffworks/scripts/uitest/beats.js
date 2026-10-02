// In-webview test for beat detection. __CLICKS__ is substituted by beats.sh.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const ptr = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1 }));
  const drag = async (el, dx) => { const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; ptr(el, "pointerdown", x, y); await sleep(30); ptr(el, "pointermove", x + dx / 2, y); ptr(el, "pointermove", x + dx, y); await sleep(30); ptr(el, "pointerup", x + dx, y); await sleep(300); };
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__CLICKS__"]); await waitFor(() => $$(".media-item").length === 1);
    $$(".media-item")[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); await sleep(300);
    const P = window.__ffworks.useProject.getState();
    await P.dispatch({ type: "add_track", kind: "video" }); await P.dispatch({ type: "add_track", kind: "audio" });
    const tracks = () => view().project.sequences[0].tracks;
    const v2 = tracks().filter((t) => t.kind === "video")[1].id, a2 = tracks().filter((t) => t.kind === "audio")[1].id;
    await P.dispatch({ type: "place_clip", media: view().project.media[0].id, track: v2, start: "10200000/1000000", with_audio: true, audio_track: a2 }); await sleep(400);
    step("clip at 0s on V1/A1 and a copy at 10.2s on V2/A2", $$(".track.video .clip").length === 2 && $$(".track.audio .clip").length === 2);
    const x = $$(".track.video .clip").find((c) => parseFloat(c.style.left) === 0);
    const r = x.getBoundingClientRect();
    x.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: r.left + 20, clientY: r.top + 10 })); ptr(x, "pointerup", 0, 0); await sleep(200);
    const btn = await waitFor(() => $$("button").find((b) => b.textContent === "Detect beats"));
    step("Inspector offers Detect beats for the selected clip", !!btn);
    btn.click();
    const sum = await waitFor(() => $("[data-testid=beat-summary]"));
    step("beats detected; BPM close to 120", sum && /(\d+) beats · (1[12]\d(\.\d)?) BPM/.test(sum.textContent), sum && sum.textContent);
    const n = sum && +((sum.textContent.match(/^(\d+) beats/) || [])[1]);
    step("at least 9 of the 11 clicks were found", n >= 9, n);
    await sleep(300);
    const ticks = $$(".track.audio .clip")[0].querySelectorAll(".beat-ticks i").length;
    step("beat ticks are drawn on the audio clip", ticks >= 9, ticks);
    // Drag the copy so its start is at 3.06 s. Unsnapped that is frame 3.0667 s = 245.3 px (observed before the fix); with beat snapping it must land on
    // the first clip's beat near 2.98 s -> frame 3.0 s = 240 px.
    const cb = $$(".timeline-bar input[type=checkbox]").find((c) => /beats/.test(c.parentElement.textContent)); cb.click(); await sleep(100);
    const y = $$(".track.video .clip").find((c) => parseFloat(c.style.left) > 400);
    await drag(y, (3.06 - 10.2) * 80);
    const left = parseFloat(y.style.left);
    step("with Snap to beats on, the dragged clip snaps onto a beat (240 px = 3.0 s, not 245 px)", Math.abs(left - 240) < 1, left);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
