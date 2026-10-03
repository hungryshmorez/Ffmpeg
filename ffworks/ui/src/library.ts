import type { LibraryEntry } from "./api";

/** "1.4 GB", "820 KB" … */
export function fileSize(bytes: number | null): string {
  if (bytes == null) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** "1:05", "1:02:03" */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

/** One line describing a remembered file: kind, picture size, length, file size. Pictures have no length of their own. */
export function describe(e: LibraryEntry): string {
  const kind = e.hasVideo && e.hasAudio ? "video + sound" : e.hasVideo ? "picture" : e.hasAudio ? "sound" : "file";
  const parts = [kind];
  if (e.width && e.height) parts.push(`${e.width}×${e.height}`);
  if (e.duration > 0 && e.duration < 86400) parts.push(clock(e.duration));
  const size = fileSize(e.sizeBytes);
  if (size) parts.push(size);
  return parts.join(" · ");
}

export function folderOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : "";
}
