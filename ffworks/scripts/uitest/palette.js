// In-webview test for the command palette. __SRC__ is substituted by palette.sh.
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
    const key = (k, extra = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...extra }));
    const pal = () => $("[aria-label='Command palette']");
    step("the palette is closed at start", !pal());
    key("k", { ctrlKey: true }); await sleep(300);
    step("Ctrl+K opens the palette with the input focused", !!pal() && document.activeElement === $("input[aria-label='Type a command']"));
    const opts = () => $$("[role=option]").map((o) => o.textContent);
    step("it lists the commands with shortcut hints", opts().length >= 15 && opts().some((t) => /Undo.*Ctrl\+Z/.test(t)) && opts().some((t) => /^Export/.test(t)), opts().slice(0, 4).join(" | "));
    const box = $("input[aria-label='Type a command']");
    setNum(box, "expo"); await sleep(200);
    step("typing filters and ranks: Export first", opts()[0] && /^Export/.test(opts()[0]), opts().join(" | "));
    setNum(box, "zzzzqq"); await sleep(200);
    step("a query that matches nothing says so", /No command matches/.test(pal().textContent) && $$("[role=option]").length === 0);
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(250);
    step("Escape closes it", !pal());
    key("k", { ctrlKey: true }); await sleep(300);
    setNum($("input[aria-label='Type a command']"), "demo"); await sleep(200);
    $("input[aria-label='Type a command']").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(500);
    step("Enter runs the chosen command (Demo mode opens) and closes the palette", !pal() && !!$("[aria-label='Demo mode']"), $$("[role=dialog]").map((d) => d.getAttribute("aria-label")).join(","));
    key("k", { ctrlKey: true }); await sleep(300);
    step("Ctrl+K does not stack a palette on top of another dialog", !pal());
    $$("[role=dialog] button").find((b) => /close|stop/i.test(b.textContent))?.click(); await sleep(200);
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await inv("uitest_report", { report: JSON.stringify(R) });
})();
