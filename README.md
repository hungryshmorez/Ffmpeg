# FFmpeg Studio

A browser-based video & audio editor built on **ffmpeg.wasm** and **WebCodecs** — no
uploads, no server, everything runs locally in the tab. Trim, transcode, colour-grade,
datamosh, master audio, and perform live visuals, all client-side.

> **Status:** `v10.4.0` · **round trip verified 5/5 green** · tests run in CI on every push.

- **Feature encyclopedia + roadmap:** [`ENCYCLOPEDIA.md`](./ENCYCLOPEDIA.md) — every feature,
  its status, and what's left to build.
- **v10.2 source archive:** [`v10.2-source/`](./v10.2-source/) — the earlier source, kept for
  reference (not the runnable build).

---

## What it does

| Area | Highlights |
|---|---|
| **Convert & compress** | 193 one-click workflows across 16 categories — format conversion, downscale, fps, compression, GIF, trims. |
| **Colour & video** | false-colour exposure, speed ramping with a draggable curve, before/after wipe, node graph (27 node types). |
| **Datamosh & glitch** | hierarchical SAD block-matching motion estimation (real codec-style vectors), auto-glitch/chaos engine, CPU pixel sort. |
| **Audio studio** | real-time Web Audio rack (23 knobs, 12 presets, 7 modules), spectrogram, phase-vocoder time-stretch (keeps pitch), key/BPM detection, semantic macros. |
| **Live / VJ** | 11 reactive shaders, 3-band audio reactivity, MIDI learn, 16-step sequencer, tap tempo, adaptive-quality load-shedding. |
| **Trust** | version stamp, copyable command history, sentry-style error capture, changelog generated from the code. |

The build metadata is generated, not claimed: **31 JS modules · 193 workflows · 812/812
balanced CSS braces · 27 node-graph types · 11 trip-cam effects.** See
[`scripts/generate-changelog.js`](./scripts/generate-changelog.js) and
[`build-info.js`](./build-info.js) (the single source of truth).

---

## Running it

The app needs **cross-origin isolation** (COOP/COEP headers) so ffmpeg.wasm can use
`SharedArrayBuffer`. Any static server that sends those headers works. A minimal one is
included for the tests and is fine for local use:

```bash
# from the repo root
node .test/server.mjs      # serves the repo on http://localhost:8099 with COOP/COEP
# then open http://localhost:8099
```

`.test/server.mjs` sends:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

There is also a `coi-serviceworker.js` in the app that re-adds these headers on hosts that
don't send them, so the deployed build works on static hosting too.

**No build step.** It's plain ES modules + the ffmpeg.wasm core under `vendor/`. Open the
page and go. First render lazily downloads the ~30 MB wasm core; the UI paints first.

---

## Testing — the test that can't lie

Every past regression in this project came from a check that reported success without
verifying the thing it claimed (`node -c` passing while the app was dead, `bytes > 0` on an
empty container). The tests here **decode the output and assert on real frames**, never bytes.

```bash
npm install            # only dependency is playwright
npx playwright install chromium

npm run verify         # fast: syntax + changelog gate
npm test               # the round trip, 5x — a real file in, a real DECODED video out
npm run test:workflows # golden matrix: each workflow's signature landed + both audio branches
npm run test:compositor # layer compositor: two decoded clips stacked, composited PIXELS read back
```

- **`.test/roundtrip.mjs`** boots the real app in headless Chromium (with an in-process
  COOP/COEP server), runs `downscale-480p` on a deterministic clip, decodes the output, and
  asserts on frame count + that it actually reached 480p. Runs it 5× and fails unless all
  five are green.
- **`.test/workflows.mjs`** runs several workflows and asserts each one's *signature* actually
  landed (right resolution, right frame count), plus **both audio branches** — a video-only
  input (the `-an` guard fires) and a video+audio input (the split render's video/audio/mux
  passes all succeed and preserve the track).
