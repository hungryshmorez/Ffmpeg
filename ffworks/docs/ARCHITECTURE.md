# FFWORKS — Architecture (Phase 0)

FFWORKS is a nonlinear editor whose render backend is FFmpeg. The **project model is authoritative**; FFmpeg is an engine, not the architecture.

```
PROJECT MODEL ─► COMMAND BUS ─► PATCHES (undo/redo) ─► RENDER GRAPH ─► FFMPEG JOB ─► FFmpeg process
   (serde JSON)    (typed)        (invertible)           (IR)            (argv)
```

## Layout

| Path | Role |
|---|---|
| `crates/ffworks-core` | The engine. **No GUI dependency.** Project model, rational time, command bus, patches, render graph, FFmpeg compiler, job runner, analysis. |
| `crates/ffworks-cli` | Headless `ffworks` binary (`caps`, `probe`, `command`, `render`) — proves the engine is decoupled from React/Tauri. |
| `src-tauri` | Thin Tauri v2 shell: IPC marshalling, engine mutex, job events. No editing logic. |
| `ui` | React + TypeScript + Zustand front-end. Talks only to `api.ts`. |
| `scripts/uitest` | Headless GUI end-to-end test (real webview, real engine, real FFmpeg). |

The product name lives in `brand.rs` / `brand.ts` (and `tauri.conf.json`'s `productName`).

## Rational time (`time.rs`)

All timeline/source times are exact `Rational` seconds (normalised `i64/i64`, `i128` intermediates). Serialised as `"n/d"` strings. Frame *N* at 30000/1001 is exactly `N·1001/30000` s, so there is no accumulated drift; tests cover 10 000-frame accumulation and 23.976/29.97/59.94 round-trips. Floats appear only at the edges (FFprobe `duration`, UI layout). Audio positions are converted to **sample counts** for `atrim`/`adelay`, so audio stays sample-accurate. Timeline edits snap to the project frame grid in the planner.

## Project format (`project.rs`)

`.ffworks` = pretty-printed JSON: `schema_version`, `name`, `settings{width,height,fps,sample_rate}`, `media[]` (path, full FFprobe info incl. colour metadata, fingerprint), `sequences[]` → `tracks[]` → `clips[]` (`start`, `source_in`, `duration`, `link`, `gain_db`). Source files are never modified. Saves are atomic (temp file + rename). `migrate.rs` upgrades older schemas stepwise and refuses newer ones (the step table is empty until schema 2 exists). Fields for later phases (effects, keyframes, transitions…) are added with `#[serde(default)]` so v1 projects keep loading.

## Command bus, patches, undo (`commands.rs`, `patch.rs`, `engine.rs`)

* A `Command` (serde-tagged enum: `place_clip`, `move_clip`, `trim_clip`, `split_clip`, `delete_clip`, `set_clip_gain`, `set_track`, `add_track`, `batch`, …) is **planned** against the current project into `Patch`es without mutating anything. Planning is where validation lives (overlaps, locked tracks, source bounds, kind mismatches) and errors name the exact problem.
* `patch::apply` returns the inverse patch. The engine stores `{forward, inverse}` per history entry, so undo/redo is exact and cheap, and a failed command (or failed post-validation) is rolled back leaving the project unchanged.
* `Command::Batch` = one undo step (transactions). Linked clips (video + its audio) share a `link` id and move/trim/split/delete together.
* The same JSON is the automation representation: `Engine::start_recording/stop_recording` returns the replayable command list. UI, tests, scripts and (later) macros all use this one path.

## Effects (`effects.rs`)

A registry of `EffectDef`s (id, category, required FFmpeg filters, `ParamDef`s with min/max/default/step/unit). `EffectInstance` (id, effect, enabled, params) lives in `Clip.effects`; commands `add_effect / remove_effect / set_effect_param / set_effect_enabled / move_effect / set_clip_opacity` validate against the registry and, like everything else, undo through patches. `to_filter` is the single serialisation point; the compiler inserts enabled effects after scaling, applies opacity via `colorchannelmixer=aa` + `overlay format=auto`, and refuses to render if a required filter is missing from the discovered capabilities. Grain takes an explicit seed so renders are reproducible. Old projects without these fields load via `serde(default)`.

## Render graph and FFmpeg compiler (`render_graph.rs`, `ffmpeg.rs`)

`render_graph::build` flattens the active sequence into inputs, ordered video layer segments and audio segments (clip gain + track gain). `ffmpeg::compile` turns it into an `FfmpegJob { pre, filter_graph, post }` — **argv vectors, never shell strings**:

* video: black `color` canvas → per clip `setpts/trim/setpts/fps/scale/pad/setsar` → `overlay` chain; repeated inputs are `split`; trim bounds sit half a source frame early so decimal rounding cannot drop a boundary frame;
* audio: `anullsrc` base + per clip `aresample/aformat/atrim(start_sample,end_sample)/volume/adelay(NS)` → `amix normalize=0` (needs FFmpeg ≥ 4.4);
* gaps are black/silence; muted audio renders as silence; hidden video tracks are skipped;
* the graph is passed with `-filter_complex_script` (avoids the 32 k Windows command-line limit); the Command Inspector shows the inline form;
* refuses to write over any source file; checks encoders against the discovered capability registry.

**Preview/final parity:** preview renders (`range`, `scale_div`) use the same compiler; only resolution/range differ.

## Transitions (`transitions.rs`)

`Track.transitions` holds `{clip_a, clip_b, kind, duration}` for touching clips on a video track. A transition is centred on the cut: the render graph shortens A and B by `duration/2` each and adds an overlapped segment that `xfade`s A's media *after* its out point with B's media *before* its in point (handles), so the timeline length never changes; linked audio gets an `acrossfade` of the same span. Durations snap to an even number of frames. `Project::validate` enforces adjacency, opacity = 100 %, handle availability and that transitions don't consume whole clips; moving/trimming/splitting a transitioned clip is therefore refused with an explanation, while deleting a clip removes its transitions automatically.

**Render-graph inputs:** every clip use (linked A/V share one) and every transition side gets its own `-i`. Sharing one input across branches with `split`/`asplit` starved branches that were consumed at very different times (the crossfade audio came out silent), so splitting is not used; a render needing more than 200 simultaneous inputs is refused with an explanation (OS file-handle limits).

## Clip properties, keyframes and retiming (`clipprops.rs`, `keyframes.rs`, `effects.rs`, `ffmpeg.rs`)

`Clip` carries `transform {x, y, scale, rotation}` (pixels / ×1 / degrees, pivot = frame centre), `opacity`, `blend`, `speed` (rational), `reverse`, `freeze` (source time of a held frame) and `keyframes: {param id → [Keyframe{t, v, interp}]}`. Param ids are `opacity | x | y | scale | rotation | fx:<effect id>:<param>`; key times are clip-relative **timeline** seconds snapped to the frame grid (so retiming never moves keys). Interpolations: linear, hold, ease in/out/in-out. `keyframes::eval` (Rust, mirrored in `ui/src/keyframes.ts`) and `keyframes::to_expr` (FFmpeg expression text) are the same curve; a test renders every interpolation in real FFmpeg and compares with `eval`.

* **Commands:** `set_clip_param`, `set_clip_blend`, `set_keyframe` (upsert; snaps time), `remove_keyframe`, `clear_keyframes`, `set_clip_speed`, `set_clip_reverse`, `set_clip_freeze`. A static setter is refused while the parameter is animated (the UI auto-keys instead). Removing the last key keeps its value as the static value. Removing an effect removes its keyframes.
* **Split/trim:** a split keeps the curve identical on both halves (`keyframes::window` keeps the keys inside plus the nearest outside); trimming the start shifts keys; a reversed clip's left piece takes the *later* source; speed makes source ranges `duration × speed`.
* **Speed** changes the clip's timeline duration (source span fixed) for the whole link group and needs free track space. Audio uses `atempo` (chained for factors outside 0.5–2) and is padded/trimmed to the exact sample length. Slow motion repeats frames (no interpolation yet).
* **Reverse** uses `reverse`/`areverse`, which buffer the clip in memory; compile refuses clips over ~2 GB of decoded frames at output size (previews at lower quality still work). **Freeze** keeps one frame (`trim=end_frame=1,tpad=clone`), has no source span so it can be lengthened freely, and detaches the linked audio.
* **Transform** is one `perspective` pass on a frame padded with a 2 px transparent border (`perspective` replicates edge pixels; the border makes the outside transparent; odd pad offsets corrupt the alpha plane in `pad`, hence 2). Animated parameters make it `eval=frame`, with time derived from `perspective`'s 1-based `in` counter. Verified pixel-exact for position/scale/rotation.
* **Opacity** static: `colorchannelmixer=aa`; keyframed: `geq` on the alpha plane (exact, slower). Effect parameters keyframe through the filter's own per-frame expressions (`eq`, `hue`, `vignette`); blur/sharpen/grain take fixed values in FFmpeg and are marked `animatable: false` in the registry (no fake keyframe button).
* **Blend modes** (`normal` = overlay): the clip is placed on a full-length transparent canvas, both inputs are converted to planar RGB (`blend` multiplies raw planes: in YUV the result is wrong, a bug the first pixel test caught), blended, converted back and composited through the clip's own alpha. `crop` is an effect that clears alpha strips, so lower layers show through.
* Transitions refuse clips with retiming, transform, blend or keyframes (handles/timing would be wrong); the reverse is refused too.

## Preview (`preview.rs`)

`preview::render` compiles the same render graph with a `range` and `scale_div` into a cached `previews/<key>.mp4`. The key is a SHA-256 of the project JSON (minus the display name) + range + quality, so any edit yields a new key and the UI compares `renderHash` to decide whether a preview is current. Cached hits skip FFmpeg. Not yet done: per-range invalidation, background pre-render, frame cache.

## Autosave and recovery (`recovery.rs`)

`Engine::autosave(dir)` writes the unsaved project (plus original path and timestamp) when `revision` changed since the last autosave, rotating `recovery.autosave.json`, `.1`, `.2` (temp file + rename). Explicit save, new, open, and deliberate close-without-saving delete them, so an autosave present at startup means an abnormal exit. `recovery::find` returns the newest *parseable* copy, so a file truncated mid-write falls back to the previous rotation. Recovered engines are dirty and bound to the original path; the autosave stays until the user saves.

## Relinking and settings (`relink.rs`, `settings.rs`)

`RelinkMedia` replaces an asset in place (same id) through `Patch::ReplaceMedia`, so clips keep their references and undo is exact. `relink::find_candidates` walks the chosen folders (depth ≤ 8, ≤ 100 000 files, symlinks skipped), hashes only files whose size equals the original's, and ranks fingerprint matches (`exact`, even if renamed) above same-name files. `Engine::relink_search` applies only exact matches, as one batch. Settings (`settings.json` in the app config dir) override `FFWORKS_FFMPEG`/`PATH`; new paths are executed (`-version`) and must identify as FFmpeg/FFprobe before they are saved.

## Beat detection (`beats.rs`)

FFmpeg decodes the first audio stream to mono 44.1 kHz f32; a 1024-sample Hann-windowed FFT (hop 512) gives spectral flux; peaks must be local maxima, exceed 1.35× the moving average and a 5 % strength floor, and be ≥ 0.18 s apart; BPM is the median inter-onset interval folded into 60–200. Results are cached per media fingerprint. Beat times are source-relative; the UI maps them to the timeline per clip (`beatPoints`) for ticks and snapping.

## Render queue (`queue.rs`)

`JobQueue` owns worker threads (concurrency limit, default 1). `submit(job, operation, priority)` returns an id; workers always take the highest-priority queued job, oldest first (`PRIORITY_EXPORT` > `PRIORITY_BACKGROUND`). `cancel` removes a queued job without ever running it or kills a running one (nothing is written to the destination). Every state change goes to a listener (Tauri turns it into `job-state` events); `run_job_logged` guarantees a `JobLog` (argv, exit code, stderr) for completed, failed and canceled runs. Not yet done: persisting queue state across crashes (spec §160) and routing previews/analysis through the queue.

## Jobs (`jobs.rs`)

`run_job` executes on a worker thread with real progress from FFmpeg `-progress pipe:1` (`out_time_us` ÷ timeline length → fraction; no fake percentages), ETA, cancellation (watchdog kills the process tree), stderr capture, and a `JobLog` (executable, argv, timestamps, exit code, stderr). Output goes to `name.ffworks-partial.ext` and is renamed on success, so a failed/cancelled export never leaves a truncated file or clobbers a good one. Failures get a plain-language hint (`explain_failure`) alongside the raw log.

## Analysis and cache (`analysis.rs`)

Waveform peaks (100 bins/s, from an FFmpeg s16le pipe) and JPEG filmstrips are generated off the UI thread, cached under the app cache dir keyed by media fingerprint (size + head/tail SHA-256). Not yet done: preview-frame cache, proxies, range-level invalidation (Phase 2).

## Security model

* No shell: `Command::new(program).args(argv)`; paths are single argv elements (spaces/Unicode/long paths need no quoting).
* The webview gets **no filesystem or shell permissions**; capabilities grant only core IPC + native open/save dialogs. Media is exposed to `<video>` through the asset protocol with a *dynamic* scope that only ever allows files already imported into the open project (plus the analysis cache).
* FFmpeg/FFprobe are resolved from `FFWORKS_FFMPEG`/`FFWORKS_FFPROBE` or `PATH`; nothing is downloaded silently.
* Future scripting runs the command JSON through the same validator; scripts get no raw process or filesystem access (capability model planned in Phase 4).

## Designed for, not yet built

* **Automation DSL / blueprints / macros** (Phase 4): text DSL and graph both compile to `Vec<Command>`; dry-run = plan onto a cloned project and diff.
* **Datamosh / codec lab** (Phases 8–9): isolated jobs on disposable copies in a managed temp dir (`name.ffworks-partial` pattern + crash-safe job state), recorded seeds + tool versions for reproducibility; honest labelling of what is codec-level vs. filter-level.
* **Plugins** (Phase 10): manifest-declared capabilities, out-of-process, no ambient access.
* **Local automation API**: not started; no network listener exists.
