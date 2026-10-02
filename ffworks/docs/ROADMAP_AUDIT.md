# FFWORKS remaining-work audit

Honest status. "Done" = tested with real FFmpeg and/or the GUI scripts. Unverified items say so. Updated after the "do everything" pass.

## A. Plugins in the installer
* DONE (config + CI): the Windows job downloads the gyan **full** FFmpeg build and the official frei0r Win64 plugins; the app adds `<resources>/frei0r` to `FREI0R_PATH`. On CI both downloads succeeded.
* TODO (read the next CI summary): does the full build list `frei0r` / `ladspa` / `lv2` / `libplacebo` / `zscale`? was `glitch0r.dll` found? Then pin both SHA-256 values in the workflow (they are logged; the GitHub release has no checksum file to compare).
* TODO: installer build itself not yet confirmed green after the latest commits (CI result pending when this was written).
* NOT POSSIBLE: VST / Audacity-style plugins (FFmpeg cannot load them). LADSPA/LV2 only if the bundled build has them.
* TODO: FFglitch (separate `ffedit`/`ffgac` tools) as its own engine slot; Windows CI never renders with plugins, so only Linux proves frei0r.

## B. Done in this pass (all with tests, see STATUS.md)
24 more effects · silence/black/freeze detection + cut-ranges-out · 11 more export presets incl. GPU encoders (only when a trial encode works) · quick export without re-encode · copy/paste effects + saved looks · subtitle import · audio auto-sync · CLI (`presets`, `run`, `detect`, `sync`, `batch`) · command palette (Ctrl+K).

## C. Still open from the earlier conversation
* Demo mode: no audio; "hold" only toggle-tested; "keep this look" not built; real playback needs eyeballing on Windows (sandbox webview cannot decode video).
* GL transitions: ~75 more shaders not expressible (hand-porting possible); slow (1–2.5 min per 1 s transition at 1080p); no per-feature build routing.
* frei0r: the 18 filters with colour/position/text params; sources/mixers; keyframes; preview.
* MLT-style luma-wipe transitions via `maskedmerge`; export preset library (HandBrake/Shutter Encoder ideas); spectrogram / scopes views.
* Housekeeping: STATUS header counts outdated; unrelated old "test" workflow is flaky; older GUI scripts not all re-run after every change.

## D. Spec phases not started
* Phase 2: image-sequence import and export (needs numbered input/output handling in the render graph), multi-clip selection editing, more effect coverage (mask, lens correction).
* Phase 3: scopes (waveform/vectorscope/histogram), adjustment layers, nested sequences, "Add to clip" from the Filters dialog, graph templates, audio graphs, keyframed graph options, docking/workspaces, shortcut editor (the palette lists shortcuts but they are fixed).
* Phase 4: Rhai/DSL scripting beyond JSON command lists, macros with variables, recorder UI (engine has `start_recording`), watch folders, permissions.
* Phase 5: transient detection, drift correction for auto-sync.
* Phase 6: expressions, modulators, parameter linking, audio-reactive visuals, MIDI.
* Phases 7–9: glitch lab (presets, pixel sort, variation generator/contact sheet, datamosh via I-frame removal, FFglitch motion transfer, corruption lab).
* Phase 10: plugins (Extism), local API.
* Cross-cutting: multiple sequences/snapshots, project packaging, smart rendering, export naming/versioning, SQLite index, disk-space checks, persistent job state across crashes, accessibility pass, colour management, queue for previews/analysis.
