# Status (update this at the end of every working session)

_Last updated: after the "reuse pass" commit (scene detection, loudness, 57 transitions). 91 Rust tests, 13 UI unit tests, 6 GUI scripts, clippy clean._

## Done (tested)
Phase 0 architecture doc · Phase 1 editor (import/probe/metadata, thumbnails, waveforms, multitrack timeline: place/trim/split/move/ripple-delete/linked A/V/lock/mute/snap, volume, undo/redo, save/load, export H.264/VP9/WAV/MP3 with progress/cancel/verify, Command Inspector, headless CLI) ·
Effects (11, with parameter metadata registry) + opacity · processed preview (cached by content hash, staleness shown) · autosave + crash recovery (verified with kill -9) · relinking · FFmpeg path settings · render queue (priority, cancel, logs) · transitions (all 57 xfade kinds from the installed FFmpeg, crossfaded linked audio, handle validation) · beat detection (ported from the browser app) + snap-to-beats · scene detection (`scenesdetect` crate) · loudness + normalize (`ebur128`) · bundled FFmpeg in the Windows installer (CI-built; installer artifact ~114 MB zipped).

## Left (by spec phase)
* **Phase 2 remainder:** keyframes · proxies (also fixes webview not decoding some codecs) · transform (position/scale/rotate/crop/flip), speed/reverse/freeze, blend modes · audio mixer/meters/fades/pan + audio effects (EQ, compressor, limiter…) · titles/text · image/GIF/sequence/subtitle import · markers/labels/notes · quick export · copy/paste effects, multi-clip edit · remaining common effects.
* **Phase 3:** full filter browser · visual filter-graph editor + raw nodes (use `@xyflow/react`) · GPU detection/hw encoders · scopes · adjustment layers · nested sequences/compound clips · effect-chain presets · more exports (H.265, ProRes, DNxHR, GIF, image sequence) · docking/workspaces · command palette · shortcut editor.
* **Phase 4:** DSL + JSON automation · script editor · recorder UI (engine `start_recording/stop_recording` exists) · macros · batch · watch folders · blueprints · dry run/diff · variables/loops/conditions · permissions.
* **Phase 5:** silence/black-frame/duplicate-frame/transient detection · audio auto-sync (cross-correlation). (beats, scenes, loudness done)
* **Phase 6:** expressions (`fasteval`) · modulators · parameter linking · audio-reactive · custom effect builder · MIDI (`midir`).
* **Phase 7:** glitch presets · temporal/feedback effects · variation generator + contact sheet (pixel sort: see REUSE.md).
* **Phases 8–9:** real datamoshing/codec work · motion vectors · optical flow · motion transfer · corruption lab. **Next step planned: try FFglitch (GPL, separate tool) on a real clip before designing this.**
* **Phase 10:** plugins (Extism) · user tools · headless polish · local API.
* **Cross-cutting:** multiple sequences + snapshots · project packaging · smart rendering · export naming/versioning/manifest · SQLite index · disk-space checks · persistent job state across crashes · accessibility pass · colour management · queue should also carry previews/analysis.

## Unverified / known gaps
* **Never installed or launched on Windows.** The installer builds in CI; nobody has run it. Preview picture playback unobserved (sandbox webview can't decode H.264).
* Native open/save dialogs and the close-confirmation prompt aren't exercised by GUI tests (tests call the same backend commands).
* Preview invalidation is whole-project, not per time range. Undo history isn't restored after crash recovery.
* Many clips → many `-i` inputs (limit 200); chunked rendering isn't implemented.

## Decisions (don't relitigate without reason)
* Bundle GPL FFmpeg 7.1.1 in the Windows installer (H.264 export needs libx264). FFWORKS runs it as a separate process. Notices in `THIRD_PARTY_NOTICES.md`; user can override via Diagnostics.
* Tool lookup order: saved setting > `FFWORKS_FFMPEG`/`FFWORKS_FFPROBE` > bundled > PATH.
* Transitions are centred on the cut and use media handles (timeline length unchanged).
* Project JSON uses rational strings `"n/d"` for times; schema version 1 with `serde(default)` for new fields.
* Source preview is honest: effects only appear in a *rendered* preview, with a visible "bypassed" badge otherwise.

## Process notes
* User preference: reuse open source first ("pull as much as possible"), build what's missing. Be honest about what's tested vs not. Keep the user's usage low: fresh sessions with this file beat one endless conversation.
* The user can't build installers locally; GitHub Actions is the build path.
