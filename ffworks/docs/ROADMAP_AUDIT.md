# FFWORKS remaining-work audit

Honest status. "Done" = tested with real FFmpeg and/or the GUI scripts. Unverified items say so. Updated after the "do everything" pass.

## A. Plugins in the installer
* DONE (config + CI): the Windows job downloads the gyan **full** FFmpeg build and the official frei0r Win64 plugins; the app adds `<resources>/frei0r` to `FREI0R_PATH`. On CI both downloads succeeded.
* DONE: CI shows the bundled build has frei0r, LADSPA, libplacebo, zscale (no LV2); frei0r v3.6.0 Win64 (158 DLLs, glitch0r included) is bundled; both downloads are checksum-pinned; the plugin parameter tables are read from the bundled DLLs at build time.
* TODO: confirm the CI-read table (it is printed between BEGIN/END markers in the Windows job log) and commit it, so Linux/dev builds know the 3.x plugins too.
* DONE: the Windows installer job (tests + `tauri build` + size check with the full FFmpeg and plugins bundled) is green on CI since the palette commit.
* NOT POSSIBLE: VST plugins (FFmpeg cannot load them). LV2 needs a build with `lv2` (the bundled one lacks it).
* DONE: LADSPA (Audacity-style) audio plugins: 122 swh/TAP/CMT effects offered when installed (Linux-verified). Not bundled on Windows. 17 sample-rate-scaled plugins excluded because of an FFmpeg `ladspa` filter bug (needs an upstream patch).
* TODO: FFglitch (separate `ffedit`/`ffgac` tools) as its own engine slot; Windows CI never renders with plugins, so only Linux proves frei0r.

## B. Done (all with tests; details in STATUS.md)
Effects: 24 + 3 more, frei0r colour/position params · detection (silence/black/freeze) + cut-ranges-out · export presets (H.265, AV1, ProRes, DNxHR, FFV1, GIF, FLAC, PNG sequence, GPU encoders when they work, datamosh, quick no-re-encode export) · copy/paste effects, saved looks, "Add to clip" from the filter browser · subtitle import · image-sequence import · audio auto-sync · scopes + spectrogram · multi-clip selection · snapshots · macro recorder/replayer · project packaging · disk-space check · demo "Keep look" · 12 extra wipe transitions · command palette · CLI (`presets`, `run`, `detect`, `sync`, `package`, `batch`, `watch`).

## C. Still open from the earlier conversation
* Demo mode: no audio; "hold" only toggle-tested; "keep this look" not built; real playback needs eyeballing on Windows (sandbox webview cannot decode video).
* GL transitions: ~75 more shaders not expressible (hand-porting possible); slow (1–2.5 min per 1 s transition at 1080p); no per-feature build routing.
* frei0r: the 18 filters with colour/position/text params; sources/mixers; keyframes; preview.
* MLT-style luma-wipe transitions via `maskedmerge`; export preset library (HandBrake/Shutter Encoder ideas); spectrogram / scopes views.
* Housekeeping: STATUS header counts outdated; unrelated old "test" workflow is flaky; older GUI scripts not all re-run after every change.

## D. Spec phases still open
* Phase 2/3: mask/lens-correction effects, adjustment layers, nested/compound clips and truly editable multiple sequences, audio graphs, keyframed graph options, graph templates, docking/workspaces. (Shortcut editor: DONE for the 19 keyboard actions.)
* Phase 4: Rhai/DSL scripting beyond JSON command lists, macro variables/loops/conditions, permissions model.
* Phase 5: transient detection, drift correction for auto-sync.
* Phase 6: expressions, modulators, parameter linking, audio-reactive visuals, MIDI.
* Phases 7-9: pixel sort (PARTIAL: frei0r 3.6's `pixels0rt` is offered on Windows where it is bundled; not on Linux test machines with frei0r 1.8, so untested here; no built-in sorter), real motion-vector datamosh / FFglitch motion transfer, corruption lab.
* Phase 10: plugin system (Extism), local API.
* Cross-cutting: SQLite index, smart rendering, export naming/versioning, persistent job state across crashes, accessibility pass, colour management, preview/analysis through the job queue.
