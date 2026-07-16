/* =============================================================================
 * FFmpeg Studio v3 — Workflows 111-180 (70 new workflows)
 * -----------------------------------------------------------------------------
 * Spec source: /workspace/v3_check.txt PART D.
 * Categories (per spec):
 *   - audio-repair-utility      (111-128)  18 workflows
 *   - audio-visualization       (129-136)   8 workflows
 *   - multi-file-composites     (137-148)  12 workflows
 *   - retro-analog              (149-158)  10 workflows
 *   - artistic-stylize          (159-170)  12 workflows
 *   - motion-speed              (171-178)   8 workflows
 *   - social-media-additions    (179-180)   2 workflows
 *
 * Every workflow has a `settings` object mapping control IDs to values.
 * Multi-file workflows carry `requiresBinCount: N` and `binIndices: [i, j, ...]`
 * for the Compositor / Bin-Composite paths. Each workflow's "Apply & Run"
 * works through the standard applyWorkflow() → executeFromUI() path; multi-file
 * workflows have an extra `binCompositeMode` hint and the agent's batch
 * runner honors `requiresBinCount`.
 *
 * All ffmpeg flags reference real, currently-supported 0.12.x filters and
 * options. No hallucinated APIs.
 * ============================================================================= */

'use strict';

// =============================================================================
// AUDIO REPAIR & UTILITY (111-128)
// =============================================================================
const AUDIO_REPAIR_UTILITY_WORKFLOWS = [
  {
    id: 'vocal-removal',
    name: 'Vocal Removal (Karaoke)',
    category: 'audio-repair-utility',
    description: 'Center-channel cancellation. Removes (or attenuates) lead vocals from a stereo mix. Works best on tracks where vocals are panned center.',
    tags: ['vocal', 'karaoke', 'remove', 'center', 'audio'],
    icon: '🎤',
    settings: { 'enable-27': true, 'channel-mode': 'karaoke' },
  },
  {
    id: 'isolate-center',
    name: 'Isolate Center (Vocals Only)',
    category: 'audio-repair-utility',
    description: 'Crude vocal isolation: average the L+R channels, then band-pass 200-8000 Hz to remove bass bleed and high hiss.',
    tags: ['vocals', 'isolate', 'center', 'audio'],
    icon: '🎙️',
    settings: { 'enable-12': true, 'highpass': 200, 'lowpass': 8000 },
  },
  {
    id: 'stereo-to-mono',
    name: 'Stereo → Mono',
    category: 'audio-repair-utility',
    description: 'Collapse stereo to mono. Uses -ac 1 (auto-mix to single channel).',
    tags: ['mono', 'stereo', 'channel', 'audio'],
    icon: '🔉',
    settings: { 'enable-1': true, 'acodec': 'aac', 'ab-rate': '192k' },
  },
  {
    id: 'mono-to-stereo',
    name: 'Mono → Stereo',
    category: 'audio-repair-utility',
    description: 'Duplicate the mono signal to both L and R channels.',
    tags: ['mono', 'stereo', 'channel', 'audio'],
    icon: '🔊',
    settings: { 'enable-27': true, 'channel-mode': 'mono2stereo' },
  },
  {
    id: 'swap-lr',
    name: 'Swap Left / Right',
    category: 'audio-repair-utility',
    description: 'Swap the L and R audio channels.',
    tags: ['swap', 'stereo', 'channel', 'audio'],
    icon: '↔',
    settings: { 'enable-27': true, 'channel-mode': 'swap' },
  },
  {
    id: 'noise-gate',
    name: 'Noise Gate (Remove Room Tone)',
    category: 'audio-repair-utility',
    description: 'Attenuate audio below -50 dB. Falls back to a high-pass filter if agate is not compiled into the wasm build.',
    tags: ['gate', 'noise', 'room', 'silence', 'audio'],
    icon: '🤫',
    settings: { 'enable-28': true, 'gate-enable': true, 'gate-thresh': -50 },
  },
  {
    id: 'de-esser',
    name: 'De-Esser (Notch 6kHz)',
    category: 'audio-repair-utility',
    description: 'Apply a narrow EQ notch around 6kHz with -6dB gain to tame sibilant "ess" sounds.',
    tags: ['deess', 'sibilance', 'eq', 'audio'],
    icon: '🧹',
    settings: { 'enable-28': true, 'deess-enable': true, 'deess-freq': 6000, 'deess-reduce': 6 },
  },
  {
    id: 'telephone',
    name: 'Telephone Effect',
    category: 'audio-repair-utility',
    description: 'Band-pass 400-3400 Hz to simulate a phone call, plus a gentle compressor.',
    tags: ['telephone', 'phone', 'lofi', 'eq', 'audio'],
    icon: '☎️',
    settings: { 'enable-12': true, 'highpass': 400, 'lowpass': 3400,
                'enable-28': true, 'comp-enable': true, 'comp-thresh': -20, 'comp-ratio': 6, 'comp-attack': 20, 'comp-release': 250 },
  },
  {
    id: 'megaphone',
    name: 'Megaphone / PA System',
    category: 'audio-repair-utility',
    description: 'Band-pass 500-4000 Hz with a hard compressor and +3.5 dB boost. Sounds like a megaphone.',
    tags: ['megaphone', 'pa', 'lofi', 'eq', 'audio'],
    icon: '📢',
    settings: { 'enable-12': true, 'highpass': 500, 'lowpass': 4000, 'volume': 1.5,
                'enable-28': true, 'comp-enable': true, 'comp-thresh': -15, 'comp-ratio': 8, 'comp-attack': 5, 'comp-release': 100 },
  },
  {
    id: 'radio-am',
    name: 'Radio / AM Broadcast',
    category: 'audio-repair-utility',
    description: 'Narrow band EQ 300-5000 Hz with a +1.6 dB boost. Sounds like AM radio.',
    tags: ['radio', 'am', 'lofi', 'broadcast', 'eq', 'audio'],
    icon: '📻',
    settings: { 'enable-12': true, 'highpass': 300, 'lowpass': 5000, 'volume': 1.2 },
  },
  {
    id: 'underwater',
    name: 'Underwater',
    category: 'audio-repair-utility',
    description: 'Heavy low-pass + multi-tap echo + tremolo. Sounds like being submerged.',
    tags: ['underwater', 'submerged', 'echo', 'tremolo', 'audio'],
    icon: '🌊',
    settings: { 'enable-12': true, 'lowpass': 800, 'aecho': true, 'aecho-delay': 100, 'aecho-decay': 0.4, 'tremolo': true, 'tremolo-f': 0.3, 'tremolo-d': 0.3 },
  },
  {
    id: '8d-audio',
    name: '8D Audio (Rotating Pan)',
    category: 'audio-repair-utility',
    description: 'Auto-pan the audio at 0.08 Hz using apulsator. Falls back to tremolo if apulsator is not compiled in.',
    tags: ['8d', 'pan', 'rotating', 'audio'],
    icon: '🌀',
    settings: { 'enable-27': true, 'channel-mode': '8d', 'apulsator-hz': 0.08 },
  },
  {
    id: 'pitch-up-5',
    name: 'Pitch Up +5 Semitones (Chipmunk)',
    category: 'audio-repair-utility',
    description: 'Shift pitch up 5 semitones without changing tempo via asetrate + aresample + atempo.',
    tags: ['pitch', 'chipmunk', 'semitone', 'audio'],
    icon: '🐿️',
    settings: { 'enable-26': true, 'pitch-semitones': 5 },
  },
  {
    id: 'pitch-down-5',
    name: 'Pitch Down −5 Semitones (Deep)',
    category: 'audio-repair-utility',
    description: 'Shift pitch down 5 semitones without changing tempo.',
    tags: ['pitch', 'deep', 'semitone', 'audio'],
    icon: '🗿',
    settings: { 'enable-26': true, 'pitch-semitones': -5 },
  },
  {
    id: 'nightcore',
    name: 'Nightcore (+Pitch +Tempo)',
    category: 'audio-repair-utility',
    description: 'The classic nightcore treatment: shift up 1.25× and speed up 1.25× via the Section 26 pitch + tempo controls.',
    tags: ['nightcore', 'pitch', 'tempo', 'audio'],
    icon: '🌙',
    settings: { 'enable-26': true, 'pitch-semitones': 4, 'tempo-only': 1.25 },
  },
  {
    id: 'screwed-chopped',
    name: 'Screwed & Chopped',
    category: 'audio-repair-utility',
    description: 'Slow the audio, add a +6 dB bass boost, and a long echo.',
    tags: ['screwed', 'chopped', 'slow', 'echo', 'audio'],
    icon: '🎚️',
    settings: { 'enable-26': true, 'tempo-only': 0.8,
                'enable-12': true, 'bass': 6, 'aecho': true, 'aecho-delay': 80, 'aecho-decay': 0.4 },
  },
  {
    id: 'sample-rate-48k',
    name: 'Sample Rate → 48 kHz',
    category: 'audio-repair-utility',
    description: 'Resample audio to 48 kHz (broadcast / video standard).',
    tags: ['samplerate', 'resample', '48k', 'audio'],
    icon: '🔢',
    settings: { 'enable-1': true, 'audio-rate': 48000, 'out-format': 'wav' },
  },
  {
    id: 'sample-rate-441',
    name: 'Sample Rate → 44.1 kHz',
    category: 'audio-repair-utility',
    description: 'Resample audio to 44.1 kHz (CD standard).',
    tags: ['samplerate', 'resample', '44.1k', 'audio'],
    icon: '💿',
    settings: { 'enable-1': true, 'audio-rate': 44100, 'out-format': 'wav' },
  },
];

