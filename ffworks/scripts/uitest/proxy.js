// In-webview test for proxies. Placeholders __SRC__ are substituted by proxy.sh.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const T = () => window.__ffworks.usePlayhead.getState();
  const btn = (txt) => $$("button").find((b) => b.textContent.trim() === txt);
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
    const mk = await waitFor(() => $(".media-item [data-proxy-state='none']"));
    step("a video item offers 'Make proxy'", !!mk && /Make proxy/.test(mk.textContent));
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: null, duration: null, with_audio: true }); await sleep(300);
    T().setT(1); await sleep(300);

    // either the webview can't decode the original (then the monitor says so and offers a proxy) or it can (then use the media item's button)
    const notice = await waitFor(() => $(".decode-notice"), 4000);
    const via = notice ? notice.querySelector("button") : $(".media-item [data-proxy-state='none']");
    step(notice ? "the monitor reports the file can't be decoded and offers a proxy (real <video> error)" : "the original plays; proxy offered from the media item", !!via, notice ? notice.textContent : "no decode error");
    via.click();
    const working = await waitFor(() => $(".media-item [data-proxy-state='working']") || $(".media-item [data-proxy-state='ready']"), 10000);
    step("a proxy job is queued and shown on the media item", !!working);
    const ready = await waitFor(() => $(".media-item [data-proxy-state='ready']"), 120000);
    step("the proxy finishes and the item shows 'proxy ✓' with its size", !!ready && /proxy ✓ .*[KM]?B/.test(ready.textContent), ready && ready.textContent);
    const jobs = Object.values(window.__ffworks.useJobs.getState().jobs);
    step("the proxy ran through the render queue as a completed background job", jobs.some((j) => /^proxy:/.test(j.operation) && j.state === "completed"), JSON.stringify(jobs.map((j) => [j.operation, j.state])));
    // monitor now plays the proxy
    const src = await waitFor(() => { const v = $("video"); return v && /proxies/.test(v.dataset.src || "") ? v.dataset.src : null; }, 8000);
    step("the monitor switches to the proxy file", !!src, $("video")?.dataset.src);
    const cb = $("input[aria-label='Use proxies']"); cb.click(); await sleep(400);
    step("turning 'Proxies' off plays the original again", !/proxies/.test($("video").dataset.src || ""), $("video").dataset.src);
    cb.click(); await sleep(400);
    step("and on again uses the proxy", /proxies/.test($("video").dataset.src || ""));
    // exports/previews must always read the original
    const cmd = await inv("preview_command", { preset: "h264_mp4", output: "/tmp/ffworks-proxy-test-out.mp4" });
    step("the export command still reads the original media, never the proxy", cmd.includes("src.mp4") && !/proxies/.test(cmd), cmd.slice(0, 220));
    // clear
    btn("Clear").click(); await waitFor(() => $(".media-item [data-proxy-state='none']"), 8000);
    step("Clear deletes the proxy and the item offers 'Make proxy' again", !!$(".media-item [data-proxy-state='none']"));
    await sleep(300);
    step("with no proxy the monitor is back on the original", !/proxies/.test($("video").dataset.src || ""));
    // keep one proxy on disk for the independent check in proxy.sh
    btn("Make proxies").click(); await waitFor(() => $(".media-item [data-proxy-state='ready']"), 120000);
    step("'Make proxies' makes proxies for every video", !!$(".media-item [data-proxy-state='ready']"));
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
