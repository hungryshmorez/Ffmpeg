// In-webview test for registering several FFmpeg builds. Placeholders __SRC__ __OUT__ __BUILDS__ (folder with ffA/bin and ffB).
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const setIn = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, String(v)); el.dispatchEvent(new Event("input", { bubbles: true })); };
  const setSel = (sel, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, v); sel.dispatchEvent(new Event("change", { bubbles: true })); };
  const btn = (re, root = document) => [...root.querySelectorAll("button")].find((b) => re.test(b.textContent));
  const rows = () => $$("[aria-label='Registered builds'] li");
  try {
    await waitFor(() => $(".app") && view());
    btn(/^FFmpeg builds$/).click();
    await waitFor(() => rows().length >= 1 && /in use/.test(rows()[0].textContent));
    step("the dialog lists the default build, working, marked in use", /in use/.test(rows()[0].textContent) && /ffmpeg version/i.test(rows()[0].textContent) && /filters/.test(rows()[0].textContent), rows()[0].textContent.slice(0, 200));

    const scanned = await inv("scan_engines", { dir: "__BUILDS__" });
    step("scanning the builds folder finds both installs (one under bin/, one flat) and ignores the one without ffprobe", scanned.length === 2 && scanned.some((f) => f.suggested_name === "ffA") && scanned.some((f) => f.suggested_name === "ffB"), JSON.stringify(scanned.map((f) => f.suggested_name)));

    // add one through the form, one through the command; a bad path is refused
    setIn($("input[aria-label='Build name']"), "Build A"); setIn($("input[aria-label='Path of ffmpeg']"), "__BUILDS__/ffA/bin/ffmpeg"); await sleep(100);
    btn(/^Add$/, $(".engines-dialog")).click();
    await waitFor(() => rows().length === 2);
    step("adding through the form registers the build and shows what it reports", rows().length === 2 && /Build A/.test(rows()[1].textContent) && /ffmpeg version/i.test(rows()[1].textContent), rows().map((r) => r.textContent.slice(0, 60)).join(" | "));
    const bad = await inv("add_engine", { name: "Nope", ffmpegPath: "__BUILDS__/does-not-exist", ffprobePath: null }).then(() => null, (e) => String(e));
    step("a path that is not FFmpeg is refused and not saved", !!bad && (await inv("list_engines")).engines.length === 2, bad);
    const b = await inv("add_engine", { name: "Build B", ffmpegPath: "__BUILDS__/ffB/ffmpeg", ffprobePath: null });
    step("a flat install (ffprobe beside ffmpeg) registers with the ffprobe found automatically", b.ok && /ffprobe/.test(b.ffprobe_path), b.ffprobe_path);
    const dup = await inv("add_engine", { name: "Again", ffmpegPath: "__BUILDS__/ffB/ffmpeg", ffprobePath: null }).then(() => null, (e) => String(e));
    step("registering the same ffmpeg twice is refused", /already/.test(dup || ""), dup);

    // switch the active build and prove the app really uses it
    await waitFor(async () => true);
    const all = await inv("list_engines");
    const idA = all.engines.find((e) => e.name === "Build A").id, idB = all.engines.find((e) => e.name === "Build B").id;
    await $("[data-engine='" + idA + "']") || null;
    // refresh the dialog by reopening it
    btn(/^Close$/, $(".engines-dialog")).click(); await sleep(150); btn(/^FFmpeg builds$/).click();
    await waitFor(() => rows().length === 3);
    btn(/^Use this$/, $("[data-engine='" + idA + "']")).click();
    await waitFor(async () => true); await sleep(900);
    const diag = await inv("get_diagnostics");
    step("choosing Build A makes the app run that ffmpeg", /ffA/.test(diag.ffmpegPath), diag.ffmpegPath);
    step("the dialog marks it in use", /in use/.test($("[data-engine='" + idA + "']").textContent));

    // an export can name another build; the Command Inspector and the output prove which one ran
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "0", duration: "2", with_audio: false }); await sleep(300);
    const cmd = await inv("preview_command", { preset: "h264_mp4", output: "__OUT__", engine: idB });
    step("an export that names Build B is compiled to run Build B's ffmpeg", /ffB/.test(cmd) && !/ffA/.test(cmd), cmd.slice(0, 160));
    await inv("start_export", { preset: "h264_mp4", output: "__OUT__", engine: idB });
    let ver = null;
    for (let i = 0; i < 120 && !ver; i++) { await sleep(500); try { ver = await inv("verify_output", { path: "__OUT__" }); } catch (_) {} }
    step("that export completes", ver && !/WARNING/.test(ver), ver);
    const unknown = await inv("preview_command", { preset: "h264_mp4", output: "__OUT__", engine: "eng-nope" }).then(() => null, (e) => String(e));
    step("an unknown build id is refused", /not registered/.test(unknown || ""), unknown);

    // removing the active build falls back to the default
    btn(/^Close$/, $(".engines-dialog")).click(); await sleep(150); btn(/^FFmpeg builds$/).click();
    await waitFor(() => rows().length === 3);
    $("[aria-label='Remove Build A']").click();
    await waitFor(() => rows().length === 2);
    await sleep(500);
    const d2 = await inv("get_diagnostics");
    step("removing the build in use returns the app to the default", !/ffA/.test(d2.ffmpegPath) && /in use/.test(rows()[0].textContent), d2.ffmpegPath);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
