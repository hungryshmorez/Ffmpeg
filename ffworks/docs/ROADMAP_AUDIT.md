# FFWORKS remaining-work audit

Honest status: "done" means tested with real FFmpeg and/or the GUI scripts; "unverified" says so.

## A. Shipping plugins (this request)
* DONE in config, UNVERIFIED until CI runs: installer bundles gyan **full** FFmpeg (checksum from the publisher's .sha256, hash logged for pinning) and official frei0r Win64 DLLs; app searches `<resources>/frei0r`.
* TODO next session: read the CI job summary (does the full build contain frei0r / ladspa / lv2 / libplacebo / zscale? was glitch0r.dll found?), then pin both SHA-256 values in the workflow.
* TODO: frei0r is the only plugin family wired in. LADSPA/LV2 audio plugins only if the build lists those filters; VST/Audacity-style plugins cannot be loaded by FFmpeg.
* TODO: FFglitch (separate ffedit/ffgac tools) as its own engine slot; Windows CI never renders with plugins (skips), so only Linux proves it.

## B. Items from this conversation still open
* Demo mode: no audio; "hold" only toggle-tested; "keep this look" not built; real playback needs eyeballing on Windows.
* GL transitions: ~75 more shaders not expressible (hand-porting possible); they are slow (1-2.5 min per 1 s transition at 1080p); no per-feature build routing.
* frei0r: 18 filters with colour/position/text params; sources/mixers; keyframes; preview.
* MLT-style luma-wipe transitions via `maskedmerge`; export preset library (HandBrake/Shutter Encoder ideas); spectrogram view (`showspectrumpic`).
* Housekeeping: older GUI scripts not re-run after GL/frei0r changes; STATUS header counts outdated; unrelated old "test" workflow is flaky.

## C. Spec phases (see STATUS.md "Left")
* Phase 2: image-sequence/subtitle import, quick export (`-c copy`), copy/paste effects, multi-clip edit, chroma key, mask, deinterlace, pixelate, phaser/chorus/flanger, gate, de-click.
* Phase 3: GPU/hw encoders, scopes, adjustment layers, nested sequences, effect presets, more exports (H.265, ProRes, DNxHR, GIF, image sequence), docking/workspaces, command palette, shortcut editor, "Add to clip" from Filters, graph templates, audio graphs, keyframed graph options.
* Phase 4: scripting/DSL, macros, batch CLI, recorder UI, watch folders, permissions, dry run.
* Phase 5: silence/black/duplicate-frame/transient detection, audio auto-sync.
* Phase 6: expressions, modulators, parameter linking, audio-reactive, MIDI.
* Phases 7-9: glitch presets, pixel sort, variation generator/contact sheet, datamosh, motion transfer, corruption lab.
* Phase 10: plugins (Extism), local API.
* Cross-cutting: multiple sequences/snapshots, packaging, smart rendering, export naming, SQLite index, disk checks, persistent job state, accessibility, colour management, queue for previews/analysis.