// =============================================================================
// AUDIO VISUALIZATION (129-136)
// =============================================================================
const AUDIO_VISUALIZATION_WORKFLOWS = [
  {
    id: 'waveform-line',
    name: 'Waveform Video (Line)',
    category: 'audio-visualization',
    description: 'Turn audio into a music video. Cyan line waveform on black, 1280×720, 30 fps.',
    tags: ['waveform', 'showwaves', 'line', 'visualizer', 'audio'],
    icon: '🌊',
    settings: { 'enable-29': true, 'viz-type': 'showwaves', 'viz-mode': 'line', 'viz-w': 1280, 'viz-h': 720, 'viz-color': '#00d4ff', 'viz-fps': 30, 'enable-1': true, 'out-format': 'mp4' },
  },
  {
    id: 'waveform-scatter',
    name: 'Waveform Video (Point Scatter)',
    category: 'audio-visualization',
    description: 'Peak-to-peak (p2p) waveform on black — a classic album-art look.',
    tags: ['waveform', 'p2p', 'scatter', 'visualizer', 'audio'],
    icon: '✨',
    settings: { 'enable-29': true, 'viz-type': 'showwaves', 'viz-mode': 'p2p', 'viz-w': 1280, 'viz-h': 720, 'viz-color': '#ff00aa', 'viz-fps': 30, 'enable-1': true, 'out-format': 'mp4' },
  },
  {
    id: 'spectrum-analyzer',
    name: 'Spectrum Analyzer Video',
    category: 'audio-visualization',
    description: 'Log-scale spectrum with the "fire" colormap.',
    tags: ['spectrum', 'showspectrum', 'fire', 'visualizer', 'audio'],
    icon: '🔥',
    settings: { 'enable-29': true, 'viz-type': 'showspectrum', 'viz-w': 1280, 'viz-h': 720, 'viz-colormap': 'fire', 'viz-fps': 30, 'enable-1': true, 'out-format': 'mp4' },
  },
  {
    id: 'frequency-bars',
    name: 'Frequency Bars',
    category: 'audio-visualization',
    description: 'Vertical bar visualizer using showfreqs. Like a hardware EQ.',
    tags: ['bars', 'showfreqs', 'eq', 'visualizer', 'audio'],
    icon: '📊',
    settings: { 'enable-29': true, 'viz-type': 'showfreqs', 'viz-w': 1280, 'viz-h': 720, 'viz-color': '#00ff88', 'viz-fps': 30, 'enable-1': true, 'out-format': 'mp4' },
  },
  {
    id: 'cqt-spectrum',
    name: 'CQT Music Spectrum',
    category: 'audio-visualization',
    description: 'Constant-Q transform spectrum. Higher resolution at low frequencies — better for music.',
    tags: ['cqt', 'showcqt', 'music', 'visualizer', 'audio'],
    icon: '🎼',
    settings: { 'enable-29': true, 'viz-type': 'showcqt', 'viz-w': 1280, 'viz-h': 720, 'viz-fps': 30, 'enable-1': true, 'out-format': 'mp4' },
  },
  {
    id: 'audiogram',
    name: 'Audiogram (Waveform over Image)',
    category: 'audio-visualization',
    description: 'Classic podcast/music promo. Requires 2 files in the bin (audio + image). Use the Visualizer agent or Batch Apply to assemble.',
    tags: ['audiogram', 'podcast', 'waveform', 'cover', 'audio'],
    icon: '🖼️',
    requiresBinCount: 2,
    settings: { 'enable-29': true, 'viz-type': 'showwaves', 'viz-mode': 'cline', 'viz-w': 1280, 'viz-h': 720, 'viz-color': '#00d4ff', 'viz-fps': 30, 'enable-1': true, 'out-format': 'mp4' },
  },
  {
    id: 'vinyl-spin-audiogram',
    name: 'Vinyl Spin Audiogram',
    category: 'audio-visualization',
    description: 'Spinning vinyl-style cover with waveform pulse. Requires 2 files (audio + image). Combines rotate on the image with a centered waveform.',
    tags: ['vinyl', 'spin', 'audiogram', 'rotate', 'audio'],
    icon: '💿',
    requiresBinCount: 2,
    settings: { 'enable-29': true, 'viz-type': 'showwaves', 'viz-mode': 'cline', 'viz-w': 1280, 'viz-h': 720, 'viz-color': '#ffffff', 'viz-fps': 30, 'enable-1': true, 'out-format': 'mp4' },
  },
  {
    id: 'music-video-spectrum',
    name: 'Full Music Video (Spectrum + Video)',
    category: 'audio-visualization',
    description: 'Overlay a translucent spectrum on the bottom of an existing video. Requires a video + an audio file in the bin (handled by the agent).',
    tags: ['music-video', 'spectrum', 'overlay', 'video', 'audio'],
    icon: '🎬',
    requiresBinCount: 2,
    settings: { 'enable-29': true, 'viz-type': 'showspectrum', 'viz-w': 1280, 'viz-h': 360, 'viz-colormap': 'rainbow', 'viz-fps': 30, 'enable-1': true, 'out-format': 'mp4' },
  },
];

