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
