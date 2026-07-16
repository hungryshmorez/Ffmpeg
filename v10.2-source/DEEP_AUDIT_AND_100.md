# DEEP AUDIT — ALL SIX APPS, FRONT TO BACK
### Everything I missed, everything now taken, and 100 ways forward

---

# PART 1: THE FULL AUDIT

I read **every file** this time. Here's what was actually in each, what I took, and — honestly — what I'd skipped.

## Total surface reviewed

| App | Lines | Files I read on pass 1 | Files I read on pass 3 |
|---|---|---|---|
| SauceLab VJ | **8,198** | 3 | **13** |
| Trippy Effects | **7,495** | 2 (badly) | **9** |
| Driftwave Vaporizer | 4,559 | 4 | **16** |
| Trippy Cam 2.0 | **3,560** | 1 (top-level only) | **20** — *I never opened `shaders/` or `js/features/`* |
| Clip Studio | 2,648 | grep only | **full** |
| Datamosh Lab | 2,040 | 1 | **3** |

**I missed ~15,000 lines on the first pass.** That's the honest number.

---

## ✅ WHAT I NOW TOOK (v10.1 + v10.2)

### From **Datamosh Lab** — the crown jewel
- **Hierarchical SAD block-matching motion estimation.** Does what the codec does. Retired both of my previous datamosh implementations.
- Scene-cut auto-mosh · I-frame interval · JPEG artifact pass · motion vector overlay

### From **Trippy Cam 2.0** *(the directory I never opened)*
- **3-band audio reactivity** (bass/mid/treble, per-band gates) — my version averaged the whole spectrum into ONE number, so a kick and a hi-hat moved the same slider identically
- **`u_cameraRotation` on every shader** — device tilt, upside-down feeds, rotation as a performable parameter. Retrofitted onto all 11 shaders I'd ported without it.
- **Per-effect defaults** — Feedback wants a different starting patch than Kaleidoscope
- `u_displacementMapStrength`

### From **Trippy Effects**
- **AUTO-GLITCH / chaos engine** — 8 glitch types, each with a probability, firing on a random schedule with a heavy-glitch chance. The app misbehaves on its own.
- **ADAPTIVE QUALITY** — monitors FPS and *sheds load automatically*: resolution first, then expensive shaders. We're running 11 shaders + a motion mosher + particles + a WebGL preview. **This is not optional.**
- **Global intensity master** — one knob over everything
- Real CPU pixel sort (actually sorts runs — visibly different from the shader approximation)
- Sparkle particles with gravity, emitted on the treble

### From **SauceLab VJ**
- MIDI learn · keyboard (hold=stab, shift=latch) · 16-step sequencer · tap tempo · beat-sync
- **HOT CUES** — stored jump points. Click to jump, shift-click to set. *This is what makes a source playable.*
- **Layer compositor** — 4 layers, **16 blend modes**, opacity, solo, mute, crossfade
- Energy-variance beat detection

### From **Aesthetic Audio**
- Key detection (chromagram + Krumhansl-Schmuckler) · BPM + beat positions
- **Semantic macros** (MELT / MUFFLE / WASH / SLUSH / VINTAGE)
- Musical intervals instead of semitones

### From **Clip Studio**
- Clip library · take numbers · drag-to-reorder · audio bed · sequence export
- **Video queue** — batch a list of clips through the shader pipeline
- Countdown-timer recording · debug panel

### From **Driftwave**
- The whole real-time Web Audio rack (23 params, 12 presets)
- 20 ffmpeg mastering templates

---

## ❌ WHAT I DELIBERATELY LEFT (and why)

| Thing | Why |
|---|---|
| **Face tracking** (Trippy Cam 2.0) | **It's a stub.** The class contains `// Placeholder for face tracking initialization` and returns hardcoded coordinates. No model. |
| **Neural effects** (Trippy Effects, 784 lines) | Zero TensorFlow references. The name is aspirational. |
| **Trippy chatbot** (410 lines) | A rhyming psychedelic assistant. Charming; not a media tool. |
| **Video cube** (THREE.js) | A *presentation* effect, not a manipulation. 600 KB dependency for one look. |
| **Scroll-reactive effects** | Makes sense for a marketing page. Meaningless in an editor. |
| Trippy Cam 2.0's datamosh/pixelsort/feedback/colorshift/crt shaders | **Smaller** than the Clip Studio versions I already ported. Those really are the more developed ones. |

---

# PART 2: 100 WAYS TO MAKE THIS BETTER

## 🔴 CORRECTNESS & TRUST (1–12)

