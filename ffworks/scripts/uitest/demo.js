// In-webview test for demo mode. Placeholders __SRC__.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(100); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const setIn = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, String(v)); el.dispatchEvent(new Event("input", { bubbles: true })); };
  const setSel = (sel, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, v); sel.dispatchEvent(new Event("change", { bubbles: true })); };
  const btn = (re, root = document) => [...root.querySelectorAll("button")].find((b) => re.test(b.textContent));
  const dlg = () => $("[aria-label='Demo mode']");
  const steps = () => $$("[aria-label='What is playing'] li");
  const seed = () => ((dlg().querySelector("[data-demo-status]") || {}).textContent || "").match(/seed (\d+)/)?.[1];
  const look = () => ((dlg().querySelector("[data-demo-status]") || {}).textContent || "").match(/look (\d+)/)?.[1];
  const check = (label) => dlg().querySelector(`input[aria-label='${label}']`);
  const click = (el) => el.click();
  try {
    await waitFor(() => $(".app") && view());
    btn(/^Demo mode$/).click(); await waitFor(dlg);
    step("the Demo mode button opens the dialog", !!dlg());
    // no project clip yet: starting must explain, not hang
    setIn(dlg().querySelector("input[aria-label='Pieces per demo']"), 3); setIn(dlg().querySelector("input[aria-label='Seconds per piece']"), 1.5);
    setSel(dlg().querySelector("select[aria-label='Demo quality']"), "8"); await sleep(100);
    btn(/^Start demo$/, dlg()).click();
    await waitFor(() => /video clip/.test(($(".toasts") || { textContent: "" }).textContent), 20000);
    step("with no video in the project it says so and stays stopped", /video clip/.test($(".toasts").textContent) && !!btn(/^Start demo$/, dlg()), $(".toasts").textContent);

    btn(/^Close$/, dlg()).click(); await sleep(150);
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "0", duration: "8", with_audio: false }); await sleep(300);
    const undoBefore = view().undoLabel, clipsBefore = view().project.sequences[0].tracks.flatMap((t) => t.clips).length;
    btn(/^Demo mode$/).click(); await waitFor(dlg);
    setIn(dlg().querySelector("input[aria-label='Pieces per demo']"), 3); setIn(dlg().querySelector("input[aria-label='Seconds per piece']"), 1.5);
    setSel(dlg().querySelector("select[aria-label='Demo quality']"), "8"); await sleep(100);

    // transitions only, native
    btn(/^Start demo$/, dlg()).click();
    await waitFor(() => steps().length === 3);
    step("a demo of 3 pieces appears with what each got", steps().length === 3, steps().map((l) => l.textContent.trim()).join(" | "));
    step("the first piece has no transition, the other two each have one", /start/.test(steps()[0].textContent) && steps().slice(1).every((l) => l.querySelector("b")), steps().map((l) => l.textContent.trim()).join(" | "));
    step("it is a video that was really rendered", !!dlg().querySelector("video") && /^file:|asset|^http/.test(dlg().querySelector("video").src), dlg().querySelector("video") && dlg().querySelector("video").src);
    step("the user's project was not changed", view().undoLabel === undoBefore && view().project.sequences[0].tracks.flatMap((t) => t.clips).length === clipsBefore, `${view().undoLabel} / ${undoBefore}`);

    // star one of the transitions from the list
    const starBtn = steps()[1].querySelector("button[aria-label^='Star transition']");
    const kind = starBtn.getAttribute("aria-label").replace("Star transition ", "");
    starBtn.click(); await sleep(600);
    step("starring a transition in the demo saves it as a favourite", (await inv("get_favourites")).starred.transitions.includes(kind), kind);

    // it keeps going: when a look ends, the next (already rendered) one takes over
    const s1 = seed();
    let s2 = null;
    for (let i = 0; i < 60 && (!s2 || s2 === s1); i++) { const v = dlg().querySelector("video"); if (v) v.dispatchEvent(new Event("ended")); await sleep(1000); s2 = seed(); }
    step("when a look ends the next random one replaces it (new seed)", !!s2 && s2 !== s1 && look() === "2", `${s1} -> ${s2}, look ${look()}`);
    step("and the new one lists its own transitions", steps().length === 3 && steps().slice(1).every((l) => l.querySelector("b")));
    btn(/^Hold this one$/, dlg()).click(); await sleep(200);
    step("Hold keeps the current look instead of moving on", !!btn(/^Release$/, dlg()));
    btn(/^Release$/, dlg()).click();
    btn(/^Stop$/, dlg()).click(); await sleep(300);
    step("Stop ends the demo", !!btn(/^Start demo$/, dlg()) && /Stopped/.test(dlg().textContent));

    // effects board only, stack of 2
    click(check("Random transitions")); click(check("Random effects")); await sleep(150);
    setIn(dlg().querySelector("input[aria-label='Effects per piece']"), 2); await sleep(100);
    btn(/^Start demo$/, dlg()).click();
    await waitFor(() => steps().length === 3 && steps().every((l) => !l.querySelector("b")));
    step("effects only: every piece shows 2 random effects and no transitions", steps().length === 3 && steps().every((l) => !l.querySelector("b") && l.querySelectorAll("button[aria-label*='effect']").length === 2), steps().map((l) => l.textContent.trim()).join(" | "));
    btn(/^Stop$/, dlg()).click(); await sleep(300);

    // both boards, restricted to favourites: the starred transition only
    click(check("Random transitions")); await sleep(100);
    setSel(dlg().querySelector("select[aria-label='Transition pool']"), "favourites");
    click(check("Random effects")); await sleep(100);
    btn(/^Start demo$/, dlg()).click();
    await waitFor(() => steps().length === 3 && steps()[1].querySelector("b"));
    step("favourites-only board only uses the starred transition", steps().slice(1).every((l) => l.querySelector("b").textContent.toLowerCase() === kind.toLowerCase()), steps().map((l) => l.textContent.trim()).join(" | "));
    btn(/^Stop$/, dlg()).click(); await sleep(300);

    // an empty favourites pool is refused with a reason
    click(check("Random transitions")); click(check("Random effects")); await sleep(100);
    setSel(dlg().querySelector("select[aria-label='Effect pool']"), "favourites"); await sleep(100);
    btn(/^Start demo$/, dlg()).click();
    await waitFor(() => /No favourite effects/.test(document.body.textContent), 20000);
    step("an empty favourites pool is refused with a reason and nothing runs", /No favourite effects/.test(document.body.textContent) && !!btn(/^Start demo$/, dlg()));
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
