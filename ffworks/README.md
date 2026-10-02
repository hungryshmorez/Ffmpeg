# FFWORKS (working title)

A native desktop nonlinear editor built around FFmpeg. Rust engine + Tauri v2 shell + React UI.
Lives alongside the browser-based FFmpeg Studio in this repository and shares no code with it.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design.

## Status: Phase 1 (working editor)

| Capability | State |
|---|---|
| New / save / load `.ffworks` project (versioned JSON, atomic save, migration framework) | done, tested |
| Import media (FFprobe metadata incl. colour info), media browser, thumbnails, waveforms | done, tested |
| Multitrack timeline: place, trim, split, move (drag), ripple delete, linked A/V, lock/mute/hide, snapping | done, tested |
| Per-clip volume (absolute and relative dB) | done, tested |
| Undo/redo, transactions (`batch`), command bus, action recorder | done, tested |
| Source-preview playback + scrubbing | done; relies on the webview's codec support (see limits) |
| FFmpeg export (H.264 MP4, VP9 WebM, WAV, MP3) with real progress, cancel, partial-file safety, FFprobe verification, Command Inspector | done, tested |
| Headless CLI (`ffworks caps/probe/command/render`) | done |
| Per-clip effect stack (11 effects: brightness, contrast, saturation, gamma, hue, blur, sharpen, grain, vignette, flips), opacity; reorder/enable/remove; parameter metadata registry; capability-checked | done, tested (pixel-verified in real FFmpeg) |
| Processed preview: same compiler as export at 1, 1/2, 1/4 or 1/8 resolution over a 10 s window, cached by project content hash, marked out-of-date on any edit | done, tested (file generation + staleness; picture playback not observable in this sandbox) |
| Autosave (every 20 s while unsaved, 3 rotating copies, atomic) and crash recovery dialog (Recover / Open original / Discard); corrupt latest autosave falls back to the previous | done, tested incl. a real `kill -9` of the app |
| Keyframes, transitions, proxies, render queue, settings UI, relinking | **not started** (rest of Phase 2) |
| Automation DSL, macros, blueprints, analysis, glitch/datamosh labs, plugins | **not started** (Phases 3–10) |

Nothing in the UI is a placeholder: unimplemented features are simply absent.

## Requirements

* Windows 10/11 x64 (target). Linux/macOS builds work for development.
* **FFmpeg ≥ 4.4 and FFprobe** on `PATH`, or set `FFWORKS_FFMPEG` / `FFWORKS_FFPROBE`. Not bundled and never downloaded automatically. *Diagnostics* in the app reports what was found (H.264 export needs a build with `libx264`).
* Rust (stable), Node 20+. On Windows: Visual Studio Build Tools (C++) and WebView2 (preinstalled on Windows 11).

## Build and run

```powershell
cd ffworks
npm install --prefix ui
npx --prefix ui tauri dev      # development
npx --prefix ui tauri build    # NSIS + MSI installers in target/release/bundle
```

Headless: `cargo run -p ffworks-cli -- command project.ffworks` prints the exact FFmpeg command; `render project.ffworks out.mp4` exports.

## Tests

```bash
cargo test --workspace            # 55 tests: time, model, commands/undo, effects, ffprobe parsing, real-FFmpeg e2e
(cd ui && npm test)               # timeline math
scripts/uitest/run.sh             # headless GUI test under Xvfb (Linux): 30 steps in the real webview
scripts/uitest/recovery.sh        # kill -9 crash-recovery test: 9 steps across 3 app launches
```

The e2e tests generate tiny fixtures with FFmpeg, build an edit (trim, split, move, gain), save → reload → export, then verify with FFprobe, **pixel sampling and audio level measurement** that the output matches the edit.

## Known limitations

* The monitor plays *source* media through the webview and does **not** render effects or opacity unless you press *Render preview*; otherwise it shows a "bypassed" badge. Codecs the webview cannot decode (e.g. HEVC/ProRes on WebView2, or H.264 on a WebKitGTK without GStreamer plugins) will show black; proxy-based preview is Phase 2 (rendered previews are H.264, so they play where H.264 does). Invalidation is per whole project, not per time range yet. The monitor says it is a source preview; export is the authoritative render.
* Verified on Linux only (Rust tests, WebKitGTK GUI test). The Windows build is configured (`tauri.conf.json`, CI workflow) but **has not been built or run on Windows**.
* Native open/save dialogs and window-close confirmation are wired but not exercised by the automated GUI test (the test calls the same backend commands the dialogs call).
* Autosave covers the project state only; it does not recover in-progress renders. Undo history is not restored after recovery.
