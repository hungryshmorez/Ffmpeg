/** Keyboard shortcuts: the actions that have one, their default keys, the user's overrides, and turning a key event into a
 * binding. Pure (no DOM besides reading a KeyboardEvent-like object) so it can be unit tested. */

export interface ShortcutAction {
  id: string;
  label: string;
  defaults: string[];
}

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  { id: "palette", label: "Command palette", defaults: ["Ctrl+K"] },
  { id: "undo", label: "Undo", defaults: ["Ctrl+Z"] },
  { id: "redo", label: "Redo", defaults: ["Ctrl+Y", "Ctrl+Shift+Z"] },
  { id: "save", label: "Save project", defaults: ["Ctrl+S"] },
  { id: "saveas", label: "Save project as…", defaults: ["Ctrl+Shift+S"] },
  { id: "open", label: "Open project…", defaults: ["Ctrl+O"] },
  { id: "play", label: "Play / pause", defaults: ["Space"] },
  { id: "split", label: "Split clip at playhead", defaults: ["S"] },
  { id: "delete", label: "Delete selected clip", defaults: ["Delete", "Backspace"] },
  { id: "ripple", label: "Ripple delete selected clip", defaults: ["Shift+Delete", "Shift+Backspace"] },
  { id: "frameBack", label: "Back one frame", defaults: ["ArrowLeft"] },
  { id: "frameFwd", label: "Forward one frame", defaults: ["ArrowRight"] },
  { id: "back10", label: "Back ten frames", defaults: ["Shift+ArrowLeft"] },
  { id: "fwd10", label: "Forward ten frames", defaults: ["Shift+ArrowRight"] },
  { id: "start", label: "Go to start", defaults: ["Home"] },
  { id: "marker", label: "Add marker at playhead", defaults: ["M"] },
  { id: "prevMarker", label: "Previous marker", defaults: ["["] },
  { id: "nextMarker", label: "Next marker", defaults: ["]"] },
  { id: "deselect", label: "Clear selection", defaults: ["Escape"] },
];

/** The user's changes: action id → its keys (an empty list means "no shortcut"). Actions not listed use their defaults. */
export type Overrides = Record<string, string[]>;

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "OS"]);

/** "Ctrl+Shift+S" for a key event (Cmd counts as Ctrl); null for a lone modifier press. Letters are upper case; Space is named. */
export function chordOf(e: KeyLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  let k = e.key === " " ? "Space" : e.key;
  if (k.length === 1) k = k.toUpperCase();
  // Shift+[ arrives as "{" on most layouts; keep the bracket so the binding reads as typed
  if (e.shiftKey && k === "{") k = "[";
  if (e.shiftKey && k === "}") k = "]";
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(k);
  return parts.join("+");
}

/** True when a chord has Ctrl (such shortcuts still work while typing in a text field). */
export function hasCtrl(chord: string): boolean {
  return chord.startsWith("Ctrl+");
}

/** Effective keys for every action. */
export function bindings(over: Overrides): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const a of SHORTCUT_ACTIONS) out[a.id] = over[a.id] ?? a.defaults;
  return out;
}

/** The action a chord triggers, if any. */
export function actionFor(over: Overrides, chord: string): string | null {
  const b = bindings(over);
  for (const a of SHORTCUT_ACTIONS) if ((b[a.id] ?? []).includes(chord)) return a.id;
  return null;
}

/** Give `action` the single key `chord`; any other action using that key loses it. Returns the new overrides and the
 * actions that lost the key (so the UI can say so). */
export function rebind(over: Overrides, action: string, chord: string): { overrides: Overrides; took: string[] } {
  const b = bindings(over);
  const next: Overrides = { ...over, [action]: [chord] };
  const took: string[] = [];
  for (const a of SHORTCUT_ACTIONS) {
    if (a.id !== action && (b[a.id] ?? []).includes(chord)) {
      next[a.id] = (b[a.id] ?? []).filter((c) => c !== chord);
      took.push(a.id);
    }
  }
  return { overrides: tidy(next), took };
}

/** Remove the shortcut from `action`. */
export function clear(over: Overrides, action: string): Overrides {
  return tidy({ ...over, [action]: [] });
}

/** Back to the default keys for one action; a default another action now uses is not taken back from it. */
export function reset(over: Overrides, action: string): Overrides {
  const next = { ...over };
  delete next[action];
  const def = SHORTCUT_ACTIONS.find((a) => a.id === action)?.defaults ?? [];
  const b = bindings(next);
  const clash = def.filter((c) => SHORTCUT_ACTIONS.some((a) => a.id !== action && (b[a.id] ?? []).includes(c)));
  if (clash.length) next[action] = def.filter((c) => !clash.includes(c));
  return tidy(next);
}

/** Drop overrides equal to the defaults and unknown action ids. */
export function tidy(over: Overrides): Overrides {
  const out: Overrides = {};
  for (const a of SHORTCUT_ACTIONS) {
    const v = over[a.id];
    if (v && !(v.length === a.defaults.length && v.every((c, i) => c === a.defaults[i]))) out[a.id] = [...v];
  }
  return out;
}

/** Parse saved overrides, ignoring anything malformed. */
export function parseOverrides(text: string | null): Overrides {
  if (!text) return {};
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object") return {};
    const out: Overrides = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(v) && v.every((c) => typeof c === "string")) out[k] = v as string[];
    }
    return tidy(out);
  } catch {
    return {};
  }
}

/** Shortcut text for the palette ("Ctrl+Y / Ctrl+Shift+Z"), or undefined when the action has none. */
export function hintFor(over: Overrides, action: string): string | undefined {
  const keys = bindings(over)[action] ?? [];
  return keys.length ? keys.map(pretty).join(" / ") : undefined;
}

export function pretty(chord: string): string {
  return chord.replace("ArrowLeft", "←").replace("ArrowRight", "→").replace("Delete", "Del");
}
