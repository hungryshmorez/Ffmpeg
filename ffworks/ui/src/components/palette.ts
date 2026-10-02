/** Command palette model: an action list and the ranking that filters it. Pure so it can be unit tested. */
export interface PaletteAction {
  id: string;
  label: string;
  /** Shortcut or short explanation shown on the right. */
  hint?: string;
  /** Extra words that should find this action. */
  keywords?: string;
  run: () => void;
}

/** Score of `query` against `text`: -1 when the letters do not appear in order; higher is better (prefix and word-start matches win). */
export function scoreMatch(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, ""), t = text.toLowerCase();
  if (!q) return 0;
  if (t.includes(query.toLowerCase().trim())) return 100 - t.indexOf(query.toLowerCase().trim()) + (t.startsWith(query.toLowerCase().trim()) ? 50 : 0);
  let ti = 0, score = 0, prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return -1;
    score += at === prev + 1 ? 5 : 1;
    if (at === 0 || t[at - 1] === " ") score += 3;
    prev = at;
    ti = at + 1;
  }
  return score;
}

/** Actions matching `query`, best first; an empty query keeps the original order. */
export function filterActions(actions: readonly PaletteAction[], query: string): PaletteAction[] {
  if (!query.trim()) return [...actions];
  return actions
    .map((a, i) => ({ a, i, s: Math.max(scoreMatch(query, a.label), scoreMatch(query, `${a.label} ${a.keywords ?? ""}`) - 20) }))
    .filter((x) => x.s >= 0)
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .map((x) => x.a);
}
