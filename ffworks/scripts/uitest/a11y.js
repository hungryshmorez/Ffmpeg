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
  // WCAG contrast: every visible text against the colours it is drawn on (gradients, images, video and canvas are skipped: unknown)
  const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; const [r, g, b, a] = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [r, g, b, a === undefined || Number.isNaN(a) ? 1 : a]; };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat([1]);
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const backdrop = (el) => {
    const chain = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (e !== el && (cs.backgroundImage !== "none" || ["IMG", "VIDEO", "CANVAS", "SVG"].includes(e.tagName.toUpperCase()))) return null;
      if (cs.backgroundImage !== "none") return null;
      chain.push(parse(cs.backgroundColor) || [0, 0, 0, 0]);
    }
    let bg = parse(getComputedStyle(document.body).backgroundColor) || [18, 20, 25, 1];
    if (bg[3] < 1) bg = over(bg, [255, 255, 255, 1]);
    for (let i = chain.length - 1; i >= 0; i--) bg = over(chain[i], bg);
    return bg;
  };
  const contrast = (scope) => {
    const root = scope || document.body, out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !n.textContent.trim() || !visible(el) || el.closest("[aria-hidden=true],[disabled],[aria-disabled=true],script,style,option")) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      let opacity = 1;
      for (let e = el; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
      const bg = backdrop(el);
      if (!bg) continue;
      let fg = parse(cs.color); if (!fg) continue;
      fg = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
      const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700 || cs.fontWeight === "bold";
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      const got = ratio(fg, bg);
      if (got < need) out.push(`${got.toFixed(2)}:1 < ${need}:1  «${n.textContent.trim().slice(0, 40)}» in ${describe(el)}  fg=${cs.color} opacity=${opacity.toFixed(2)}`);
    }
    return [...new Set(out)];
  };
  const check = (name, found) => step(name, found.length === 0, found.length + " problem(s):\n" + found.join("\n"));
  const checkBoth = (name) => { check(name, scan()); check("contrast: " + name, contrast()); };
  const closeAll = async () => { window.__ffworks.useJobs.getState().setQueueOpen(false); for (const k of ["setSnapshotsOpen", "setScriptOpen", "setShortcutsOpen", "setPaletteOpen", "setDemoOpen", "setEnginesOpen", "setFavsOpen", "setFiltersOpen", "setExportOpen", "setDiagOpen", "setLibraryOpen", "setPluginsOpen"]) U()[k]?.(false);
    U().setCorruptClip?.(null); await sleep(150); };
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
    checkBoth("the empty-ish main screen (toolbar, media browser, monitor, timeline)");
    const clip = view().project.sequences[0].tracks[0].clips[0];
    U().select(clip.id); await sleep(600);
    checkBoth("with a video clip selected (inspector, effects, properties)");
    await P().dispatch({ type: "add_effect", clip: clip.id, effect: "brightness", params: {}, index: null }); await sleep(500);
    await P().dispatch({ type: "set_keyframe", clip: clip.id, param: "opacity", time: "1", value: 0.5, interp: null }); await sleep(500);
    checkBoth("with an effect and keyframes on the clip");
    U().select(view().project.sequences[0].tracks[0].clips[1].id); await sleep(600);
    checkBoth("with a title clip selected");
    for (const [name, setter] of [["export", "setExportOpen"], ["script editor", "setScriptOpen"], ["diagnostics", "setDiagOpen"], ["snapshots", "setSnapshotsOpen"], ["keyboard shortcuts", "setShortcutsOpen"], ["FFmpeg builds", "setEnginesOpen"], ["favourites", "setFavsOpen"], ["filter browser", "setFiltersOpen"], ["demo mode", "setDemoOpen"], ["render queue", "setQueueOpen"], ["media library", "setLibraryOpen"], ["plugins", "setPluginsOpen"]]) {
      await closeAll();
      (setter === "setQueueOpen" ? window.__ffworks.useJobs.getState() : U())[setter](true); await sleep(700);
      checkBoth(`the ${name} dialog`);
    }
    await closeAll();
    U().select(view().project.sequences[0].tracks[0].clips[0].id);
    U().setCorruptClip(view().project.sequences[0].tracks[0].clips[0].id); await sleep(700);
    checkBoth("the corruption lab dialog");
    await closeAll();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); await sleep(500);
    checkBoth("the command palette");
    $("input[aria-label='Type a command']")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(300);

    // keyboard behaviour of dialogs: focus goes in, Tab wraps, Escape closes, focus returns to the opener
    await closeAll();
    const opener = $$("button").find((b) => b.textContent.trim().startsWith("Export"));
    opener.focus();
    U().setExportOpen(true); await sleep(500);
    const dlgEl = $("[role=dialog][aria-modal=true]");
    step("opening a dialog moves focus into it", !!dlgEl && dlgEl.contains(document.activeElement), document.activeElement && document.activeElement.outerHTML.slice(0, 80));
    const reach = [...dlgEl.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(visible);
    const key = (k, mods = {}) => { (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods })); };
    reach[reach.length - 1].focus(); key("Tab"); await sleep(100);
    step("Tab from the last control wraps to the first (focus is trapped)", document.activeElement === reach[0], document.activeElement && document.activeElement.outerHTML.slice(0, 80));
    key("Tab", { shiftKey: true }); await sleep(100);
    step("Shift+Tab from the first control wraps to the last", document.activeElement === reach[reach.length - 1]);
    opener.focus(); key("Tab"); await sleep(100);
    step("Tab pressed with focus outside the dialog pulls it in", dlgEl.contains(document.activeElement));
    key("Escape"); await sleep(400);
    step("Escape closes the dialog", !$("[role=dialog][aria-modal=true]") && !U().exportOpen);
    step("focus returns to the control that opened it", document.activeElement === opener, document.activeElement && document.activeElement.outerHTML.slice(0, 80));

    // progress is announced to screen readers
    const J = window.__ffworks.useJobs.getState();
    const live = () => ($("[data-job-announcement]") || {}).textContent;
    const evt = (o) => J.upsert({ jobId: "a11y-job", operation: "export", output: "x.mp4", priority: 0, enqueuedUnix: 0, ...o });
    evt({ state: "rendering", fraction: 0.52, fps: 10, elapsed_secs: 1, eta_secs: 2 }); await sleep(200);
    step("a job passing half way is announced in a polite live region", live() === "Export 50 percent" && $("[data-job-announcement]").getAttribute("aria-live") === "polite", live());
    evt({ state: "rendering", fraction: 0.55, fps: 10, elapsed_secs: 1, eta_secs: 2 }); await sleep(100);
    step("small progress steps do not repeat the announcement", live() === "Export 50 percent");
    evt({ state: "completed" }); await sleep(200);
    step("the end of a job is announced", live() === "Export finished", live());

    // motion and forced-colours preferences are honoured by the stylesheet
    const conds = []; const walk = (rules) => { for (const r of rules) { if (r.media) conds.push(r.media.mediaText); if (r.cssRules) walk(r.cssRules); } };
    for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch (e) { /* cross-origin sheet */ } }
    step("the stylesheet switches animation and transitions off for reduced motion", conds.some((c) => /prefers-reduced-motion:\s*reduce/.test(c)), conds.join(" | "));
    step("the stylesheet has forced-colours (high contrast) rules", conds.some((c) => /forced-colors:\s*active/.test(c)), conds.join(" | "));
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
    // moving a focused clip between tracks from the keyboard
    await P().dispatch({ type: "add_track", kind: "video", name: "V2" }); await sleep(400);
    const vids = () => view().project.sequences[0].tracks.filter((t) => t.kind === "video");
    const find = (id) => { for (const t of view().project.sequences[0].tracks) for (const c of t.clips) if (c.id === id) return { t, c }; return null; };
    const moving = lastClip(), movingName = moving.name;
    const el2 = () => $$(".track .clip").find((e) => (e.getAttribute("aria-label") || "").includes(`clip ${movingName},`));
    const press2 = async (key, mods) => { el2().focus(); el2().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods })); await sleep(450); };
    const lowId = vids()[0].id, highId = vids()[vids().length - 1].id, hx = view().history.length;
    await press2("ArrowUp", { altKey: true });
    step("Alt+↑ moves the focused clip to the track above, one undo step", find(moving.id).t.id === highId && view().history.length === hx + 1, `${find(moving.id).t.id} vs ${highId}`);
    step("it keeps its time", find(moving.id).c.start === moving.start, `${find(moving.id).c.start} vs ${moving.start}`);
    await press2("ArrowUp", { altKey: true });
    step("Alt+↑ on the top track does nothing", find(moving.id).t.id === highId && view().history.length === hx + 1);
    await press2("ArrowDown", { altKey: true });
    step("Alt+↓ moves it back down", find(moving.id).t.id === lowId && view().history.length === hx + 2, `${find(moving.id).t.id} vs ${lowId}`);
    await press2("ArrowDown", { altKey: true });
    step("Alt+↓ on the bottom video track does nothing (it never jumps to an audio track)", find(moving.id).t.id === lowId && view().history.length === hx + 2);
    step("the clip lists the new shortcut", /Alt\+ArrowUp/.test(el2().getAttribute("aria-keyshortcuts") || ""));

    // several selected clips: the same keys edit all of them as one undo step, all or nothing
    await P().dispatch({ type: "add_track", kind: "video", name: "V3" }); await sleep(400);
    const v3 = vids()[vids().length - 1], mid = view().project.media.find((m) => m.info.video.length).id;
    await P().dispatch({ type: "place_clip", media: mid, track: v3.id, start: "20", source_in: "0", duration: "2", with_audio: false }); await sleep(300);
    await P().dispatch({ type: "place_clip", media: mid, track: v3.id, start: "1/2", source_in: "0", duration: "2", with_audio: false }); await sleep(400);
    const onV3 = () => find2().clips.slice().sort((a, b) => rat(a.start) - rat(b.start));
    const find2 = () => view().project.sequences[0].tracks.find((t) => t.id === v3.id);
    const [early, late] = onV3();
    const lateEl = () => $(`[data-track-id="${v3.id}"]`).querySelectorAll(".clip")[1];
    U().select(late.id); U().toggleExtra(early.id); await sleep(200);
    const pressSel = async (key, mods) => { lateEl().focus(); lateEl().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods })); await sleep(500); };
    const hm = view().history.length;
    await pressSel("ArrowRight", { altKey: true });
    const [e1, l1] = onV3();
    step("focusing a selected clip keeps the whole selection", U().selected === late.id && U().extra.includes(early.id), JSON.stringify([U().selected, U().extra]));
    step("Alt+→ with two clips selected moves both a frame, as one undo step", near(rat(e1.start), rat(early.start) + frame) && near(rat(l1.start), rat(late.start) + frame) && view().history.length === hm + 1, `${rat(e1.start)} ${rat(l1.start)} h${view().history.length - hm}`);
    await pressSel("ArrowLeft", { ctrlKey: true });
    const [e2, l2] = onV3();
    step("Ctrl+← trims both ends by a frame", near(rat(e2.duration), rat(early.duration) - frame) && near(rat(l2.duration), rat(late.duration) - frame) && view().history.length === hm + 2);
    for (let i = 0; i < 2; i++) P().setView(await inv("undo"));
    await sleep(300);
    const [e3, l3] = onV3();
    step("two undos restore both clips exactly", e3.start === early.start && l3.start === late.start && e3.duration === early.duration, `${e3.start} ${l3.start}`);
    const hr = view().history.length;
    await pressSel("ArrowLeft", { altKey: true, shiftKey: true });
    const [e4, l4] = onV3();
    step("a move one clip cannot make (before zero) changes neither, with an explanation", e4.start === early.start && l4.start === late.start && view().history.length === hr && /none were changed/.test(document.body.innerText), `${e4.start} ${l4.start}`);
    await pressSel("ArrowDown", { altKey: true });
    const lower = vids()[vids().length - 2].id;
    step("Alt+↓ moves both clips to the track below together", [early.id, late.id].every((id) => find(id).t.id === lower) && view().history.length === hr + 1, [early.id, late.id].map((id) => find(id).t.id).join(" "));
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