- **`.test/compositor.mjs`** opens the VJ tab, feeds two solid-colour clips into two layers of
  the real Layer Compositor, and **reads the composited pixels back** — asserting the blend math
  ran (`screen(red, green)` → yellow), plus solo, mute, opacity and crossfade. Pixels, not bytes:
  a dead compositor leaves the canvas black and every check fails.
- **`.test/shortcuts.mjs`** dispatches real `KeyboardEvent`s and reads the UI back: `?` opens the
  cheat sheet (and it lists every VJ key), `Escape` closes it, `[`/`]` cycle tabs, `Alt+6` jumps
  to VJ — asserting on observed state, never on "the handler exists".
- **`.test/workflows-v4v5.mjs`** drives the real **Apply & Run** card click for the "new engine"
  workflows (TRUE bitstream datamosh, real-time motion-vector datamosh) and **decodes what lands
  in the Media Bin**: bloom's output has *more* decoded frames than the source (P-frames were
  duplicated), and the motion mosh output is a genuinely decodable video. These were unreachable
  before — counted in build-info but never merged into the catalog, dispatched, or added to the bin.
- **`.test/bin-features.mjs`** exercises the other "produce a clip → bin" surfaces that the missing
  `addBlobToBin` had silently broken: **compress-to-target** (decodes to real frames, lands under
  the size budget) and the **scene splitter** (three clips, each decodable). It also guards the
  fix that batch producers no longer leave every clip but the last with a revoked blob URL.
- **`.test/audio-studio.mjs`** loads an audio clip through `loadFromBin`, decodes it into the Web
  Audio engine, and **bounces it two ways** — direct WAV and MP3 with two-pass loudness
  normalisation — decoding each result back to **PCM samples** (the audio equivalent of frames,
  not bytes).

**CI:** [`.github/workflows/test.yml`](./.github/workflows/test.yml) runs `verify`, `test`,
`test:workflows`, `test:compositor`, `test:shortcuts`, `test:workflows-v4v5`, `test:bin-features`,
and `test:audio-studio` in real headless Chromium on every push and pull request.

---

## The v10.4 round-trip fix

The round trip — a file in, a real video out — had **never been seen green** before v10.4.
It was three stacked bugs, each hidden behind the one before it:

1. **A 30 ms timeout masquerading as 30 s.** `instrumentFfmpeg` divided the exec timeout by
   1000, believing ffmpeg.wasm's argument was in *seconds* — it's *milliseconds*. So
   `ff.exec(-1)` was coerced to `30000` and then divided to `30`, and the core read it as
   **30 milliseconds** and aborted every multi-frame encode after ~1 frame
   (`Conversion failed! / Aborted()`). The 10-frame boot self-test finished inside 30 ms, so
   it passed — which is exactly why the bug only ever showed on real renders.
2. **The audio pass failing on video-only inputs.** The split renderer always ran
   `-c:a aac`, which errors out on a clip with no audio stream (demo clips, screen
   recordings), taking the whole render down. Fixed with a render-time guard that detects a
   silent input and drops to `-an`, plus fixing `analyzeMedia`, which parsed the probe but
   never actually set `hasAudio` (and leaked a log listener).
3. **A field-name mismatch crashing the success path.** `executeFFmpeg` returned `{filename}`
   but the caller read `result.outputFilename` → `undefined.split('.')` threw the instant a
   render actually completed. Latent for the project's whole history because nothing ever got
   this far.

All three are fixed and verified by the tests above.

---

## Project structure

