# FFmpeg Studio v10 — THE HARVEST

**27 JS modules, all `node -c` clean. CSS 725/725 balanced. 9 tabs.**

I went through all six apps. Here's what was worth taking — and one of them makes an entire feature of this app obsolete.

---

## 🌀 1. REAL MOTION-VECTOR DATAMOSHING (from **Datamosh Lab**)

**This is the big one, and it retires both of my previous datamosh implementations.**

| Version | What it did | Verdict |
|---|---|---|
| v1–v7 | `tblend` / `lagfun` | **Ghosting. Not datamoshing.** |
| v8 | AVI bitstream I-frame removal | Real, but **offline**, MPEG-4 only, and only works if ffmpeg lays the file out the way the parser expects |
| **v10** | **Motion estimation in JavaScript** | **The actual thing the codec does. Any video. Real time.** |

Your Datamosh Lab does what a video codec does, itself:

1. Split the frame into blocks.
2. For each block, **search the previous frame for where that block came from** — block matching, minimising **Sum of Absolute Differences**. That displacement **is a motion vector.** It is precisely what a P-frame stores.
3. **Apply those motion vectors to the wrong picture.**

The old scene gets dragged along the new scene's motion. That's datamoshing — no ffmpeg, no bitstream parsing, no container assumptions, and it works on **any** video.

It runs at frame rate because the search starts from the neighbouring block's vector (motion is spatially coherent, so that's a far better guess than zero) and subsamples inside the block.

Ported with everything:
- **Scene-cut auto-mosh** — a cut is exactly where the codec *would* insert a keyframe, and we refuse to. That's why moshing looks best there.
- **I-frame interval** — 0 = never recover. >0 = breathe.
- **JPEG artifact pass** — re-encodes each frame at quality 0.2 and reads it back. Genuine DCT blocking, because it *is* genuine DCT blocking.
- **Motion vector overlay** — see the field you're moshing with.
- **Mosh Cut** trigger, **Force I-Frame** reset.

**7 new workflows:** Classic Smear · Total Liquefaction · Pulse · Bloom · Compression Death · Ghost Trails · Scene-Cut Only.

---

## 🎛️ 2. VJ MODE (from **SauceLab VJ**)

Everything in this app has been about *making a file*. This is about **performing**.

- **MIDI learn** — Web MIDI. Twist a knob on your controller, bind it to any parameter. Hit a pad, fire an effect. Mappings persist.
- **Keyboard as an instrument** — **hold a key for a stab, Shift+key to latch it on.** That distinction *is* the ergonomics of live performance, and it's why a VJ tool can't just be a checkbox list.
- **16-step sequencer** with **tap tempo** — because nobody sets a BPM by typing a number in a dark room.
- **Beat-sync** — locks the sequencer to the *actual* detected BPM of the loaded track.
- **15 trigger pads:** Flash · Strobe · Invert · Kaleidoscope · Mirror · Pixelate · Wave · Chromatic · Smear · Glitch · **Datamosh** · Freeze · Zoom Punch · RGB Split · Blackout.
- **FPS monitor** — dropping frames on stage is the only bug that matters.

The strobe runs on the frame clock, not a timer, because it has to be frame-accurate.

---

## 🎹 3. MUSICAL INTELLIGENCE (from **Aesthetic Audio**)

**The app should know what the music is.**

- **Key detection** — chromagram via Goertzel per semitone across 6 octaves, correlated against the **Krumhansl-Schmuckler** major/minor profiles. Returns key, mode, and confidence.
- **Tempo detection** — spectral-flux onsets + autocorrelation of the envelope. Returns BPM *and beat positions* — which go straight onto the waveform (finally giving the beat ticks something to draw on) and into the VJ sequencer.
- **Musical intervals instead of semitones.** "0.75× speed" means nothing. **"Down a perfect fourth, to G minor"** means everything. And it warns you when a speed change lands **out of tune** by more than 8 cents.

## 🫠 4. SEMANTIC MACROS (also Aesthetic Audio)

Nobody thinks *"I want a 6 kHz low-pass at Q 0.7 with 40% wet convolution."* They think **"make it MELT."**

Five macros, each moving a coordinated set of the 23 real parameters along a curve that always sounds good:

**🫠 MELT** · **🫥 MUFFLE** · **🌊 WASH** · **🧊 SLUSH** · **📻 VINTAGE**

They **compose** — and they take the *more extreme* of any two values rather than averaging them into blandness. The 23 real knobs are still right there underneath. This is a shortcut, not a replacement.

---

## 🎬 5. CLIP LIBRARY (from **Trippy Cam Clip Studio**)

The missing link between *"I recorded something cool"* and *"I have a finished piece."*

A clip library is **not** a media bin. Clips are **outputs**, not inputs — they have take numbers, they need reviewing fast in a grid, and the bad ones need binning.

- Every **Trip Cam / VJ recording** now lands here as a numbered take
- **Hover a card to preview** it
- **Drag to reorder — the order is the edit**
- **Drop a music track underneath** the whole sequence
- **Export the entire session as one piece** — concat + audio bed, in one click

---

## WHAT I DIDN'T TAKE, AND WHY

- **Trippy Effects' chatbot** — a rhyming psychedelic assistant is charming but it isn't a media tool.
- **The 3D video cube (THREE.js)** — genuinely fun, but it's a *presentation* effect, not a manipulation, and it would drag a 600 KB dependency in for one shader.
- **Neural effects** — the module is a stub; there's no actual model behind it.
- **Trippy Cam 2.0** — everything in it is already in our Trip Cam, at higher fidelity.

Sparkle/particle overlays are a reasonable future addition but they belong in the shader pipeline, not as a separate system.

---

## VERIFY

1. [ ] **Motion Mosh — Classic Smear** on a real video. The scene should visibly **drag itself** into the next one. Compare it to the old `tblend` "datamosh" — it isn't close.
2. [ ] **Compression Death** → visible DCT blocking, because the frames are genuinely being JPEG'd.
3. [ ] **VJ Mode** → hold `Q` for a flash stab. `Shift+A` to latch a smear. `TAP` four times → BPM locks.
4. [ ] Plug in a MIDI controller → **MIDI Learn** → twist a knob → it binds and persists.
5. [ ] Sequencer: click cells on the grid, hit ▶ — **effects fire on the beat**.
6. [ ] Load a track in the **Audio Studio** → key and BPM appear. Beat ticks appear **on the waveform**.
7. [ ] Drag **MELT** to 60 → the whole rack moves as one, and you hear it immediately.
8. [ ] Record 3 takes in Trip Cam → they appear in **Clips** → reorder → add an audio bed → **Export sequence** → one file.
9. [ ] **Round trip still works.** (Regression.)

---

## WHERE IT LANDS

| | v9 | v10 |
|---|---|---|
| Tabs | 7 | **9** (+ VJ Mode, Clips) |
| JS modules | 22 | **27** |
| Datamosh | `tblend` cosplay + an offline bitstream hack | **Real motion vectors, any video, real time** |
| Live performance | none | **MIDI + keyboard + 16-step sequencer** |
| Audio knowledge | duration and sample rate | **Key, mode, BPM, beat positions** |
| Audio UX | 23 technical parameters | **+ 5 macros that speak English** |
| Recordings | dumped into the media bin | **A clip library you can sequence** |
