# FFmpeg Studio — Feature Encyclopedia & Integration Plan

*What every feature is, what it was meant to be, where it stands today, and exactly what
is left to do to fold all of it into one project.*

This document is the planning bible. It merges three sources:

1. **The six source apps** that were mined for features (SauceLab VJ, Trippy Effects,
   Driftwave Vaporizer, Trippy Cam 2.0, Clip Studio, Datamosh Lab — plus Aesthetic Audio).
2. **The "100 Ways" list** — the correctness/perf/audio/video/glitch/live/intelligence/UX/
   architecture backlog.
3. **The current build** (v10.4 at the repo root) and what has actually been verified.

Status legend used throughout:

| Badge | Meaning |
|---|---|
| ✅ **Done** | In the build and *verified by running it* (not assumed). |
| 🟡 **Partial** | Code exists but is unwired, unverified, or only half the feature. |
| 🔒 **Blocked** | Can't be finished/verified in the current environment (needs real hardware, a build toolchain, etc.). |
| ⬜ **To do** | Not started. |

Effort is a rough T-shirt size (S = hours, M = a day, L = multiple days, XL = a week+),
and *Risk* flags how likely the change is to break the working app.

---

## Table of Contents

- [Part 0 — Current verified state](#part-0--current-verified-state)
- [Part 1 — The crown jewels (the six source apps)](#part-1--the-crown-jewels-the-six-source-apps)
- [Part 2 — The 100 Ways, catalogued](#part-2--the-100-ways-catalogued)
  - [Correctness & Trust (1–12)](#correctness--trust-112)
  - [Performance (13–24)](#performance-1324)
  - [Audio (25–40)](#audio-2540)
  - [Video (41–56)](#video-4156)
  - [Glitch & Mosh (57–68)](#glitch--mosh-5768)
  - [Live & Performance (69–80)](#live--performance-6980)
  - [Intelligence (81–88)](#intelligence-8188)
  - [UX (89–96)](#ux-8996)
  - [Architecture (97–100)](#architecture-97100)
- [Part 3 — The integration roadmap (if we add ALL of them)](#part-3--the-integration-roadmap-if-we-add-all-of-them)
- [Part 4 — Cross-cutting prerequisites](#part-4--cross-cutting-prerequisites)

---

## Part 0 — Current verified state

Before planning the future, here is the honest present. Everything in this list is in the
v10.4 build at the repo root and was confirmed by *executing it in a headless browser*, not
by grep or `node -c`.

| Feature | Status | Evidence |
|---|---|---|
| **Round trip green 5/5** (#1) | ✅ | `.test/roundtrip.mjs` decodes real output frames (not bytes); 5/5 green |
| **Playwright test that can't lie** (#100) | ✅ | Self-contained headless test, in-repo, `npm test` |
| **Golden multi-workflow matrix** (#6, #7) | ✅ | `.test/workflows.mjs` — downscale-480p/360p, fps-24, + both audio branches; 4/4 |
| **Frames not bytes** (#2) | ✅ | `assertRealVideo()` + tests assert decoded frame counts |
| **Exit-code checks** (#3) | ✅ | split-render/fallback/pipeline all read `ff.exec()` rc |
| **Command history** (#9) | ✅ | `state.commandHistory` (last 50) + copy button |
| **Sentry-style error capture** (#10) | ✅ | `window.onerror` / `unhandledrejection` attach last 50 logs |
| **Version stamp** (#11) | ✅ | `build-info.js` single source of truth → `#ff-version` |
| **Changelog from code** (#12) | ✅ | `scripts/generate-changelog.js` reads the code |
| **Lazy-load wasm core** (#22) | ✅ | boot defers the 30 MB core so the UI paints first |
| **requestVideoFrameCallback** (#17) | ✅ | trip-cam engine uses rVFC for video sources |
| **Demo clip button** (#91) | ✅ | `generateDemoClip()` — canvas + MediaRecorder |
| **Time-stretch, keep pitch** (#34) | ✅ | `atempo` phase-vocoder chain at bounce |
| **Spectrogram view** (#25) | ✅ | Audio Studio spectrogram tab |
| **False-colour exposure** (#52) | ✅ | Preview colourist exposure view |
| **Before/after wipe** (#92) | ✅ | draggable divider in Preview |
| **Speed curve editor** (#42) | ✅ | 4-keyframe editor with presets |
| **Adaptive quality** (Trippy Effects) | ✅ | `performance.js` restored, `#perf-hud` visible, trip-cam sheds resolution via `FFPerf.scale` |
| **Layer compositor UI** (#1.4 / #9) | ✅ | `compositor-ui.js` drives `FFPerf.Compositor`; `.test/compositor.mjs` reads composited pixels back — screen blend → yellow, solo/mute, opacity, crossfade all assert on decoded frames (6/6) |
| **TRUE datamosh + motion mosh reachable** (#1.1) | ✅ | The v4/v5 "new engine" workflows were counted but never merged into the catalog, never dispatched (`wf.run()`), and `addBlobToBin` was undefined so output vanished. All three fixed; `.test/workflows-v4v5.mjs` drives the real card click and decodes the bin output — bloom's frames > source (P-frames duplicated), motion mosh is a decodable video |
| **Compress-to-target + scene split** | ✅ | Same missing `addBlobToBin` dropped these too. Compress also used a two-pass `/dev/null` encode ffmpeg.wasm can't do (empty file) and bailed on a missing `<video>` duration — now single-pass, audio-guarded, ffmpeg-probe fallback. Fixed a batch-producer bug where `addOutputToBin` revoked live bin-entry blob URLs. `.test/bin-features.mjs` decodes both out of the bin (5/5) |
| **Audio Studio bounce** (revived module) | ✅ | `loadFromBin` (reads `window.state.mediaBin`) decodes into the Web Audio engine; bounce renders offline → WAV, and MP3 through the ffmpeg encode + two-pass loudnorm branch. `.test/audio-studio.mjs` decodes each bounce back to PCM samples (3/3) |
| **Clip Studio sequence export** (revived module) | ✅ | `exportSequence` concatenates the library (re-encode) and hands the result to `addBlobToBin`. `.test/clips.mjs` adds two clips, exports, and decodes the output — frame count = sum of the clips (3/3) |
| **iPad + mobile layout & touch** | ✅ | Fixed the iPad-portrait header overflowing the page 99px (the stacking rule stopped at 768px, missing 810–834px iPads) and the preview mode buttons overflowing on phones. `.test/mobile.mjs` (touch-emulated phone/iPad, 5/5) asserts no horizontal overflow on any tab and that taps switch/reach tabs. Also hardened MediaRecorder MIME selection to fall back to mp4 on Safari/iOS (no webm encoder) — *the iOS branch itself needs real hardware to verify; the Chrome path is unchanged (v4v5 7/7)* |
| **Clip Studio tab restored** | ✅ | The clip library UI was orphaned (module loaded, no nav button / `#tab-clips` container — like the VJ tab before it). Wired the tab + a Video-mode nav entry, and added touch-accessible ◀▶ reorder buttons since native HTML5 drag never fires on iOS. `.test/clips.mjs` opens the tab, renders cards, reorders by tap, and decodes the exported sequence (5/5) |
| **Media-bin touch reorder** | ✅ | The bin's drag-to-reorder was native HTML5 drag (dead on touch), yet bin order IS the composite order (concat/hstack/vstack/grid read the bin sequence). Added ◀▶ move buttons to each bin card. `.test/bin-features.mjs` taps one and asserts the order swapped (6/6) |

**The three bugs that were actually blocking #1** (all fixed): the `instrumentFfmpeg`
ms→s timeout that became a 30 ms abort; the split-render audio pass failing on video-only
inputs; and the `filename`/`outputFilename` field mismatch crashing the success path.

---

## Part 1 — The crown jewels (the six source apps)

These are the substantial features mined from the source apps. Some are already in v10.4;
several are present as engines but not fully wired into the UI.

### 1.1 Datamosh Lab — motion & mosh

**Hierarchical SAD block-matching motion estimation.**
- *What it is:* a real motion estimator — it splits each frame into blocks and searches the
  previous frame for the best match (sum-of-absolute-differences), coarse-to-fine. It is what
  a video codec does internally.
- *The vision:* datamosh that behaves like the real technique — smearing along genuine motion
  vectors, not a shader approximation.
- *Status:* ✅ in `motion-mosh.js` / `datamosh.js`, and now actually **reachable**: the TRUE
  bitstream datamosh (v4) and real-time motion-vector datamosh (v5) workflows were dead —
  missing from `getAllBuiltInWorkflows()`, never dispatched through `wf.run()`, and dropping
  their output because `addBlobToBin` was never defined. Also fixed a `renderFile` hang (it
  relied on `requestVideoFrameCallback` to detect end-of-video; now it also honours the video's
  `ended`/`pause` events + a stall watchdog). Verified by `.test/workflows-v4v5.mjs`.
- *To finish the family (see Glitch & Mosh 57–68):* directional bias, motion masking,
  vector-amplification curve, bloom (repeat vectors), **datamosh between two clips**, persistent
  vector recording, motion-vector overlay on by default. — *M–L each.*

### 1.2 Trippy Cam 2.0 — reactive camera

- **3-band audio reactivity** (bass/mid/treble with per-band gates). *Vision:* a kick and a
  hi-hat move *different* parameters. ✅ present.
- **`u_cameraRotation` on every shader** — device tilt / rotation as a performable parameter.
  ✅ retrofitted onto all 11 shaders.
- **Per-effect defaults** — each effect starts from its own good patch. ✅.
- **`u_displacementMapStrength`**. ✅.
- *Deliberately skipped:* face tracking (a stub returning hardcoded coordinates — no model).

### 1.3 Trippy Effects — the load-shedding stack

- **Adaptive quality** — monitors FPS and sheds load automatically (resolution first, then
  expensive shaders). ✅ restored (`performance.js`) and given teeth: trip-cam now renders at
  `FFPerf.scale`. **To do:** also gate expensive shaders via `FFPerf.Perf.isAllowed()` and wire
  the WebGL editor preview to the same scale. — *S–M.*
- **Global intensity master** — one knob toward neutral over everything. 🟡 `FFPerf.Master`
  exists; the vj-mode slider that drives it was dropped from v10.4's reduced `vj-mode.js`.
  **To do:** restore `#vj-master` slider + wiring. — *S.*
- **Auto-glitch / chaos engine** — 8 glitch types firing on a random schedule. ✅ present.
- **Real CPU pixel sort** (sorts runs, visibly different from the shader approximation). ✅.
- **Sparkle particles with gravity**, emitted on the treble. ✅.

### 1.4 SauceLab VJ — the performance deck

- **MIDI learn, keyboard (hold=stab, shift=latch), 16-step sequencer, tap tempo, beat-sync.**
  ✅ present in `vj-mode.js`.
- **Hot cues** — stored jump points, click to jump / shift-click to set. 🟡 the engine logic
  exists; v10.4's reduced `vj-mode.js` dropped the `.vj-cues` wiring + markup.
  **To do:** restore the cue buttons + handlers. — *S.*
- **Layer compositor** — 4 layers, 16 blend modes, opacity, solo, mute, crossfade. ✅
  `compositor-ui.js` is the deck over `FFPerf.Compositor`: four layer strips (load / Media-Bin /
  demo source), a 16-mode blend dropdown, opacity, solo/mute, per-layer hot cues, a crossfader
  and a master. Lives in the VJ tab below the pads. It composites *decoded frames* on a 2D
  canvas (`globalCompositeOperation`), which is why `.test/compositor.mjs` can verify the blend
  math headless (screen(red,green)→yellow, solo/mute/opacity/crossfade — 6/6, pixels not bytes).
  **Still to do (extensions):** per-layer effect chains (#73), N-layer beyond 4 (#72), crossfade
  curve options (#74). — *those are M–L each.*
- **Energy-variance beat detection.** ✅ (`beat-detection.js`).

### 1.5 Aesthetic Audio — musical intelligence

- **Key detection** (chromagram + Krumhansl-Schmuckler) and **BPM + beat positions.** ✅
  (`audio-intel.js`, `beat-detection.js`).
- **Semantic macros** (MELT / MUFFLE / WASH / SLUSH / VINTAGE). ✅.
- **Musical intervals instead of semitones.** ✅.

### 1.6 Clip Studio — the library & queue

- **Clip library, take numbers, drag-to-reorder, audio bed, sequence export.** ✅ (`clips.js`).
- **Video queue** — batch a list of clips through the shader pipeline. ✅.
- **Countdown-timer recording, debug panel.** ✅.

### 1.7 Driftwave — the audio rack

- **Real-time Web Audio rack** (23 params, 12 presets). ✅ (`audio-engine.js`, `audio-studio.js`).
- **20 ffmpeg mastering templates.** ✅ (workflows).

### 1.8 Deliberately left out (and why)

| Thing | Why it was skipped |
|---|---|
| Face tracking (Trippy Cam) | A stub — hardcoded coordinates, no model. |
| Neural effects (Trippy Effects, 784 lines) | No TensorFlow anywhere; the name is aspirational. |
| Trippy chatbot (410 lines) | A rhyming assistant — charming, not a media tool. |
| Video cube (THREE.js) | A presentation effect, 600 KB for one look. |
| Scroll-reactive effects | Meaningless in an editor. |
| Trippy Cam's smaller shader variants | The Clip Studio versions already ported are more developed. |

---

## Part 2 — The 100 Ways, catalogued

Each entry: **what it is → what it was meant to be → status → what's left → effort/risk.**

### Correctness & Trust (1–12)

| # | Feature | What it is / the vision | Status | What's left |
|---|---|---|---|---|
| 1 | Round trip 5/5 | The one fact that gates everything: a file goes in, a real video comes out, five times. | ✅ | — |
| 2 | Assert on frames, never bytes | A 1-frame file is ~20 KB and passes every byte check. Decode and count frames. | ✅ | — |
| 3 | Check `exec()` exit code everywhere | `ff.exec()` *resolves* on failure; ignoring rc is how a failed pass looked "done". | ✅ | Keep grepping new call sites in review. |
| 4 | Every `await ff.*` has a timeout | A pending promise makes no sound. | ✅ | `ffRun`'s queue timeout guards all calls. |
| 5 | Zero-setting workflow hard-blocks | A workflow that applies nothing must refuse, loudly. | ✅ | Audit any new silent no-op paths. |
| 6 | Verify the signature filter ran | If `downscale-480p` produced no scale, fail. | ✅ | `.test/workflows.mjs` asserts signatures; consider an in-app pre-run assert too. |
| 7 | Golden-file tests | Hash/measure output of known workflows; drift = regression. | 🟡 | Matrix measures frames/res; add stable perceptual hashes for a fixed clip. — *M* |
| 8 | In-UI self-test panel | A button that runs encoder smoke tests and reports **frames**. | ⬜ | Surface `assertRealVideo` + selftests in a panel. — *S* |
| 9 | Copyable command history | You can't debug what you can't see. | ✅ | — |
| 10 | Sentry-style error capture | Attach the last 50 log lines to every thrown error. | ✅ | — |
| 11 | Version-stamp the build | "Which version is deployed?" should never be a question. | ✅ | — |
| 12 | Changelog from code | Counts generated, not claimed. | ✅ | — |

### Performance (13–24)

| # | Feature | What it is / the vision | Status | What's left |
|---|---|---|---|---|
| 13 | Ship the WebCodecs path | Direct GPU/ASIC encode — 10–50× over wasm. | 🔒 | Path is written + routed; **can't verify here** (headless Chromium has no H.264 enc/dec). Make it codec-adaptive (VP9/AV1 fallback), verify the encode half on real Chrome. — *M* |
| 14 | OffscreenCanvas + Worker for shaders | Get WebGL off the main thread. | ⬜ | Move `TripEngine` render into a worker with an OffscreenCanvas. — *L, Risk: M* |
| 15 | Motion estimation in a Worker | Block matching is embarrassingly parallel; it currently blocks the UI. | ⬜ | Worker harness + transferable frames. — *L* |
| 16 | WASM SIMD for the SAD loop | The inner loop is pure integer math — the biggest mosher win. | 🔒 | Needs an emcc/wat2wasm build pipeline + benchmarking. — *L* |
| 17 | `requestVideoFrameCallback` everywhere | Process each video frame exactly once. | ✅ | Extend rVFC to the WebGL editor preview too. — *S* |
| 18 | Half-res motion est., full-res apply | Vectors don't need pixel precision. | ⬜ | Estimate at ½ scale, upscale vectors. — *M* |
| 19 | Cache compiled shader programs | We recompile 11 shaders per canvas. | ⬜ | Program cache keyed by source, shared across engine instances. — *S–M* |
| 20 | Texture pooling | `_initTextures()` reallocates + GCs. | ⬜ | Pool + reuse GL textures. — *M* |
| 21 | Parallel segment encoding | Split at keyframes, encode N segments in a worker pool, concat. | ⬜ | Worker pool + concat demux. — *XL* |
| 22 | Lazy-load the wasm core | 30 MB shouldn't download if you only came for the Audio Studio. | ✅ | — |
| 23 | Preload core on Editor hover | Warm the core before it's needed. | ⬜ | Prefetch on hover/intent. — *S* |
| 24 | A real memory budget | MEMFS + GPU + VideoFrames + AudioBuffers compete; show one number. | 🟡 | MEMFS gauge exists; unify GPU/audio into one budget readout. — *M* |

### Audio (25–40)

| # | Feature | What it is / the vision | Status | What's left |
|---|---|---|---|---|
| 25 | Spectrogram view | Spot a problem frequency a waveform hides. | ✅ | — |
| 26 | Stem separation | Naive mid/side or band-split → usable acapella/instrumental. | ✅ | `FFAudioDSP.stemSeparate` — INSTRUMENTAL cancels the centre (out = L−R, the exact OOPS karaoke trick); ACAPELLA runs a real STFT centre-extractor (radix-2 FFT, Hann overlap-add) that keeps centre-panned bins and attenuates side-panned ones per frequency. A "Stem" selector in the bounce panel applies it to the rendered buffer. `.test/stems.mjs` verifies on a centre-vocal + panned-instrument mix: instrumental drops the vocal 0.249→0.016 while keeping the instrument, and acapella lifts the vocal/instrument ratio 1.79→7.23. |
| 27 | Sidechain compression to the kick | The most-requested production effect. | ✅ | `FFAudioDSP.sidechainDuck` — a 2-pole low-pass isolates the sub band, and each threshold crossing (a kick) ducks the whole mix to (1-amount), recovering over the release. The rhythmic pump, detected from the mix itself (no separate key track). Applied at bounce, before transient/limiter. "Sidechain" rack module (Duck depth). `.test/sidechain.mjs` verifies on a pad+kick mix that the level dips after each kick and recovers before the next; amount=0 is untouched. |
| 28 | Multiband compression (3-band + GR meters) | Standard mastering. | ✅ | `FFAudioDSP.multibandCompress` splits low/mid/high with COMPLEMENTARY (subtractive) crossovers — high = signal − low — so the bands sum back to unity with no crossover ripple, compresses each stereo-linked, and returns per-band peak gain reduction. Applied at bounce; a "Multiband" rack module (Amount) drives all three, and three GR meter bars paint the last bounce's reduction. `.test/multiband.mjs` verifies unity reconstruction (Δ=0), the low band compressing down with a real GR read, and the high band left alone. |
| 29 | Limiter with lookahead | Not just `alimiter`. | ✅ | `FFAudioDSP.limiter` — a true lookahead brickwall: an O(n) sliding-window min of the demanded gain over the lookahead window pulls the gain down BEFORE each peak arrives, so transients are caught, not overshot; gain is shared across channels (stereo image intact) and released smoothly. Applied at bounce on the rendered PCM. "Master Limiter" rack module (Ceiling in dBFS, 0 = off). `.test/limiter.mjs` verifies no sample exceeds the ceiling, the first transient is capped, an under-ceiling signal is untouched, and an end-to-end bounce caps at the set dB. |
| 30 | Mid/side EQ | Widen highs, mono the bass. | ✅ | `FFAudioDSP.midSideEQ` encodes M/S, EQs the SIDE with RBJ biquads (`highpass`, `highShelf`) — high-pass the side to mono the bass, high-shelf-boost it to widen the highs — then decodes. Applied at bounce. "M/S EQ" rack module (Mono Bass Hz + Widen dB). `.test/ms-eq.mjs` verifies on a signal with low+high side content that mono-the-bass collapses the low side (0.197→0.019) while keeping the high side, and widen-the-highs lifts it (0.224→0.563). |
| 31 | Stereo width + correlation meter | See when you've gone out of phase. | ✅ | Mid/side width matrix inserted after the final gain in the live graph (four gains → a 2-in merger), applied live AND at bounce; a Width knob in a new "Stereo" rack module. Split analysers feed a live correlation meter (`AudioEngine.getCorrelation` → `FFAudioDSP.correlation`). `audio-dsp.js` holds the pure maths. `.test/stereo-width.mjs` verifies correlation on synthetic PCM and renders a stereo buffer through the real graph — width=0 → mono (corr +1), width=2 wider than width=1. |
| 32 | Automatic gain staging | Warn when the rack clips into the reverb. | ⬜ | Inter-node level checks + warnings. — *S–M* |
| 33 | A/B vs a reference track, loudness-matched | Honest comparison. | ⬜ | Reference load + LUFS-match + toggle. — *M* |
| 34 | Time-stretch, keep pitch (phase vocoder) | `speed` shouldn't shift pitch. | ✅ | — |
| 35 | Pitch correction / snap to detected key | You already detect the key. | ✅ | `FFAudioDSP.detectPitch` finds the fundamental by autocorrelation (with an octave-bias fix that takes the shortest strong lag, not a subharmonic); `nearestNote` names it; `snapToScale` finds the nearest note IN a chosen root+scale and returns the semitone correction, which a "🎯 Snap to key" button feeds to the engine's pitch control. `.test/pitch-snap.mjs` verifies a 440 Hz sine is detected at 441 Hz (no octave error), 466 Hz → A#4, an off-key pitch snaps into C-major (→ D4), and an in-scale note needs ~0 correction. |
| 36 | Beat-grid quantised chopping | Slice on beats, rearrange, repeat. | ✅ | `FFBeatSync.chopOnBeats` slices a clip into contiguous per-beat segments; `rearrangeSlices` lays any order of source-slice indices onto a fresh output timeline — a reversed order shuffles, a repeated index stutters, and the output duration is the sum of the taken slices (out-of-range indices are skipped). `.test/beat-chop.mjs` verifies the slicing, a reverse shuffle, a 4× stutter of one slice, and index safety. |
| 37 | Granular / stutter on the beat grid | Beat-driven stutter. | ✅ | `FFAudioDSP.granularRearrange(samples, sr, steps)` realises a beat-grid rearrangement (from `FFBeatSync.rearrangeSlices`) as audio — it concatenates the chosen grains with a short equal-power crossfade at each seam so the stutter doesn't click. `.test/granular.mjs` verifies on a source with a different tone per slice (200/400/800 Hz) that a `[0,0,0]` stutter fills the output with 200 Hz, a `[2,1,0]` shuffle plays 800/400/200, and the length equals the taken slices. |
| 38 | Convolution reverb from a user IR | Not just the generated one. | ✅ | `AudioEngine.loadIR(audioBuffer)` stores a user impulse response and `_irBuffer` rebuilds it per context (linear-resampled) so it feeds the existing ConvolverNode live AND at bounce; `clearIR` reverts to the generated IR. An "＋ Load IR" file picker in the Reverb module decodes and loads it. `.test/conv-reverb.mjs` bounces a click through a hand-built 2-tap IR and confirms the echo lands at the tap position — and only with the IR loaded (the dry render is silent there). |
| 39 | Transient shaper (attack/sustain) | Shape the punch. | ✅ | `FFAudioDSP.transientShaper` — an instant-attack envelope hugs the onset peak, a lagged one trails it; their difference marks the leading edge (Attack scales it, aligned to the peak) and the tail where the lagged env sits above the signal (Sustain scales it). Applied at bounce, before the limiter. "Transient" rack module (Attack / Sustain). `.test/transient.mjs` verifies on a synthetic drum hit that attack=+1 raises the crest factor, attack=-1 lowers it, and sustain=+1 lifts the tail RMS. |
| 40 | Export stems (dry/reverb/delay) | Separate files. | ✅ | `AudioEngine.bounceStems` renders the mix three ways (dry, +reverb, +delay) with the master processors bypassed and subtracts the dry render to isolate each wet return — the buses sum linearly and the dry path is deterministic, so no graph surgery is needed. An "⎇ Export stems" button drops three WAVs in the Media Bin. `.test/stems-export.mjs` bounces a click through reverb+delay and confirms the dry stem carries the click, the reverb stem isolates the reverb with the dry click removed (0.119→0.003), and the delay stem echoes at the delay time. |

### Video (41–56)

| # | Feature | What it is / the vision | Status | What's left |
|---|---|---|---|---|
| 41 | Optical-flow frame interpolation | Real slow-mo, not frame duplication. | ✅ | `MotionMosher.interpolate(a,b,vec,…,t)` warps A forward along the flow by t and B backward by (1−t) and cross-dissolves, so a moving object lands at its in-between position; `renderInterpolate` inserts factor−1 such frames for smooth slow-mo → Media Bin. Workflow "🐢 Slow-Mo (optical flow)". `.test/interpolate.mjs` verifies a block that moves 20 px lands at the midpoint (x=31.5) at t=0.5, a quarter/three-quarters along at t=0.25/0.75, and that t=0/1 return A/B exactly. |
| 42 | Speed ramping with a draggable curve | Not one multiplier. | ✅ | — |
| 43 | Motion blur on speed-up | 4× timelapse shouldn't strobe. | ✅ | `FFShaderPlus.frameBlend` averages the frames a fast decimation would drop into one (a long-exposure blend); `renderSpeedBlur` plays the source at factor× and blends each group of skipped frames → Media Bin. Workflow "💨 Timelapse 4× (motion blur)". `.test/speed-blur.mjs` verifies on a stepping dot that the blend lights a mid-path point that was black in frame 0, lowers the peak, and widens the lit span into a trail; a still is untouched. |
| 44 | Stabilisation that works | You have motion vectors — average global motion, counter it. | ✅ | `FFMosh.globalMotion` takes the MEDIAN of a frame's motion field (outlier-robust — a moving object doesn't sway it) as the camera translation; `FFMosh.stabilizePath` integrates the per-frame motions into the camera path, smooths it (centred moving average), and returns per-frame correction offsets. `renderStabilize` applies a causal real-time smoother and counter-shifts each frame → Media Bin. Workflow "🎯 Stabilise". `.test/stabilize.mjs` verifies the median rejects wild outliers, and a jittery pan's acceleration drops 2.02→0.06 after correction while the pan travel survives. |
| 45 | Auto-reframe (track subject) | Crop toward motion for vertical. | ✅ | `FFMosh.motionCentroid` returns the magnitude-weighted centre of mass of the motion field (the subject) or [null,null] when still; `renderReframe` follows it (causal-smoothed) with a 9:16 crop window so a horizontal clip becomes a vertical one that keeps the moving subject in frame. Workflow "📱 Auto-Reframe → Vertical". `.test/reframe.mjs` verifies the centroid tracks motion to each corner (top-right (136,16), bottom-left (32,88)), is magnitude-weighted, and returns null on a still field. |
| 46 | Rolling-shutter / jello (sim + correct) | Both directions. | ✅ | `FFShaderPlus.rollingShutter` models the CMOS row-time skew as a per-row horizontal shift — a linear shear (the lean) plus an optional sinusoid (the wobble). `renderRollingShutter` applies it (or its inverse, to correct) per frame → Media Bin. Workflows "🍮 Rolling Shutter (jello)" / "📐 De-jello (correct skew)". `.test/rolling-shutter.mjs` verifies shear slants a vertical line (top x=56 vs bottom x=100), the opposite shear round-trips it back to straight (78/78), wobble bends it (4 direction reversals), and the no-op is a byte-identity. |
| 47 | Real film grain (plate-based) | Not procedural noise. | ✅ | `FFShaderPlus.FilmGrain` builds a grain PLATE once (white noise blurred into silver-halide clumps, zero-mean normalised) and overlays it luma-weighted (shows in the mids, fades in blacks/highlights), shifting it each frame like a physical negative. `renderFilmGrain` applies it offline → Media Bin. Workflow "🎞️ Film Grain". `.test/film-grain.mjs` verifies it adds texture, preserves the mean, scales with intensity, and is CLUMPY — lag-1 autocorrelation 0.94 vs a white-noise reference's ~0, which is what makes it a plate and not hiss. |
| 48 | Halation & bloom (physical pass) | Proper light bleed. | ✅ | `FFShaderPlus.halation` — bright-pass (soft knee above threshold) → separable box blur → reddish tint → screen back over the original. Real light bleed, not procedural noise. `renderHalation` applies it per-frame → Media Bin. Workflow "🌟 Halation & Bloom". `.test/halation.mjs` verifies a bright spot blooms into black surroundings with a reddish tint, and dim/black frames barely change. |
| 49 | Lens distortion + CA profiles | Named-lens profiles. | ✅ | `FFShaderPlus.lensDistort` — a radial remap (k1/k2 barrel-pincushion) plus per-channel radius sampling for real, edge-weighted chromatic aberration. `LENS_PROFILES` names five looks (vintage-wide, anamorphic, cctv, tele-pincushion); `renderLens` applies one per frame → Media Bin. Workflows "🔎 Lens — …". `.test/lens.mjs` verifies barrel bows a straight line (top x=3 vs mid x=22), CA fringes the edges (|R−B|=255) but not the centre (0), and k1=0/ca=0 is a byte-identity. |
| 50 | Deflicker for timelapse | Even out exposure flicker. | ✅ | `FFShaderPlus.Deflicker` tracks a smoothed running mean of frame brightness and scales each frame's gain onto it — the fast exposure jitter cancels, the slow trend stays. `renderDeflicker` applies it per frame → Media Bin. Workflow "💡 Deflicker (timelapse)". `.test/deflicker.mjs` verifies a 128±40 flicker's frame-brightness variance collapses 796→3, a slow 80→180 ramp is preserved (Δ75), and a steady sequence is unchanged. |
| 51 | Vectorscope + waveform monitor | Real colour scopes. | ✅ | `scopes.js` — `vectorscope` plots per-pixel chroma (Cb,Cr) as a scatter (neutral greys centre, saturated hues push to the rim); `waveform` plots per-column luma up the Y axis. Both pure ImageData→ImageData. Live "Scopes" preview mode (`startScopesLoop`) paints them off the source video. `.test/scopes.mjs` verifies grey→centre, red/blue apart, and the luma trace rising on a gradient. |
| 52 | False-colour exposure view | See over/under exposure. | ✅ | — |
| 53 | Curves editor with a draggable spline | Not preset names. | 🟡 | Speed-curve editor exists; reuse the spline widget for colour curves. — *M* |
| 54 | HSL secondary qualifiers | Grade just skin / just sky. | ✅ | `FFShaderPlus.hslQualify` keys a hue/saturation/luma range (soft-edged) into a mask and applies a hue-shift / sat / luma grade only where it matches — a real colour-selective secondary. `renderHslQualify` runs it per frame → Media Bin. Workflows "🌤️ Punch the Sky" / "🧑 Warm the Skin". `.test/hsl-qualify.mjs` verifies that qualifying red and hue-shifting turns a red half green (30,220,30) while the blue half is untouched, qualifying blue darkens only it, and a hue with no content selects nothing (Δ=0). |
| 55 | Power windows / masks | Grade part of the frame. | ✅ | `FFShaderPlus.powerWindow` builds an ellipse/rectangle mask with a feathered edge and applies a brightness/contrast/saturation grade blended by the mask (invertible). `renderPowerWindow` runs it per frame → Media Bin. Workflows "🔦 Spotlight" / "🌑 Darken Surround". `.test/power-window.mjs` verifies inside brightens (120→222), outside is untouched (120), the feathered edge is partial (168), and invert flips the region. |
| 56 | Frame-blend vs optical-flow toggle | Choose retime method. | ⬜ | Toggle on the speed panel. — *S* |

### Glitch & Mosh (57–68)

| # | Feature | What it is / the vision | Status | What's left |
|---|---|---|---|---|
| 57 | Motion-vector overlay on by default | Dial in a mosh while seeing the field. | ✅ | `MotionMosher.drawVectors(ctx,opts)` draws the estimated field as arrows onto any 2-D context; `renderVectorOverlay` composites them over a dimmed frame with the overlay ON by default. Workflow "🧭 Motion Vectors — Overlay". `.test/vector-overlay.mjs` verifies nothing draws before a field, the estimated field inks, and arrows point the way the block moved. |
| 58 | Directional mosh | Bias vectors along one axis (horizontal smear = the classic). | ✅ | `directionX/Y` axis bias in `_estimate`; presets "Horizontal Smear" / "Vertical Drip". `.test/mosh-family.mjs` asserts `directionY=0` zeroes every Y. |
| 59 | Mosh masking | Only mosh where motion exceeds a threshold. | ✅ | `_maskLowMotion` shows the clean frame in low-motion blocks; preset "Masked Mosh". Unit-tested. |
| 60 | Vector amplification curve | Non-linear response — ignore small, explode large. | ✅ | `amplify` power curve on vector magnitude; preset "Amplified Chaos". Test asserts the field magnitude shifts. |
| 61 | Bloom mode (repeat vectors N×) | Smear further. | ✅ | `bloomIterations` re-applies the displacement N×; preset "Bloom Push". Test asserts 4× displaces further than 1×. |
| 62 | **Datamosh between TWO clips** | Take A's vectors, apply to B — the *actual* classic technique. | ✅ | `MotionMosher.moshAcross` estimates on the motion clip and applies to the picture clip; `FFMosh.renderTwoClips` records it. UI: select 2 bin clips → "🌀 Datamosh A→B". Core verified deterministically + end-to-end (`.test/mosh-family.mjs`, `.test/datamosh2.mjs`). |
| 63 | Persistent vector recording | Capture a motion field once, replay over anything. | ✅ | `recordVectors` captures a clip's fields; `serializeVectors`/`deserializeVectors` round-trip them (Int16, saved to localStorage); `replayVectors` applies them to any clip. UI: 🔴 Record Motion / ▶ Apply Motion. Verified deterministically + end-to-end (record 27 fields → replay onto another clip). |
| 64 | Pixel sort with a mask | Sort within a luma/hue range, angled. | ✅ | `sortBands` sorts only contiguous runs whose luma/hue is inside a `[lo,hi]` band (out-of-band pixels untouched); `pixelSortMasked` runs it along any angle (rotate → sort → rotate back); `renderPixelSort` applies it per-frame → Media Bin. Workflows "🌈 Pixel Sort — Masked" / "📐 Pixel Sort — Diagonal". `.test/pixelsort.mjs` verifies mask selectivity, run ordering, and angle deterministically. |
| 65 | True DCT manipulation | Corrupt DCT blocks at coefficient level. | 🔒 | Needs coefficient-level decode (custom codec work). — *XL* |
| 66 | Databend mode | Corrupt raw bytes of any file and try to decode. | ✅ | `databendBytes` pokes the AVI frame-data region (header-safe, deterministic); `databend()` remuxes with error concealment. Workflow "🧨 Databend". `.test/databend.mjs` decodes the wreckage to real frames. |
| 67 | Feedback with geometric transforms | Zoom+rotate per iteration — the infinite tunnel. | ✅ | `FeedbackTunnel` keeps a persistent buffer, re-draws it zoomed+rotated over an opaque black bg and faded by `decay` each frame, then composites the new frame — detail spirals outward forever. `renderFeedback` runs it offline → Media Bin. Workflows "🌀 Feedback Tunnel" / "🌪️ Feedback Vortex". `.test/feedback.mjs` verifies zoom-spread, decay, and rotation deterministically on the buffer. |
| 68 | Optical-flow-driven displacement | Use the motion field as a displacement map. | ✅ | `MotionMosher.displaceByFlow` samples the same picture through the block-grid flow field, bilinearly interpolated per pixel — a smooth liquid warp where the scene moves, not a datamosh tear. `renderFlowDisplace` estimates each frame's flow and warps that frame → Media Bin. Workflows "💧 Flow Warp — Liquid / 🔥 Heat Haze / 🌊 Riptide". `.test/flow-displace.mjs` verifies the shift-by-dx·scale, scale linearity, zero-field identity, and spatially-varying warp deterministically. |

### Live & Performance (69–80)

| # | Feature | What it is / the vision | Status | What's left |
|---|---|---|---|---|
| 69 | MIDI clock sync (slave) | Play with anyone. | ⬜ | Sync sequencer to incoming MIDI clock. — *M* |
| 70 | Ableton Link | Networked tempo. | 🔒 | No browser Link without a bridge. — *L* |
| 71 | MIDI output | Send clock/notes so lights follow. | ⬜ | MIDI-out from the sequencer. — *S–M* |
| 72 | More than 4 layers + mixer strip | Real mixer. | ✅ | The `Compositor` engine already takes any layer count; `FFComp.setLayerCount(n)` (＋/− in the deck head) rebuilds the mixer for 2–8 layers, regenerating the strips, crossfader options and wiring. `.test/n-layers.mjs` grows the deck to 6 in the real app, loads a clip into layer 5 (beyond the old max), and screen-blends it over a red base → yellow centre pixel (frames, not bytes); the count clamps to [2,8]. |
| 73 | Per-layer effect chains | Each layer its own shader stack. | ⬜ | Effect chain per layer. — *L* |
| 74 | Crossfader with curve selection | Linear / constant-power / sharp. | ✅ | `FFPerf.CROSSFADE_CURVES` — linear (gainA+gainB=1), constant-power (gainA²+gainB²=1, no mid-level dip), and sharp (an S-curve that lingers at the ends and snaps through the middle). `Compositor.crossfade(a,b,x,curve)` drives the two layers' opacity by the chosen law; a curve dropdown sits by the crossfader in the deck. `.test/crossfade-curves.mjs` verifies each law's defining property and that the compositor's layer opacities follow (const-power → 0.707/0.707 at the midpoint). |
| 75 | Pattern banks (8, switch on the bar) | Recall sequencer patterns. | ⬜ | Save/recall + bar-quantised switch. — *M* |
| 76 | Automation recording | Record knob moves, play back. | ⬜ | Param automation lanes. — *L* |
| 77 | Panic key (instant reset) | Non-negotiable on stage. | ✅ | PANIC button + `0` key drop every latched/held trigger, the sequencer, chaos, strobe and mosh and reset the patch. Also revived the whole VJ keyboard — `bindKeys()` was defined but never called, so hold=stab / shift=latch was dead. `.test/panic.mjs` 3/3. |
| 78 | Beat-synced clip launching | Clips start on the next bar. | ✅ | `FFBeatSync.nextGridTime(elapsed, bpm, unit)` returns the next beat/bar/2-bar grid time and the delay to it; the VJ deck records the transport start and its `launch(id)` defers a pad to that grid (lighting it "queued" while it waits) when the "⚡ Launch" quantise is set. `.test/launch-quantize.mjs` verifies at 120 BPM a launch 300 ms in fires at 500 ms (beat) or 2000 ms (bar), on-grid fires immediately, and the tempo scales the grid. |
| 79 | NDI / virtual-camera output | Feed OBS/Zoom. | 🔒 | No browser NDI/virtual-cam without a native bridge. — *XL* |
| 80 | Second-screen / projector output | Full-screen visuals on an external display. | ⬜ | Present the canvas to a second window/screen. — *M* |

### Intelligence (81–88)

| # | Feature | What it is / the vision | Status | What's left |
|---|---|---|---|---|
| 81 | Whisper.wasm | Auto-subtitles, transcript, filler-word cutting. | ⬜ | Bundle whisper.wasm; transcript → subtitle/cut UI. — *XL* |
| 82 | Auto-detect interesting moments | Energy + scene cuts + motion → highlight reel. | ✅ | `FFHighlights` — `scoreWindows` normalises the per-window audio energy + motion and adds a scene-cut bonus into one score; `pickHighlights` returns the top moments kept `minGap` seconds apart (so a burst contributes one pick) in chronological order. Consumes the signals the app already produces (energy, mosher motion, scene cuts). `.test/highlights.mjs` verifies the reel picks the two peaks (t=5, t=14), spaces them ≥3 s, returns them in time order, and that a scene-cut window outscores an identical non-cut one. |
| 83 | Auto-sync an edit to the beat grid | You have both halves already. | ✅ | `FFBeatSync` — `snapToBeats` nudges cuts to the nearest detected beat, `beatSegments` puts a boundary every N beats, and `assembleOnBeats` lays clips into beat-length segments so every cut lands on the downbeat (a clip shorter than its segment is used whole, a longer one trimmed to fit). Pairs with the existing beat detection. `.test/beatsync.mjs` verifies all three over a 120 BPM grid — snap → nearest beat, segment every 4 beats (0,2,4,6,8), clips laid at [0,2,4] with takes [1.2,2,2]. |
| 84 | Shot-type classification | Wide/medium/close by subject size. | 🔒 | Needs a model (face/subject detector). — *L* |
| 85 | Auto colour-match across clips | You have the LUT generator; run it clip-to-clip. | 🟡 | Wire the LUT generator into a batch clip-to-clip pass. — *M* |
| 86 | Auto loop-point detection | Find the two most similar frames for seamless GIFs. | ✅ | `FFAudioDSP.detectLoop` takes the normalised autocorrelation of the (decimated) signal over candidate loop lengths and returns the strongest peak — length, end sample, and a confidence. A "🔁 Find loop point" button in the Audio Studio reports it for the loaded clip. `.test/loop-detect.mjs` verifies a 0.5 s motif tiled 4× is detected at 0.5 s (conf 1.00), a 0.3 s motif at 0.3 s (not hard-coded), and unrepeating noise scores low (0.18). |
| 87 | Content-aware fill | Remove objects (WebGPU compute). | 🔒 | WebGPU inpainting — research-grade. — *XL* |
| 88 | Suggest a workflow from content | "Talking head → Silence Trim + Loudnorm." | ✅ | `FFSuggest.suggest(meta)` ranks the workflows that fit a clip from the probe metadata (has audio? duration? aspect? resolution?) — a talking head gets Loudnorm + Trim Silence + Auto-Reframe, a vertical no-audio short gets Add Music + social export + Loop, a 4K clip gets Downscale. Wired into the source-loaded path (logs the top three). `.test/suggest.mjs` verifies the rankings and that audio-only steps don't appear for silent clips. |

### UX (89–96)

| # | Feature | What it is / the vision | Status | What's left |
|---|---|---|---|---|
| 89 | Undo/redo across the WHOLE app | Not just the editor. | 🟡 | Form controls are captured app-wide already; **custom state** (audio-studio knobs, trip-cam params, node graph) needs a per-module `capture()/restore()` hook registered with the undo stack. — *L* |
| 90 | Real onboarding tour | Four dismissible, `localStorage`-gated steps. | ⬜ | Tour component. — *S–M* |
| 91 | Demo clip button | Evaluate with zero friction. | ✅ | — |
| 92 | Before/after wipe on every effect | Not just the preview tab. | ✅ (preview) | Extend the wipe to inline effect previews. — *M* |
| 93 | Workflow thumbnails | Show what "Bleach Bypass" does. | ⬜ | Pre-rendered thumbnails per workflow. — *M* |
| 94 | Hover-preview a workflow on the canvas | Preview before committing. | ⬜ | Live preview on hover. — *M* |
| 95 | Preferences panel | Default codec/quality/autosave/theme. | ⬜ | Settings store + panel. — *S–M* |
| 96 | Keyboard shortcuts for everything + cheat sheet | Discoverable. | ✅ | `?` toggles the sheet; `[`/`]` cycle tabs; `Alt+1‑8` jump to any tab (was 1‑4); the cheat sheet is grouped (Global / Navigation / VJ) and the VJ keys are auto-generated from `FFVJ.TRIGGERS` so they can't drift. `.test/shortcuts.mjs` drives the keyboard and reads UI state back (6/6). |

### Architecture (97–100)

| # | Feature | What it is / the vision | Status | What's left |
|---|---|---|---|---|
| 97 | Split `app.js` | ~6.5k lines → five files. | ⬜ | Extract engine / commands / UI / state / workflows. — *L, Risk: M* |
| 98 | Single source of truth for state | `state`, `S`, `G`, `REC`, `macroValues` don't know about each other. | ⬜ | One store; migrate modules onto it. — *XL, Risk: H* |
| 99 | A real event bus | Replace `CustomEvent` on `window` + `window.FFX?.y()`. | ⬜ | Typed event bus. — *L* |
| 100 | Automated browser tests in CI | The one test that can't lie, on every commit. | ✅ | Test + matrix exist; **add the CI workflow file** to run them on push. — *S* |

---

## Part 3 — The integration roadmap (if we add ALL of them)

Doing everything is a program, not a task. Ordered so each phase de-risks the next.

### Phase A — Lock the foundation (mostly done)
1. ✅ Round trip 5/5, frames-not-bytes, exit codes, error capture, version stamp, changelog.
2. ✅ Playwright test + golden matrix.
3. ⬜ **#100 CI file** — add `.github/workflows/test.yml` running `npm test` + `npm run test:workflows` on push. *(This is the single highest-leverage remaining item: it makes every phase below cheaper by catching regressions automatically.)*
4. ⬜ **#8 self-test panel** — expose the smoke tests in-app.

### Phase B — Finish what's already half-built (fast wins)
5. 🟡 Wire the **global-intensity slider** + **hot cues** back into `vj-mode.js` (dropped in v10.4's reduced copy). — *S each.*
6. 🟡 Gate expensive shaders via `FFPerf.Perf.isAllowed()` and apply `FFPerf.scale` to the **WebGL editor preview** too. — *S–M.*
7. ✅ **Motion-vector overlay** — `drawVectors` + `renderVectorOverlay`, on by default (#57).
8. ✅ **Keyboard-shortcut coverage + cheat sheet** (#96) — `?` toggle, `[`/`]` tab cycle, `Alt+1‑8`
   jumps, grouped auto-generated cheat sheet; verified by `.test/shortcuts.mjs`.

### Phase C — The layer compositor & live deck (the big VJ surface)
9. ✅ **Compositor UI** built + verified (`compositor-ui.js`, `.test/compositor.mjs`): layer strips,
   16 blend modes, opacity, solo/mute, per-layer hot cues, crossfader, master. ⬜ Remaining:
   crossfader curve options (#74), per-layer effect chains (#73), N-layer support (#72).
10. ⬜ **Automation recording** (#76), **pattern banks** (#75), **beat-synced launching** (#78),
    **panic key** (#77), **MIDI clock in/out** (#69/#71), **second-screen output** (#80).

### Phase D — The mosh/glitch family (build on the SAD estimator)
11. ⬜ Directional mosh, masking, amplification curve, bloom (#58–61) — small, share the vector field.
12. ⬜ **Datamosh between two clips** (#62) + persistent vector recording (#63) — the headline.
13. ✅ masked pixel sort (#64), databend (#66), feedback transforms (#67), flow displacement (#68).

### Phase E — Audio depth
14. ⬜ Sidechain (#27), multiband comp (#28), limiter (#29), mid/side EQ (#30), width+correlation (#31),
    gain-staging warnings (#32), A/B reference (#33), transient shaper (#39), stems (#40).
15. ⬜ Beat-grid chopping (#36), granular (#37), pitch-snap to key (#35), user IR reverb (#38),
    stem separation (#26).

### Phase F — Video/colour depth
16. ⬜ Colour tools: vectorscope/waveform (#51), curves spline (#53), HSL qualifiers (#54),
    power windows (#55), auto colour-match (#85).
17. ⬜ Motion tools: optical-flow interp (#41), stabilisation from vectors (#44), auto-reframe (#45),
    motion blur (#43), deflicker (#50), film grain (#47), halation/bloom (#48), lens profiles (#49).

### Phase G — Intelligence
18. ⬜ Highlight detection (#82), auto beat-sync edit (#83), loop-point detection (#86),
    workflow suggestion (#88). Then the model-dependent ones (Whisper #81, shot classification #84,
    content-aware fill #87) as they become feasible.

### Phase H — Performance & architecture (do continuously, verify each step)
19. ⬜ Shader program cache (#19), texture pooling (#20), half-res estimation (#18),
    OffscreenCanvas worker (#14), motion estimation in a worker (#15), WASM SIMD (#16),
    parallel segment encoding (#21), unified memory budget (#24), preload-on-hover (#23).
20. ⬜ Refactors, gated behind the CI from Phase A: split `app.js` (#97), single state store (#98),
    event bus (#99). **Do these last** — highest blast radius; they only pay off once tests guard them.

### Environment-blocked (need real hardware or a native bridge, not solvable in-repo)
- **#13 WebCodecs** end-to-end (no H.264 in the test browser; works on real Chrome).
- **#16 WASM SIMD** (needs emcc/wat2wasm toolchain + benchmarking).
- **#65 DCT manipulation, #70 Ableton Link, #79 NDI/virtual-cam, #84/#87 model-based.**

---

## Part 4 — Cross-cutting prerequisites

Some things everything else leans on. Build these once, reuse everywhere.

1. **CI (#100 file).** Nothing below is safe without it. One `.github/workflows/test.yml`.
2. **A single state store (#98).** Undo/redo across the app (#89), automation recording (#76),
   pattern banks (#75), and preferences (#95) *all* need one authoritative, serializable state.
   Every one of those is cheaper after #98 and painful before it.
3. **A worker + OffscreenCanvas harness (#14).** Motion-in-worker (#15), parallel encode (#21),
   and keeping the compositor smooth all reuse it.
4. **The vector-field as a first-class object (#63).** Directional/masked/amplified mosh (#58–60),
   two-clip mosh (#62), stabilisation (#44), and flow displacement (#68) all consume it.
5. **A spline widget.** The speed-curve editor (#42, done) already has one — reuse it for colour
   curves (#53), automation lanes (#76), and vector-amplification curves (#60).

> **The single most important next step is Phase A #3 — the CI file.** Every expensive bug in
> this project existed because something reported success without verifying it. The round trip is
> green and the tests exist; wiring them to run on every commit is what stops the next regression
> from hiding.
