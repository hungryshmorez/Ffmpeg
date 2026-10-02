import { useEffect, useState } from "react";
import { api } from "../api";
import { useProject, useUi } from "../state/stores";
import type { Clip, EffectDef } from "../types";
import { CommitSlider } from "./CommitSlider";
import { KeyframeField, type FieldSpec } from "./KeyframeField";
import { useClipProps } from "./ClipPropsPanel";
import { RandomBar } from "./RandomBar";
import { toggleStar, useFavs } from "../state/favourites";
import { pasteCommands, useFxClipboard } from "../state/fxClipboard";

let registryCache: EffectDef[] | null = null;

/** Effect stack for a video clip. Every change is a command (undoable, recordable); animatable parameters can be keyframed. */
export function EffectsPanel({ clip }: { clip: Clip }) {
  const dispatch = useProject((s) => s.dispatch);
  const clipProps = useClipProps();
  const [defs, setDefs] = useState<EffectDef[]>(registryCache ?? []);
  const favs = useFavs((s) => s.favs);
  const saveFavs = useFavs((s) => s.save);
  useEffect(() => { void useFavs.getState().load(); }, []);
  const [pick, setPick] = useState(clip.kind === "audio" ? "compressor" : "saturation");
  useEffect(() => {
    if (!registryCache) void api.listEffects().then((d) => { registryCache = d; setDefs(d); });
  }, []);
  const clip$ = useFxClipboard();
  const toast = useProject((s) => s.toast);
  const view = useProject((s) => s.view);
  const sameKind = clip$.kind === (clip.kind === "audio" ? "audio" : "video") && clip$.effects.length > 0;
  const paste = (targets: Clip[]) => {
    const all = targets.flatMap((t) => pasteCommands(clip$.effects, t).commands);
    const skipped = pasteCommands(clip$.effects, clip).skipped;
    if (!all.length) return toast("info", "Nothing to paste (graph effects are not copied)");
    if (skipped) toast("info", `${skipped} custom graph effect(s) were not pasted`);
    void dispatch({ type: "batch", label: `Paste ${clip$.effects.length - skipped} effects onto ${targets.length} clip(s)`, commands: all });
  };
  const trackClips = view?.project.sequences[0]?.tracks.find((t) => t.clips.some((c) => c.id === clip.id))?.clips ?? [clip];
  const byId = (id: string) => defs.find((d) => d.id === id);
  const mine = defs.filter((d) => d.kind === clip.kind);
  const groups = [...new Set(mine.map((d) => d.category))];

  return (
    <div className="effects" aria-label="Effects" data-kind={clip.kind}>
      <div className="panel-title sub">Effects</div>
      <div className="field">
        <div className="row">
          <select aria-label="Effect to add" value={pick} onChange={(e) => setPick(e.target.value)}>
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {mine.filter((d) => d.category === g).map((d) => <option key={d.id} value={d.id}>{favs.starred.effects.includes(d.id) ? "★ " : ""}{d.name}</option>)}
              </optgroup>
            ))}
          </select>
          <button onClick={() => void dispatch({ type: "add_effect", clip: clip.id, effect: pick })}>Add</button>
          <button className="small" aria-label={favs.starred.effects.includes(pick) ? "Remove from favourites" : "Add to favourites"} title="Favourite" onClick={() => void saveFavs(toggleStar(favs, "effects", pick))}>{favs.starred.effects.includes(pick) ? "★" : "☆"}</button>
        </div>
      </div>
      <div className="field">
        <div className="row">
          <button disabled={clip.effects.length === 0} title="Copy this clip's effect stack" onClick={() => clip$.copy(clip)}>Copy effects</button>
          <button disabled={!sameKind} title="Add the copied effects to this clip (one undo step)" onClick={() => paste([clip])}>Paste</button>
          <button disabled={!sameKind || trackClips.length < 2} title="Add the copied effects to every clip on this track (one undo step)" onClick={() => paste(trackClips)}>Paste to track</button>
        </div>
      </div>
      <RandomBar kind="effects" roll={(pool, count, seed) => api.randomEffects(clip.id, count, pool, seed)} />
      {clip.effects.length === 0 && <p className="muted pad">No effects.</p>}
      {clip.effects.map((fx, i) => {
        const def = byId(fx.effect);
        return (
          <div key={fx.id} className={`fx ${fx.enabled ? "" : "off"}`} data-effect={fx.effect}>
            <div className="row fx-head">
              <label className="check"><input type="checkbox" aria-label={`Enable ${def?.name ?? fx.effect}`} checked={fx.enabled} onChange={(e) => void dispatch({ type: "set_effect_enabled", clip: clip.id, effect_id: fx.id, enabled: e.target.checked })} /><strong>{def?.name ?? fx.effect}</strong></label>
              <span className="grow" />
              <button className="small" title="Move up" disabled={i === 0} onClick={() => void dispatch({ type: "move_effect", clip: clip.id, effect_id: fx.id, index: i - 1 })}>↑</button>
              <button className="small" title="Move down" disabled={i === clip.effects.length - 1} onClick={() => void dispatch({ type: "move_effect", clip: clip.id, effect_id: fx.id, index: i + 1 })}>↓</button>
              <button className="small" title="Remove effect" aria-label={`Remove ${def?.name ?? fx.effect}`} onClick={() => void dispatch({ type: "remove_effect", clip: clip.id, effect_id: fx.id })}>✕</button>
            </div>
            {fx.effect === "graph" && (
              <div className="field">
                <button onClick={() => useUi.getState().setGraphEdit({ clip: clip.id, fx: fx.id })}>Edit graph…</button>
                <span className="muted"> {fx.graph ? `${fx.graph.nodes.length - 2} filter(s)` : ""}</span>
              </div>
            )}
            {def?.params.map((p) => {
              const value = fx.params[p.id] ?? p.default;
              if (p.animatable && clipProps) {
                const spec: FieldSpec = { param: `fx:${fx.id}:${p.id}`, label: p.name, unit: p.unit, min: p.min, max: p.max, step: p.step, value, animatable: true };
                return <KeyframeField key={p.id} clip={clip} spec={spec} interps={clipProps.interps} />;
              }
              return <CommitSlider key={p.id} label={p.name} unit={p.unit} value={value} min={p.min} max={p.max} step={p.step} onCommit={(v) => void dispatch({ type: "set_effect_param", clip: clip.id, effect_id: fx.id, param: p.id, value: v })} />;
            })}
          </div>
        );
      })}
    </div>
  );
}
