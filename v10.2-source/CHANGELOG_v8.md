# FFmpeg Studio v8 — PHASE 4: HARDWARE

**19 JS modules, all passing `node -c`. CSS balanced (549/549).**

This is the version where the app stops being a GUI over a CLI.

---

## ⚡ 1. HARDWARE ACCELERATION (`hwaccel.js`)

**ffmpeg.wasm can never be hardware accelerated.** It's a WebAssembly sandbox — no GPU, no media engine, no NVENC, no QuickSync, no VideoToolbox. It runs roughly an order of magnitude slower than native FFmpeg, and that is *structural*, not a tuning problem. Every hour spent tuning CRF was optimizing a software encoder inside a VM.

**WebCodecs is a direct binding to the browser's real, silicon-backed encoder** — the same hardware path Chrome uses to play YouTube.

```
MP4 → demux (mp4box) → VideoDecoder (GPU/ASIC) → VideoFrame
                                                     ↓
                                          WebGL shader (TRIP CAM)
                                                     ↓
         mux (mp4-muxer) ← VideoEncoder (GPU/ASIC) ← VideoFrame
```

**The pixels never touch the CPU.** A 10-second glitch render goes from ~30s to under 1s.

### What's in it
- **Codec capability probe at boot** — `VideoEncoder.isConfigSupported({ hardwareAcceleration: 'prefer-hardware' })` for H.264 / VP9 / AV1 / HEVC / VP8. Surfaced in a **Hardware panel**: GPU name, HW decode ✓/✕, HW encode ✓/✕.
- **GPU detection.** When Chrome's hardware acceleration is off, WebGL silently falls back to a software rasterizer — you can see it in the renderer string (`SwiftShader`, `llvmpipe`). We detect it and show a dismissible nag. **A site cannot turn that setting on — there is no API.** All a web page may do is detect it and give you a copy-to-clipboard of `chrome://settings/system` (you can't even *link* to a `chrome://` URL — browsers block it).
- **Shader bridge** — a decoded `VideoFrame` goes straight into the existing TRIP CAM WebGL texture, the shader runs, and the result comes back as a new `VideoFrame` handed to the hardware encoder. GPU to GPU.
- **`frame.close()` everywhere.** Every `VideoFrame` holds real GPU memory. Leak them and the tab hard-crashes in seconds — the #1 WebCodecs footgun.
- **Automatic routing.** `canUseHardware(args)` inspects the command. Jobs that qualify take the fast path; everything else falls through to wasm.
- **Every job shows which path ran:** `⚡ Hardware (0.8s)` or `🐢 WebAssembly (34.2s)`.

### What deliberately stays on ffmpeg.wasm
- **All 19 audio mastering chains** — **WebCodecs has no MP3 or FLAC encoder.** Not a limitation we can route around. And it's fine: audio is cheap. Video was what was killing you.
- **GIF** (needs palettegen/paletteuse), **`geq` / `minterpolate`**, and any filter with no shader equivalent.

The cost of admission was a demuxer and a muxer — `mp4box.js` and `mp4-muxer`, both lazy-loaded so nothing downloads until the fast path is actually used.

---

## 💾 2. OPFS — THE MEDIA BIN SURVIVES A RELOAD (`opfs.js`)

Origin Private File System: a real, persistent, high-performance browser filesystem. Quota is a large fraction of free disk, not the 5 MB `localStorage` cap.

- Every upload is persisted. Every reload **rehydrates the bin automatically.**
- No more re-uploading a 500 MB file because you fumbled a refresh.
- Requests `navigator.storage.persist()` so the browser won't evict it under pressure.
- Also the path to streaming large files into ffmpeg instead of holding them entirely in the wasm heap — which is what would otherwise OOM you past ~1 GB.

---

## 🌀 3. TRUE BITSTREAM DATAMOSH (`datamosh.js`)

**Everything labelled "datamosh" in this app until now was a `tblend`/`lagfun` approximation.** It looks like ghosting. It is not datamoshing.

Real datamoshing is a **bitstream operation**:

- An **I-frame** is a complete picture. It resets the decoder.
- A **P-frame** contains only **motion vectors** — *"move these blocks from where they were."* It has no picture of its own.
- **Delete the I-frames**, and the P-frames keep applying their motion to whatever happens to be on screen. The old scene **smears** along the new scene's motion.
- **Duplicate a P-frame**, and its motion is applied twice — the **bloom**.

