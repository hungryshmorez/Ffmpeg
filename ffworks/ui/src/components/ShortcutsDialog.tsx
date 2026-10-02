import { useEffect, useState } from "react";
import { bindings, chordOf, clear, pretty, rebind, reset, SHORTCUT_ACTIONS, tidy } from "../state/keymap";
import { useUi } from "../state/stores";

/** Change the keyboard shortcuts. Click "Change", press the new key; a key already in use moves to this action. */
export function ShortcutsDialog() {
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcutsOpen);
  const keymap = useUi((s) => s.keymap);
  const setKeymap = useUi((s) => s.setKeymap);
  const [listening, setListening] = useState<string | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) { setListening(null); setNote(""); return; }
    const onKey = (e: KeyboardEvent) => {
      if (!listening) {
        if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) { setListening(null); setNote("Cancelled."); return; }
      const chord = chordOf(e);
      if (!chord) return; // wait for the key itself after the modifiers
      const { overrides, took } = rebind(keymap, listening, chord);
      setKeymap(overrides);
      const label = (id: string) => SHORTCUT_ACTIONS.find((a) => a.id === id)?.label ?? id;
      setNote(took.length ? `${pretty(chord)} now does “${label(listening)}”; it was taken from “${took.map(label).join("”, “")}”.` : `${pretty(chord)} now does “${label(listening)}”.`);
      setListening(null);
    };
    // capture phase, so the key never reaches the app's own shortcut handler or the buttons
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, listening, keymap, setKeymap, setOpen]);

  if (!open) return null;
  const b = bindings(keymap);
  const changed = Object.keys(tidy(keymap)).length;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="modal">
        <h2>Keyboard shortcuts</h2>
        <p className="muted">Click Change, then press the new key (with Ctrl / Shift / Alt if you like). Esc cancels. Shortcuts with Ctrl also work while typing in a field.</p>
        <table className="shortcut-table" aria-label="Shortcuts">
          <tbody>
            {SHORTCUT_ACTIONS.map((a) => (
              <tr key={a.id} data-shortcut={a.id}>
                <td>{a.label}</td>
                <td data-keys>{listening === a.id ? <em>press a key…</em> : (b[a.id] ?? []).length ? (b[a.id] ?? []).map((c) => <kbd key={c}>{pretty(c)}</kbd>) : <span className="muted">none</span>}</td>
                <td>
                  <button className="small" aria-label={`Change shortcut for ${a.label}`} onClick={() => { setNote(""); setListening(a.id); }}>Change</button>{" "}
                  <button className="small" aria-label={`Remove shortcut for ${a.label}`} disabled={(b[a.id] ?? []).length === 0} onClick={() => setKeymap(clear(keymap, a.id))}>Remove</button>{" "}
                  <button className="small" aria-label={`Reset shortcut for ${a.label}`} disabled={!(a.id in keymap)} onClick={() => setKeymap(reset(keymap, a.id))}>Reset</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" aria-live="polite" data-shortcut-note>{note}</p>
        <div className="row end">
          <button disabled={changed === 0} onClick={() => { setKeymap({}); setNote("All shortcuts are back to their defaults."); }}>Reset all</button>
          <button onClick={() => setOpen(false)}>Close</button>
        </div>
      </div>
    </div>
  );
}
