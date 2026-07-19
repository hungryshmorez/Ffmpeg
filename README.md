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
| **Convert & compress** | 199 one-click workflows across 16 categories — format conversion, downscale, fps, compression, GIF, trims. |
| **Colour & video** | false-colour exposure, vectorscope + waveform monitor, speed ramping with a draggable curve, before/after wipe, node graph (27 node types). |
| **Datamosh & glitch** | hierarchical SAD block-matching motion estimation (real codec-style vectors), motion-vector overlay, optical-flow warp, feedback tunnel, auto-glitch/chaos engine, masked pixel sort. |
| **Audio studio** | real-time Web Audio rack (23 knobs, 12 presets, 7 modules), spectrogram, phase-vocoder time-stretch (keeps pitch), key/BPM detection, semantic macros. |
| **Live / VJ** | 11 reactive shaders, 3-band audio reactivity, MIDI learn, 16-step sequencer, tap tempo, adaptive-quality load-shedding. |
| **Trust** | version stamp, copyable command history, sentry-style error capture, changelog generated from the code. |

The build metadata is generated, not claimed: **31 JS modules · 199 workflows · 825/825
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
  fix that batch producers no longer leave every clip but the last with a revoked blob URL, and
  that the touch-accessible bin **reorder** button moves an item (composite order is bin order).
- **`.test/audio-studio.mjs`** loads an audio clip through `loadFromBin`, decodes it into the Web
  Audio engine, and **bounces it two ways** — direct WAV and MP3 with two-pass loudness
  normalisation — decoding each result back to **PCM samples** (the audio equivalent of frames,
  not bytes).
- **`.test/clips.mjs`** opens the (newly un-orphaned) **Clips tab**, adds two clips, reorders one
  with the touch-accessible move button, then runs **`exportSequence`** and decodes the output —
  the frame count equals the sum of the clips, proving the concat ran (not just that a file appeared).
- **`.test/mobile.mjs`** loads the app in **touch-emulated** contexts at phone, iPad-portrait and
  iPad-landscape sizes and asserts the page never scrolls sideways (across every tab) and that real
  taps switch tabs and reach off-screen ones.
- **`.test/panic.mjs`** latches VJ triggers, runs the sequencer and pulls the master down, then hits
  **PANIC** (both the button and the `0` key) and asserts everything reset — no live tool ships
  without a panic. (Also caught that the VJ keyboard was never bound.)
- **`.test/mosh-family.mjs`** feeds a shifted texture through the `MotionMosher` and asserts the new
  shaping params act on the vector field / pixels **deterministically** (no MediaRecorder):
  directional bias zeroes an axis, amplification bends the magnitude, bloom displaces further,
  masking shows the clean frame where motion is weak, and the two-clip `moshAcross` drags the
  picture with the motion clip's field.
