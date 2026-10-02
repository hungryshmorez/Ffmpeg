import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api } from "../api";
import { fpsOf, formatBytes, timecode, toSec } from "../time";
import { useAnalysis } from "../state/analysis";
import { usePlayhead, useProject, useUi } from "../state/stores";
import type { MediaAsset } from "../types";

export async function importViaDialog() {
  const picked = await open({ multiple: true, title: "Import media", filters: [{ name: "Media", extensions: ["mp4", "mov", "mkv", "avi", "webm", "m4v", "mp3", "wav", "flac", "aac", "ogg", "m4a", "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"] }, { name: "All files", extensions: ["*"] }] });
  if (picked) await importPaths(Array.isArray(picked) ? picked : [picked]);
}

export async function importPaths(paths: string[]) {
  const { toast, setView } = useProject.getState();
  try {
    const r = await api.importMedia(paths);
    setView(r.state);
    r.errors.forEach((e) => toast("error", `Import failed — ${e}`));
    if (r.errors.length < paths.length) toast("info", `Imported ${paths.length - r.errors.length} file(s)`);
  } catch (e) {
    toast("error", String(e));
  }
}

export async function relinkFolder() {
  const dir = await open({ directory: true, title: "Folder to search for the missing media" });
  if (typeof dir !== "string") return;
  const { setView, toast } = useProject.getState();
  try {
    const r = await api.relinkSearch(dir);
    setView(r.state);
    if (r.relinked.length) toast("info", `Relinked ${r.relinked.length} file(s) by content`);
    for (const u of r.unresolved) {
      const m = r.state.project.media.find((x) => x.id === u.mediaId);
      const hint = u.candidates.length ? `only name-based candidates: ${u.candidates.map((c) => c.path).join(", ")} (${u.candidates[0]?.reason}) — use Locate to accept one` : "no match found";
      toast("error", `${m?.name ?? u.mediaId}: ${hint}`);
    }
  } catch (e) {
    toast("error", String(e));
  }
}

export async function locateMedia(id: string) {
  const p = await open({ title: "Locate file" });
  if (typeof p === "string") await useProject.getState().run(() => api.relinkMedia(id, p));
}

/** Place media at the playhead on the first free compatible track (keyboard-accessible alternative to dragging). */
export function addToTimeline(media: MediaAsset, startSec?: number, trackId?: string) {
  const { view, dispatch, toast } = useProject.getState();
  if (!view) return;
  const seq = view.project.sequences.find((s) => s.id === view.project.active_sequence)!;
  const kind = media.info.video.length ? "video" : "audio";
  const track = trackId ? seq.tracks.find((t) => t.id === trackId) : seq.tracks.find((t) => t.kind === kind);
  if (!track) return toast("error", `No ${kind} track available`);
  const t = startSec ?? usePlayhead.getState().t;
  void dispatch({ type: "place_clip", media: media.id, track: track.id, start: `${Math.round(t * 1_000_000)}/1000000`, with_audio: true });
}

