import type { Clip, MediaAsset, Project, Sequence } from "../types";

/** The sequence commands act on (the main timeline, or a compound clip's contents while one is open). */
export function activeSequence(p: Project): Sequence {
  return p.sequences.find((s) => s.id === p.active_sequence)!;
}

/** The sequence a compound clip stands for, or null for an ordinary clip. */
export function compoundOf(p: Project, clip: Clip | undefined): Sequence | null {
  const m: MediaAsset | undefined = clip && p.media.find((x) => x.id === clip.media);
  return m?.generator?.kind === "nested" ? (p.sequences.find((s) => s.id === (m.generator as { sequence: string }).sequence) ?? null) : null;
}

/** The timeline to go back to from a compound clip: the first sequence that is neither a compound nor a snapshot. */
export function mainSequence(p: Project): Sequence | undefined {
  return p.sequences.find((s) => !s.compound && !s.name.startsWith("Snapshot: "));
}