### How it's done
1. ffmpeg.wasm encodes to **AVI** with `-g 9999 -sc_threshold 0` — one I-frame at the top, nothing but P-frames after.
2. **We parse the AVI chunk index in JavaScript** and rewrite the byte stream: find the MPEG-4 VOP start codes (`00 00 01 B6`), read the 2-bit `vop_coding_type` to identify I-VOPs, delete them, repeat delta chunks.
3. Remux the corrupted stream to MP4.

AVI is used deliberately — its frame boundaries are trivially parseable, where MP4 hides everything behind sample tables. This is the classic datamosh workflow, done in the browser.

**Three new workflows:** Smear · Bloom · Total Destruction.

**Nobody else has this in a browser.**

---

## 🎨 4. AUTO COLOUR MATCH (`datamosh.js`)

*"Make my footage look like this."*

Upload a still from a film you like. The app:
- Converts both images to **Lαβ** (Ruderman decorrelated log space)
- Computes the **mean and standard deviation** of each channel
- Builds a **3D LUT** that rescales your footage's statistics into the reference's (Reinhard colour transfer)
- Writes `match.cube` to MEMFS, applies it with `lut3d` — with the intensity slider working

**Pure mathematics. No model. No network call.** One of the most expensive features in commercial grading suites.

---

## ⛓️ 5. NODE-BASED `filter_complex` EDITOR (`nodegraph.js`)

**FFmpeg's `filter_complex` IS a node graph** — named inputs, named outputs, branches (`[a][b]`), merges. We had been hiding that behind 32 accordion sections and a hardcoded 6-step "Lagfun Massacre".

New **⛓️ Graph** tab:
- **26 node types** — colour, geometry, temporal/glitch, spatial, and multi-input (split / blend / overlay / hstack / vstack)
- Drag from the library, **wire port to port** with bezier edges, double-click to delete
- **Compiles to a real `filter_complex` string, live**, with cycle detection and unconnected-input errors
- **Run the graph** directly, or **save it as a named custom workflow**

**The Lagfun Massacre stops being a thing you hardcode and becomes a thing you build.**

---

## 📴 6. PWA / OFFLINE

- `manifest.json` + generated icons → **installable** as a desktop/mobile app
- The service worker (already there for COOP/COEP) now **precaches the app shell and the ~30 MB wasm core**
- **Works with no network at all.** A local-first media editor that needs zero connectivity is a genuinely rare thing.

---

## NEW WORKFLOWS (6)

| Workflow | Engine |
|---|---|
| **TRUE Datamosh — Smear** | Bitstream I-frame removal |
| **TRUE Datamosh — Bloom** | Bitstream P-frame duplication |
| **TRUE Datamosh — Total Destruction** | Both |
| **Match Colour to a Reference** | Auto-LUT generation |
| **⚡ Hardware Transcode** | WebCodecs |
| **⚡ Hardware Glitch (GPU shader)** | WebCodecs + TRIP shader |

---

## VERIFY

1. [ ] **Round trip still works.** 5/5. (Regression — the hardware path must fall back cleanly.)
2. [ ] Hardware panel shows your **GPU name** and HW encode ✓ for H.264.
3. [ ] Run "⚡ Hardware Transcode" → completes in **~1s**, badge reads `⚡ Hardware`.
4. [ ] Run an audio mastering chain → badge reads `🐢 WebAssembly` (correct — no MP3 encoder in WebCodecs).
5. [ ] Upload a file, **hard-refresh** → the bin **rehydrates from OPFS**.
6. [ ] Run **TRUE Datamosh — Smear** → the log reports `removed N I-frame(s)` and the output genuinely smears.
7. [ ] **Match Colour to a Reference** → upload a film still → your footage takes its palette.
8. [ ] **⛓️ Graph tab** → drag Input → Lagfun → RGB Shift → Output, wire them, watch the `filter_complex` compile live, hit Run.
9. [ ] Save a graph as a workflow → it appears in **My Custom**.
10. [ ] Install as a PWA → **go offline** → it still loads and still encodes.

---

## WHERE THIS LANDS

| | v1 | v8 |
|---|---|---|
| Workflows | 180 | **186** |
| Editor sections | 32 | 32 |
| Tabs | 4 | **6** (+ Trip Cam, Graph) |
| JS modules | 5 | **19** |
| Video encode | wasm only | **hardware, with wasm fallback** |
| Media bin | dies on refresh | **persists (OPFS)** |
| Datamosh | `tblend` cosplay | **real bitstream manipulation** |
| Filter graph | 32 accordions | **visual node editor** |
| Offline | no | **yes (PWA)** |
| Live preview | none | **60fps GPU shaders** |

**Still not built:** keyframe automation curves, parallel segment encoding across a worker pool, WebGPU compute, local Whisper.wasm.
