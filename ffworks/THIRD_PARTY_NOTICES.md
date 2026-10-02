# Third-party notices

## FFmpeg and FFprobe (bundled in Windows installers)

The Windows installer includes unmodified `ffmpeg.exe` and `ffprobe.exe` from the **gyan.dev "essentials" build, version 7.1.1**.

* License: **GNU GPL v3** (the build includes GPL components such as libx264 and libx265). Full text: `ffmpeg/LICENSE` next to the executables in the installed application.
* Download of the exact build: https://github.com/GyanD/codexffmpeg/releases/tag/7.1.1
* Corresponding source code: https://github.com/FFmpeg/FFmpeg/commit/db69d06eee (build configuration in `ffmpeg/README.txt`); further component sources are linked from https://www.gyan.dev/ffmpeg/builds/
* FFWORKS runs these programs as separate processes; they are not linked into FFWORKS. You can use your own FFmpeg instead via *Diagnostics → FFmpeg location*.
* FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

The installer build verifies the download against a pinned SHA-256 (see `.github/workflows/ffworks.yml`).

## Rust and JavaScript libraries (statically included in the app)

| Library | Used for | License |
|---|---|---|
| [`scenesdetect`](https://crates.io/crates/scenesdetect) (a Rust port of [PySceneDetect](https://github.com/Breakthrough/PySceneDetect), © Brandon Castellano, BSD-3-Clause) | scene/shot cut detection | MIT OR Apache-2.0 |
| [`ebur128`](https://github.com/sdroege/ebur128) (port of libebur128, © Jan Kokemüller / Sebastian Dröge) | loudness (LUFS, LRA, true peak) | MIT |
| Tauri, React, Zustand, Vite and their dependencies | application shell and UI | MIT / Apache-2.0 |

Complete dependency licenses can be listed with `cargo license` and `npx license-checker` in `ffworks/` and `ffworks/ui/`.
