import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api } from "../api";
import { fpsOf, formatBytes, timecode, toSec } from "../time";
import { useAnalysis } from "../state/analysis";
import { useJobs, usePlayhead, useProject, useUi } from "../state/stores";
import { useProxies } from "../state/proxies";
import type { MediaAsset } from "../types";

export async function importViaDialog() {
  const picked = await open({ multiple: true, title: "Import media", filters: [{ name: "Media", extensions: ["mp4", "mov", "mkv", "avi", "webm", "m4v", "mp3", "wav", "flac", "aac", "ogg", "m4a", "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"] }, { name: "All files", extensions: ["*"] }] });
  if (picked) await importPaths(Array.isArray(picked) ? picked : [picked]);
}

export async function importSubtitlesViaDialog() {
  const p = await open({ title: "Import subtitles", filters: [{ name: "Subtitles", extensions: ["srt", "vtt"] }] });
  if (typeof p !== "string") return;
  const { toast, setView } = useProject.getState();
  try {
    setView(await api.importSubtitles(p, 0));
    toast("info", "Subtitles added on a new track");
  } catch (e) {
    toast("error", String(e));
  }
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
  const proxies = useProxies((s) => s.status);
  const refreshProxies = useProxies((s) => s.refresh);
  const jobs = useJobs((s) => s.jobs);
  const toast = useProject((s) => s.toast);
  useEffect(() => { void refreshProxies(); }, [media.length, refreshProxies]);
  // a finished (or failed/canceled) proxy job changes what exists on disk
  const finished = Object.values(jobs).filter((j) => j.operation.startsWith("proxy:") && ["completed", "failed", "canceled"].includes(j.state)).map((j) => `${j.jobId}:${j.state}`).join(",");
  useEffect(() => { void refreshProxies(); }, [finished, refreshProxies]);
  const proxyJob = (id: string) => Object.values(jobs).find((j) => j.operation === `proxy:${id}` && (j.state === "queued" || j.state === "rendering"));
  const make = async (id: string) => { try { await api.createProxy(id); } catch (e) { toast("error", String(e)); } };
  const makeAll = () => media.filter((m) => proxies[m.id]?.eligible && !proxies[m.id]?.ready && !proxyJob(m.id)).forEach((m) => void make(m.id));

  return (
    <div className="panel media" aria-label="Media browser">
      <div className="panel-title">
        Media <button className="small" onClick={() => void importViaDialog()}>Import…</button> <button className="small" title="Add a .srt / .vtt file as title clips on a new track" onClick={() => void importSubtitlesViaDialog()}>Subtitles…</button>
        <button className="small" title="Make low-resolution H.264 copies of every video for smooth, universally playable preview (exports always use the originals)" onClick={makeAll}>Make proxies</button>
        <button className="small" title="Delete all proxy files (they can be made again)" onClick={() => void api.clearProxies().then((b) => { toast("info", `Deleted proxies (${formatBytes(b)})`); return refreshProxies(); })}>Clear</button>
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
                {proxies[m.id]?.eligible && (
                  <div className="proxy-line">
                    {(() => {
                      const job = proxyJob(m.id);
                      const p = proxies[m.id]!;
                      if (job) return <span className="muted" data-proxy-state="working">proxy {job.state === "rendering" && job.fraction != null ? `${Math.round(job.fraction * 100)}%` : "queued"}…</span>;
                      if (p.ready) return <span className="proxy-ok" data-proxy-state="ready">proxy ✓ {formatBytes(p.bytes)}</span>;
                      return <button className="small" data-proxy-state="none" onClick={(e) => { e.stopPropagation(); void make(m.id); }} onPointerDown={(e) => e.stopPropagation()}>Make proxy</button>;
                    })()}
                  </div>
                )}
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
