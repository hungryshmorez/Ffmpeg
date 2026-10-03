import { describe as suite, expect, it } from "vitest";
import type { LibraryEntry } from "./api";
import { clock, describe, fileSize, folderOf } from "./library";

const entry = (over: Partial<LibraryEntry> = {}): LibraryEntry => ({ path: "/media/a.mp4", name: "a.mp4", fingerprint: "f", sizeBytes: 1_500_000, duration: 65, hasVideo: true, hasAudio: true, width: 1920, height: 1080, container: "mov", firstSeenUnix: 0, lastSeenUnix: 0, exists: true, ...over });

suite("library formatting", () => {
  it("writes file sizes in decimal units", () => {
    expect(fileSize(null)).toBe("");
    expect(fileSize(999)).toBe("999 B");
    expect(fileSize(1_500_000)).toBe("1.5 MB");
    expect(fileSize(820_000)).toBe("820 KB");
    expect(fileSize(12_345_000_000)).toBe("12 GB");
  });
  it("writes lengths as a clock", () => {
    expect(clock(65)).toBe("1:05");
    expect(clock(3723)).toBe("1:02:03");
    expect(clock(Number.NaN)).toBe("");
  });
  it("describes a file in one line, leaving out a picture's invented length", () => {
    expect(describe(entry())).toBe("video + sound · 1920×1080 · 1:05 · 1.5 MB");
    expect(describe(entry({ hasAudio: false, duration: 86400, sizeBytes: 90_000 }))).toBe("picture · 1920×1080 · 90 KB");
    expect(describe(entry({ hasVideo: false, width: null, height: null }))).toBe("sound · 1:05 · 1.5 MB");
  });
  it("finds the folder with either kind of separator", () => {
    expect(folderOf("/media/a.mp4")).toBe("/media");
    expect(folderOf("C:\\clips\\a.mp4")).toBe("C:\\clips");
    expect(folderOf("a.mp4")).toBe("");
  });
});
