# Browser app workflows → FFWORKS parity

Generated from the browser app's catalogue (`workflows.js`, `_v3`, `_v4`, `_v5`; `scripts/workflows/dump.js` → `browser_workflows.json`): **227 unique workflows** in 16 categories (the README's "215" is an older count).

## Status, honestly

* **Ported and tested: 19** — all of *audio-mastering*, as audio filter chains you apply to an audio clip from the Effects panel (`workflows.rs`, `AddAudioChain`; `tests/audioworkflows.rs` renders each on a tone and checks length and level, GUI `workflows.sh`).
* **Not ported, not yet checked one by one: 208.** FFWORKS already has the *capabilities* behind many of them (effects, LUTs, speed/reverse/freeze, transitions, export presets, pixel sort, the mosh/frame/corruption labs, loudness normalize) but they are not packaged as one-click workflows, and I have not verified, workflow by workflow, that the same result is reachable. Most of the browser app's workflows are *settings of its own control panel* (`settings` maps control ids such as `enable-3`, `scale-w` to values); what each does lives in `app.js`, so a faithful port means reading that mapping per workflow.

## By category

| Category | Workflows | Data in the catalogue | FFWORKS |
|---|---|---|---|
| video-editing | 20 | 17 × settings of the browser app's control panel; 2 × format/codec only; 1 × built in app code | not ported |
| speed-time | 7 | 7 × settings of the browser app's control panel | not ported |
| audio | 13 | 13 × settings of the browser app's control panel | not ported |
| color-grading | 23 | 16 × settings of the browser app's control panel; 7 × built in app code | not ported |
| glitch | 10 | 10 × settings of the browser app's control panel | not ported |
| social-media | 8 | 8 × settings of the browser app's control panel | not ported |
| gif | 4 | 4 × settings of the browser app's control panel | not ported |
| utility | 5 | 5 × settings of the browser app's control panel | not ported |
| audio-mastering | 19 | 19 × audio filter chain | **all ported** |
| video-glitch-pipelines | 36 | 11 × multi-step pipeline (described, steps built in app code); 25 × built in app code | not ported |
| audio-repair-utility | 18 | 18 × settings of the browser app's control panel | not ported |
| audio-visualization | 8 | 8 × settings of the browser app's control panel | not ported |
| multi-file-composites | 12 | 7 × format/codec only; 5 × settings of the browser app's control panel | not ported |
| retro-analog | 16 | 10 × settings of the browser app's control panel; 6 × built in app code | not ported |
| artistic-stylize | 13 | 12 × settings of the browser app's control panel; 1 × built in app code | not ported |
| motion-speed | 15 | 8 × settings of the browser app's control panel; 7 × built in app code | not ported |

## Every workflow

### video-editing

| id | name | data | status |
|---|---|---|---|
| `quick-trim` | Quick Trim | settings of the browser app's control panel | not ported |
| `convert-mp4-to-webm` | Convert MP4 → WebM | format/codec only | not ported |
| `convert-webm-to-mp4` | Convert WebM → MP4 | format/codec only | not ported |
| `compress-aggressive` | Reduce File Size (Aggressive) | settings of the browser app's control panel | not ported |
| `compress-moderate` | Reduce File Size (Moderate) | settings of the browser app's control panel | not ported |
| `downscale-720p` | Downscale to 720p | settings of the browser app's control panel | not ported |
| `downscale-480p` | Downscale to 480p | settings of the browser app's control panel | not ported |
| `downscale-360p` | Downscale to 360p | settings of the browser app's control panel | not ported |
| `fps-30` | Change Frame Rate to 30fps | settings of the browser app's control panel | not ported |
| `fps-24` | Change Frame Rate to 24fps (Cinematic) | settings of the browser app's control panel | not ported |
| `fps-60` | Change Frame Rate to 60fps | settings of the browser app's control panel | not ported |
| `extract-frame` | Extract Still Frame / Thumbnail | settings of the browser app's control panel | not ported |
| `rotate-90-cw` | Rotate 90° Clockwise | settings of the browser app's control panel | not ported |
| `rotate-90-ccw` | Rotate 90° Counter-Clockwise | settings of the browser app's control panel | not ported |
| `rotate-180` | Rotate 180° | settings of the browser app's control panel | not ported |
| `flip-horizontal` | Flip Horizontal (Mirror) | settings of the browser app's control panel | not ported |
| `flip-vertical` | Flip Vertical | settings of the browser app's control panel | not ported |
| `mute-strip-audio` | Mute Video (Strip Audio) | settings of the browser app's control panel | not ported |
| `max-quality-archive` | Max Quality Archive Export | settings of the browser app's control panel | not ported |
| `hw-transcode` | ⚡ Hardware Transcode | built in app code | not ported |