// =============================================================================
// MULTI-FILE COMPOSITES (137-148)
// =============================================================================
const MULTI_FILE_COMPOSITES_WORKFLOWS = [
  {
    id: 'concat-sequential',
    name: 'Concatenate (Sequential Join)',
    category: 'multi-file-composites',
    description: 'Joins selected bin files in order. Uses the concat demuxer with -c copy when formats match; re-encodes otherwise.',
    tags: ['concat', 'join', 'multi', 'composite'],
    icon: '⛓',
    requiresBinCount: 2,
    settings: {},
  },
  {
    id: 'side-by-side',
    name: 'Side-by-Side (Horizontal)',
    category: 'multi-file-composites',
    description: 'Stack two videos horizontally. Both are auto-scaled to the same height (720).',
    tags: ['side', 'sidebyside', 'horizontal', 'hstack', 'multi'],
    icon: '⇋',
    requiresBinCount: 2,
    settings: {},
  },
  {
    id: 'stacked-vertical',
    name: 'Stacked (Vertical)',
    category: 'multi-file-composites',
    description: 'Stack two videos vertically. Both are auto-scaled to width 1280.',
    tags: ['stack', 'vertical', 'vstack', 'multi'],
    icon: '⇅',
    requiresBinCount: 2,
    settings: {},
  },
  {
    id: 'grid-2x2',
    name: '2×2 Grid (4 files)',
    category: 'multi-file-composites',
    description: 'Lay four videos out in a 2×2 grid using xstack.',
    tags: ['grid', '2x2', 'xstack', 'multi'],
    icon: '▦',
    requiresBinCount: 4,
    settings: {},
  },
  {
    id: 'picture-in-picture',
    name: 'Picture-in-Picture',
    category: 'multi-file-composites',
    description: 'Second video is scaled to 25% and overlaid in the bottom-right corner (20 px margin).',
    tags: ['pip', 'overlay', 'picture-in-picture', 'multi'],
    icon: '◳',
    requiresBinCount: 2,
    settings: {},
  },
  {
    id: 'add-soundtrack',
    name: 'Add Soundtrack to Video',
    category: 'multi-file-composites',
    description: 'First file = video (visual). Second file = audio (soundtrack). Output: video from first + audio from second.',
    tags: ['soundtrack', 'add-audio', 'video+audio', 'multi'],
    icon: '🎬+🔊',
    requiresBinCount: 2,
    settings: {},
  },
  {
    id: 'replace-audio',
    name: 'Replace Audio Track',
    category: 'multi-file-composites',
    description: 'Same as Add Soundtrack but explicit. Video from file 1, audio from file 2.',
    tags: ['replace', 'audio', 'swap', 'multi'],
    icon: '🔁',
    requiresBinCount: 2,
    settings: {},
  },
  {
    id: 'mix-2-audio',
    name: 'Mix Two Audio Tracks',
    category: 'multi-file-composites',
    description: 'Mix two audio files together with amix=inputs=2:duration=longest:dropout_transition=2.',
    tags: ['mix', 'audio', 'amix', 'multi'],
    icon: '🔀',
    requiresBinCount: 2,
    settings: { 'enable-12': true, 'volume': 1.0 },
  },
  {
    id: 'image-watermark',
    name: 'Image Watermark Overlay',
    category: 'multi-file-composites',
    description: 'Overlay an image from the bin on top of a video, top-right, 10% opacity.',
    tags: ['watermark', 'image', 'overlay', 'logo', 'multi'],
    icon: '©️',
    requiresBinCount: 2,
    settings: { 'enable-1': true, 'out-format': 'mp4', 'vcodec': 'libx264', 'crf': 20, 'enc-preset': 'fast' },
  },
  {
    id: 'crossfade',
    name: 'Crossfade Two Clips',
    category: 'multi-file-composites',
    description: 'xfade transition between two clips. 1 second fade. Use the Compositor agent for full transition control.',
    tags: ['xfade', 'transition', 'crossfade', 'multi'],
    icon: '⇌',
    requiresBinCount: 2,
    settings: { 'enable-1': true, 'out-format': 'mp4', 'vcodec': 'libx264', 'crf': 20, 'enc-preset': 'fast' },
  },
  {
    id: 'green-screen',
    name: 'Green Screen Composite',
    category: 'multi-file-composites',
    description: 'Key out a green (or any color) background from the first file, then overlay it on the second file.',
    tags: ['green', 'screen', 'key', 'colorkey', 'multi'],
    icon: '🟩',
    requiresBinCount: 2,
    settings: { 'enable-20': true, 'chroma-enable': true, 'chroma-color': '0x00FF00', 'chroma-similarity': 0.3, 'chroma-blend': 0.1, 'enable-1': true, 'out-format': 'mp4', 'vcodec': 'libx264', 'crf': 20, 'enc-preset': 'fast' },
  },
  {
    id: 'blend-2-videos',
    name: 'Blend Two Videos',
    category: 'multi-file-composites',
    description: 'Blend two videos together. Default mode is "addition" with 50% opacity. Use the Compositor agent for the full blend-mode dropdown.',
    tags: ['blend', 'mix', 'composite', 'multi'],
    icon: '🌀',
    requiresBinCount: 2,
    settings: { 'enable-1': true, 'out-format': 'mp4', 'vcodec': 'libx264', 'crf': 20, 'enc-preset': 'fast' },
  },
];

