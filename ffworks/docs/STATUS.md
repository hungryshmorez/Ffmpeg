# Status (update this at the end of every working session)

_Last updated: Phase 2 complete except image-sequence/subtitle import, quick export, copy/paste effects. ~156 Rust tests, 28 UI unit tests, 11 GUI scripts, clippy clean._

## Done (tested)
Phase 0 architecture doc · Phase 1 editor (import/probe/metadata, thumbnails, waveforms, multitrack timeline: place/trim/split/move/ripple-delete/linked A/V/lock/mute/snap, volume, undo/redo, save/load, export H.264/VP9/WAV/MP3 with progress/cancel/verify, Command Inspector, headless CLI) ·
Effects (11, with parameter metadata registry) + opacity · processed preview (cached by content hash, staleness shown) · autosave + crash recovery (verified with kill -9) · relinking · FFmpeg path settings · render queue (priority, cancel, logs) · transitions (all 57 xfade kinds from the installed FFmpeg, crossfaded linked audio, handle validation) · beat detection (ported from the browser app) + snap-to-beats · scene detection (`scenesdetect` crate) · loudness + normalize (`ebur128`) · bundled FFmpeg in the Windows installer (CI-built; installer artifact ~114 MB zipped) · **keyframes** (opacity, position, scale, rotation, animatable effect params; linear/hold/ease) · transform · crop · 16 blend modes · speed/reverse/freeze (video+audio) · **audio**: pan/balance, fades, volume envelope (keyframes), solo, per-track gain/pan, 9 audio effects (3-band EQ, high/low-pass, compressor, limiter, echo, FFT denoise, dynamic normalizer, mono), Mixer panel with meters · **markers** (M key, ruler flags, notes/colours, [ ] jump, snapping) · **proxies** (540p H.264 cache keyed by fingerprint; monitor-only, exports/previews use originals; real decode-error notice offers one) · **titles** (drawtext: font, size, colour, align, outline, shadow, box; position/opacity/blend via the clip) · solid-colour clips · still images and animated GIFs — all through the command bus with undo, save/load and real-FFmpeg pixel tests.

## Left (by spec phase)
* **Phase 2 remainder:** image-sequence and subtitle import · quick export · copy/paste effects, multi-clip edit · remaining common effects. (Keyframes, transform, crop, blend, speed/reverse/freeze are done: see ARCHITECTURE.md.)
* **Phase 3:** full filter browser · visual filter-graph editor + raw nodes (use `@xyflow/react`) · GPU detection/hw encoders · scopes · adjustment layers · nested sequences/compound clips · effect-chain presets · more exports (H.265, ProRes, DNxHR, GIF, image sequence) · docking/workspaces · command palette · shortcut editor.
* **Phase 4:** DSL + JSON automation · script editor · recorder UI (engine `start_recording/stop_recording` exists) · macros · batch · watch folders · blueprints · dry run/diff · variables/loops/conditions · permissions.
* **Phase 5:** silence/black-frame/duplicate-frame/transient detection · audio auto-sync (cross-correlation). (beats, scenes, loudness done)
* **Phase 6:** expressions (`fasteval`) · modulators · parameter linking · audio-reactive · custom effect builder · MIDI (`midir`).
* **Phase 7:** glitch presets · temporal/feedback effects · variation generator + contact sheet (pixel sort: see REUSE.md).
* **Phases 8–9:** real datamoshing/codec work · motion vectors · optical flow · motion transfer · corruption lab. FFglitch trial done (below).
* **Phase 10:** plugins (Extism) · user tools · headless polish · local API.
* **Cross-cutting:** multiple sequences + snapshots · project packaging · smart rendering · export naming/versioning/manifest · SQLite index · disk-space checks · persistent job state across crashes · accessibility pass · colour management · queue should also carry previews/analysis.

## Filter browser (Phase 3, step 1 — done)
Toolbar "Filters" opens a searchable list of every filter in the installed FFmpeg with options, defaults, ranges, enum choices and pad counts (parsed from `-filters` / `-h filter=NAME`; `filterdb.rs`, 3 real-FFmpeg tests + `filters.sh` 10 GUI checks). Read-only so far: adding a filter to a clip / raw graph nodes comes with the `@xyflow/react` graph editor (next).

