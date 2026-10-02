// In-webview test for the keyboard shortcut editor. __SRC__ and __PHASE__ are substituted by shortcuts.sh;
// phase 2 runs in a fresh app process with the same profile and checks the change was kept.
(async () => {
  const R = { ok: true, steps: [] };
  const step = (n, c, d = "") => { R.steps.push({ name: n, pass: !!c, detail: String(d) }); if (!c) R.ok = false; };
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const view = () => window.__ffworks.useProject.getState().view;
  const P = () => window.__ffworks.useProject.getState();
  const U = () => window.__ffworks.useUi.getState();
  const key = (k, extra = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
  const clips = () => view().project.sequences[0].tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips);
  const markers = () => view().project.sequences[0].markers.length;
  const dlg = () => $("[aria-label='Keyboard shortcuts']");
  const keysOf = (id) => $(`[data-shortcut='${id}'] [data-keys]`).textContent;
  const btn = (label) => $(`button[aria-label='${label}']`);
  try {
    await waitFor(() => $(".app") && view());
    if ("__PHASE__" === "2") {
      step("after a restart the changed shortcut is still there", JSON.stringify(U().keymap.marker) === '["Ctrl+Alt+J"]' && JSON.stringify(U().keymap.play) === "[]", JSON.stringify(U().keymap));
      U().setShortcutsOpen(true); await sleep(300);
      step("and the editor shows it", dlg() && /Ctrl\+Alt\+J/.test(keysOf("marker")) && /none/.test(keysOf("play")), dlg() && keysOf("marker"));
      U().setKeymap({}); U().setShortcutsOpen(false);
    } else {
      await window.__ffworks.importPaths(["__SRC__"]); await waitFor(() => $$(".media-item").length === 1);
      const m = view().project.media[0].id, v1 = view().project.sequences[0].tracks.find((t) => t.kind === "video").id;
      await P().dispatch({ type: "place_clip", media: m, track: v1, start: "0", source_in: "0", duration: "4", with_audio: false }); await sleep(400);
      window.__ffworks.usePlayhead.getState().setT(2);
      U().select(clips()[0].id); await sleep(200);

      key("k", { ctrlKey: true }); await sleep(300);
      const box = $("input[aria-label='Type a command']");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(box, "keyboard"); box.dispatchEvent(new Event("input", { bubbles: true })); await sleep(200);
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(400);
      step("the palette opens the shortcut editor", !!dlg());
      step("it lists the default keys", /S/.test(keysOf("split")) && /Ctrl\+Y/.test(keysOf("redo")) && /Ctrl\+Shift\+Z/.test(keysOf("redo")), keysOf("redo"));

      btn("Change shortcut for Add marker at playhead").click(); await sleep(200);
      step("Change waits for a key", /press a key/.test(keysOf("marker")));
      key("Shift", { shiftKey: true }); await sleep(100);
      step("a lone modifier is not taken as the key", /press a key/.test(keysOf("marker")));
      key("s"); await sleep(300);
      step("pressing S assigns it and says it was taken from Split", /^S$/.test(keysOf("marker").trim()) && /none/.test(keysOf("split")) && /taken from .Split clip at playhead/.test($("[data-shortcut-note]").textContent), $("[data-shortcut-note]").textContent);
      step("the key press did not also split the clip behind the dialog", clips().length === 1, clips().length);
      [...dlg().querySelectorAll("button")].find((b) => b.textContent === "Close").click(); await sleep(200);

      const m0 = markers();
      key("s"); await sleep(500);
      step("S now adds a marker and no longer splits", markers() === m0 + 1 && clips().length === 1, `${markers()} markers, ${clips().length} clips`);
      key("k", { ctrlKey: true }); await sleep(300);
      const hint = $$("[role=option]").find((o) => /Add marker/.test(o.textContent));
      step("the palette shows the new key next to the action", hint && hint.querySelector("kbd") && hint.querySelector("kbd").textContent === "S", hint && hint.textContent);
      $("input[aria-label='Type a command']").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(200);

      U().setShortcutsOpen(true); await sleep(300);
      btn("Reset shortcut for Split clip at playhead").click(); await sleep(200);
      step("resetting Split leaves S with the marker (no silent theft)", /none/.test(keysOf("split")) && /S/.test(keysOf("marker")));
      btn("Change shortcut for Add marker at playhead").click(); await sleep(150);
      key("j", { ctrlKey: true, altKey: true }); await sleep(250);
      btn("Reset shortcut for Split clip at playhead").click(); await sleep(200);
      step("with S free again, resetting Split gives it back", /^S$/.test(keysOf("split").trim()) && /Ctrl\+Alt\+J/.test(keysOf("marker")), keysOf("split") + " / " + keysOf("marker"));
      btn("Change shortcut for Add marker at playhead").click(); await sleep(150);
      key("Escape"); await sleep(200);
      step("Escape cancels a change", /Ctrl\+Alt\+J/.test(keysOf("marker")) && !!dlg() && /Cancelled/.test($("[data-shortcut-note]").textContent));
      btn("Remove shortcut for Play / pause").click(); await sleep(200);
      step("Remove leaves an action with no key", /none/.test(keysOf("play")));
      [...dlg().querySelectorAll("button")].find((b) => b.textContent === "Close").click(); await sleep(200);
      const playing = window.__ffworks.usePlayhead.getState().playing;
      key(" "); await sleep(200);
      step("Space no longer plays", window.__ffworks.usePlayhead.getState().playing === playing);
      key("s"); await sleep(500);
      step("S splits again", clips().length === 2, clips().length);
      key("z", { ctrlKey: true }); await sleep(500);
      step("untouched shortcuts still work (Ctrl+Z undoes the split)", clips().length === 1, clips().length);
      const before = markers();
      key("j", { ctrlKey: true, altKey: true }); await sleep(500);
      step("the new Ctrl+Alt+J adds a marker", markers() === before + 1, markers());
    }
  } catch (e) { step("exception", false, (e && e.stack) || e); }
  await window.__TAURI_INTERNALS__.invoke("uitest_report", { report: JSON.stringify(R) });
})();
