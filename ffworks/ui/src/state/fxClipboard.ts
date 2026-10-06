import { create } from "zustand";
import type { Clip, Command, EffectInstance } from "../types";

interface FxClipboard {
  kind: "video" | "audio" | null;
  effects: EffectInstance[];
  copy: (clip: Clip) => void;
}

/** Effects copied from a clip, ready to paste onto others (the stack is copied by value, so later edits to the source do not follow). */
export const useFxClipboard = create<FxClipboard>((set) => ({
  kind: null,
  effects: [],
  copy: (clip) => set({ kind: clip.kind === "audio" ? "audio" : "video", effects: clip.effects.map((e) => ({ ...e, params: { ...e.params } })) }),
}));

/**
 * Commands that append copies of `effects` to `target`. Custom filter-graph effects are skipped (their node graph needs the
 * graph editor); `skipped` says how many. Disabled effects are pasted disabled.
 */
export function pasteCommands(effects: readonly EffectInstance[], target: Clip): { commands: Command[]; skipped: number } {
  const commands: Command[] = [];
  let skipped = 0;
  for (const fx of effects) {
    if (fx.effect === "graph") { skipped++; continue; }
    if (fx.effect === "afilterchain" || fx.effect === "vfilterchain") {
      if (fx.text) commands.push({ type: fx.effect === "afilterchain" ? "add_audio_chain" : "add_video_chain", clip: target.id, chain: fx.text });
      else skipped++;
      continue;
    }
    commands.push({ type: "add_effect", clip: target.id, effect: fx.effect, params: { ...fx.params } });
  }
  return { commands, skipped };
}