### speed-time

| id | name | data | status |
|---|---|---|---|
| `slow-0_5x` | Slow Motion 0.5× | settings of the browser app's control panel | not ported |
| `slow-0_25x` | Slow Motion 0.25× | settings of the browser app's control panel | not ported |
| `speed-2x` | Speed Up 2× | settings of the browser app's control panel | not ported |
| `speed-4x` | Speed Up 4× (Timelapse) | settings of the browser app's control panel | not ported |
| `speed-8x` | Speed Up 8× (Fast Timelapse) | settings of the browser app's control panel | not ported |
| `reverse-video` | Reverse Video | settings of the browser app's control panel | not ported |
| `boomerang` | Boomerang Loop | settings of the browser app's control panel | not ported |

### audio

| id | name | data | status |
|---|---|---|---|
| `extract-mp3` | Extract Audio as MP3 | settings of the browser app's control panel | not ported |
| `extract-wav` | Extract Audio as WAV (Lossless) | settings of the browser app's control panel | not ported |
| `extract-aac` | Extract Audio as AAC | settings of the browser app's control panel | not ported |
| `normalize-audio` | Normalize Audio (Loudness Standard) | settings of the browser app's control panel | not ported |
| `podcast-processing` | Podcast Processing | settings of the browser app's control panel | not ported |
| `bass-boost` | Bass Boost | settings of the browser app's control panel | not ported |
| `treble-boost` | Treble Boost | settings of the browser app's control panel | not ported |
| `add-echo` | Add Echo Effect | settings of the browser app's control panel | not ported |
| `add-flanger` | Add Flanger Effect | settings of the browser app's control panel | not ported |
| `tremolo-effect` | Tremolo Effect | settings of the browser app's control panel | not ported |
| `vibrato-effect` | Vibrato Effect | settings of the browser app's control panel | not ported |
| `audio-speed-1_5x` | Audio Speed Up 1.5× | settings of the browser app's control panel | not ported |
| `audio-slow-0_75x` | Audio Slow Down 0.75× | settings of the browser app's control panel | not ported |

### color-grading

| id | name | data | status |
|---|---|---|---|
| `blockbuster-orange-teal` | Blockbuster Orange & Teal | settings of the browser app's control panel | not ported |
| `moody-dark-cinematic` | Moody Dark Cinematic | settings of the browser app's control panel | not ported |
| `warm-golden-hour` | Warm Golden Hour | settings of the browser app's control panel | not ported |
| `cool-moonlight` | Cool Moonlight | settings of the browser app's control panel | not ported |
| `vhs-retro` | VHS Retro Look | settings of the browser app's control panel | not ported |
| `vintage-film` | Vintage Film | settings of the browser app's control panel | not ported |
| `sepia-tone` | Sepia Tone | settings of the browser app's control panel | not ported |
| `high-contrast-bw` | High Contrast Black & White | settings of the browser app's control panel | not ported |
| `desaturated-bleach-bypass` | Desaturated / Bleach Bypass | settings of the browser app's control panel | not ported |
| `neon-cyberpunk` | Neon Cyberpunk | settings of the browser app's control panel | not ported |
| `dream-ethereal` | Dream / Ethereal | settings of the browser app's control panel | not ported |
| `night-vision` | Night Vision | settings of the browser app's control panel | not ported |
| `film-grain-vignette` | Film Grain + Vignette | settings of the browser app's control panel | not ported |
| `cross-process` | Cross Process | settings of the browser app's control panel | not ported |
| `high-key-bright` | High Key Bright | settings of the browser app's control panel | not ported |
| `invert-negative` | Invert / Negative | settings of the browser app's control panel | not ported |
| `curve-film-contrast` | Curve — Film Contrast | built in app code | not ported |
| `curve-faded-matte` | Curve — Faded Matte | built in app code | not ported |
| `secondary-sky` | Secondary — Punch the Sky | built in app code | not ported |
| `secondary-skin` | Secondary — Warm the Skin | built in app code | not ported |
| `power-window-spotlight` | Power Window — Spotlight | built in app code | not ported |
| `power-window-darken-edges` | Power Window — Darken Surround | built in app code | not ported |
| `color-match` | Match Colour to a Reference | built in app code | not ported |

