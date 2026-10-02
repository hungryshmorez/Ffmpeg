import { useEffect, useState } from "react";

/**
 * Slider + number box that shows live feedback while dragging but commits ONE value on release,
 * so a drag produces a single undo step instead of dozens.
 */
export function CommitSlider({ label, value, min, max, step, unit, onCommit }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onCommit: (v: number) => void }) {
  const [live, setLive] = useState(value);
  useEffect(() => setLive(value), [value]);
  const commit = (v: number) => {
    if (Number.isFinite(v) && v !== value) onCommit(Math.min(max, Math.max(min, v)));
  };
  return (
    <div className="field compact">
      <label>{label}{unit ? ` (${unit})` : ""}</label>
      <div className="row">
        <input aria-label={`${label} slider`} type="range" min={min} max={max} step={step} value={live} onChange={(e) => setLive(Number(e.target.value))} onPointerUp={() => commit(live)} onKeyUp={() => commit(live)} onBlur={() => commit(live)} />
        <input aria-label={label} className="num" type="number" min={min} max={max} step={step} value={Number.isInteger(live) ? live : Number(live.toFixed(3))} onChange={(e) => { setLive(e.target.valueAsNumber); if (!Number.isNaN(e.target.valueAsNumber)) commit(e.target.valueAsNumber); }} />
      </div>
    </div>
  );
}
