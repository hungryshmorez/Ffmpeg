// In-webview test for snapshots. __SRC__ is substituted by snapshots.sh.
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
    const mainSeq = () => view().project.sequences.find((q) => q.id === view().project.active_sequence);
    const clips = () => mainSeq().tracks.flatMap((t) => t.clips);
    const btn = (t) => $$("[aria-label=Snapshots] button").find((b) => b.textContent.trim() === t);
    step("a video clip and its audio at the start", clips().length === 2);
    window.__ffworks.useUi.getState().setSnapshotsOpen(true); await sleep(300);
    step("the dialog opens empty", !!$("[aria-label=Snapshots]") && /No snapshots yet/.test($("[aria-label=Snapshots]").textContent));
    setNum($("[aria-label='Snapshot name']"), "before recut"); await sleep(150);
    btn("Take snapshot").click(); await sleep(500);
    step("the snapshot is listed with its clip count", /before recut/.test($("[aria-label='Saved snapshots']").textContent) && /2 clips/.test($("[aria-label='Saved snapshots']").textContent), $("[aria-label=Snapshots]").textContent);
    step("the live timeline is unchanged and still the active one", clips().length === 2 && view().project.sequences[0].id === view().project.active_sequence);
    // edit on, then restore
    await P().dispatch({ type: "split_clip", clip: clips()[0].id, at: "1" }); await sleep(300);
    await P().dispatch({ type: "add_marker", time: "2", name: "later", color: null, note: null }); await sleep(300);
    step("the edit created a second clip and a marker", clips().length === 4 && mainSeq().markers.length === 1);
    btn("Restore").click(); await sleep(500);
    step("Restore brought back the original clips and no marker", clips().length === 2 && mainSeq().markers.length === 0, `${clips().length} ${mainSeq().markers.length}`);
    P().setView(await inv("undo")); await sleep(300);
    step("restoring is ONE undo step (the edited state returns)", clips().length === 4 && mainSeq().markers.length === 1);
    $("button[aria-label^='Delete snapshot']").click(); await sleep(400);
    step("deleting removes it from the list", /No snapshots yet/.test($("[aria-label=Snapshots]").textContent) && view().project.sequences.length === 1);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