### glitch

| id | name | data | status |
|---|---|---|---|
| `datamosh-simulation` | Datamosh Simulation | settings of the browser app's control panel | not ported |
| `rgb-channel-split` | RGB Channel Split | settings of the browser app's control panel | not ported |
| `scanline-corruption` | Scanline Corruption | settings of the browser app's control panel | not ported |
| `vhs-tracking-error` | VHS Tracking Error | settings of the browser app's control panel | not ported |
| `frame-ghosting` | Frame Ghosting | settings of the browser app's control panel | not ported |
| `warp-melt` | Warp / Melt | settings of the browser app's control panel | not ported |
| `edge-detect-wireframe` | Edge Detect Wireframe | settings of the browser app's control panel | not ported |
| `posterize` | Posterize (Limited Colors) | settings of the browser app's control panel | not ported |
| `color-corruption` | Color Corruption | settings of the browser app's control panel | not ported |
| `frame-amplify` | Frame Amplify (Motion Trails) | settings of the browser app's control panel | not ported |

### social-media

| id | name | data | status |
|---|---|---|---|
| `instagram-post` | Instagram Post (Square 1:1) | settings of the browser app's control panel | not ported |
| `instagram-reel-tiktok` | Instagram Reel / TikTok (9:16) | settings of the browser app's control panel | not ported |
| `youtube-short` | YouTube Short (9:16 Vertical) | settings of the browser app's control panel | not ported |
| `twitter-x` | Twitter/X Video (16:9) | settings of the browser app's control panel | not ported |
| `discord-embed` | Discord Embed (< 8MB) | settings of the browser app's control panel | not ported |
| `whatsapp-status` | WhatsApp Status | settings of the browser app's control panel | not ported |
| `podcast-audiogram-1x1` | Podcast Audiogram (1:1 Square) | settings of the browser app's control panel | not ported |
| `reels-blur-bg` | Blurred-Background Vertical (Reels / Shorts) | settings of the browser app's control panel | not ported |

### gif

| id | name | data | status |
|---|---|---|---|
| `gif-standard` | Video to GIF (Standard) | settings of the browser app's control panel | not ported |
| `gif-high-quality` | Video to GIF (High Quality) | settings of the browser app's control panel | not ported |
| `gif-tiny` | Video to GIF (Tiny/Fast) | settings of the browser app's control panel | not ported |
| `gif-reverse` | Reverse GIF | settings of the browser app's control panel | not ported |

### utility

| id | name | data | status |
|---|---|---|---|
| `strip-metadata` | Strip All Metadata (Privacy) | settings of the browser app's control panel | not ported |
| `add-watermark` | Add Copyright Watermark | settings of the browser app's control panel | not ported |
| `preview-10s` | Preview First 10 Seconds | settings of the browser app's control panel | not ported |
| `fade-in-out` | Fade In + Fade Out | settings of the browser app's control panel | not ported |
| `letterbox` | Letterbox (Add Black Bars) | settings of the browser app's control panel | not ported |

### audio-mastering