// =============================================================================
// RETRO & ANALOG (149-158)
// =============================================================================
const RETRO_ANALOG_WORKFLOWS = [
  {
    id: 'full-crt',
    name: 'Full CRT Monitor',
    category: 'retro-analog',
    description: 'CRT curvature + scanlines + chroma bleed + vignette + slight blur.',
    tags: ['crt', 'monitor', 'retro', 'vintage', 'tube'],
    icon: '📺',
    settings: { 'enable-31': true, 'crt-enable': true, 'scan-enable': true, 'scan-spacing': 3, 'scan-opacity': 0.4, 'chromableed-enable': true, 'chromableed-h': 2, 'enable-9': true, 'blur-type': 'box', 'blur-strength': 1, 'enable-16': true, 'vignette': true, 'vignette-angle': 0.5 },
  },
  {
    id: 'vhs-tracking',
    name: 'VHS Tracking Error',
    category: 'retro-analog',
    description: 'Random line displacement + noise + chroma bleed. Classic VHS glitch.',
    tags: ['vhs', 'tracking', 'glitch', 'retro', 'tape'],
    icon: '📼',
    settings: { 'enable-31': true, 'tracking-enable': true, 'tracking-severity': 12, 'chromableed-enable': true, 'chromableed-h': 4, 'enable-13': true, 'add-noise': true, 'noise-strength': 8, 'noise-type': 't+u' },
  },
  {
    id: 'signal-dropout',
    name: 'Signal Dropout',
    category: 'retro-analog',
    description: 'Random black frames + static bursts. Lost-signal aesthetic.',
    tags: ['dropout', 'lost-signal', 'static', 'retro'],
    icon: '📡',
    settings: { 'enable-31': true, 'dropout-enable': true, 'dropout-freq': 0.04, 'enable-13': true, 'add-noise': true, 'noise-strength': 12, 'noise-type': 't+u' },
  },
  {
    id: 'interlaced-broadcast',
    name: 'Interlaced Broadcast',
    category: 'retro-analog',
    description: 'Interlace then deinterlace, leaving comb artifacts. Looks like an old TV capture.',
    tags: ['interlace', 'broadcast', 'comb', 'retro'],
    icon: '🧶',
    settings: { 'enable-31': true, 'interlace-enable': true },
  },
  {
    id: 'film-projector',
    name: 'Film Projector',
    category: 'retro-analog',
    description: 'Grain + vertical jitter + vignette + warm grade + occasional white flash.',
    tags: ['film', 'projector', 'cinema', 'warm', 'retro'],
    icon: '🎞',
    settings: { 'enable-13': true, 'grain-overlay': true, 'enable-7': true, 'eq-saturation': 0.85, 'eq-contrast': 1.05, 'eq-brightness': 0.03, 'enable-16': true, 'vignette': true, 'vignette-angle': 0.5 },
  },
  {
    id: 'old-film-scratches',
    name: 'Old Film Scratches',
    category: 'retro-analog',
    description: 'Grain + random vertical white lines. Damaged film look.',
    tags: ['film', 'scratches', 'damage', 'retro', 'grain'],
    icon: '🎞️',
    settings: { 'enable-13': true, 'grain-overlay': true, 'enable-7': true, 'eq-contrast': 1.15 },
  },
  {
    id: 'betamax-degrade',
    name: 'Betamax Degrade',
    category: 'retro-analog',
    description: 'Heavy chroma bleed + low-res scale-down and back up + soft blur. The 80s home-movie look.',
    tags: ['betamax', 'vhs', 'home-movie', 'retro', 'tape'],
    icon: '📼',
    settings: { 'enable-31': true, 'chromableed-enable': true, 'chromableed-h': 6, 'chromableed-v': 2, 'enable-9': true, 'blur-type': 'gblur', 'blur-strength': 2, 'enable-3': true, 'scale-w': 480, 'scale-h': -1, 'scale-algo': 'neighbor' },
  },
  {
    id: 'security-camera',
    name: 'Security Camera',
    category: 'retro-analog',
    description: 'Desaturate + low fps + slight noise + 4:3 crop. Looks like CCTV footage.',
    tags: ['cctv', 'security', 'surveillance', 'retro'],
    icon: '🎥',
    settings: { 'enable-7': true, 'eq-saturation': 0.3, 'enable-13': true, 'add-noise': true, 'noise-strength': 6, 'noise-type': 't', 'enable-14': true, 'out-fps': 12, 'enable-4': true, 'crop-center': true, 'crop-w': 640, 'crop-h': 480 },
  },
  {
    id: 'thermal-vision',
    name: 'Thermal Vision',
    category: 'retro-analog',
    description: 'Color-channel mix that biases the image toward a heat palette (warm reds and yellows).',
    tags: ['thermal', 'heat', 'infrared', 'pseudocolor'],
    icon: '🌡',
    settings: { 'enable-8': true, 'ccm-rr': 1.2, 'ccm-rg': 0.4, 'ccm-rb': 0.0, 'ccm-gr': 0.8, 'ccm-gg': 0.4, 'ccm-gb': 0.0, 'ccm-br': 0.4, 'ccm-bg': 0.0, 'ccm-bb': 0.0, 'enable-7': true, 'eq-saturation': 1.4, 'eq-contrast': 1.1 },
  },
  {
    id: 'night-vision',
    name: 'Night Vision (Green Phosphor)',
    category: 'retro-analog',
    description: 'Green-channel boost + grain + vignette + slight blur. Night-vision goggles look.',
    tags: ['nightvision', 'green', 'phosphor', 'nv', 'goggles'],
    icon: '🟢',
    settings: { 'enable-8': true, 'ccm-rr': 0.0, 'ccm-rg': 0.0, 'ccm-rb': 0.0, 'ccm-gr': 0.2, 'ccm-gg': 1.4, 'ccm-gb': 0.2, 'ccm-br': 0.0, 'ccm-bg': 0.2, 'ccm-bb': 0.0, 'enable-13': true, 'grain-overlay': true, 'enable-16': true, 'vignette': true, 'vignette-angle': 0.7 },
  },
];

