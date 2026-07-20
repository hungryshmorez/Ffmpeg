# FFmpeg Studio — Handover

A zero-build, entirely client-side video/audio editor: **ffmpeg.wasm + WebCodecs +
WebGL + Web Audio + OPFS**, served as plain ES modules. No bundler, no framework,
no server — open `index.html` behind cross-origin-isolation headers and it runs.

- **Version:** v10.4.0
- **Scale:** ~53 JS modules, 215 workflows, 27 node types, a 31-knob audio rack,
  11 VJ/Trip-Cam shaders.
- **Status:** 87 / 100 backlog items done and **verified by running** (see
  `ENCYCLOPEDIA.md` — it is the authoritative scoreboard).

---

## How to run it

The app **must** be served with cross-origin isolation (COOP/COEP) so that
`SharedArrayBuffer` (multi-thread ffmpeg.wasm) and OPFS work. Any static server
that sends these headers works:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Everything the app needs is vendored under `vendor/` (the ffmpeg.wasm ST + MT
cores), so there is nothing to download or build. There is also a bundled
`coi-serviceworker.js` fallback that retrofits isolation on hosts that don't send
the headers (e.g. GitHub Pages).

## How to run the tests

The test suite is the backbone of this project — **every** claim is proven by a
headless Chromium run that asserts on DECODED FRAMES or PCM SAMPLES, never on
byte counts. Requires Node ≥ 18 and Playwright's Chromium.

```bash
npm install
npx playwright install --with-deps chromium
npm run verify          # syntax + changelog gate
npm test                # the frames-not-bytes round trip (5×)
npm run test:workflows  # golden workflow matrix
# …every feature has its own `npm run test:<name>` (see package.json scripts)
```

`.github/workflows/test.yml` runs the full matrix on every push. Tests that need
WebGL launch Chromium with SwiftShader
(`--use-gl=swiftshader --enable-unsafe-swiftshader`); the WebCodecs/camera tests
use `--use-fake-device-for-media-stream`. Each test spins up its own in-process
COOP/COEP HTTP server, so `node .test/<file>.mjs` runs standalone.

---

## Architecture / module map

| Area | Files |
|---|---|
| App shell / engine boot / routing | `app.js` (large — split is backlog #97), `pipeline.js`, `navigation.js`, `build-info.js` |
| ffmpeg.wasm cores | `vendor/st`, `vendor/mt` |
| Workflows (the 215 recipes) | `workflows.js`, `workflows_v3.js`, `workflows_v4.js`, `workflows_v5.js`, `wf-thumbs.js` |
| Node graph editor | `nodegraph.js`, `tools.js`, `compositor-ui.js` |
| Live GL engine (Trip Cam / VJ) | `tripcam.js`, `tripcam-ui.js`, `vj-mode.js`, `shader-plus.js`, `webgl-preview.js`, `preview-fx.js` |
| Motion / datamosh | `motion-mosh.js` (incl. the off-thread estimator, #15), `datamosh.js` |
| Audio | `audio-engine.js`, `audio-dsp.js`, `audio-studio.js`, `audio-intel.js`, `beat-detection.js`, `waveform.js`, `scopes.js` |
| Hardware acceleration | `hwaccel.js` (WebCodecs, #13), `accel-router.js` (graceful fallback), `opfs-stream.js`, `opfs.js` |
| Intelligence / suggestions | `analysis.js`, `suggest.js`, `highlights.js`, `beatsync.js`, `agents.js` |
| UX / a11y | `onboarding.js`, `a11y-grid.js`, `section-filter.js`, `context-menu.js`, `slider-ergonomics.js`, `hover-preview.js`, `prefs.js` |
| MIDI / automation | `midi-in.js`, `midi-out.js`, `automation.js` |
| Perf / memory | `performance.js`, `mem-budget.js`, `segment-encode.js`, `storage.js` |
| UI | `index.html`, `style.css` |
| Tests | `.test/*.mjs` (one per feature) |

`v10.2-source/` is an older source snapshot kept for reference — not the live app.

---

## Non-negotiable conventions (please keep)

1. **Frames, not bytes.** A test proves a video by DECODING it and asserting the
   frame count / resolution / pixels — or, for audio, the PCM samples. Byte-size
   checks are not evidence.
2. **No unverifiable code on the runnable branch.** If the current runner can't
   assert the behaviour, don't ship it as done — but *probe the specific thing
   first* before declaring it impossible (this bit us: "swiftshader can't link
   shaders" was actually a real varying-name bug, and "no codecs" ignored that
   VP9/AV1 encode fine). See the "environment reality" notes below.
3. **Graceful fallback.** Accelerated paths (WebCodecs, OPFS, workers) always
   fall back to the wasm/main-thread path via `FFAccel.route(...)` /
   `FFMotion` / `FFHardware` — a missing or throwing accelerator must never take
   a workflow down.

## Environment reality (what this headless runner can and can't do)

- **WebGL:** SwiftShader only. Shaders link and render real pixels (after the
  varying-mismatch fix) — pixel readback works.
- **WebCodecs:** present. Encode+decode work for **VP8 / VP9 / AV1** (software);
  **H.264 is absent**. Hardware acceleration (`prefer-hardware`) reports
  unsupported (no GPU adapter).
- **WebGPU:** `navigator.gpu` exists but `requestAdapter()` returns **null** — no
  adapter. Genuinely unavailable here.
- **OPFS + Workers + SharedArrayBuffer:** available in the isolated context.

---

## What's left (from `ENCYCLOPEDIA.md`)

- **To do (not gated):** #80 second-screen/projector output · #81 Whisper.wasm
  auto-subtitles (needs a bundled model) · #97 split `app.js` · #98 single state
  store · #99 typed event bus.
- **Blocked on real hardware/toolchain:** #14 OffscreenCanvas worker shaders
  (needs a real GPU adapter) · #16 WASM SIMD SAD (needs an emcc/wat2wasm build) ·
  #65 true DCT (custom codec) · #79 NDI/virtual-cam (native bridge) · #84
  shot-type classify + #87 content-aware fill (ML models / WebGPU).

Read `ENCYCLOPEDIA.md` for the full per-item history — each done item records
exactly what was built and which test proves it.

---

## Git

Active development branch: `claude/ffmpeg-studio-v10-4-report-7ssjim-ec3s6b`.
`CHANGELOG_v7…v10.md` carry the release history. This handover archive excludes
`.git/` history and `node_modules/` (reinstallable); everything else — including
the vendored ffmpeg cores under `vendor/` — is here and runnable as-is.
