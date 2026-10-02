// In-webview UI test. Injected by the app when built with --features uitest and FFWORKS_UITEST_SCRIPT is set.
// Placeholders __A__, __B__, __PROJECT__, __OUT__ are substituted by run.sh. It drives the REAL UI
// (DOM events on real components) against the REAL Rust engine and FFmpeg.
(async () => {
  const R = { ok: true, steps: [], info: {} };
  const step = (name, cond, detail = "") => { R.steps.push({ name, pass: !!cond, detail: String(detail) }); if (!cond) R.ok = false; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const ptr = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1 }));
  const center = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const drag = async (el, dx, grab = "center") => {
    const r = el.getBoundingClientRect();
    const x = grab === "center" ? r.left + r.width / 2 : r.left + r.width / 2; const y = r.top + r.height / 2;
    ptr(el, "pointerdown", x, y); await sleep(30);
    ptr(el, "pointermove", x + dx / 2, y); ptr(el, "pointermove", x + dx, y); await sleep(30);
    ptr(el, "pointerup", x + dx, y); await sleep(250);
  };
  const clickBtn = (text) => { const b = $$("button").find((x) => x.textContent.includes(text) || (x.title || "").includes(text)); if (!b) throw new Error("button not found: " + text); b.click(); return b; };
  const vclips = () => $$(".track.video .clip");
  const aclips = () => $$(".track.audio .clip");
  const setNum = (input, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(v)); input.dispatchEvent(new Event("input", { bubbles: true })); };
  const px = () => 80;
  const view = () => window.__ffworks.useProject.getState().view;
  try {
    await waitFor(() => $(".app") && view());
    step("app renders with project loaded", $(".toolbar") && $(".timeline") && $(".monitor"));

    await window.__ffworks.importPaths(["__A__", "__B__"]);
    await waitFor(() => $$(".media-item").length === 2);
    step("imported 2 media files", $$(".media-item").length === 2, $$(".media-item").length);
    $$(".media-item")[0].click(); await sleep(200);
    const md = $(".metadata[aria-label='Media metadata']");
    step("metadata shows codec/resolution/pix_fmt/audio", md && /h264/.test(md.textContent) && /320×240/.test(md.textContent) && /yuv420p/.test(md.textContent) && /aac/.test(md.textContent), md && md.textContent.slice(0, 200));

    // place A at 0 and B at 4 via the real "double-click to add" path
    $$(".media-item")[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); await sleep(300);
    step("placing media creates a video clip and a linked audio clip", vclips().length === 1 && aclips().length === 1, `${vclips().length}/${aclips().length}`);
    const thumbs = await waitFor(() => $$(".clip.video .filmstrip img").length > 0);
    step("thumbnails (filmstrip) appear in the video clip", !!thumbs, $$(".clip.video .filmstrip img").length);
    const wave = await waitFor(() => $(".clip.audio canvas"));
    step("waveform canvas appears in the audio clip", !!wave);
    window.__ffworks.usePlayhead.getState().setT(4);
    $$(".media-item")[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); await sleep(300);
    step("second clip placed at playhead 00:00:04", vclips().length === 2 && Math.abs(parseFloat(vclips()[1].style.left) - 4 * px()) < 1, vclips().map((c) => c.style.left).join(","));

    // trim A end by -1s
    const t0 = Date.now();
    await drag(vclips()[0].querySelector(".handle.right"), -px());
    await waitFor(() => Math.abs(parseFloat(vclips()[0].style.width) - 3 * px()) < 2, 8000);
    step("trim: dragging the right handle shortens clip A to 3s", Math.abs(parseFloat(vclips()[0].style.width) - 3 * px()) < 2, `${vclips()[0].style.width} after ${Date.now() - t0} ms`);

    // split B at 6s
    vclips()[1].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: center(vclips()[1])[0], clientY: center(vclips()[1])[1] }));
    ptr(vclips()[1], "pointerup", 0, 0); await sleep(100);
    window.__ffworks.usePlayhead.getState().setT(6); await sleep(50);
    clickBtn("Split"); await sleep(300);
    step("split: clip B becomes two clips (video and audio)", vclips().length === 3 && aclips().length === 3, `${vclips().length}/${aclips().length}`);

    // move B2 from 6s to 7s
    await drag(vclips()[2], px());
    step("move: dragging B2 right by 1s places it at 7s (linked audio follows)", Math.abs(parseFloat(vclips()[2].style.left) - 7 * px()) < 2 && Math.abs(parseFloat(aclips()[2].style.left) - 7 * px()) < 2, `${vclips()[2].style.left} / ${aclips()[2].style.left}`);

    // gain on A through the Inspector
    vclips()[0].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: center(vclips()[0])[0], clientY: center(vclips()[0])[1] }));
    ptr(vclips()[0], "pointerup", 0, 0); await sleep(150);
    const g = await waitFor(() => $("input[aria-label='Volume']"));
    step("inspector exposes volume for the selected clip", !!g);
    setNum(g, -6); await sleep(300);
    step("volume −6 dB is applied to the linked audio clip", /-6\.0 dB/.test(aclips()[0].textContent), aclips()[0].textContent);

    // undo / redo through the toolbar
    clickBtn("Undo"); await sleep(250);
    const afterUndo = !/-6\.0 dB/.test(aclips()[0].textContent);
    clickBtn("Redo"); await sleep(250);
    step("undo reverts the volume change and redo restores it", afterUndo && /-6\.0 dB/.test(aclips()[0].textContent));

    // effects: add Saturation through the Inspector, set Amount to 0 (grey), exercise opacity
    {
      const addBtn = $$(".effects button").find((b) => b.textContent.trim() === "Add");
      step("inspector shows the Effects panel for the selected clip", !!addBtn && !!$("select[aria-label='Effect to add']"));
      addBtn.click(); await sleep(300);
      const fx = await waitFor(() => $(".fx[data-effect='saturation']"));
      step("Add puts a Saturation effect on the clip", !!fx);
      setNum(fx.querySelector("input[aria-label='Amount']"), 0); await sleep(300);
      const clipA = view().project.sequences[0].tracks[0].clips[0];
      step("effect parameter edit reaches the engine", clipA.effects.length === 1 && clipA.effects[0].params.amount === 0, JSON.stringify(clipA.effects));
      setNum($("input[aria-label='Opacity']"), 0.8); await sleep(250);
      step("opacity edit reaches the engine", view().project.sequences[0].tracks[0].clips[0].opacity === 0.8);
      setNum($("input[aria-label='Opacity']"), 1); await sleep(250);
    }

    // playback
    window.__ffworks.usePlayhead.getState().setT(0.2);
    clickBtn("Play"); await sleep(900);
    const t1 = window.__ffworks.usePlayhead.getState().t; const v = $(".monitor video");
    R.info.videoElement = { readyState: v.readyState, hasSrc: !!v.src, error: v.error ? v.error.message : null };
    clickBtn("Pause"); await sleep(100);
    step("playback advances the playhead in real time", t1 > 0.8 && t1 < 1.6, t1);
    step("monitor attaches the active clip's source", !!v.src, v.src);

    // processed preview: render, verify it is used, goes stale on edit, and is current again after redo
    {
      window.__ffworks.usePlayhead.getState().setT(1.0);
      const b = $$("button").find((x) => x.textContent.includes("Render preview")); b.click();
      const ok = await waitFor(() => $(".bypass-badge.ok"), 60000);
      step("render preview produces a processed preview shown in the monitor", !!ok, ok && ok.textContent);
      R.info.previewSrc = $(".monitor video").src;
      step("monitor plays the rendered preview file", /previews/.test(decodeURIComponent($(".monitor video").src)), $(".monitor video").src);
      clickBtn("Undo"); await sleep(300);
      step("an edit marks the preview out of date (never shown as current)", !!$$(".bypass-badge").find((x) => /out of date/.test(x.textContent)) && !$(".bypass-badge.ok"));
      clickBtn("Redo"); await sleep(300);
      step("redo restores the identical project, so the cached preview is current again", !!$(".bypass-badge.ok"));
    }

    // save, wipe, reopen
    window.__ffworks.useUi.getState().select(null);
    const before = JSON.stringify(view().project.sequences);
    await window.__ffworks.useProject.getState().run(() => inv("save_project", { path: "__PROJECT__" }));
    step("save clears the dirty flag", view().dirty === false);
    await window.__ffworks.useProject.getState().run(() => inv("new_project", { name: "scratch" })); await sleep(250);
    step("new project empties the timeline", vclips().length === 0);
    await window.__ffworks.useProject.getState().run(() => inv("open_project", { path: "__PROJECT__" })); await sleep(500);
    step("reopen restores the exact timeline", JSON.stringify(view().project.sequences) === before && vclips().length === 3 && aclips().length === 3, `${vclips().length}/${aclips().length}`);

    // drag a media item from the browser onto V1 at 10s (pointer-based drag; HTML5 DnD is unavailable under Tauri on Windows)
    {
      const item = $$(".media-item")[0]; const track = $(".track.video .track-clips"); const tr = track.getBoundingClientRect(); const ir = item.getBoundingClientRect();
      const x0 = ir.left + 20, y0 = ir.top + 10;
      item.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: x0, clientY: y0 }));
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: x0 + 40, clientY: y0 + 40 }));
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: tr.left + 10 * px(), clientY: tr.top + 20 }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: tr.left + 10 * px(), clientY: tr.top + 20 }));
      await sleep(400);
      step("dragging a media item onto V1 places it at the drop position (10s)", vclips().length === 4 && Math.abs(parseFloat(vclips()[3].style.left) - 10 * px()) < 2, vclips().map((c) => c.style.left).join(","));
    }
    // keyboard shortcuts: Ctrl+Z undoes that placement, Ctrl+Y redoes it
    const key = (k, extra = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...extra }));
    key("z", { ctrlKey: true }); await sleep(300);
    const undone = vclips().length === 3;
    key("y", { ctrlKey: true }); await sleep(300);
    step("Ctrl+Z / Ctrl+Y shortcuts undo and redo the placement", undone && vclips().length === 4, `${undone} ${vclips().length}`);

    // export dialog shows the real command
    clickBtn("Export…"); await sleep(300);
    const dlg = $(".modal[class*='modal']") ; step("export dialog opens", !!$("[aria-label='Export']"));
    clickBtn("Close"); await sleep(100);

    // export through the backend (native save dialog cannot be driven), then verify with FFprobe
    await inv("start_export", { preset: "h264_mp4", output: "__OUT__" });
    let ver = null;
    for (let i = 0; i < 240 && !ver; i++) { await sleep(500); try { ver = await inv("verify_output", { path: "__OUT__" }); } catch (_) {} }
    R.info.verify = ver;
    step("export finished and FFprobe verification matches the timeline", ver && /640×360|1920×1080/.test(ver) && !/WARNING/.test(ver), ver);
    // render queue: three jobs through the UI-visible queue; the last is canceled while still queued
    {
      const A = "__OUT__".replace(/out\.mp4$/, "qa.mp4"), B = "__OUT__".replace(/out\.mp4$/, "qb.mp4"), C = "__OUT__".replace(/out\.mp4$/, "qc.mp4");
      const ids = [];
      for (const o of [A, B, C]) ids.push(await inv("start_export", { preset: "h264_mp4", output: o }));
      clickBtn("Queue"); await sleep(400);
      step("Queue panel lists the submitted jobs", !!$("[aria-label='Render queue']") && $$(".job-row").length >= 3, $$(".job-row").length);
      const rowC = $(`.job-row[data-job='${ids[2]}']`);
      const cancelBtn = rowC && [...rowC.querySelectorAll("button")].find((b) => b.textContent === "Cancel");
      step("a queued job has a Cancel button", !!cancelBtn);
      cancelBtn.click(); await sleep(400);
      step("canceling a queued job marks it canceled without running it", /canceled/.test($(`.job-row[data-job='${ids[2]}'] .state-badge`).textContent));
      const done = await waitFor(() => ["qa", "qb"].every((_, i) => /completed/.test(($(`.job-row[data-job='${ids[i]}'] .state-badge`) || {}).textContent || "")), 120000);
      step("the other two jobs complete in the background", !!done, ids.map((id) => ($(`.job-row[data-job='${id}']`) || {}).textContent).join(" || "));
      const logBtn = [...$(`.job-row[data-job='${ids[0]}']`).querySelectorAll("button")].find((b) => b.textContent === "Log"); logBtn.click(); await sleep(500);
      const logTxt = ($(`.job-row[data-job='${ids[0]}'] pre`) || {}).textContent || "";
      step("job log shows exit code 0 and the real FFmpeg command line", /exit code: 0/.test(logTxt) && /-filter_complex/.test(logTxt), logTxt.slice(0, 120));
      let v1 = null, v2 = null, v3 = true;
      try { v1 = await inv("verify_output", { path: A }); v2 = await inv("verify_output", { path: B }); } catch (e) { v1 = null; }
      try { await inv("verify_output", { path: C }); } catch (e) { v3 = false; }
      step("queued exports produced valid files and the canceled one produced none", !!v1 && !!v2 && v3 === false);
      clickBtn("Close"); await sleep(100);
    }
    void dlg;
  } catch (e) {
    step("no exception", false, (e && e.stack) || e);
  }
  await inv("uitest_report", { report: JSON.stringify(R, null, 1) });
})();