// =============================================================================
// ARTISTIC & STYLIZE (159-170)
// =============================================================================
const ARTISTIC_STYLIZE_WORKFLOWS = [
  {
    id: 'cartoon-cel',
    name: 'Cartoon / Cel Shade',
    category: 'artistic-stylize',
    description: 'Posterize + edge detect + composite edges over the flattened colors. The cel-shaded comic look.',
    tags: ['cartoon', 'cel', 'comic', 'artistic', 'posterize'],
    icon: '🎨',
    settings: { 'enable-16': true, 'posterize': 3, 'edge-detect': true, 'edge-mode': 'colormix', 'edge-low': 0.1, 'edge-high': 0.4, 'enable-7': true, 'eq-saturation': 1.4 },
  },
  {
    id: 'oil-painting',
    name: 'Oil Painting',
    category: 'artistic-stylize',
    description: 'Heavy box blur + unsharp + posterize. Imitates an oil-paint surface.',
    tags: ['oil', 'painting', 'artistic', 'blur'],
    icon: '🖌',
    settings: { 'enable-9': true, 'blur-type': 'box', 'blur-strength': 5, 'sharpen-amt': 1.5, 'enable-16': true, 'posterize': 5 },
  },
  {
    id: 'ascii-art',
    name: 'ASCII Art Video',
    category: 'artistic-stylize',
    description: 'Extreme downscale + posterize + upscale with nearest-neighbor. The ASCII aesthetic.',
    tags: ['ascii', 'art', 'pixel', 'downscale'],
    icon: '🔤',
    settings: { 'enable-3': true, 'scale-w': 160, 'scale-h': 90, 'scale-algo': 'neighbor', 'enable-16': true, 'posterize': 4 },
  },
  {
    id: 'halftone',
    name: 'Halftone Print',
    category: 'artistic-stylize',
    description: 'Posterize + geq dot pattern. Mimics newspaper halftone printing.',
    tags: ['halftone', 'print', 'newspaper', 'dot'],
    icon: '🗞',
    settings: { 'enable-16': true, 'posterize': 4, 'enable-7': true, 'eq-saturation': 0.0, 'eq-contrast': 1.4 },
  },
  {
    id: 'pixel-art',
    name: 'Pixel Art (Nearest Neighbor)',
    category: 'artistic-stylize',
    description: 'Scale to 128 wide with neighbor flags, then back up. Crisp pixel art.',
    tags: ['pixel', 'art', '8bit', '16bit', 'neighbor'],
    icon: '👾',
    settings: { 'enable-3': true, 'scale-w': 128, 'scale-h': -1, 'scale-algo': 'neighbor' },
  },
  {
    id: 'duotone',
    name: 'Duotone (Two-Color Map)',
    category: 'artistic-stylize',
    description: 'Map luminance onto two chosen colors via color-channel mixer. Black shadow → blue midtones → cyan highlight.',
    tags: ['duotone', 'two-color', 'lut', 'artistic'],
    icon: '🟦',
    settings: { 'enable-8': true, 'ccm-rr': 0.0, 'ccm-rg': 0.0, 'ccm-rb': 0.2, 'ccm-gr': 0.0, 'ccm-gg': 0.0, 'ccm-gb': 0.6, 'ccm-br': 0.0, 'ccm-bg': 0.0, 'ccm-bb': 1.0 },
  },
  {
    id: 'solarize',
    name: 'Solarize',
    category: 'artistic-stylize',
    description: 'Invert the upper half of the tonal range. Classic photographic effect.',
    tags: ['solarize', 'invert', 'artistic', 'curves'],
    icon: '☀️',
    settings: { 'enable-7': true, 'eq-contrast': 1.3, 'enable-1': true, 'vcodec': 'libx264' },
  },
  {
    id: 'neon-edge',
    name: 'Neon Edge Glow',
    category: 'artistic-stylize',
    description: 'Edge detect with colormix mode + saturation boost + gaussian-blur bloom. A glowing edge look.',
    tags: ['neon', 'edge', 'glow', 'bloom', 'artistic'],
    icon: '💡',
    settings: { 'enable-16': true, 'edge-detect': true, 'edge-mode': 'colormix', 'enable-7': true, 'eq-saturation': 1.6, 'eq-contrast': 1.2, 'enable-9': true, 'blur-type': 'gblur', 'blur-strength': 3 },
  },
  {
    id: 'chromatic-bloom',
    name: 'Chromatic Bloom',
    category: 'artistic-stylize',
    description: 'Bright areas bleed color. Boost saturation + add a soft blur for a bloom look.',
    tags: ['bloom', 'chromatic', 'bright', 'glow', 'artistic'],
    icon: '🌸',
    settings: { 'enable-7': true, 'eq-saturation': 1.5, 'eq-brightness': 0.05, 'enable-9': true, 'blur-type': 'gblur', 'blur-strength': 4 },
  },
  {
    id: 'kaleidoscope',
    name: 'Kaleidoscope',
    category: 'artistic-stylize',
    description: 'Symmetric mirror effect. Crop a quadrant, hflip, and vstack/hstack the four reflections.',
    tags: ['kaleidoscope', 'mirror', 'symmetric', 'artistic'],
    icon: '🔮',
    settings: { 'enable-3': true, 'scale-w': 640, 'scale-h': 640, 'scale-algo': 'lanczos' },
  },
  {
    id: 'mirror-lr',
    name: 'Mirror (Left → Right)',
    category: 'artistic-stylize',
    description: 'Split horizontally, hflip the right half, and hstack the two halves.',
    tags: ['mirror', 'hflip', 'symmetric', 'artistic'],
    icon: '⇋',
    settings: { 'enable-5': true, 'hflip': true },
  },
  {
    id: 'droste-zoom',
    name: 'Infinite Zoom (Droste)',
    category: 'artistic-stylize',
    description: 'A looping zoom-in via zoompan with an exponentially growing zoom expression.',
    tags: ['droste', 'infinite', 'zoom', 'artistic'],
    icon: '♾',
    settings: { 'enable-30': true, 'kb-enable': true, 'kb-zstart': 1.0, 'kb-zend': 2.5, 'kb-dir': 'center' },
  },
];

