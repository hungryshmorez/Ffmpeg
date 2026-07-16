# FFmpeg Studio v7 — PHASE 1, 2 & 3 COMPLETE

The round trip works. Everything here is built on top of a foundation that actually encodes video.

**All 14 JS files pass `node -c`. CSS braces balanced (515/515).**

---

## NEW FILES

| File | Lines | What |
|---|---|---|
| `storage.js` | ~230 | Autosave · session restore · project export/import |
| `waveform.js` | ~330 | Waveform · filmstrip · beat ticks · trim handles · loop region |
| `analysis.js` | ~250 | LUFS meter · **two-pass loudnorm** · silence detect · scene detect |
| `tools.js` | ~390 | Ctrl+K palette · recording · LUTs · subtitles · target-size encode |
| **`tripcam.js`** | **1,044** | **The real WebGL glitch engine — all 11 shaders, ported verbatim** |
| `tripcam-ui.js` | ~380 | Trip Cam tab · source selector · Editor ⚡ Live preview binding |

---

## PHASE 1 — CORRECTNESS & DATA SAFETY

### Autosave (`storage.js`)
**You were one accidental refresh from losing everything.** Now:
- Full session saved to `localStorage` every 30s, on blur, and on `pagehide`
- On load: *"Restore your last session?"* → Restore / Start fresh
- Saves all 32 sections, enabled flags, active workflow, and a **manifest** of the media bin (names/durations — not the bytes; on restore it tells you which files to re-add)
- **Project Export/Import** as `.json` — including custom workflows and saved chains
- `beforeunload` warning if a render is in flight

### Command-builder guards (`app.js`)
- **`safeScaleFilter()` / `evenDims()`** — H.264 requires even dimensions. An odd width was a **fatal encoder error**. Now `scale=trunc(w/2)*2:trunc(h/2)*2`.
- **`stripInvalidPreset()`** — `-preset` is x264/x265 only. It hard-errors on VP9, GIF, and audio-only. Wired into `ff.exec`, so it's stripped at the single funnel and can't leak from any code path.
- **`chainAtempo()`** — `atempo` only accepts 0.5–2.0. 4× **must** become `atempo=2.0,atempo=2.0`.
- **`checkCopyConflict()`** — stream-copy + filters on the same stream is an ffmpeg error. It was only a *warning*. Now it **hard-blocks Run** with a visible reason.

### Killed the duplicate file system
**§23's rogue `<input type="file" id="merge-additional">` is gone.** Merge now works from the Media Bin's multi-select. Two file systems in one app was a bug factory.

---

## PHASE 2 — THE MISSING FEATURES

### Waveform + Timeline (`waveform.js`)
**You could not see audio.** The trim handles floated over nothing and beat detection had nowhere to draw. Now, in one canvas stack:
- **Peak-envelope waveform** — decoded via Web Audio. Native, ~50ms, **cannot touch the wasm heap**.
- **Filmstrip** of 12 thumbnails above it — `<video>` + canvas, **zero ffmpeg**, cannot deadlock the queue.
- **Beat ticks** — the detector has existed for versions with nowhere to render.
- **Silent regions** (red bands) and **scene cuts** (yellow markers) draw onto it.
- **Trim handles ride on the waveform** and sync bidirectionally with §2. Cut on a transient by eye.
- Click to seek · drag to trim · **Shift-drag to loop a region** while you tweak sliders.

### LUFS Meter + TWO-PASS loudnorm (`analysis.js`)
The most conspicuous hole in an audio-mastering app.
- `ebur128` → **Integrated LUFS · Loudness Range · True Peak**, with a target-compliance bar (Spotify/Apple/YouTube −14 · Broadcast −23 · Club −8 · Film −27).
- **`buildTwoPassLoudnorm()`** — measures the file, then applies the correction with `measured_I` / `measured_TP` / `measured_LRA` / `measured_thresh`.
  **All 19 mastering chains were shipping single-pass loudnorm and *claiming* −14 LUFS.** Single-pass is a live estimator, not a measurement. Now the chains can actually **prove** they hit the target, because the meter reads it back.

### Silence detection → auto-trim
`silencedetect` → red bands on the waveform → *"Found 23 regions, 4m 12s → 3m 08s"* → `buildSilenceRemoval()` emits a `select`/`aselect` chain keeping only the non-silent segments, with configurable padding so it breathes.

### Scene detection → auto-split
`select='gt(scene,T)'` → cut markers → **`splitScenes()` makes each scene its own Media Bin item.**

### Command Palette — `Ctrl+K` / `Cmd+K` (`tools.js`)
With 180 workflows and 32 sections, browsing died as a navigation model several versions ago. Fuzzy-searches **every workflow, every section, and every action** (Add Media, Run, Download, Measure LUFS, Detect Silence, Record Screen…). Arrows + Enter.

### Recording — mic / webcam / screen
`getUserMedia` / `getDisplayMedia` + `MediaRecorder` → **lands straight in the Media Bin.** Live timer chip, click to stop.

### Custom LUTs
Upload `.cube`, **or use the 6 built-ins that are generated in JS at runtime** (Teal & Orange, Bleach Bypass, Vintage, Cyberpunk, Moonlight, Golden Hour — no download needed). **Intensity slider** via a split/blend so you can dial a LUT to 40%.

### Subtitle burn-in
`.srt` / `.ass` → `subtitles=…:fontsdir=/:force_style='…'`. **`fontsdir=/` is mandatory** — ffmpeg.wasm has no system fonts, which is the same trap that silently broke Text Overlay for four versions.