## Filter-graph editor (Phase 3, step 2 — done for video)
* Effect "Custom filter graph" (`graph`): node editor (`@xyflow/react`) between a fixed `in` and `out`; add any video filter from the installed FFmpeg, edit options (names/defaults from `-h filter=`), wire pads by dragging, `split` for reuse. Apply = one undoable `SetEffectGraph` command; saved in the project file (`EffectInstance.graph`).
* Core: `filtergraph.rs` (validate: DAG, pad numbering, one connection per pad, size limits; compile to filtergraph statements spliced into the clip chain, result refitted to project size), `filterdb::check_pads` (pad counts vs FFmpeg before Apply). Tests: 6 real-render tests (split/negate/blend maths, source node + overlay, size change, undo/save/load, refusals), pad-check test, flow.ts unit tests, `graph.sh` 23 GUI checks incl. real drags and independent pixel check of the export.
* Honest limits: video only (no audio graphs yet); not combinable with transitions (refused both ways); option values cannot be keyframed; effects see the already-padded project-size frame (letterbox bars included); the filter/option denylist (files, plugins, network, outputs) is not a sandbox; only `split`/`inputs`/`outputs` pad counts are derived for dynamic-pad filters; no per-node preview thumbnails; Delete in the editor no longer reaches the timeline (global shortcuts now ignore open dialogs — this was a real bug found by the GUI test).
* Not yet: filter presets/favourites from the browser into the graph, "Add to clip" from the Filters dialog, graph templates, audio graph.

## Favourites and random / stacked effects (done)
* Star any effect or transition (★ in the lists) and sort them into named groups (Favourites dialog); stored in the user settings file, kept when tool paths change. Random buttons draw from everything, the starred set or one group.
* 🎲 Random effect(s): stack 1–20 random effects on a clip (audio clips get audio effects) with moderate random parameter values; 🎲 Random transition(s): random transitions on up to N consecutive cuts starting after the selected clip. Each is one undoable Batch. Picks are seeded (SplitMix64); the seed is shown and can be typed back to reproduce a result.
* Tests: 5 real-FFmpeg tests (determinism, pools, one-undo, real renders of 5 random stacks, transition skipping with reasons), favourites unit tests, UI unit tests, `random.sh` 17 GUI checks (real clicks, persisted settings, export + saved project verified independently).
* Honest limits: a "transition stack" means consecutive cuts, not several layered on one cut (FFmpeg path allows one per cut); cuts without media handles or on retimed clips are skipped and reported; random effect values are moderate, not guaranteed pretty; custom graph effects are never picked or starred.

## GL transitions (done, with a speed caveat)
* 48 gl-transitions shaders appear as "GL …" in the transition list (also in random picks, favourites, saved projects) when the installed FFmpeg's `xfade` supports custom expressions (`Capabilities.xfade_custom`; true for the Linux 6.1 test build and the pinned Windows 7.1.1 build in CI).
* Verified: `tests/glx.rs` runs every one through real FFmpeg (starts on A, ends on B, differs from both during the transition; a hang fails after 60 s) and three go through project → export → save/load.
* **Slow:** they are evaluated per pixel by FFmpeg's expression engine. Measured on this 4-core sandbox at 1080p: about 2.3 s/frame (gl_angular) to 5.5 s/frame (gl_crosswarp); at 960x540 about 0.6–1.4 s/frame; gl_linearblur is ~4× slower still. A 1 s transition at 25 fps therefore costs roughly 1–2.5 minutes of export at 1080p. Use the preview scale while editing. The transition lists mark them "(slow to render)"; native transitions stay instant.
* Not available: ~75 other gl-transitions shaders (textures, loops, multi-pass), 14 of which xfade-easing only supports in its patched FFmpeg. Not faked.

## Requested additions (still to do: demo mode)
* **GL Transitions library** (gl-transitions.com, MIT). Stock Windows FFmpeg has no `gl-transition` filter, so plan is to port shaders to `xfade` custom expressions (approach of the MIT `xfade-easing` project) — only shaders expressible that way; the rest are listed as unsupported, not faked.
* **Transition demo mode**: button that cycles random transitions through the timeline continuously (preview/playback only, nothing written to the project unless "Keep").
* **Effects demo mode**: same for effects; two separate boards (transitions / effects) that can run combined.
* **Random transition** and **Random effect** buttons; **stacking**: choose N (e.g. 1 or 3) and apply that many random effects (or chained transitions) in one undoable command.
* **Favourites**: star any effect or transition; favourites form groups (one for effects, one for transitions, user can also name extra groups) saved in user settings. Demo mode and the random buttons can be limited to "favourites only" or a chosen group, or use everything.
* **Stacking both ways**: stack several effects on a clip, and stack several transitions (chained back-to-back or layered on one cut where FFmpeg allows) — random buttons take a stack count for each.
* Ordering: after the filter-graph editor (needs the same effect/preset registry); random picks are seeded so a result can be reproduced.