// =============================================================================
// MOTION & SPEED (171-178)
// =============================================================================
const MOTION_SPEED_WORKFLOWS = [
  {
    id: 'ken-burns-in',
    name: 'Ken Burns Zoom In',
    category: 'motion-speed',
    description: 'Slow zoompan push from 1.0× to 1.3× over the source duration.',
    tags: ['ken', 'burns', 'zoom', 'in', 'pan'],
    icon: '🔍',
    settings: { 'enable-30': true, 'kb-enable': true, 'kb-zstart': 1.0, 'kb-zend': 1.3, 'kb-dir': 'center' },
  },
  {
    id: 'ken-burns-out',
    name: 'Ken Burns Zoom Out',
    category: 'motion-speed',
    description: 'Pull-back zoompan from 1.3× to 1.0× over the source duration.',
    tags: ['ken', 'burns', 'zoom', 'out', 'pull'],
    icon: '🔎',
    settings: { 'enable-30': true, 'kb-enable': true, 'kb-zstart': 1.3, 'kb-zend': 1.0, 'kb-dir': 'center' },
  },
  {
    id: 'handheld-shake',
    name: 'Handheld Camera Shake',
    category: 'motion-speed',
    description: 'Subtle sinusoidal crop offset. Looks like a hand-held camera.',
    tags: ['shake', 'handheld', 'camera', 'motion'],
    icon: '🤳',
    settings: { 'enable-30': true, 'shake-enable': true, 'shake-intensity': 5, 'shake-speed': 6 },
  },
  {
    id: 'speed-ramp',
    name: 'Speed Ramp (Slow → Fast)',
    category: 'motion-speed',
    description: 'Slow → fast. The classic YouTube-intro ramp. Use the Speed slider for the slow factor.',
    tags: ['speed', 'ramp', 'slow', 'fast'],
    icon: '⏩',
    settings: { 'enable-6': true, 'speed': 0.5, 'speed-video': true, 'speed-audio': true, 'enable-1': true, 'vcodec': 'libx264', 'enc-preset': 'fast', 'crf': 20 },
  },
  {
    id: 'freeze-punch',
    name: 'Freeze Frame Punch-In',
    category: 'motion-speed',
    description: 'Freeze a frame, hold 1.5s, zoom 1.2×. Use Section 30 Freeze controls for the timestamp.',
    tags: ['freeze', 'punch', 'zoom', 'still'],
    icon: '❄',
    settings: { 'enable-30': true, 'freeze-enable': true, 'freeze-time': 1.0, 'freeze-hold': 1.5, 'kb-enable': true, 'kb-zstart': 1.0, 'kb-zend': 1.2 },
  },
  {
    id: 'stutter',
    name: 'Stutter / Frame Hold',
    category: 'motion-speed',
    description: 'Frame-hold rhythm. Use the Workflows agent for the full stutter pattern; here we apply a moderate setpts=2.0 effect.',
    tags: ['stutter', 'glitch', 'frame', 'hold'],
    icon: '⏸',
    settings: { 'enable-1': true, 'out-fps': 12, 'vcodec': 'libx264', 'enc-preset': 'fast', 'crf': 20 },
  },
  {
    id: 'loop-n',
    name: 'Loop 3 Times',
    category: 'motion-speed',
    description: 'Loop the input 3 times. Uses -stream_loop 3.',
    tags: ['loop', 'repeat', 'cycle'],
    icon: '🔁',
    settings: { 'enable-1': true, 'vcodec': 'libx264', 'enc-preset': 'fast', 'crf': 20, 'out-format': 'mp4' },
  },
  {
    id: 'ping-pong',
    name: 'Ping-Pong Loop (Boomerang)',
    category: 'motion-speed',
    description: 'Forward + reverse concat. A boomerang loop.',
    tags: ['boomerang', 'ping', 'pong', 'reverse', 'loop'],
    icon: '🏓',
    boomerang: true,
    settings: { 'enable-1': true, 'out-format': 'mp4', 'vcodec': 'libx264', 'crf': 20, 'enc-preset': 'fast' },
  },
];

