# v10.2 source (archive)

This directory is the **v10.2 source** of FFmpeg Studio, added verbatim as
provided. It is kept here as an archive/reference — it is **not** what the app
at the repository root runs.

The root of this repo is the newer **v10.4** build, which contains the verified
round-trip fix and the rest of the current work. v10.4 is a superset of v10.2
except for one module, `performance.js` (adaptive quality / global intensity /
layer compositor), which v10.4 had dropped — that module has since been
restored to the root build (see the git history) and given a live HUD and
render-loop load-shedding.

Notable file here: `DEEP_AUDIT_AND_100.md` — the "deep audit + 100 ways" planning
document that drove the v10.4 work.

Do not point a web server at this folder; it has no `vendor/` (the ffmpeg.wasm
core binaries), so it will not run standalone. Use the repository root for a
runnable build.
