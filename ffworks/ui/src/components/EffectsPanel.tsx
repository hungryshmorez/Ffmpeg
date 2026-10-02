import { useEffect, useState } from "react";
import { api } from "../api";
import { useProject } from "../state/stores";
import type { Clip, EffectDef } from "../types";
import { CommitSlider } from "./CommitSlider";

let registryCache: EffectDef[] | null = null;

/** Opacity and effect stack for a video clip. Every change is a command (undoable, recordable). */
export function EffectsPanel({ clip }: { clip: Clip }) {
  const dispatch = useProject((s) => s.dispatch);
  const [defs, setDefs] = useState<EffectDef[]>(registryCache ?? []);
  const [pick, setPick] = useState("saturation");
  useEffect(() => {
    if (!registryCache) void api.listEffects().then((d) => { registryCache = d; setDefs(d); });
  }, []);
  const byId = (id: string) => defs.find((d) => d.id === id);
  const groups = [...new Set(defs.map((d) => d.category))];

  return (
    <div className="effects" aria-label="Effects">
      <div className="panel-title sub">Video</div>
      <CommitSlider label="Opacity" value={clip.opacity} min={0} max={1} step={0.01} onCommit={(v) => void dispatch({ type: "set_clip_opacity", clip: clip.id, opacity: v })} />
      <div className="panel-title sub">Effects</div>
      <div className="field">
        <div className="row">
          <select aria-label="Effect to add" value={pick} onChange={(e) => setPick(e.target.value)}>
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {defs.filter((d) => d.category === g).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </optgroup>
            ))}
          </select>
          <button onClick={() => void dispatch({ type: "add_effect", clip: clip.id, effect: pick })}>Add</button>
        </div>
      </div>
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
            {def?.params.map((p) => (
              <CommitSlider key={p.id} label={p.name} unit={p.unit} value={fx.params[p.id] ?? p.default} min={p.min} max={p.max} step={p.step} onCommit={(v) => void dispatch({ type: "set_effect_param", clip: clip.id, effect_id: fx.id, param: p.id, value: v })} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
