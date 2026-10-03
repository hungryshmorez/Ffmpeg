# Reuse register: what we pull from open source instead of writing

Rule: **search first, adopt if the license (MIT/BSD/Apache) and quality allow, build only what is missing.** Reference clones were reviewed under `~/ref` (not committed).

## Adopted
| Need | Source | How it is used |
|---|---|---|
| Beat/onset detection | the browser app's `beat-detection.js` (our own) | ported to `beats.rs`, with a bug fix |
| Loudness (LUFS, LRA, true peak) | [`ebur128`](https://github.com/sdroege/ebur128) crate, MIT | `loudness.rs` + Inspector "Measure loudness / Normalize" |
| Scene detection | [`scenesdetect`](https://crates.io/crates/scenesdetect) crate (PySceneDetect port) | `scenes.rs` + Inspector "Detect scenes / Split at scene cuts" |
| 57 transitions | FFmpeg's own `xfade`/`acrossfade` | list read from the installed FFmpeg at runtime |

## Reviewed, planned (license OK)
| Need | Source | Plan |
|---|---|---|
| Expression evaluator | [`fasteval`](https://github.com/likebike/fasteval) (MIT) | Phase 6 modulators/expressions |
| MIDI | [`midir`](https://github.com/Boddlnagg/midir) (MIT) | Phase 6 |
| Node graph UI | [`@xyflow/react`](https://github.com/xyflow/xyflow) (MIT) | **Adopted** for the Phase 3 filter-graph editor (MIT, v12); still planned for Phases 4/6 (blueprints, compositor) |
| Plugin sandbox | [Extism](https://extism.org) (BSD-3) | Phase 10 |
| Pixel sorting | [`patsore/pixel-sorter`](https://github.com/patsore/pixel-sorter) (MIT) | Phase 7 reference algorithm (decode → sort → encode helper job) |
| Optical flow | [`iris-cv`](https://github.com/muhammad-fiaz/iris-cv) (MIT, v0.0.0 — immature) | Phase 9 candidate; evaluate against OpenCV bindings |
| Custom shader transitions | [`gl-transitions`](https://github.com/gl-transitions/gl-transitions) (MIT, 125 GLSL files) | Phase 7+: needs a GPU compositor; not usable through plain FFmpeg |
| Real-time native preview (decode pool, wgpu compositor, cpal audio) | [Clypra](https://github.com/AIEraDev/clypra) (MIT) | architecture reference for replacing webview playback if proxies prove insufficient |
| Datamosh / codec bitstream editing | [FFglitch](https://ffglitch.org) 0.10.2 (GPL-2+, separate FFmpeg fork; `ffedit` + `ffgac` + QuickJS scripts) | **Trialled (see STATUS.md "FFglitch trial")**: works for MPEG-4 Part 2 / MPEG-2 / MJPEG in AVI/M2V. Drive as an external tool on disposable AVI intermediates; I-frame removal needs only stock FFmpeg. `scripts/ffglitch/trial.sh` reproduces the findings |
| Audio sync | SyncSink / audio-offset-finder (cross-correlation) | Phase 5: simple enough to implement directly |
| OpenShot / Audacity (reference) | [libopenshot](https://github.com/openshot/libopenshot) LGPL-3, [Audacity](https://github.com/audacity/audacity) GPLv3 | Idea sources only (effects, Nyquist/LV2 plugin model); no code copied. Future plugin phase may run them as external tools |
| GL transitions | gl-transitions (MIT) via [xfade-easing](https://github.com/scriptituk/xfade-easing) (MIT) pre-generated yuv420p expressions | **Adopted** (48 of ~125 shaders). No GL filter in stock FFmpeg, so only shaders expressible as per-pixel `xfade` expressions are offered; xfade-easing marks 14 more as needing its custom FFmpeg build, 2 (kaleidoscope, powerkaleido) never finish in stock FFmpeg and are dropped. Hand-porting more is possible but not done |

## Review of the "FFmpeg Projects" list (trac.ffmpeg.org/wiki/Projects) and Kdenlive's manual

Read through the screenshots the user sent (≈250 programs). Most are players, converters, libraries, wrappers or dead; below is what can feed FFWORKS. Licences marked * are from memory and were not re-checked this session — confirm before copying anything. FFWORKS only ever *drives* GPL tools as separate programs/plugins and never copies GPL code.

| Project | What it offers | Use for FFWORKS | Status |
|---|---|---|---|
| [**fasteval**](https://crates.io/crates/fasteval) (MIT) | Fast expression parser/evaluator for Rust (variables via a callback, no unsafe eval of code) | `expr.rs`: formulas over clip time and another parameter, baked to keyframes | **Adopted** |
| [**Rhai**](https://rhai.rs) (MIT/Apache-2.0) | Embedded scripting language for Rust, sandboxed by default (no files/network unless the host adds them) | `script.rs`: user scripts with variables/loops/conditions; the host exposes only project reads and command-bus writes, plus operation/time/size limits | **Adopted** |
| **frei0r** (incl. **glitch0r**, GPL-2+*; official Win64 .dll releases at github.com/dyne/frei0r/releases) | ~136 small video plugins; FFmpeg's `frei0r` filter loads them by name | Glitch/colour/distort effects. Parameter tables read with `scripts/frei0r/dump.py`; 73 filters (numbers/switches only) offered as "Frei0r" effects when the plugin file is installed and the FFmpeg build has the `frei0r` filter | **Done** (user-installed plugins only; none shipped) |
| **Kdenlive** manual / **MLT** (LGPL*) / **Shotcut** (GPL-3+*) / **Flowblade** (GPL-3*) | MLT = effects + transitions framework; Kdenlive builds effect GUIs automatically from filter metadata or an XML description; Shotcut uses frei0r for video and LADSPA for audio plugins | Same idea already used: filter browser + registry-generated UI. LADSPA audio plugins now driven through FFmpeg's `ladspa` filter (control tables read with `scripts/ladspa/dump.py`); LV2 still needs a build with `lv2` | LADSPA adopted |
| Pixel sorting (technique popularised by Kim Asendorf's "ASDF Pixel Sort") | Sort runs of pixels by brightness within a threshold range | Reimplemented from the idea only (`pixelsort.rs`, counting sort per span); no code copied. FFmpeg has no filter for it, and frei0r's `pixels0rt` exists only on the Windows bundle | **Done** |
| MLT luma wipes / compositing transitions | Image-driven wipes | Could be done with FFmpeg `maskedmerge` + a grayscale ramp; not started | Idea logged |
| **LosslessCut** (GPL-2*), **VidCutter** | Cut without re-encoding (`-c copy`) | "Quick export / smart cut" — already on the Phase 2 list | Todo |
| **VeeJay** / **LiVES** (GPL*) | Live VJ effect chains | Inspiration for demo mode; their plugin sets are frei0r/own formats | Reference |
| **Natron** (GPL-2*) / **Blender** / **Cinelerra** / **Olive** (GPL-3*) | Node compositing (OpenFX), VSE, timeline UX | OpenFX plugins cannot be loaded by FFmpeg; node-editor UX already covered by the filter-graph editor | Reference |
| **HandBrake** / **Shutter Encoder** / **Avidemux** | Mature export preset libraries | Source of sensible default presets (web, mobile, ProRes, DNxHD, GIF, social sizes) | Todo (presets) |
| **Spek** | Spectrogram viewer | FFmpeg `showspectrumpic`/`showwavespic` give the same picture | Todo (audio analysis) |
| **shotdetect** / PySceneDetect | Scene cuts | Already done with `scenesdetect` crate | Done |
| **Pitivi** (GStreamer/GES), **Movit** (GPU filters via MLT), **Lightworks**, **DaVinci Resolve**, **Datura**, **Cinelerra** forks | Other engines or proprietary | Not usable with FFmpeg-only rendering | Skip |
| Players/converters/wrappers (VLC, MPV, MPlayer, ffmpegX, Hyper Video Converter, WinFF, QWinFF, MobileMediaConverter, Handbrake clones, Kodi, Plex-likes, library bindings such as PyMedia/pyffmpeg/Jffmpeg/PHP-FFMpeg, etc.) | Playback, one-click conversion, bindings | Nothing to reuse; some useful for comparing export presets | Skip |