export function MediaBrowser() {
  const view = useProject((s) => s.view)!;
  const [sel, setSel] = useState<string | null>(null);
  const ensure = useAnalysis((s) => s.ensureThumbs);
  const thumbs = useAnalysis((s) => s.thumbs);
  // generated media (title canvas, solid colours) is created from the timeline, not imported
  const media = view.project.media.filter((m) => !m.generator);
  useEffect(() => media.forEach((m) => m.info.video.length && ensure(m.id)), [media, ensure]);
  const selected = media.find((m) => m.id === sel) ?? null;
  const fps = fpsOf(view.project.settings.fps);

  return (
    <div className="panel media" aria-label="Media browser">
      <div className="panel-title">
        Media <button className="small" onClick={() => void importViaDialog()}>Import…</button>
      </div>
      {view.offlineMedia.length > 0 && (
        <div className="offline-banner" role="alert">
          {view.offlineMedia.length} media file(s) offline. <button className="small" onClick={() => void relinkFolder()}>Relink from folder…</button>
        </div>
      )}
      <div className="media-list" role="listbox" aria-label="Media items">
        {media.length === 0 && <p className="muted pad">Import files with the button above or drop them on the window.</p>}
        {media.map((m) => {
          const th = thumbs[m.id];
          const offline = view.offlineMedia.includes(m.id);
          const v = m.info.video[0];
          return (
            <div
              key={m.id}
              role="option"
              aria-selected={sel === m.id}
              tabIndex={0}
              className={`media-item ${sel === m.id ? "selected" : ""} ${offline ? "offline" : ""}`}
              onClick={() => setSel(m.id)}
              onDoubleClick={() => addToTimeline(m)}
              onKeyDown={(e) => e.key === "Enter" && addToTimeline(m)}
              onPointerDown={(e) => startMediaDrag(e, m)}
              title="Double-click or press Enter to add at the playhead. Drag onto a track to place."
            >
              <div className="thumb">{Array.isArray(th) && th[0] ? <img src={th[0]} alt="" draggable={false} /> : <span>{m.info.video.length ? "🎞" : "🎵"}</span>}</div>
              <div className="media-meta">
                <div className="name">{m.name}{offline && <em> — offline</em>}{offline && <button className="small" onClick={(e) => { e.stopPropagation(); void locateMedia(m.id); }} onPointerDown={(e) => e.stopPropagation()}>Locate…</button>}</div>
                <div className="muted">{m.info.still ? "still image" : timecode(toSec(m.info.duration), fps)} · {v ? `${v.width}×${v.height}` : "audio"} {v?.fps ? `· ${toSec(v.fps).toFixed(3)} fps` : ""}</div>
              </div>
            </div>
          );
        })}
      </div>
      {selected && <Metadata m={selected} />}
    </div>
  );
}

/** Pointer-based drag (HTML5 DnD is disabled by Tauri's OS file-drop handler on Windows). */
function startMediaDrag(e: React.PointerEvent, m: MediaAsset) {
  if (e.button !== 0) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let ghost: HTMLDivElement | null = null;
  const move = (ev: PointerEvent) => {
    if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6) {
      ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.textContent = m.name;
      document.body.appendChild(ghost);
    }
    if (ghost) {
      ghost.style.left = `${ev.clientX + 8}px`;
      ghost.style.top = `${ev.clientY + 8}px`;
    }
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!ghost) return;
    ghost.remove();
    const target = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => (n as HTMLElement).dataset?.trackId) as HTMLElement | undefined;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const pxPerSec = useUi.getState().pxPerSec;
    const t = Math.max(0, (ev.clientX - rect.left) / pxPerSec);
    addToTimeline(m, t, target.dataset.trackId);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function Metadata({ m }: { m: MediaAsset }) {
  const v = m.info.video[0];
  const a = m.info.audio[0];
  const rows: [string, string][] = [
    ["Path", m.path],
    ["Container", m.info.container],
    ["Duration", `${toSec(m.info.duration).toFixed(3)} s`],
    ["Size", formatBytes(m.info.size_bytes)],
    ["Bitrate", m.info.bit_rate ? `${Math.round(m.info.bit_rate / 1000)} kb/s` : "—"],
  ];
  if (v) {
    rows.push(["Video", `${v.codec} ${v.width}×${v.height}${v.fps ? ` @ ${toSec(v.fps).toFixed(3)} fps` : ""}`]);
    rows.push(["Pixel format", `${v.color.pix_fmt ?? "—"}${v.color.bits_per_raw_sample ? ` (${v.color.bits_per_raw_sample}-bit)` : ""}`]);
    rows.push(["Color", [v.color.color_space, v.color.color_transfer, v.color.color_primaries, v.color.color_range].map((x) => x ?? "unspecified").join(" / ")]);
  }
  if (a) rows.push(["Audio", `${a.codec} ${a.sample_rate} Hz, ${a.channels} ch${a.channel_layout ? ` (${a.channel_layout})` : ""}`]);
  for (const [k, val] of m.info.tags.slice(0, 6)) rows.push([`tag: ${k}`, val]);
  return (
    <dl className="metadata" aria-label="Media metadata">
      {rows.map(([k, val]) => (
        <div key={k}><dt>{k}</dt><dd>{val}</dd></div>
      ))}
    </dl>
  );
}