1. **Run the round trip 5 times and get 5/5.** It has *still* never been seen green end-to-end. Everything below is speculative until it is.
2. **Assert on frames, never bytes.** A 1-frame 720p file is ~20 KB and passes every byte check. This cost four cycles.
3. **Check `exec()`'s exit code everywhere.** It *resolves* on failure. This cost another cycle. Grep for any remaining unchecked call.
4. **Every `await ff.*` must have a timeout.** A pending promise makes no sound.
5. **A workflow that applies zero settings must hard-block** — it already does; audit that no other silent no-op paths exist.
6. **Verify the generated command contains the workflow's signature filter** before running. If `downscale-480p` produces no `-vf scale=`, fail loudly.
7. **Golden-file tests** — hash the output of 10 known workflows on a fixed clip. Any drift is a regression.
8. **A "self-test" panel** in the UI that runs the encoder smoke tests on demand and reports frames, not bytes.
9. **Log the actual command for every run** to a copyable history. You cannot debug what you cannot see.
10. **Sentry-style error capture** — collect the last 50 log lines with every thrown error.
11. **Version-stamp the build** in the UI. "Which version is deployed?" should never be a question.
12. **Kill the changelog's unverified claims.** I've now written three counts (24/26/27 nodes) and been wrong twice. Generate them from the code.

## ⚡ PERFORMANCE (13–24)

13. **Ship the WebCodecs path.** It's written and routed but has never actually run a real file. 10–50×.
14. **OffscreenCanvas + Worker for the shader pipeline** — get WebGL off the main thread entirely.
15. **Move motion estimation into a Web Worker.** Block matching is embarrassingly parallel and currently blocks the UI.
16. **WASM SIMD for the SAD loop.** The inner loop is pure integer arithmetic — the single biggest win available in the mosher.
17. **`requestVideoFrameCallback` everywhere** instead of `requestAnimationFrame` for video sources. You process each frame exactly once.
18. **Half-resolution motion estimation, full-resolution application.** Vectors don't need pixel precision.
19. **Cache the compiled shader programs** across engine instances. We recompile 11 shaders per canvas.
20. **Texture pooling.** Every `_initTextures()` allocates new GPU memory and drops the old on the GC.
21. **Parallel segment encoding across a worker pool.** Split at keyframes, encode N segments simultaneously, concat.
22. **Lazy-load the wasm core** — 30 MB downloaded on first paint even if you only came to use the Audio Studio.
23. **Preload the core on hover** over the Editor tab, so it's warm before it's needed.
24. **A real memory budget.** MEMFS + GPU textures + VideoFrames + AudioBuffers all compete. Show one number.

## 🎛️ AUDIO (25–40)