```
├── index.html              # the app shell + all UI markup
├── app.js                  # engine wrapper, command builder, executor, editor (largest module)
├── pipeline.js             # media probe + multi-step pipeline execution
├── build-info.js           # single source of truth for version/build metadata → #ff-version
├── style.css
├── vendor/                 # ffmpeg.wasm core (mt/ + st/), self-hosted for same-origin workers
├── scripts/
│   └── generate-changelog.js   # counts generated from the code (modules, workflows, braces…)
├── .test/
│   ├── roundtrip.mjs       # the 5x round trip (frames, not bytes)
│   ├── workflows.mjs       # golden multi-workflow matrix + both audio branches
│   ├── compositor.mjs      # layer compositor: composited pixels read back (blend/solo/mute/xfade)
│   ├── shortcuts.mjs       # keyboard shortcuts: cheat sheet + tab nav, asserted on UI state
│   ├── workflows-v4v5.mjs  # TRUE datamosh + motion mosh reachable: real card click → decoded bin output
│   ├── bin-features.mjs    # compress-to-target + scene split: decoded clips out of the Media Bin
│   ├── audio-studio.mjs    # loadFromBin → Web Audio bounce (WAV + MP3/loudnorm) → decoded PCM samples
│   └── server.mjs          # minimal COOP/COEP static server
├── .github/workflows/
│   └── test.yml            # runs the tests on every push
├── ENCYCLOPEDIA.md         # every feature + the full integration roadmap
└── v10.2-source/           # the earlier v10.2 source, archived for reference
```

### The modules

| Module | Responsibility |
|---|---|
| `app.js` | ffmpeg engine wrapper (`ff.exec/writeFile/…`), serialization queue, command builder, split-render, editor UI, undo/redo, demo clip, error capture |
| `pipeline.js` | `analyzeMedia` probe, `executePipeline` multi-step runner, retry |
| `hwaccel.js` | WebCodecs path — demux (mp4box) → VideoDecoder → VideoEncoder → mux |
| `tripcam.js` / `tripcam-ui.js` | live reactive-camera WebGL engine + its UI |
| `webgl-preview.js`, `shader-plus.js` | editor WebGL preview + shader effects |
| `datamosh.js`, `motion-mosh.js` | datamosh + SAD motion estimation |
| `audio-engine.js`, `audio-studio.js`, `audio-intel.js` | Web Audio rack, studio UI, key/BPM/loudness intelligence |
| `beat-detection.js`, `waveform.js` | energy-variance beat detection, waveform rendering |
| `vj-mode.js` | MIDI learn, sequencer, tap tempo, hot cues, triggers/pads |
| `performance.js` | adaptive quality (FPS-driven load-shedding), global intensity, `Compositor` engine + 16 blend modes |
| `compositor-ui.js` | the Layer Compositor deck (layer strips, blend/opacity/solo/mute, crossfader, hot cues) over `FFPerf.Compositor` |
| `nodegraph.js` | node-graph editor (27 node types) |
| `clips.js` | clip library, take numbers, sequence export, video queue |
| `workflows*.js` | the 193 workflow definitions across 16 categories |
| `storage.js`, `opfs.js` | autosave + OPFS persistence |
| `navigation.js`, `tools.js`, `analysis.js`, `agents.js` | tab nav, misc tools, analysis, agent helpers |

---

## Feature status at a glance

Roughly 30 of the 100 backlog items are **done and verified**; a handful are **partial**
(engine present, UI unwired); **7 are environment-blocked** (need real hardware or a native
bridge — WebCodecs H.264, WASM SIMD, DCT-level manipulation, Ableton Link, NDI, model-based
features); the rest are **to-do** with honest effort sizes. The full breakdown — what each is,
what it was meant to be, and what's left — is in **[`ENCYCLOPEDIA.md`](./ENCYCLOPEDIA.md)**.

The single highest-leverage next step is already done: **CI runs the round trip on every
push**, so the next regression can't hide behind a green-but-untested check. Build outward
from there — the encyclopedia's Phase B (finishing the half-built features) is the natural
next move.

---

## Notes

- **`v10.2-source/`** is an archive of the earlier v10.2 source, added for reference. It is
  *not* what runs — the repo root is the newer v10.4 build with the round-trip fix. v10.4 is a
  superset of v10.2 except for `performance.js`, which was dropped and has since been restored
  to the root build (with a live HUD and render-loop load-shedding).
- The ffmpeg.wasm core is pinned: `@ffmpeg/ffmpeg 0.12.10`, `@ffmpeg/util 0.12.1`,
  `@ffmpeg/core 0.12.10`. The single-thread core is preferred at boot (it round-trips
  deterministically); the multi-thread core is a fallback.