- **`.test/datamosh2.mjs`** drives the headline **two-clip datamosh** UI end-to-end — two VP9 clips
  into the bin, select both, click "Datamosh A→B" — and plays the result back to prove it's a real
  decodable video (clip A's motion on clip B's picture). Then **records** one clip's motion field
  (#63) and **replays** it onto the other, proving the persistent-recording round-trip end-to-end.
- **`.test/databend.mjs`** runs the **Databend** card (corrupt the raw bytes, decode through the
  damage) and asserts the wrecked stream still **decodes to real frames** — plus a deterministic
  unit check that the corruptor pokes bytes and leaves the container header intact.
- **`.test/pixelsort.mjs`** verifies the **masked / angled pixel sort** deterministically: a
  hand-built row proves out-of-band pixels are left untouched and in-band runs come back sorted
  (asc + desc), and a 90° pass proves the angle actually rotates the sort axis.
- **`.test/feedback.mjs`** verifies the **feedback tunnel** deterministically on the buffer: a
  central square spreads outward under zoom>1, the buffer fades under decay when nothing is added,
  and a non-zero rotation lands the trail somewhere different.
- **`.test/flow-displace.mjs`** verifies **optical-flow displacement** deterministically with
  hand-built fields: a uniform field shifts a vertical edge by exactly `dx*scale`, the scale scales
  it, a zero field is an identity, and a top→bottom-varying field warps the two halves differently.
- **`.test/vector-overlay.mjs`** verifies the **motion-vector overlay** deterministically: nothing
  is drawn before a field exists, the estimated field inks the canvas, and a single isolated vector's
  arrow runs toward the tip (+x,+y) and not the other way.
- **`.test/scopes.mjs`** verifies the **vectorscope + waveform** deterministically: a grey frame
  plots at the vectorscope centre while saturated red and blue push apart, and a dark→bright gradient
  makes the waveform's luma trace rise from bottom to top.
- **`.test/halation.mjs`** verifies **halation & bloom** deterministically: a bright spot bleeds a
  reddish glow into its black surroundings, while a below-threshold frame and a fully black frame
  barely change.
- **`.test/stereo-width.mjs`** verifies **stereo width + correlation**: the DSP core on synthesised
  PCM (mono → +1, anti-phase → −1), then an end-to-end offline bounce through the real engine graph
  where width=0 renders mono and width=2 is measurably wider than width=1.
- **`.test/limiter.mjs`** verifies the **lookahead limiter**: spikes at 2.0 come back with no sample
  over the ceiling (transient caught, not overshot), an under-ceiling signal is untouched, and an
  end-to-end bounce caps the rendered output at the set dB ceiling.
- **`.test/transient.mjs`** verifies the **transient shaper** on a synthetic drum hit: attack=+1
  raises the crest factor, attack=−1 lowers it, and sustain=+1 lifts the tail RMS.
- **`.test/sidechain.mjs`** verifies the **sidechain duck** on a pad+kick mix: the level dips right
  after each detected kick and recovers before the next; amount=0 is untouched.
- **`.test/ms-eq.mjs`** verifies **mid/side EQ**: mono-the-bass collapses the low side while keeping
  the high side, widen-the-highs lifts the high side, and neutral is untouched.
- **`.test/multiband.mjs`** verifies **multiband compression**: complementary crossovers reconstruct
  to unity (Δ=0), the low band compresses down with a real gain-reduction read, and the high band is
  left alone.
- **`.test/film-grain.mjs`** verifies **plate-based film grain**: it adds texture, preserves the
  mean, scales with intensity, and is clumpy — the grain layer's lag-1 autocorrelation (0.94) sits
  far above a white-noise reference (~0), which is what makes it a plate and not digital hiss.
- **`.test/speed-blur.mjs`** verifies **motion blur on speed-up**: `frameBlend` smears a stepping
  dot along its path (a mid-path point lights though it was black in frame 0, the peak drops, the
  lit span widens into a trail) while a still is left untouched.
- **`.test/stems.mjs`** verifies **stem separation**: instrumental cancels the centre vocal (0.249→
  0.016) while keeping the panned instrument, and the spectral acapella lifts the vocal/instrument
  ratio 1.79→7.23; mono input degrades gracefully.
- **`.test/conv-reverb.mjs`** verifies **convolution reverb from a user IR**: a click bounced through
  a hand-built 2-tap impulse response echoes at the tap position, and only when the IR is loaded (the
  dry render is silent there).
- **`.test/stems-export.mjs`** verifies **stem export**: a click through reverb+delay splits into a
  dry stem carrying the click, a reverb stem that isolates the reverb (dry click removed 0.119→0.003),
  and a delay stem that echoes at the delay time.
- **`.test/lens.mjs`** verifies **lens distortion + CA**: barrel distortion bows a straight line
  (top x=3 vs mid x=22), chromatic aberration fringes the edges (|R−B|=255) but not the centre, and
  the no-op profile is a byte-identity.
- **`.test/rolling-shutter.mjs`** verifies **rolling shutter / jello**: shear slants a vertical line,
  the opposite shear corrects it back to straight, wobble bends it (jello), and the no-op is a
  byte-identity.
- **`.test/stabilize.mjs`** verifies **stabilisation**: `globalMotion` is outlier-robust (median),
  and `stabilizePath` drops a jittery pan's acceleration (2.02→0.06) while preserving the pan travel.
- **`.test/reframe.mjs`** verifies **auto-reframe**: the magnitude-weighted motion centroid tracks
  the subject to each corner and returns null on a still field.
- **`.test/crossfade-curves.mjs`** verifies the **crossfader curves**: linear sums to 1, constant-
  power's sum-of-squares is 1 (no mid dip → 0.707/0.707), sharp is an S-curve, and the compositor's
  layer opacities follow the selected law.
- **`.test/n-layers.mjs`** verifies the **N-layer compositor**: the deck grows to 6 layers in the
  real app and a clip on layer 5 (beyond the old max) screen-blends over red to a yellow centre
  pixel; the layer count clamps to [2,8].
- **`.test/interpolate.mjs`** verifies **optical-flow interpolation**: a block that moves 20 px lands
  at the midpoint (x=31.5) when interpolated at t=0.5, a quarter/three-quarters along at t=0.25/0.75,
  and t=0/1 return the source frames exactly.
- **`.test/deflicker.mjs`** verifies **deflicker**: a 128±40 flicker's frame-brightness variance
  collapses (796→3) while a slow 80→180 ramp is preserved (Δ75) and a steady sequence is unchanged.
- **`.test/power-window.mjs`** verifies **power windows**: a feathered elliptical mask brightens the
  inside (120→222), leaves the outside untouched, grades the feathered edge partially, and inverts.
- **`.test/hsl-qualify.mjs`** verifies **HSL secondaries**: qualifying red and hue-shifting turns a
  red half green (30,220,30) while the blue half is untouched, qualifying blue darkens only it, and a
  hue with no content in the frame selects nothing.
- **`.test/loop-detect.mjs`** verifies **loop-point detection**: a 0.5 s / 0.3 s motif tiled several
  times is detected at its true period with ~1.0 confidence, and unrepeating noise scores low.
- **`.test/suggest.mjs`** verifies **workflow suggestions**: a talking-head clip ranks Loudnorm/Trim/
  Reframe, a vertical no-audio short gets Music/social/Loop (no audio-only steps), 4K gets Downscale.
- **`.test/beatsync.mjs`** verifies the **beat-sync assembler**: cuts snap to the nearest beat,
  segments fall every N beats, and clips lay onto the grid (short used whole, long trimmed to fit).
- **`.test/highlights.mjs`** verifies the **highlight reel**: scoring energy+motion+scene-cut picks
  the two peaks (t=5, t=14), keeps them ≥3 s apart, and returns them chronologically.
- **`.test/launch-quantize.mjs`** verifies **beat-synced launching**: at 120 BPM a launch 300 ms in
  fires at 500 ms (beat) or 2000 ms (bar), an on-grid launch fires immediately, and tempo scales it.
- **`.test/beat-chop.mjs`** verifies **beat-grid chopping**: slicing on the grid, a reverse shuffle,
  a 4× stutter of one slice onto a fresh timeline, and out-of-range index safety.
- **`.test/granular.mjs`** verifies **granular beat stutter**: rendering a rearrangement to PCM — a
  `[0,0,0]` stutter fills with slice-0's 200 Hz tone, a `[2,1,0]` shuffle plays 800/400/200, length sums.
- **`.test/pitch-snap.mjs`** verifies **pitch snap**: `detectPitch` recovers a 440 Hz fundamental
  without an octave error, and `snapToScale` nudges an off-key pitch into the chosen scale (→ D4).
- **`.test/gain-staging.mjs`** verifies **gain staging + A/B**: the staging check flags the first
  stage that clips (a +12 dB bass boost), and `loudnessMatch` brings a mix onto a reference's RMS.
- **`.test/retime-toggle.mjs`** verifies the **retime toggle**: at t=0.5 the `'flow'` method warps to
  one sharp block at the midpoint while `'blend'` cross-dissolves to two ghosts.
- **`.test/curves.mjs`** verifies the **tone curves**: the identity curve is a no-op, a curve passes
  through its control point (128→190), invert gives 255−i, and a per-channel curve is isolated.
- **`.test/pattern-banks.mjs`** verifies the **pattern banks**: save→change→recall restores the
  sequencer pattern (deep-copied), an empty bank is safe, and a recall while playing queues for the bar.
- **`.test/automation.mjs`** verifies **automation recording**: moves are time-stamped from the take
  start, `valueAt` is sample-and-hold, `stateAt` gives the whole patch, and the take round-trips.
- **`.test/live-record.mjs`** verifies the **live record → Media Bin** path (TripCam and the VJ deck):
  recording an animated canvas hands back a non-empty video that decodes to real frames and lands in
  the bin as an ordinary clip (so any ffmpeg workflow can then run on it).
- **`.test/prefs.mjs`** verifies the **preferences panel**: defaults, `set()` persists and applies
  (reduce-motion class + accent), survives a reload, "," opens the modal, and `reset()` restores.
- **`.test/color-match.mjs`** verifies **auto colour-match**: the Reinhard transfer lands the target's
  per-channel mean and std on the reference's, strength blends (0 = no-op, 0.5 = halfway), self = identity.
- **`.test/hover-preview.mjs`** verifies **workflow hover-preview**: the per-pixel look ops (grayscale → R=G=B,
  invert → 255−x, saturate widens the channel spread, warm gain lifts red over blue), that `deriveLook` grounds
  the look in the real ffmpeg command and in name/tag keywords, that every video workflow resolves to a visible
  look, and end-to-end that `showFor` paints the overlay canvas and hovering a real card reveals it.
- **`.test/wf-thumbs.mjs`** verifies **workflow thumbnails**: `renderThumb` bakes each workflow's look onto a
  canonical frame (grayscale workflow → grayscale tile, saturate widens the spread, invert ≠ grayscale, audio →
  waveform tile), and `decorate` injects exactly one non-blank thumbnail per card across all cards, idempotently.
- **`.test/onboarding.mjs`** verifies the **onboarding tour**: it auto-appears on first run at step 1 with the
  spotlight on the Add-media button, Next advances the steps and switches to a step's target tab, finishing gates
  it in `localStorage` and hides it, `start(false)` is a no-op once gated while the cheat-sheet button replays it.
- **`.test/undo-custom.mjs`** verifies **app-wide undo of custom state**: a registered provider's non-DOM state
  rides the shared undo stack in lockstep with a form control across a run of undo/redo (round-tripping to the
  start), a null capture opts out cleanly, and app-level Undo reverts a real VJ sequencer step edit while keeping
  the grid DOM and pattern state consistent.
- **`.test/preview-fx.mjs`** verifies **Live FX in the Preview tab**: the effect list includes real FFShaderPlus
  shader passes, the pixel ops behave (grayscale→R=G=B, invert→255−x, vibrant widens the spread), the shader
  passes actually alter pixels, `renderFrameFrom` paints the effect onto `#pv-fx`, entering/leaving the mode
  starts/stops the loop, and Record → Bin lands a decodable 480×270 clip in the Media Bin.
- **`.test/fx-chain.mjs`** verifies **effect chains**: stages apply in order ([grayscale,warm] stays coloured vs
  [warm,grayscale] goes grey), disabled stages skip, add/move/toggle/remove and serialize↔restore behave, and a
  stacked chain drives the preview loop over the single picker while the ＋ Add / remove UI stacks and clears it.
- **`.test/midi-out.mjs`** verifies **MIDI output** from the sequencer: the encoders + realtime constants, 24-PPQN
  clock timing, note-on/off to an injected output with a deterministic trigger→note map, a START→CLOCK…→STOP
  stream, graceful silence when disabled / no device, and that firing a real VJ trigger emits note-on/off.

**CI:** [`.github/workflows/test.yml`](./.github/workflows/test.yml) runs `verify`, `test`,
`test:workflows`, `test:compositor`, `test:shortcuts`, `test:workflows-v4v5`, `test:bin-features`,
`test:audio-studio`, `test:clips`, `test:mobile`, `test:panic`, `test:mosh-family`, `test:datamosh2`, `test:databend`, `test:pixelsort`, `test:feedback`, `test:flow-displace`, `test:vector-overlay`, `test:scopes`, `test:halation`, `test:stereo-width`, `test:limiter`, `test:transient`, `test:sidechain`, `test:ms-eq`, `test:multiband`, `test:film-grain`, `test:speed-blur`, `test:stems`, `test:conv-reverb`, `test:stems-export`, `test:lens`, `test:rolling-shutter`, `test:stabilize`, `test:reframe`, `test:crossfade-curves`, `test:n-layers`, `test:interpolate`, `test:deflicker`, `test:power-window`, `test:hsl-qualify`, `test:loop-detect`, `test:suggest`, `test:beatsync`, `test:highlights`, `test:launch-quantize`, `test:beat-chop`, `test:granular`, `test:pitch-snap`, `test:gain-staging`, `test:retime-toggle`, `test:curves`, `test:pattern-banks`, `test:automation`, `test:live-record`, `test:prefs`, `test:color-match`, `test:hover-preview`, `test:wf-thumbs`, `test:onboarding`, `test:undo-custom`, `test:preview-fx`, `test:fx-chain`, and `test:midi-out` in real headless Chromium on
every push and pull request.

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
│   ├── clips.mjs           # Clip Studio exportSequence: concat of two clips → decoded frame count
│   ├── mobile.mjs          # touch-emulated phone/iPad: no horizontal overflow + taps switch tabs
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
| `clips.js` | Clip Studio (its own tab): clip library, take numbers, touch/drag reorder, sequence export |
| `workflows*.js` | the 199 workflow definitions across 16 categories |
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
- **iPad & mobile.** The layout is responsive and touch-driven — drag handles (trim, wipe) and
  the VJ pads use pointer/touch events, the tab and mode bars scroll horizontally, and the header
  stacks on tablet-portrait widths so nothing pushes the page sideways (`.test/mobile.mjs` guards
  this across phone/iPad sizes). Recording paths select an mp4 MIME on Safari/iOS, which has no
  webm encoder. Two things still depend on the browser, not this code: `SharedArrayBuffer`
  (needs the COOP/COEP headers, which the bundled `coi-serviceworker.js` re-adds on static hosts)
  and tight iOS memory limits on very large clips.
