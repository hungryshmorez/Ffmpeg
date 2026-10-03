// In-webview accessibility scan: opens every screen and dialog and lists controls a screen reader could not name.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const inv = window.__TAURI_INTERNALS__.invoke;
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const U = () => window.__ffworks.useUi.getState();
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const text = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
  // the accessible name, close to the accname algorithm for the cases this UI uses
  const named = (el) => {
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return true;
    const by = el.getAttribute("aria-labelledby");
    if (by && by.split(/\s+/).some((id) => text(document.getElementById(id) || document.createElement("i")))) return true;
    if (el.labels && [...el.labels].some((l) => text(l))) return true;
    if ((el.getAttribute("title") || "").trim()) return true;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && ["submit", "button", "reset"].includes(el.type) && el.value) return true;
    if (tag === "input" && el.type === "text" && (el.getAttribute("placeholder") || "").trim()) return true;
    if (tag === "select") return false;
    if (text(el)) return true;
    // an image inside counts when it has alt text
    return !!el.querySelector("img[alt]:not([alt=''])");
  };
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""} in «${text(el.closest("[aria-label],section,.panel,.modal,.toolbar,header") || el.parentElement).slice(0, 40)}»`;
  const scan = (scope) => {
    const root = scope || document;
    const out = [];
    for (const el of root.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=slider], [role=checkbox], [role=tab], [role=option], [role=menuitem]")) {
      if (!visible(el) || el.closest("[aria-hidden=true]")) continue;
      if (!named(el)) out.push(describe(el));
    }
    for (const el of root.querySelectorAll("img")) if (visible(el) && !el.hasAttribute("alt")) out.push("img without alt: " + describe(el));
    for (const el of root.querySelectorAll("[role=button]")) if (visible(el) && !el.hasAttribute("tabindex") && el.tagName !== "BUTTON") out.push("role=button that cannot take focus: " + describe(el));
    for (const el of root.querySelectorAll("[role=dialog]")) {
      if (!visible(el)) continue;
      if (!(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"))) out.push("dialog without a name: " + describe(el));
      if (el.getAttribute("aria-modal") !== "true") out.push("dialog that is not aria-modal: " + describe(el));
    }
    return [...new Set(out)];
  };
  const check = (name, found) => step(name, found.length === 0, found.length + " problem(s):\n" + found.join("\n"));
  const closeAll = async () => { window.__ffworks.useJobs.getState().setQueueOpen(false); for (const k of ["setSnapshotsOpen", "setShortcutsOpen", "setPaletteOpen", "setDemoOpen", "setEnginesOpen", "setFavsOpen", "setFiltersOpen", "setExportOpen", "setDiagOpen", "setLibraryOpen"]) U()[k]?.(false); await sleep(150); };
  try {
    await waitFor(() => $(".app") && view());
    // positive control: the scanner must see what it is looking for
    const probe = document.createElement("div");
    probe.innerHTML = '<button id="p1"><svg width="8" height="8"></svg></button><input id="p2" type="number"><select id="p3"><option>a</option></select><div role="button" id="p4">x</div><img id="p5" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="4" height="4"><div role="dialog" id="p6">d</div>';
    document.body.appendChild(probe);
    const bad = scan(probe);
    probe.remove();
    step("the scanner flags an unnamed icon button, an unlabelled field, an unlabelled select, an unfocusable role=button, an image without alt and an unnamed dialog", bad.length >= 6, bad.join("\n"));
    const v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
    await P().dispatch({ type: "add_solid", track: v1, start: "0", duration: "4", color: "#336699" });
    await P().dispatch({ type: "add_title", track: v1, start: "4", duration: "2", text: "Hello" });
    await P().dispatch({ type: "add_marker", time: "1", name: "m", color: null, note: null });
    await sleep(500);
    check("the empty-ish main screen (toolbar, media browser, monitor, timeline)", scan());
    const clip = view().project.sequences[0].tracks[0].clips[0];
    U().select(clip.id); await sleep(600);
    check("with a video clip selected (inspector, effects, properties)", scan());
    await P().dispatch({ type: "add_effect", clip: clip.id, effect: "brightness", params: {}, index: null }); await sleep(500);
    await P().dispatch({ type: "set_keyframe", clip: clip.id, param: "opacity", time: "1", value: 0.5, interp: null }); await sleep(500);
    check("with an effect and keyframes on the clip", scan());
    U().select(view().project.sequences[0].tracks[0].clips[1].id); await sleep(600);
    check("with a title clip selected", scan());
    for (const [name, setter] of [["export", "setExportOpen"], ["diagnostics", "setDiagOpen"], ["snapshots", "setSnapshotsOpen"], ["keyboard shortcuts", "setShortcutsOpen"], ["FFmpeg builds", "setEnginesOpen"], ["favourites", "setFavsOpen"], ["filter browser", "setFiltersOpen"], ["demo mode", "setDemoOpen"], ["render queue", "setQueueOpen"], ["media library", "setLibraryOpen"]]) {
      await closeAll();
      (setter === "setQueueOpen" ? window.__ffworks.useJobs.getState() : U())[setter](true); await sleep(700);
      check(`the ${name} dialog`, scan());
    }
    await closeAll();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); await sleep(500);
    check("the command palette", scan());
    $("input[aria-label='Type a command']")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(300);
    // keyboard-only editing of a focused clip (the last clip on V1, which has free space after it)
    await closeAll();
    const rat = (x) => { const [n, d] = String(x).split("/"); return Number(n) / (d === undefined ? 1 : Number(d)); };
    const frame = 1 / rat(view().project.settings.fps);
    const lastClip = () => { const cs = view().project.sequences[0].tracks.find((t) => t.kind === "video").clips; return cs[cs.length - 1]; };
    const clipEl = () => { const els = $$(".track.video .clip"); return els[els.length - 1]; };
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const press = async (key, mods) => { const t0 = window.__ffworks.usePlayhead.getState().t; clipEl().focus(); clipEl().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods })); await sleep(400); return window.__ffworks.usePlayhead.getState().t === t0; };
    const s0 = rat(lastClip().start), d0 = rat(lastClip().duration), h0 = view().history.length;
    step("a clip announces its position and length and its keyboard shortcuts", /starts at .*lasts /.test(clipEl().getAttribute("aria-label")) && /Alt\+ArrowLeft/.test(clipEl().getAttribute("aria-keyshortcuts") || ""), clipEl().getAttribute("aria-label"));
    const calm = await press("ArrowRight", { altKey: true });
    step("Alt+→ moves the focused clip one frame later (and the playhead does not move)", near(rat(lastClip().start), s0 + frame) && calm, rat(lastClip().start));
    await press("ArrowRight", { altKey: true, shiftKey: true });
    step("Alt+Shift+→ moves it a second", near(rat(lastClip().start), s0 + frame + 1), rat(lastClip().start));
    await press("ArrowLeft", { ctrlKey: true });
    step("Ctrl+← trims its end by a frame", near(rat(lastClip().duration), d0 - frame), rat(lastClip().duration));
    await press("ArrowRight", { ctrlKey: true, shiftKey: true });
    step("Ctrl+Shift+→ trims its start by a frame", near(rat(lastClip().start), s0 + 2 * frame + 1) && near(rat(lastClip().duration), d0 - 2 * frame), `${rat(lastClip().start)} ${rat(lastClip().duration)}`);
    step("each key press is one undo step", view().history.length === h0 + 4, `${h0} -> ${view().history.length}`);
    await press("ArrowLeft", { altKey: true, ctrlKey: true });
    step("both modifiers together do nothing", view().history.length === h0 + 4);
    for (let i = 0; i < 4; i++) P().setView(await inv("undo"));
    await sleep(300);
    step("four undos put the clip back exactly", rat(lastClip().start) === s0 && rat(lastClip().duration) === d0, `${rat(lastClip().start)} ${rat(lastClip().duration)}`);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