| id | name | data | status |
|---|---|---|---|
| `am-bass-dubstep` | Bass-Boosted Dubstep Mastering | audio filter chain | ported |
| `am-country-trap` | Country Trap Mastering | audio filter chain | ported |
| `am-slushwave` | Slushwave Recipe | audio filter chain | ported |
| `am-tidal-ghost` | Tidal Ghost Ultimate | audio filter chain | ported |
| `am-ultimate-cd` | Ultimate CD Mastering | audio filter chain | ported |
| `am-cd-dual-comp` | CD Mastering (Dual Compression) | audio filter chain | ported |
| `am-slushwave-bass` | Slushwave Bass Preservation | audio filter chain | ported |
| `am-daycore-phonk` | Daycore Phonk Slush | audio filter chain | ported |
| `am-ambient-drone` | Ambient Drone v4 | audio filter chain | ported |
| `am-driftwave` | DriftWave Mastering | audio filter chain | ported |
| `am-vhs-warp` | VHS Warp Audio | audio filter chain | ported |
| `am-cyber-grind` | Cyber Grind Bass | audio filter chain | ported |
| `am-ethereal-wash` | Ethereal Wash | audio filter chain | ported |
| `am-nightdrive` | Nightdrive Echo | audio filter chain | ported |
| `am-lofi-tape` | Lo-Fi Tape Decay | audio filter chain | ported |
| `am-digital-glitch` | Digital Glitch Wash | audio filter chain | ported |
| `am-void-bass` | Void Bass Texture | audio filter chain | ported |
| `am-crystal-mesh` | Crystal Mesh Wash | audio filter chain | ported |
| `am-midnight-cascade` | Midnight Cascade | audio filter chain | ported |

### video-glitch-pipelines

| id | name | data | status |
|---|---|---|---|
| `vgp-lagfun-massacre` | LAGFUN MASSACRE MELTDOWN | multi-step pipeline (described, steps built in app code) | not ported |
| `vgp-max-entropy` | Maximum Entropy Lagfun Massacre | multi-step pipeline (described, steps built in app code) | not ported |
| `vgp-echo-ghost` | Echo Ghost Video | multi-step pipeline (described, steps built in app code) | not ported |
| `vgp-lagfun-dynamic` | Lagfun Dynamic Decay | multi-step pipeline (described, steps built in app code) | not ported |
| `vgp-tblend-diff` | Stacked tblend Difference | multi-step pipeline (described, steps built in app code) | not ported |
| `vgp-flip-chaos` | Flip/Mirror Chaos | multi-step pipeline (described, steps built in app code) | not ported |
| `vgp-reverse-echo` | Reverse Video + Audio Echo | multi-step pipeline (described, steps built in app code) | not ported |
| `vgp-speed-bass` | Speed Slowdown + Bass Boost | multi-step pipeline (described, steps built in app code) | not ported |
| `vgp-3way-alternating` | 3-Way Alternating FX | multi-step pipeline (described, steps built in app code) | not ported |
| `vgp-vhs-scanlines` | VHS Scan Lines | multi-step pipeline (described, steps built in app code) | not ported |
| `vgp-iframe-strip` | I-Frame Strip (Datamosh Prep) | multi-step pipeline (described, steps built in app code) | not ported |
| `true-datamosh-smear` | TRUE Datamosh — Smear | built in app code | not ported |
| `true-datamosh-bloom` | TRUE Datamosh — Bloom | built in app code | not ported |
| `true-datamosh-both` | TRUE Datamosh — Total Destruction | built in app code | not ported |
| `databend` | Databend | built in app code | not ported |
| `pixel-sort-masked` | Pixel Sort — Masked | built in app code | not ported |
| `pixel-sort-diagonal` | Pixel Sort — Diagonal | built in app code | not ported |
| `feedback-tunnel` | Feedback Tunnel | built in app code | not ported |
| `feedback-vortex` | Feedback Vortex | built in app code | not ported |
| `hw-glitch` | ⚡ Hardware Glitch (GPU shader) | built in app code | not ported |
| `mosh-classic-smear` | Motion Mosh — Classic Smear | built in app code | not ported |
| `mosh-total-liquefaction` | Motion Mosh — Total Liquefaction | built in app code | not ported |
| `mosh-pulse` | Motion Mosh — Pulse | built in app code | not ported |
| `mosh-bloom` | Motion Mosh — Bloom | built in app code | not ported |
| `mosh-compression-death` | Motion Mosh — Compression Death | built in app code | not ported |
| `mosh-ghost-trails` | Motion Mosh — Ghost Trails | built in app code | not ported |
| `mosh-scene-cut-only` | Motion Mosh — Scene-Cut Only | built in app code | not ported |
| `mosh-horizontal-smear` | Motion Mosh — Horizontal Smear | built in app code | not ported |
| `mosh-vertical-drip` | Motion Mosh — Vertical Drip | built in app code | not ported |
| `mosh-masked-mosh` | Motion Mosh — Masked Mosh | built in app code | not ported |
| `mosh-amplified-chaos` | Motion Mosh — Amplified Chaos | built in app code | not ported |
| `mosh-bloom-push` | Motion Mosh — Bloom Push | built in app code | not ported |
| `flow-liquid` | Flow Warp — Liquid | built in app code | not ported |
| `flow-heat-haze` | Flow Warp — Heat Haze | built in app code | not ported |
| `flow-riptide` | Flow Warp — Riptide | built in app code | not ported |
| `vector-overlay` | Motion Vectors — Overlay | built in app code | not ported |

