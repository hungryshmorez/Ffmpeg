# FFmpeg Studio v9 — AUDIO / VIDEO SPLIT

**22 JS modules, all passing `node -c`. CSS balanced. 7 tabs, 7 panels.**

---

## THE PROBLEM

The app had grown to 6 tabs, 32 editor sections, 186 workflows and 13 agents. Someone who doesn't already know what's going on opens it and sees a wall.

## THE FIX — one question at the top

**"What are you working on — audio or video?"** Everything reshapes around the answer.

```
  ♪ AUDIO                          ▶ VIDEO
  ├─ 🎛 Studio    (live rack)      ├─ 📋 Workflows (video only)
  ├─ 📋 Workflows (audio only)     ├─ ✂️ Editor    (32 sections)
  └─ ▶ Preview                     ├─ 🌀 Trip Cam  (real-time GPU glitch)
                                   ├─ ⛓️ Graph     (node editor)
                                   ├─ ▶ Preview
                                   └─ 🤖 Agents

  ⚙ Everything → all 7 tabs at once (for when you know what you want)
```

**Nothing was removed.** Every feature is still there. It's just no longer all shouting at you simultaneously.

- **First-run screen**: two big buttons, one question. Not a tour, not a wall.
- **Mode bar** persists the choice to `localStorage`. Switch any time.
- **Workflows tab gets Audio / Video / All sub-tabs** — and category pills hide themselves when they're irrelevant to the current sub-tab.
- **The Media Bin stays global.** A file is a file. But clicking an **audio** file in the bin now opens it in the **Audio Studio**, and a video file opens in the Editor. Obvious — and previously not the case.

---

## 🎛 THE AUDIO STUDIO (`audio-engine.js` + `audio-studio.js`)

**Ported from your Driftwave / Slushwave Vaporizer.** And it fixes something that has been wrong with this app since v1.

### The insight

FFmpeg Studio has always processed audio the way it processes video: build a filter string → hand it to wasm → **wait 10–30 seconds** → listen → adjust → wait again.

**For video that's unavoidable. For audio it is completely unnecessary.**

The Web Audio API does reverb, delay, chorus, phaser, EQ, distortion, pitch and speed **in real time, natively, on the audio thread.** You drag a knob and **you hear it.** No render. No wait. No wasm.

So the Studio drives the live preview, and **ffmpeg.wasm is used exactly once — at the very end — to encode the bounce**, and only because Web Audio cannot write MP3/AAC/FLAC.

That's the correct division of labour, and it makes the audio side of this app feel like an **instrument** instead of a form submission.

### The rack — 7 modules, 23 live knobs

| Module | Knobs |
|---|---|
| ⏱ **Transport** | Speed (0.5–1.5×) · Pitch (±12 st, independent of speed) · Volume |
| 🎚 **EQ & Filter** | Bass Boost · Low · Mid · High · Low-Pass |
| 🌫 **Reverb** | Mix · Room · Decay *(generated impulse response — no IR file to download)* |
| 🔁 **Delay** | Mix · Time · Feedback *(real feedback loop)* |
| 〰️ **Chorus** | Mix · Rate · Depth · Delay *(modulated delay line — this is the tape-warble knob)* |
| 🌀 **Phaser** | Rate · Depth · Feedback *(4-stage all-pass cascade with an LFO)* |
| 🔥 **Distortion** | Drive · Tone *(waveshaper, 4× oversampled)* |

A module whose Mix is at zero **visually dims itself** — instant read of what's actually on.

### 12 presets

Slushwave Classic · Vaporwave Dream · Lo-fi Chill · Nightcore · Chopped & Screwed · **Slowed + Reverb** · Bass Boost · Bass Boost Extreme · Drift Phonk · Cathedral · Tape Warble · Underwater

### The player
- **Live spectrum visualizer** — 64 bars, log-frequency mapped, hue shifts cyan→magenta as it gets loud
- Scrub, play/pause, **spacebar**
- A banner that says the important thing plainly: *"🔊 Live. Every knob you turn is heard instantly — nothing is rendered until you Bounce."*

### Bounce
- Renders through an **`OfflineAudioContext`** — the whole graph, **faster than real time**, no ffmpeg
- **WAV needs no ffmpeg at all** (there's a WAV writer in the engine)
- MP3 320k / AAC 256k / FLAC → one ffmpeg pass, purely to encode
- **"Normalise to −14 LUFS"** checkbox → runs the **two-pass loudnorm** and then **reads the result back on the meter to prove it hit the target**
- Output lands in the Media Bin **and** downloads

### The 19 FFmpeg mastering chains are still there
Tucked into an **"FFmpeg mastering chains"** disclosure at the bottom of the Bounce panel — because they're a *different tool* (offline, filter-based) and shouldn't be mixed in with the live rack. They're one dropdown away when you want them.

---

## VERIFY

1. [ ] **First load** → "What are you working on?" → pick **Audio**.
2. [ ] Only **Studio · Workflows · Preview** are visible. The wall is gone.
3. [ ] Drop an MP3 into the Studio → spectrum animates, transport works.
4. [ ] **Drag the Reverb Mix knob while it's playing → you hear the room appear immediately.** No render. *(This is the whole point.)*
5. [ ] Click **Slowed + Reverb** → the whole rack snaps to the preset, still live.
6. [ ] Modules with Mix at 0 are **dimmed**.
7. [ ] **Bounce** → MP3, normalise on → the LUFS meter reads back ≈ **−14**.
8. [ ] The bounced file appears in the **Media Bin** and downloads.
9. [ ] Switch to **Video** mode → Editor, Trip Cam, Graph, Agents reappear.
10. [ ] Workflows tab → **Audio / Video / All** sub-tabs filter the 186 cards correctly.
11. [ ] Click an **audio** file in the Media Bin → it opens in the **Studio**, not the Editor.
12. [ ] **⚙ Everything** mode → all 7 tabs.
13. [ ] **Round trip still works.** (Regression — none of this touched the render path.)

---

## WHERE IT LANDS

| | Before | Now |
|---|---|---|
| First impression | 6 tabs, 32 sections, 186 workflows, no guidance | **One question** |
| Audio editing | build filter string → wait 20s → listen → repeat | **Turn a knob, hear it** |
| Audio preview | none | **Real-time, 23 params, spectrum** |
| Workflows | 186 in one undifferentiated grid | **Audio / Video / All** |
| Bin → click a track | opened the video editor | **opens the Audio Studio** |
| Mastering chains | mixed in with everything | **one disclosure away, where they belong** |
