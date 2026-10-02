import type { Rational } from "./types";

/** Seconds as a float — display and layout only. The backend owns exact rational time. */
export function toSec(r: Rational): number {
  const [n, d] = r.split("/");
  const num = Number(n);
  const den = d === undefined ? 1 : Number(d);
  return den === 0 ? 0 : num / den;
}

/** Encode seconds as a rational string with microsecond resolution; the backend snaps it to the frame grid. */
export function fromSec(s: number): Rational {
  return `${Math.round(s * 1_000_000)}/1000000`;
}

export function fpsOf(r: Rational): number {
  return toSec(r);
}

/** Non-drop timecode HH:MM:SS:FF using the nominal (rounded) frame rate. */
export function timecode(seconds: number, fps: number): string {
  const nominal = Math.max(1, Math.round(fps));
  const total = Math.max(0, Math.round(seconds * fps));
  const ff = total % nominal;
  const s = Math.floor(total / nominal);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

export function snapToFrame(seconds: number, fps: number): number {
  return Math.round(seconds * fps) / fps;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