### audio-repair-utility

| id | name | data | status |
|---|---|---|---|
| `vocal-removal` | Vocal Removal (Karaoke) | settings of the browser app's control panel | not ported |
| `isolate-center` | Isolate Center (Vocals Only) | settings of the browser app's control panel | not ported |
| `stereo-to-mono` | Stereo → Mono | settings of the browser app's control panel | not ported |
| `mono-to-stereo` | Mono → Stereo | settings of the browser app's control panel | not ported |
| `swap-lr` | Swap Left / Right | settings of the browser app's control panel | not ported |
| `noise-gate` | Noise Gate (Remove Room Tone) | settings of the browser app's control panel | not ported |
| `de-esser` | De-Esser (Notch 6kHz) | settings of the browser app's control panel | not ported |
| `telephone` | Telephone Effect | settings of the browser app's control panel | not ported |
| `megaphone` | Megaphone / PA System | settings of the browser app's control panel | not ported |
| `radio-am` | Radio / AM Broadcast | settings of the browser app's control panel | not ported |
| `underwater` | Underwater | settings of the browser app's control panel | not ported |
| `8d-audio` | 8D Audio (Rotating Pan) | settings of the browser app's control panel | not ported |
| `pitch-up-5` | Pitch Up +5 Semitones (Chipmunk) | settings of the browser app's control panel | not ported |
| `pitch-down-5` | Pitch Down −5 Semitones (Deep) | settings of the browser app's control panel | not ported |
| `nightcore` | Nightcore (+Pitch +Tempo) | settings of the browser app's control panel | not ported |
| `screwed-chopped` | Screwed & Chopped | settings of the browser app's control panel | not ported |
| `sample-rate-48k` | Sample Rate → 48 kHz | settings of the browser app's control panel | not ported |
| `sample-rate-441` | Sample Rate → 44.1 kHz | settings of the browser app's control panel | not ported |

### audio-visualization

| id | name | data | status |
|---|---|---|---|
| `waveform-line` | Waveform Video (Line) | settings of the browser app's control panel | not ported |
| `waveform-scatter` | Waveform Video (Point Scatter) | settings of the browser app's control panel | not ported |
| `spectrum-analyzer` | Spectrum Analyzer Video | settings of the browser app's control panel | not ported |
| `frequency-bars` | Frequency Bars | settings of the browser app's control panel | not ported |
| `cqt-spectrum` | CQT Music Spectrum | settings of the browser app's control panel | not ported |
| `audiogram` | Audiogram (Waveform over Image) | settings of the browser app's control panel | not ported |
| `vinyl-spin-audiogram` | Vinyl Spin Audiogram | settings of the browser app's control panel | not ported |
| `music-video-spectrum` | Full Music Video (Spectrum + Video) | settings of the browser app's control panel | not ported |

### multi-file-composites

| id | name | data | status |
|---|---|---|---|
| `concat-sequential` | Concatenate (Sequential Join) | format/codec only | not ported |
| `side-by-side` | Side-by-Side (Horizontal) | format/codec only | not ported |
| `stacked-vertical` | Stacked (Vertical) | format/codec only | not ported |
| `grid-2x2` | 2×2 Grid (4 files) | format/codec only | not ported |
| `picture-in-picture` | Picture-in-Picture | format/codec only | not ported |
| `add-soundtrack` | Add Soundtrack to Video | format/codec only | not ported |
| `replace-audio` | Replace Audio Track | format/codec only | not ported |
| `mix-2-audio` | Mix Two Audio Tracks | settings of the browser app's control panel | not ported |
| `image-watermark` | Image Watermark Overlay | settings of the browser app's control panel | not ported |
| `crossfade` | Crossfade Two Clips | settings of the browser app's control panel | not ported |
| `green-screen` | Green Screen Composite | settings of the browser app's control panel | not ported |
| `blend-2-videos` | Blend Two Videos | settings of the browser app's control panel | not ported |

