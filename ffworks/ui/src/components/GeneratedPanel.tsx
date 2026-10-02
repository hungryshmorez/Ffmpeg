import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useProject } from "../state/stores";
import type { Align, Clip, FontEntry, MediaAsset, Title } from "../types";
import { CommitSlider } from "./CommitSlider";

let fontCache: FontEntry[] | null = null;

/** A colour picker that commits once the user pauses or leaves the control (the native picker fires continuously while dragging). */
function ColorField({ label, value, onCommit }: { label: string; value: string; onCommit: (hex: string) => void }) {
  const [live, setLive] = useState(value);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setLive(value), [value]);
  const commit = (v: string) => { window.clearTimeout(timer.current); if (v.toLowerCase() !== value.toLowerCase()) onCommit(v); };
  return (
    <div className="field compact">
      <label>{label}</label>
      <input type="color" aria-label={label} value={live.slice(0, 7)} onChange={(e) => { const v = e.target.value; setLive(v); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => commit(v), 500); }} onBlur={() => commit(live)} />
    </div>
  );
}

/** Text and styling of a title clip. Every change is a `set_title` command (one undo step). */
export function TitlePanel({ clip }: { clip: Clip }) {
  const dispatch = useProject((s) => s.dispatch);
  const title = clip.title!;
  const [fonts, setFonts] = useState<FontEntry[]>(fontCache ?? []);
  const [text, setText] = useState(title.text);
  useEffect(() => { if (!fontCache) void api.listFonts().then((f) => { fontCache = f; setFonts(f); }); }, []);
  useEffect(() => setText(title.text), [title.text, clip.id]);
  const set = (patch: Partial<Title>) => void dispatch({ type: "set_title", clip: clip.id, title: { ...title, ...patch } });
  const fontKnown = fonts.length === 0 || fonts.some((f) => f.name.toLowerCase() === title.font.toLowerCase());
  const boxAlpha = title.box_color ? parseInt(title.box_color.slice(7, 9), 16) / 255 : 1;
  const boxRgb = title.box_color ? title.box_color.slice(0, 7) : "#000000";
  const hex2 = (a: number) => Math.round(Math.min(1, Math.max(0, a)) * 255).toString(16).padStart(2, "0");
  return (
    <div className="effects" aria-label="Title properties">
      <div className="panel-title sub">Title</div>
      <div className="field compact">
        <label>Text</label>
        <textarea aria-label="Title text" rows={3} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== title.text && text.trim() && set({ text })} />
      </div>
      <div className="field compact">
        <label>Font</label>
        <select aria-label="Title font" value={fontKnown ? title.font : ""} onChange={(e) => set({ font: e.target.value })}>
          {!fontKnown && <option value="">{title.font} (not installed)</option>}
          {fonts.map((f) => <option key={f.name} value={f.name}>{f.name}{f.bundled ? " (built in)" : ""}</option>)}
        </select>
        {!fontKnown && <p className="muted">This project's font is not installed here; choose another before rendering.</p>}
      </div>
      <CommitSlider label="Size" unit="% of height" value={title.size} min={1} max={40} step={0.5} onCommit={(v) => set({ size: v })} />
      <ColorField label="Text colour" value={title.color} onCommit={(v) => set({ color: v })} />
      <div className="field compact">
        <label>Alignment</label>
        <div className="row">
          {(["left", "center", "right"] as Align[]).map((a) => <button key={a} className={`small ${title.align === a ? "on" : ""}`} aria-pressed={title.align === a} aria-label={`Align ${a}`} onClick={() => set({ align: a })}>{a}</button>)}
        </div>
      </div>
      <CommitSlider label="Outline" unit="% of height" value={title.outline_width} min={0} max={4} step={0.1} onCommit={(v) => set({ outline_width: v })} />
      {title.outline_width > 0 && <ColorField label="Outline colour" value={title.outline_color} onCommit={(v) => set({ outline_color: v })} />}
      <CommitSlider label="Shadow" unit="% of height" value={title.shadow} min={0} max={4} step={0.1} onCommit={(v) => set({ shadow: v })} />
      <div className="field compact">
        <label className="check"><input type="checkbox" aria-label="Background box" checked={title.box_color !== null} onChange={(e) => set({ box_color: e.target.checked ? "#000000a0" : null })} /> Background box</label>
      </div>
      {title.box_color && (
        <>
          <ColorField label="Box colour" value={boxRgb} onCommit={(v) => set({ box_color: `${v}${hex2(boxAlpha)}` })} />
          <CommitSlider label="Box opacity" value={Number(boxAlpha.toFixed(2))} min={0} max={1} step={0.05} onCommit={(v) => set({ box_color: `${boxRgb}${hex2(v)}` })} />
          <CommitSlider label="Box padding" unit="% of height" value={title.box_pad} min={0} max={10} step={0.25} onCommit={(v) => set({ box_pad: v })} />
        </>
      )}
      <p className="muted pad">Move, scale, rotate and fade the title with the Transform and Opacity controls below. It shows in a rendered preview or export.</p>
    </div>
  );
}

/** Colour of a solid-colour clip. */
export function SolidPanel({ clip, media }: { clip: Clip; media: MediaAsset }) {
  const dispatch = useProject((s) => s.dispatch);
  if (media.generator?.kind !== "solid") return null;
  const color = media.generator.color;
  const rgb = color.slice(0, 7);
  const alpha = color.length === 9 ? parseInt(color.slice(7, 9), 16) / 255 : 1;
  const hex2 = (a: number) => Math.round(Math.min(1, Math.max(0, a)) * 255).toString(16).padStart(2, "0");
  return (
    <div className="effects" aria-label="Solid colour properties">
      <div className="panel-title sub">Solid colour</div>
      <ColorField label="Colour" value={rgb} onCommit={(v) => void dispatch({ type: "set_solid_color", clip: clip.id, color: `${v}${hex2(alpha)}` })} />
      <CommitSlider label="Colour opacity" value={Number(alpha.toFixed(2))} min={0} max={1} step={0.05} onCommit={(v) => void dispatch({ type: "set_solid_color", clip: clip.id, color: `${rgb}${hex2(v)}` })} />
    </div>
  );
}
