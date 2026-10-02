# Third-party notices

## FFmpeg and FFprobe (bundled in Windows installers)

The Windows installer includes unmodified `ffmpeg.exe` and `ffprobe.exe` from the **gyan.dev "essentials" build, version 7.1.1**.

* License: **GNU GPL v3** (the build includes GPL components such as libx264 and libx265). Full text: `ffmpeg/LICENSE` next to the executables in the installed application.
* Download of the exact build: https://github.com/GyanD/codexffmpeg/releases/tag/7.1.1
* Corresponding source code: https://github.com/FFmpeg/FFmpeg/commit/db69d06eee (build configuration in `ffmpeg/README.txt`); further component sources are linked from https://www.gyan.dev/ffmpeg/builds/
* FFWORKS runs these programs as separate processes; they are not linked into FFWORKS. You can use your own FFmpeg instead via *Diagnostics → FFmpeg location*.
* FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

The installer build verifies the download against a pinned SHA-256 (see `.github/workflows/ffworks.yml`).

## Fonts (built into the application)

Titles use **DejaVu Sans** and **DejaVu Sans Bold** (embedded in the binary; used when no other font is chosen).
* Licence: Bitstream Vera licence with public-domain DejaVu changes (permits use, copying and redistribution; the fonts may not be sold on their own). Full text: `crates/ffworks-core/assets/fonts/DejaVu-LICENSE.txt`.
* Source: https://dejavu-fonts.github.io/

## Rust and JavaScript libraries (statically included in the app)

| Library | Used for | License |
|---|---|---|
| [`scenesdetect`](https://crates.io/crates/scenesdetect) (a Rust port of [PySceneDetect](https://github.com/Breakthrough/PySceneDetect), © Brandon Castellano, BSD-3-Clause) | scene/shot cut detection | MIT OR Apache-2.0 |
| [`ebur128`](https://github.com/sdroege/ebur128) (port of libebur128, © Jan Kokemüller / Sebastian Dröge) | loudness (LUFS, LRA, true peak) | MIT |
| [`@xyflow/react`](https://github.com/xyflow/xyflow) (© webkid GmbH) | node-graph editor | MIT |
| [xfade-easing](https://github.com/scriptituk/xfade-easing) (© 2025 Raymond Luckhurst) and the [gl-transitions](https://github.com/gl-transitions/gl-transitions) shaders it ports (© gl-transitions contributors) | 48 GL transitions as `xfade` custom expressions (`crates/ffworks-core/assets/glx/`, licences alongside) | MIT |
| Tauri, React, Zustand, Vite and their dependencies | application shell and UI | MIT / Apache-2.0 |

Complete dependency licenses can be listed with `cargo license` and `npx license-checker` in `ffworks/` and `ffworks/ui/`.

## Bundled in the Windows installer (added by CI)
* **FFmpeg "full" build** (gyan.dev / GyanD/codexffmpeg, 7.1.1): GPL-3.0 build; licence and README ship next to ffmpeg.exe. Source: https://ffmpeg.org and https://github.com/GyanD/codexffmpeg.
* **frei0r plugins** v3.6.0 (`frei0r-3.6.0_win64.zip`, https://github.com/dyne/frei0r): GPL-2.0-or-later. Shipped as separate DLL files in `frei0r/` and loaded by FFmpeg; FFWORKS does not link them. Source offer: the repository above.
* **LADSPA plugin control tables** (`crates/ffworks-core/assets/ladspa/plugins.json`): parameter names, ranges and defaults read from swh-plugins (GPL-2+), TAP-plugins (GPL-2+) and CMT (LGPL-2.1+). No plugin code or binaries are shipped; FFmpeg loads plugins the user has installed.
