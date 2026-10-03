# FFWORKS — working notes for Claude Code sessions

Read this first, then `docs/STATUS.md` (what's done / left / decisions) and `docs/ARCHITECTURE.md` (design). Don't re-derive what they say.

## What this is
A native desktop nonlinear editor built around FFmpeg. Authority order: project model → command bus → render graph → FFmpeg argv. The full spec has ~195 items (see STATUS.md for progress). Work in phases; **do not fake features** — unfinished things are absent or disabled, never placeholder buttons.

## Layout
`crates/ffworks-core` (engine, no GUI deps) · `crates/ffworks-cli` · `src-tauri` (thin shell) · `ui` (React/TS/Zustand) · `scripts/uitest` (GUI tests) · `docs/`.

## Commands
```bash
cargo test --workspace            # ~250 tests incl. real-FFmpeg e2e (slow: run in the background; CARGO_INCREMENTAL=0 saves disk) (needs ffmpeg+ffprobe on PATH)
cargo clippy --workspace --all-targets   # keep at 0 warnings
(cd ui && npx tsc --noEmit && npx vitest run)
scripts/uitest/run.sh | recovery.sh | relink.sh | beats.sh | transitions.sh | analysis.sh | filters.sh | graph.sh | random.sh | engines.sh | demo.sh | detect.sh | fxcopy.sh | subs.sh | sync.sh | palette.sh | seq.sh | scopes.sh | addfilter.sh | multi.sh | macro.sh | snapshots.sh | variations.sh | shortcuts.sh | reactive.sh | exportname.sh | unfinished.sh | pixelsort.sh | mosh.sh | adjustment.sh | script.sh | compound.sh | localapi.sh | a11y.sh   # GUI tests (more: clipfx audio generated markers proxy), see below
```
GUI tests build the UI with `VITE_UITEST=1`, build the Tauri app with `--features custom-protocol,uitest`, run it under Xvfb (`DISPLAY=:99`) in a real WebKitGTK webview and drive the real UI through an injected script. Linux sandbox needs `libwebkit2gtk-4.1-dev` etc. (apt) and `xvfb`.

## Rules learned the hard way
* Every edit is a `Command` → planned into invertible `Patch`es (`commands.rs`, `patch.rs`). New features must support undo, save/load, and rendering.
* FFmpeg is always spawned with argv arrays, never shell strings. Filter graphs are inlined (<20k chars) else passed via a file whose option depends on version: `-/filter_complex` (FFmpeg ≥7) vs `-filter_complex_script` (<7). `-filter_complex_script` is **gone in FFmpeg 8**.
* **One `-i` per clip use** (linked A/V share one). Never feed several branches from one input via `split`/`asplit` — late branches get starved (silent audio). Limit 200 inputs per render.
* Effects FFmpeg cannot express (pixel sort) are *baked*: `effects::to_filter` returns a `bake::MARK` entry, `bake::prepare` (called by `compile_project` and `preview::render`) turns it into a pre-render stage in `FfmpegJob.stages`, `jobs::run_job` runs the stages first. `ffmpeg::compile` refuses a graph with an unbaked mark — call `bake::prepare` before it.
* FFglitch (mosh lab) passes `-sp` JSON to scripts as `args.params`, and its arrays are not iterable. Its tests need `FFWORKS_FFGLITCH` (and fail rather than skip with `FFWORKS_REQUIRE_FFGLITCH`).
* Compound clips are media (`Generator::Nested`) rendered by `nest::prepare` into a cache file before the main render; `compile` refuses a graph with an unplanned compound. Anything that reads `project.active()` acts on the *shown* sequence, which may be a compound's contents (UI: use `activeSequence()`, never `sequences[0]`).
* The local API (`api.rs`) must stay loopback-only, token-protected and Origin/Host-checked; every new endpoint goes through `Engine::dispatch` and never reads files. `AppState.engine` is an `Arc<Mutex<Engine>>` shared with it.
* Colour: footage is converted to Rec.709 per its tags (`colormgmt.rs`, `InputRef.color`) and exports are tagged Rec.709; any new place that builds a scale/pad chain for an input must also append that input's conversion (see the two sites in `ffmpeg::compile`).
* Scripts (`script.rs`, Rhai) go through `Engine::begin_group/end_group/abort_group`: one undo step, all or nothing. They get no file/network/process access; any new script function must issue a `Command`, never touch the disk.
* Time is exact rational (`time.rs`). Never use float seconds as truth.
* FFmpeg's `ladspa` filter ignores the LADSPA "multiple of sample rate" hint (checks raw bounds): plugins with such controls are excluded, not worked around.
* Run `node --check` on a GUI test script before building: a JS syntax error makes the app just sit there until the timeout.
* Capability parsing: `ffmpeg -filters` has a `------` separator on some builds (Windows CI) and none on others, and 2- or 3-character flag columns — never rely on either; transitions come from `ffmpeg -h filter=xfade`.
* Tests compare real output: pixel sampling and `volumedetect` mean (not max) levels. `eq=brightness` only moves luma.
* GUI tests: use `waitFor` on results, not fixed sleeps (the app can take >500 ms). Every script must isolate `XDG_CACHE_HOME`/`XDG_CONFIG_HOME`, otherwise a leftover autosave opens the Recovery dialog and covers the UI. Don't `pkill -f ffworks-app` from a Bash call (it kills your own shell).
* Shell escaping inside heredoc-generated JS bites; keep test JS in separate files with `__PLACEHOLDER__` substitution via `sed ... g`.
* Don't claim something works unless a test actually exercised it. Say what is unverified (see STATUS.md "Unverified").

## Git / CI
Develop on the branch the session names (`ccr-c5ebf494-74z3iz` earlier, `claude/ffworks-handoff-pixel-sort-47zca5` for the pixel-sort session); PR #6 (draft) targets the repo's default branch `claude/ffmpeg-studio-v10-4-report-7ssjim` (there is no `main`). Commit messages end with the Co-Authored-By / Claude-Session lines the harness provides.
`.github/workflows/ffworks.yml`: Linux tests + Windows build. The Windows job downloads a **pinned gyan.dev FFmpeg 7.1.1 (GPL)** with a SHA-256 check, bundles it, runs `cargo test -p ffworks-core` against `choco` FFmpeg, builds the NSIS/MSI installer and uploads artifact `ffworks-windows-installers`. Check results with the GitHub MCP `actions_list` / `get_job_logs`; schedule follow-ups with `send_later` instead of polling.

## Reference material
`docs/REUSE.md` lists open-source projects adopted or planned (search first, build only what's missing). Reference clones go in `~/ref` (not committed).