### retro-analog

| id | name | data | status |
|---|---|---|---|
| `full-crt` | Full CRT Monitor | settings of the browser app's control panel | not ported |
| `vhs-tracking` | VHS Tracking Error | settings of the browser app's control panel | not ported |
| `signal-dropout` | Signal Dropout | settings of the browser app's control panel | not ported |
| `interlaced-broadcast` | Interlaced Broadcast | settings of the browser app's control panel | not ported |
| `film-projector` | Film Projector | settings of the browser app's control panel | not ported |
| `old-film-scratches` | Old Film Scratches | settings of the browser app's control panel | not ported |
| `betamax-degrade` | Betamax Degrade | settings of the browser app's control panel | not ported |
| `security-camera` | Security Camera | settings of the browser app's control panel | not ported |
| `thermal-vision` | Thermal Vision | settings of the browser app's control panel | not ported |
| `night-vision-phosphor` | Night Vision (Green Phosphor) | settings of the browser app's control panel | not ported |
| `lens-vintage-wide` | Lens — Vintage Wide | built in app code | not ported |
| `lens-cctv` | Lens — Cctv | built in app code | not ported |
| `lens-anamorphic` | Lens — Anamorphic | built in app code | not ported |
| `lens-tele-pincushion` | Lens — Tele Pincushion | built in app code | not ported |
| `jello-sim` | Rolling Shutter (jello) | built in app code | not ported |
| `film-grain` | Film Grain | built in app code | not ported |

### artistic-stylize

| id | name | data | status |
|---|---|---|---|
| `cartoon-cel` | Cartoon / Cel Shade | settings of the browser app's control panel | not ported |
| `oil-painting` | Oil Painting | settings of the browser app's control panel | not ported |
| `ascii-art` | ASCII Art Video | settings of the browser app's control panel | not ported |
| `halftone` | Halftone Print | settings of the browser app's control panel | not ported |
| `pixel-art` | Pixel Art (Nearest Neighbor) | settings of the browser app's control panel | not ported |
| `duotone` | Duotone (Two-Color Map) | settings of the browser app's control panel | not ported |
| `solarize` | Solarize | settings of the browser app's control panel | not ported |
| `neon-edge` | Neon Edge Glow | settings of the browser app's control panel | not ported |
| `chromatic-bloom` | Chromatic Bloom | settings of the browser app's control panel | not ported |
| `kaleidoscope` | Kaleidoscope | settings of the browser app's control panel | not ported |
| `mirror-lr` | Mirror (Left → Right) | settings of the browser app's control panel | not ported |
| `droste-zoom` | Infinite Zoom (Droste) | settings of the browser app's control panel | not ported |
| `halation-bloom` | Halation & Bloom | built in app code | not ported |

### motion-speed

| id | name | data | status |
|---|---|---|---|
| `ken-burns-in` | Ken Burns Zoom In | settings of the browser app's control panel | not ported |
| `ken-burns-out` | Ken Burns Zoom Out | settings of the browser app's control panel | not ported |
| `handheld-shake` | Handheld Camera Shake | settings of the browser app's control panel | not ported |
| `speed-ramp` | Speed Ramp (Slow → Fast) | settings of the browser app's control panel | not ported |
| `freeze-punch` | Freeze Frame Punch-In | settings of the browser app's control panel | not ported |
| `stutter` | Stutter / Frame Hold | settings of the browser app's control panel | not ported |
| `loop-n` | Loop 3 Times | settings of the browser app's control panel | not ported |
| `ping-pong` | Ping-Pong Loop (Boomerang) | settings of the browser app's control panel | not ported |
| `deflicker` | Deflicker (timelapse) | built in app code | not ported |
| `jello-correct` | De-jello (correct skew) | built in app code | not ported |
| `speed-blur-4x` | Timelapse 4× (motion blur) | built in app code | not ported |
| `stabilise` | Stabilise | built in app code | not ported |
| `flow-slomo` | Slow-Mo (optical flow) | built in app code | not ported |
| `blend-slomo` | Slow-Mo (frame blend) | built in app code | not ported |
| `auto-reframe` | Auto-Reframe → Vertical | built in app code | not ported |