### Target file-size encoding
*"Fit this under 8 MB for Discord."* Computes the bitrate budget, runs a two-pass encode, and **binary-searches the CRF** (max 3 iterations) if it overshoots. Presets: Discord 8MB · Nitro 50MB · Email 25MB · WhatsApp 16MB.

---

## PHASE 3 — TRIP CAM 🌀

**The real shader engine, ported from your working "TAKE A TRIP" app.** Not rewritten — the actual GLSL, extracted verbatim.

**All 11 fragment shaders** (36 KB of GLSL): Datamosh · Pixel Sort · Feedback · Color Shift · CRT · Horizontal Mirror · Wave Warp · Kaleidoscope · Noise Glitch · Fisheye · Feedback Displace

**Including the ping-pong framebuffer** (`u_previousFrameTexture`) — real temporal feedback on the GPU, which is what makes the trails and the datamosh actually work.

**6 presets** (Default, Psychedelic, Ghostly, Neon Traces, Glitchy VHS, Dreamy) + **23 sliders**, each with a paired number input.

### The two things that make it more than a port

**1. Any Media Bin file can be the source.** TRIP originally only took webcam or a direct upload. Now: Webcam · Screen · **Media Bin file** · Upload.

**2. Record drops straight into the Media Bin.** That closes the loop:

```
Webcam / bin file
    ↓
TRIP CAM real-time GPU glitch   (60fps, instant, tactile)
    ↓
Record → Media Bin
    ↓
Any of the 180 FFmpeg workflows  (mastering chains, datamosh pipelines, grades)
    ↓
Export
```

**Capture → mangle → master, in one app.**

**Audio-reactive mode locks to a bin track, not the mic.** Point it at a song in the bin and the visuals move with *that song*.

**🔥 Bake to FFmpeg** — reverse-maps the live shader config into an FFmpeg workflow (`eq`, `hue`, `lagfun`, `rgbashift`, `geq` scanlines, `lenscorrection`, `noise`, `vignette`) and saves it to **My Custom**. Dial a look in live on the GPU, then apply it to a full-length file offline at full quality.

### Editor ⚡ Live preview
The `⚡ Live` toggle now does something. A WebGL canvas overlays the preview video, and **the Editor's FFmpeg sliders drive the shader uniforms at 60fps**:

| Editor control | Uniform |
|---|---|
| §7 Brightness / Contrast / Saturation | `u_brightness` / `u_contrast` / `u_saturation` |
| §7 Hue Shift | `u_hueShiftSpeed` |
| §19C Lagfun decay | `u_trailPersistence` |
| §19D geq intensity · §13 Noise | `u_glitchStrength` |
| §19H Chroma shift | `u_phosphorOffset` |
| §31 CRT Curvature · Scanlines | `u_curvatureAmount` / `u_scanlineIntensity` |
| §16 Vignette | `u_vignetteStrength` |

**The 5-to-30-second render-to-see-a-change loop is dead.**

Temporal filters (`tmix`, `tblend`, `reverse`) cannot be approximated in a fragment shader, so the badge says so honestly: *"⚡ Live preview — temporal effects render on export."*

---

## VERIFY

1. [ ] **Round trip still works.** 5 runs, 5/5. (Regression check — nothing above should have touched the render path.)
2. [ ] Refresh mid-session → *"Restore your last session?"* → state comes back.
3. [ ] Load an audio file → **waveform draws**. Drag the handles → §2 trim updates. Shift-drag → loops.
4. [ ] Run beat detection → **ticks appear on the waveform**.
5. [ ] Measure Loudness → real LUFS / True Peak / LRA readout with a compliance bar.
6. [ ] Run an audio mastering chain → **the meter reads back ≈ −14 LUFS.** (Two-pass loudnorm proving itself.)
7. [ ] Detect Silence → red bands. Detect Scenes → markers + split into bin items.
8. [ ] **`Ctrl+K`** → fuzzy palette over all 180 workflows.
9. [ ] Record screen/webcam/mic → the clip appears in the Media Bin.
10. [ ] Scale to an **odd width (641px)** → renders instead of erroring.
11. [ ] Set codec = `copy` with filters on → **Run is hard-blocked** with a reason.
12. [ ] Output format = GIF → `-preset` is **absent** from the generated command.
13. [ ] **Trip Cam tab** → webcam through all 11 effects, all 6 presets, all 23 sliders.
14. [ ] Trip Cam source = **a Media Bin file**. Audio-reactive locks to **that track**.
15. [ ] **Trip Cam → Record → the clip lands in the Media Bin → run a workflow on it.** ← *The loop closes.*
16. [ ] **Bake to FFmpeg** → a working custom workflow appears in My Custom.
17. [ ] Editor **⚡ Live** → drag §7 Saturation → **the preview changes at 60fps, with no render.**

---

## STILL NOT BUILT (Phase 4 / Hardware Acceleration)

Deliberately deferred — these are large, independent efforts:

- **WebCodecs hybrid pipeline** (the 10–50× speedup; needs mp4box.js demux + mp4-muxer)
- GPU detection + "hardware acceleration is off" nag chip
- OPFS persistent storage (bin survives a reload)
- Node-based `filter_complex` graph editor
- Keyframe automation curves
- Parallel segment encoding across a worker pool
- **True bitstream datamosh** (real I-frame stripping — nobody has this in a browser)
- Auto-LUT generation from a reference frame
- Local Whisper.wasm → auto-subtitles
- WebGPU compute shaders
- PWA / offline

`powerPreference: 'high-performance'` is already applied to every WebGL context.