## Unverified / known gaps
* Proxies: the file properties are verified (960x540 H.264/AAC), but whether a proxy plays in a webview that cannot decode the original (e.g. ProRes on Windows WebView2) is unverified: this sandbox webview cannot decode H.264 at all, so only the "original fails → offer proxy → proxy created" path was exercised. Markers aren't exported as chapters yet.
* Research notes: OpenShot (libopenshot LGPL-3) and Audacity (GPLv3) are reference only; do not copy their code into FFWORKS. Candidate FFmpeg-filter effects inspired by them: chroma key, mask, deinterlace, pixelate, phaser/chorus/flanger, gate, de-click.
* Titles: no per-letter animation/typewriter, no rich text (one style per title), no title preview in the source monitor (rendered preview only). Fonts are found by file name; fonts on another computer must exist there. Subtitle files (SRT) and image *sequences* are not imported yet; GIFs play once (no loop option).
* Mixer meters are *predicted* from analysed waveform peaks (gain/fades/pan applied, effects not) — not live audio levels; no master meter. Source playback in the monitor can't preview pan/fades/effects (rendered preview/export only). No reverb/pitch-shift/de-esser. Pan can't be keyframed.
* Keyframed opacity uses `geq` (exact but slow at 1080p+); not benchmarked. Slow motion repeats frames (no optical-flow interpolation). Keyframes can't be dragged on the timeline yet (edited in the Inspector list). Transitions can't be combined with transform/blend/retiming/keyframes (refused with a message). Blur/sharpen/grain parameters can't be keyframed (FFmpeg filters take fixed values).
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

## FFglitch trial (Phases 8–9 design input)
Tried FFglitch 0.10.2 (Linux x86_64 static build from ffglitch.org, GPL-2+) on real generated clips. Reproduce with `FFGLITCH_DIR=<unpacked dir> ffworks/scripts/ffglitch/trial.sh` (6 checks, all pass).
* **What works (verified by decoding the output and comparing pixels):**
  * *I-frame removal / classic datamosh* needs **no FFglitch**: stock FFmpeg `-c copy -bsf:v "noise=drop='key*gt(n,0)'"`. Frames before the cut are bit-identical, frames after smear the old picture along the new clip's motion (looked at the result: textbook mosh).
  * *Motion-vector editing*: `ffedit -i in.avi -f mv -s script.js -o out.avi`; JS (QuickJS) `glitch_frame(frame)` mutates `frame.mv.forward[row][col] = [x,y]`. Amplifying vectors x4 decodes cleanly and the error compounds over P-frames.
  * *Motion transfer*: export A's MVs (`-e a.json`), apply to B (`-a a.json`). Re-exporting the result gives exactly A's vectors on all 99 P-frames; the picture is B's pixels dragged by A's motion (B's residuals still apply on top, so it is smeary rather than clean).
* **Limits / gotchas:**
  * Supported codecs: MPEG-4 Part 2, MPEG-2, MJPEG, (see `ffedit -i file`). **H.264/H.265 are not supported** ("FFEdit does not support codec"). MP4, MKV and MPEG-PS containers are refused; AVI and raw `.m2v` work.
  * Vectors have a per-stream range (`f_code`). Scaling beyond it writes a corrupt stream (ffedit only warns "outside of range"). Fix: make the intermediate with FFglitch's own encoder: `ffgac ... -c:v mpeg4 -mpv_flags +nopimb+forcemv -g 9999 -bf 0 -fcode 6` (stock FFmpeg has no `-fcode`). Also clamp in scripts.
  * Source and target for transfer must have identical size/frame structure (same macroblock grid, same P-frame layout).
  * Script arrays are indexable but **not iterable** (`for...of` throws); use index loops.
  * Python scripting is mentioned in help but only JS was tried. Windows build not tried (ffglitch.org lists Windows builds; unverified).
* **How to drive it from FFWORKS (design, not built yet):** a "codec lab" job: (1) transcode the clip range to a disposable MPEG-4 AVI intermediate with `ffgac` (fcode 6, all-P), (2) run `ffedit` with a parameterised script (generated from the command JSON; params passed via `-sp`), (3) transcode the result back to the project's delivery format and import it as new media. Originals are never touched; each job records tool version, script and seed. UI must say plainly: output is a *new file* made from a lossy intermediate, not an effect on the live timeline. Needs ffglitch as an optional separately-downloaded GPL tool (like FFmpeg, found via settings/bundled/PATH), never linked.
