// In-webview test for favourites, random effects/transitions and stacking. Placeholders __SRC__ __OUT__.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const setSel = (sel, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, v); sel.dispatchEvent(new Event("change", { bubbles: true })); };
  const setIn = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, String(v)); el.dispatchEvent(new Event("input", { bubbles: true })); };
  const select = async (el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: r.left + 20, clientY: r.top + 10 })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 })); await sleep(300); };
  const track = () => view().project.sequences[0].tracks.find((t) => t.kind === "video");
  const clip1 = () => track().clips[0];
  const fxOf = () => clip1().effects.map((e) => e.effect);
  const btn = (re) => $$("button").find((b) => re.test(b.textContent));
  const undo = async () => { P().setView(await inv("undo")); await sleep(250); };
  const roll = async (kind, pool, count, seed) => {
    const bar = $(`[aria-label='Random ${kind}']`);
    setSel(bar.querySelector(`select`), pool); await sleep(100);
    setIn(bar.querySelector("input[type=number]"), count); await sleep(100);
    setIn(bar.querySelector("input[aria-label^='Seed']"), seed === undefined ? "" : seed); await sleep(100);
    [...bar.querySelectorAll("button")].find((b) => b.textContent.includes("Random")).click();
  };
  try {
    await waitFor(() => $(".app") && view());
    await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
    const m = view().project.media[0].id, v1 = track().id;
    for (const [start, from] of [[0, 0], [2, 3], [4, 3]]) await P().dispatch({ type: "place_clip", media: m, track: v1, start: String(start), source_in: String(from), duration: "2", with_audio: false });
    await sleep(400);
    step("three touching clips on V1", track().clips.length === 3);
    await select($$(".track.video .clip")[0]);
    await waitFor(() => $("[aria-label='Random effect']"));

    // favourites: star the current pick, make a group, put noise in it
    const star = await waitFor(() => $("button[aria-label='Add to favourites']"));
    const picked = $("select[aria-label='Effect to add']").value;
    star.click();
    await waitFor(() => $("button[aria-label='Remove from favourites']"));
    let favs = await inv("get_favourites");
    step("starring saves the effect to the settings file", favs.starred.effects.includes(picked), JSON.stringify(favs));
    step("the starred effect shows ★ in the list", [...$("select[aria-label='Effect to add']").options].some((o) => o.value === picked && o.textContent.startsWith("★")));
    btn(/^Favourites…/).click();
    await waitFor(() => $("[aria-label='Favourites']"));
    setIn($("input[aria-label='New group name']"), "Glitchy"); btn(/^Add group$/).click();
    await waitFor(() => $("[aria-label='Delete group Glitchy']"));
    await waitFor(() => $("input[aria-label='Noise in Glitchy'], input[aria-label='Film grain in Glitchy']"));
    const grainBox = $("input[aria-label='Film grain in Glitchy']");
    grainBox.click(); await waitFor(async () => true);
    await sleep(400);
    favs = await inv("get_favourites");
    step("a group can be created and an effect added to it", JSON.stringify(favs.groups.Glitchy) === JSON.stringify({ effects: ["noise"], transitions: [] }), JSON.stringify(favs.groups));
    btn(/^Close$/).click(); await sleep(150);
    step("the new group appears in the random pool list", [...$("[aria-label='Random effect'] select").options].some((o) => o.value === "Glitchy"));

    // random effects from that group: noise is its only member, so a stack of 3 is three noise effects, one undo step
    await roll("effect", "Glitchy", 3, "");
    await waitFor(() => clip1().effects.length === 3);
    step("stack of 3 from the Glitchy group gives 3 grain effects", JSON.stringify(fxOf()) === JSON.stringify(["noise", "noise", "noise"]), JSON.stringify(fxOf()));
    step("the seed used is shown for reuse", /last seed \d+/.test($("[aria-label='Random effect']").textContent));
    await undo();
    step("one undo removes the whole stack", clip1().effects.length === 0, clip1().effects.length);

    // determinism through the real UI
    await roll("effect", "all", 2, "5"); await waitFor(() => clip1().effects.length === 2);
    const first = JSON.stringify(clip1().effects.map((e) => [e.effect, e.params]));
    await undo();
    await roll("effect", "all", 2, "5"); await waitFor(() => clip1().effects.length === 2);
    step("the same seed gives the same effects and values", JSON.stringify(clip1().effects.map((e) => [e.effect, e.params])) === first, first);
    await undo();

    // empty favourites pool is refused with an explanation, not silently "everything"
    await roll("effect", "favourites", 1, "");
    await sleep(600);
    step("favourites pool with a starred effect works (stack 1)", clip1().effects.length === 1 && clip1().effects[0].effect === picked, JSON.stringify(fxOf()));
    await undo();
    const err = await inv("random_transitions", { clip: clip1().id, count: 1, pool: "favourites", seed: null, duration: null }).then(() => null, (e) => String(e));
    step("no favourite transitions yet: refused with a clear message", /No favourite transitions/.test(err || ""), err);

    // random transitions: 2 consecutive cuts, one undo step
    await roll("transition", "all", 2, "");
    await waitFor(() => track().transitions.length === 2);
    step("random transition stack of 2 covers both cuts", track().transitions.length === 2 && new Set(track().transitions.map((t) => t.clip_a)).size === 2, JSON.stringify(track().transitions.map((t) => t.kind)));
    await undo();
    step("one undo removes both transitions", track().transitions.length === 0);
    // star a transition, restrict to favourites
    const trSel = $("select[aria-label='New transition type']"); setSel(trSel, "wipeleft"); await sleep(100);
    $("button[aria-label='Add transition to favourites']").click(); await sleep(400);
    await roll("transition", "favourites", 2, "");
    await waitFor(() => track().transitions.length === 2);
    step("favourites-only transitions only use the starred one", track().transitions.every((t) => t.kind === "wipeleft"), JSON.stringify(track().transitions.map((t) => t.kind)));

    // render the result: random effects on clip 1 plus the two transitions
    await roll("effect", "all", 2, "5"); await waitFor(() => clip1().effects.length === 2);
    await inv("start_export", { preset: "h264_mp4", output: "__OUT__" });
    let ver = null;
    for (let i = 0; i < 160 && !ver; i++) { await sleep(500); try { ver = await inv("verify_output", { path: "__OUT__" }); } catch (_) {} }
    step("export with random effects and random transitions completes", ver && !/WARNING/.test(ver), ver);
    await inv("save_project", { path: "__PROJ__" }).catch(() => {});
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
