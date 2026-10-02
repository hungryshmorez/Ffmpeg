# Third-party notices

## FFmpeg and FFprobe (bundled in Windows installers)

The Windows installer includes unmodified `ffmpeg.exe` and `ffprobe.exe` from the **gyan.dev "essentials" build, version 7.1.1**.

* License: **GNU GPL v3** (the build includes GPL components such as libx264 and libx265). Full text: `ffmpeg/LICENSE` next to the executables in the installed application.
* Download of the exact build: https://github.com/GyanD/codexffmpeg/releases/tag/7.1.1
* Corresponding source code: https://github.com/FFmpeg/FFmpeg/commit/db69d06eee (build configuration in `ffmpeg/README.txt`); further component sources are linked from https://www.gyan.dev/ffmpeg/builds/
* FFWORKS runs these programs as separate processes; they are not linked into FFWORKS. You can use your own FFmpeg instead via *Diagnostics → FFmpeg location*.
* FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

The installer build verifies the download against a pinned SHA-256 (see `.github/workflows/ffworks.yml`).
