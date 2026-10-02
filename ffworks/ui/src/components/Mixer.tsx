import { useEffect } from "react";
import { useAnalysis } from "../state/analysis";
import { usePlayhead, useProject } from "../state/stores";
import { clipAt } from "../timeline/math";
import { meterPos, toDb, trackLevel } from "../timeline/mixer";
import type { Track } from "../types";
import { CommitSlider } from "./CommitSlider";

/** One channel bar on a -60..0 dB scale. */
function Bar({ linear, label }: { linear: number | null; label: string }) {
  const pos = linear === null ? 0 : meterPos(linear);
  const hot = linear !== null && linear >= 1;
  return (
    <div className="meter-bar" role="meter" aria-label={label} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={linear === null ? -60 : Math.max(-60, Math.round(toDb(linear)))}>
      <i className={hot ? "hot" : ""} style={{ width: `${pos * 100}%` }} />
    </div>
  );
}

function Strip({ track, anySolo }: { track: Track; anySolo: boolean }) {
  const dispatch = useProject((s) => s.dispatch);
  const t = usePlayhead((s) => s.t);
  const ensure = useAnalysis((s) => s.ensureWave);
  const waves = useAnalysis((s) => s.waves);
  // load the waveforms this track will need (the timeline usually has them already)
  const mediaIds = [...new Set(track.clips.map((c) => c.media))].join(",");
  useEffect(() => mediaIds.split(",").filter(Boolean).forEach(ensure), [mediaIds, ensure]);
  const active = clipAt(track, t);
  const slot = active ? waves[active.media] : undefined;
  const w = typeof slot === "object" ? slot : undefined;
  const level = trackLevel(track, t, w, anySolo);
  const db = level === null ? null : Math.max(toDb(level.l), toDb(level.r));
  return (
    <div className="strip" data-track-id={track.id} aria-label={`Mixer strip ${track.name}`}>
      <div className="row">
        <strong className="grow">{track.name}</strong>
        <button className={`small ${track.muted ? "on" : ""}`} aria-pressed={track.muted} aria-label={`Mute ${track.name}`} onClick={() => void dispatch({ type: "set_track", track: track.id, muted: !track.muted })}>M</button>
        <button className={`small ${track.solo ? "on solo" : ""}`} aria-pressed={track.solo} aria-label={`Solo ${track.name}`} title="Solo: only soloed tracks are heard" onClick={() => void dispatch({ type: "set_track", track: track.id, solo: !track.solo })}>S</button>
      </div>
      <div className="meters" title="Peak at the playhead, predicted from the analysed waveform with gain, fades and pan applied (effects not included)">
        <div className="meter-bars">
          <Bar linear={level?.l ?? null} label={`${track.name} left level`} />
          <Bar linear={level?.r ?? null} label={`${track.name} right level`} />
        </div>
        <span className="mono db">{db === null ? "—" : db === -Infinity ? "-∞" : `${db.toFixed(1)} dB`}</span>
      </div>
      <CommitSlider label="Gain" unit="dB" value={track.gain_db} min={-60} max={12} step={0.5} onCommit={(v) => void dispatch({ type: "set_track", track: track.id, gain_db: v })} />
      <CommitSlider label="Pan" value={track.pan} min={-1} max={1} step={0.05} onCommit={(v) => void dispatch({ type: "set_track", track: track.id, pan: v })} />
    </div>
  );
}

/** Per-track faders, balance, mute/solo and level meters. Every control is a command. */
export function Mixer() {
  const view = useProject((s) => s.view)!;
  const seq = view.project.sequences.find((s) => s.id === view.project.active_sequence)!;
  const audio = seq.tracks.filter((t) => t.kind === "audio");
  const anySolo = audio.some((t) => t.solo && !t.muted);
  return (
    <div className="mixer" aria-label="Mixer">
      <div className="panel-title">Mixer</div>
      {audio.length === 0 && <p className="muted pad">No audio tracks.</p>}
      {audio.map((t) => <Strip key={t.id} track={t} anySolo={anySolo} />)}
      <p className="muted pad">Meters show the predicted peak at the playhead from the analysed waveform (gain, fades and pan included; effects not).</p>
    </div>
  );
}