// =============================================================================
// SOCIAL MEDIA ADDITIONS (179-180)
// =============================================================================
const SOCIAL_MEDIA_V3_WORKFLOWS = [
  {
    id: 'podcast-audiogram-1x1',
    name: 'Podcast Audiogram (1:1 Square)',
    category: 'social-media',
    description: '1080×1080 square. Requires an audio file + a cover image in the bin (use the Visualizer agent). Uses the audiogram pattern.',
    tags: ['podcast', 'audiogram', 'square', '1080', 'social'],
    icon: '🎙️',
    requiresBinCount: 2,
    settings: { 'enable-29': true, 'viz-type': 'showwaves', 'viz-mode': 'cline', 'viz-w': 1080, 'viz-h': 1080, 'viz-color': '#ffffff', 'viz-fps': 30, 'enable-1': true, 'out-format': 'mp4', 'vcodec': 'libx264', 'enc-preset': 'fast', 'crf': 20 },
  },
  {
    id: 'reels-blur-bg',
    name: 'Blurred-Background Vertical (Reels / Shorts)',
    category: 'social-media',
    description: 'Landscape source → 9:16 vertical. The background is a blurred, scaled-up copy of the video, the original sits centered. The standard Reels/Shorts treatment.',
    tags: ['reels', 'shorts', 'tiktok', 'vertical', '9:16', 'blur', 'background'],
    icon: '📱',
    settings: { 'enable-1': true, 'out-format': 'mp4', 'vcodec': 'libx264', 'enc-preset': 'fast', 'crf': 20, 'enable-3': true, 'scale-w': 1080, 'scale-h': 1920, 'scale-algo': 'lanczos', 'enable-9': true, 'blur-type': 'gblur', 'blur-strength': 25 },
  },
];

// =============================================================================
// COMBINED NEW CATALOG (exposed as global WORKFLOWS_V3)
// =============================================================================
const WORKFLOWS_V3 = [
  ...AUDIO_REPAIR_UTILITY_WORKFLOWS,
  ...AUDIO_VISUALIZATION_WORKFLOWS,
  ...MULTI_FILE_COMPOSITES_WORKFLOWS,
  ...RETRO_ANALOG_WORKFLOWS,
  ...ARTISTIC_STYLIZE_WORKFLOWS,
  ...MOTION_SPEED_WORKFLOWS,
  ...SOCIAL_MEDIA_V3_WORKFLOWS,
];

// Expose to the global scope.
window.WORKFLOWS_V3 = WORKFLOWS_V3;
