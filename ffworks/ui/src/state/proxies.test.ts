import { describe, expect, it } from "vitest";
import { playbackPath } from "./proxies";
import type { ProxyStatus } from "../types";

const ready: ProxyStatus = { mediaId: "m", eligible: true, ready: true, path: "/cache/proxies/x_540p.mp4", bytes: 10 };

describe("playbackPath", () => {
  it("uses the proxy only when enabled and ready", () => {
    expect(playbackPath("/media/a.mov", ready, true)).toEqual({ path: "/cache/proxies/x_540p.mp4", proxy: true });
    expect(playbackPath("/media/a.mov", ready, false)).toEqual({ path: "/media/a.mov", proxy: false });
    expect(playbackPath("/media/a.mov", { ...ready, ready: false, path: null }, true)).toEqual({ path: "/media/a.mov", proxy: false });
    expect(playbackPath("/media/a.mov", undefined, true)).toEqual({ path: "/media/a.mov", proxy: false });
  });
});