25. **Spectrogram view** — you can't spot a problem frequency on a waveform.
26. **Stem separation** — even naive mid/side or band-split gives you a usable acapella/instrumental.
27. **Sidechain compression** keyed to the kick. The single most-requested production effect.
28. **Multiband compression** — 3-band, with visual gain reduction meters.
29. **A real limiter with lookahead**, not just `alimiter`.
30. **Mid/side EQ** — widen the highs, mono the bass. Standard mastering move.
31. **Stereo width control** with a correlation meter (so you can see when you've gone out of phase).
32. **Automatic gain staging** — warn when the rack is clipping *into* the reverb.
33. **A/B against a reference track**, loudness-matched, so the comparison is honest.
34. **Time-stretch without pitch change** (phase vocoder). Currently `speed` always shifts pitch.
35. **Pitch correction / snap to the detected key.** You already detect the key.
36. **Beat-grid quantised chopping** — slice on the detected beats, rearrange, repeat.
37. **Granular / stutter effect** driven by the beat grid.
38. **Convolution reverb from a user-supplied IR file**, not just the generated one.
39. **A proper transient shaper** (attack/sustain).
40. **Export stems** — dry, reverb, delay as separate files.

## 🎬 VIDEO (41–56)

41. **Optical flow frame interpolation** — real slow-mo instead of frame duplication.
42. **Speed ramping with a draggable curve**, not one multiplier.
43. **Motion blur on speed-up**, so 4× timelapse doesn't strobe.
44. **Stabilisation that actually works** — you have motion vectors now. Use them: average the global motion and counter it.
45. **Auto-reframe** — track the dominant motion and crop toward it for vertical conversion.
46. **Rolling shutter / jello simulation** (and correction).
47. **Real film grain** — plate-based, not procedural noise.
48. **Halation and bloom** as a proper physical pass.
49. **Lens distortion + chromatic aberration profiles** for named lenses.
50. **Deflicker** for timelapse.
51. **A proper vectorscope and waveform monitor** for colour work.
52. **False-colour exposure view.**
53. **Curves editor with a draggable spline**, not preset names.
54. **HSL secondary qualifiers** — grade just the skin tones, just the sky.
55. **Power windows / masks** — grade only part of the frame.
56. **Frame blending vs. optical flow toggle** for retimes.

## 🌀 GLITCH & MOSH (57–68)

57. **Show the motion vector field as an overlay by default** while dialling in a mosh. It's already written — surface it.
58. **Directional mosh** — bias the vectors along one axis. Horizontal-only smearing is the classic look.
59. **Mosh masking** — only mosh where motion exceeds a threshold, so static areas stay sharp.
60. **Vector amplification curve** — non-linear response, so small motion is ignored and large motion explodes.
61. **Bloom mode** in the motion mosher (repeat vectors N times, not just apply once).
62. **Datamosh between TWO clips** — take the vectors from clip A and apply them to clip B. This is the *actual* classic technique and we can't do it yet.
63. **Persistent vector recording** — capture a motion field once, replay it over anything.
64. **Pixel sort with a mask** — sort only within a luma/hue range, angled.
65. **True DCT manipulation** — decode to coefficient level and corrupt the DCT blocks directly.
66. **Databend mode** — corrupt the raw bytes of any file and try to decode it.
67. **Feedback with geometric transforms** (zoom+rotate per iteration) — the infinite tunnel.
68. **Optical-flow-driven displacement** using the motion field as a displacement map.

## 🎹 LIVE & PERFORMANCE (69–80)

69. **MIDI clock sync** — slave the sequencer to an external clock. Essential for playing with anyone.
70. **Ableton Link** support.
71. **MIDI output** — send clock/notes *out*, so lights can follow the visuals.
72. **More than 4 layers**, with per-layer effects and a real mixer strip.
73. **Layer effect chains** — each layer gets its own shader stack, not just the master.
74. **A crossfader with curve selection** (linear / constant-power / sharp).
75. **Pattern banks** — save/recall 8 sequencer patterns, switch on the bar.
76. **Automation recording** — record knob moves in real time and play them back.
77. **A "panic" key** that instantly resets everything. Non-negotiable on stage.
78. **Beat-synced clip launching** — clips start on the next bar, not instantly.
79. **NDI or virtual-camera output**, so the visuals feed OBS/Zoom directly.
80. **Second-screen / projector output** — full-screen the visuals on an external display while keeping controls on the laptop.

## 🧠 INTELLIGENCE (81–88)

81. **Whisper.wasm** — auto-subtitles, searchable transcript, and auto-cut of filler words.
82. **Auto-detect the interesting moments** — audio energy + scene changes + motion → a suggested highlight reel.
83. **Auto-sync a video edit to a track's beat grid.** You have both halves already.
84. **Shot-type classification** (wide/medium/close) via face/subject size, to auto-assemble.
85. **Colour-match across clips automatically** — you have the LUT generator; run it clip-to-clip.
86. **Auto-loop-point detection** for seamless GIFs — find the two most similar frames.
87. **Content-aware fill** for removing objects (WebGPU compute).
88. **Suggest a workflow from the content**: "this looks like a talking head — try Silence Trim + Loudnorm."

## 🎨 UX (89–96)

89. **Undo/redo across the WHOLE app**, not just the editor.
90. **A real onboarding tour** — four steps, dismissible, `localStorage`-gated.
91. **A demo clip button.** Someone should be able to evaluate this with zero friction.
92. **Before/after wipe on every effect**, not just the preview tab.
93. **Workflow thumbnails** — show what "Bleach Bypass" actually does.
94. **Hover-preview a workflow on the live canvas** before committing.
95. **A proper preferences panel** — default codec, default quality, autosave interval, theme.
96. **Keyboard shortcuts for everything**, with a discoverable cheat sheet.

## 🏗️ ARCHITECTURE (97–100)

97. **Split `app.js`.** It's ~6,500 lines. It should be five files.
98. **A single source of truth for state.** `state`, `S`, `G`, `REC`, `macroValues` are five separate stores that don't know about each other.
99. **A real event bus** instead of `CustomEvent` on `window` plus direct `window.FFX?.y()` calls.
100. **Automated browser tests in CI.** Playwright, on every commit, running the round trip. **The reason this project has bled cycles is that nothing ever ran the thing.** Fix that and every other item on this list gets cheaper.

---

## THE THREE THAT MATTER MOST

If you do nothing else:

**#1 — Get the round trip green, five times running.** It is still the only unverified fact in the entire project.

**#13 — Ship the WebCodecs path.** It's written, it's routed, and it has never processed a real file. It's a 10–50× speedup sitting idle.

**#100 — Put Playwright in CI.** Every single expensive bug in this project's history existed because a check reported success without verifying the thing it claimed. `node -c` passed while the app was dead. Grep counts passed while the round trip had never run. `bytes > 0` passed on an empty container. `bytes >= 1000` passed on a one-frame file. **Automate the one test that can't lie.**
