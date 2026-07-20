/* =============================================================================
 * FFmpeg Studio v2 — Workflow Catalog (110 workflows)
 * -----------------------------------------------------------------------------
 * Each workflow object has:
 *   { id, name, category, description, tags, icon, settings, outputFormat?, codec?, crf?, audioChain?, videoChain? }
 *
 * Categories:
 *   - video-editing            (workflows 1-19)
 *   - speed-time               (workflows 20-26)
 *   - audio                    (workflows 27-39)
 *   - color-grading            (workflows 40-55)
 *   - glitch                   (workflows 56-65)
 *   - social-media             (workflows 66-71)
 *   - gif                      (workflows 72-75)
 *   - utility                  (workflows 76-80)
 *   - audio-mastering          (workflows 81-99)
 *   - video-glitch-pipelines   (workflows 100-110)
 *
 * `settings` map control IDs from the v1 HTML to values.
 * `audioChain` / `videoChain` are arrays of pipeline-step objects (each
 * { name, description, args, inputFile, outputFile }) for workflows that
 * require executePipeline().
 * ============================================================================= */

'use strict';

// =============================================================================
// VIDEO EDITING (1-19)
// =============================================================================
const VIDEO_EDITING_WORKFLOWS = [
  {
    id: 'quick-trim',
    name: 'Quick Trim',
    category: 'video-editing',
    description: 'Trim video to a specific start and end time.',
    tags: ['trim', 'cut', 'start', 'end'],
    icon: '✂️',
    settings: { 'enable-2': true, 'trim-start': '00:00:05.000', 'trim-end': '00:00:15.000' },
  },
  {
    id: 'convert-mp4-to-webm',
    name: 'Convert MP4 → WebM',
    category: 'video-editing',
    description: 'Re-encode to WebM/VP9 for smaller files and broad compatibility.',
    tags: ['convert', 'webm', 'vp9', 'format'],
    icon: '🎬',
    settings: {},
    outputFormat: 'webm', codec: 'libvpx-vp9', crf: 30,
  },
  {
    id: 'convert-webm-to-mp4',
    name: 'Convert WebM → MP4',
    category: 'video-editing',
    description: 'Re-encode to MP4/H.264 for maximum compatibility.',
    tags: ['convert', 'mp4', 'h264', 'format'],
    icon: '🎬',
    settings: {},
    outputFormat: 'mp4', codec: 'libx264', crf: 23,
  },
  {
    id: 'compress-aggressive',
    name: 'Reduce File Size (Aggressive)',
    category: 'video-editing',
    description: 'Heavy compression — 720p, veryfast preset, low audio bitrate.',
    tags: ['compress', 'shrink', 'small', 'aggressive'],
    icon: '📦',
    settings: { 'vcodec': 'libx264', 'enc-preset': 'veryfast', 'crf': 32, 'ab-rate': '96k',
                'enable-3': true, 'scale-w': 1280, 'scale-h': 720, 'scale-algo': 'lanczos' },
    outputFormat: 'mp4', codec: 'libx264', crf: 32,
  },
  {
    id: 'compress-moderate',
    name: 'Reduce File Size (Moderate)',
    category: 'video-editing',
    description: 'Balanced compression that keeps quality and resolution.',
    tags: ['compress', 'shrink', 'balanced'],
    icon: '📦',
    settings: { 'vcodec': 'libx264', 'enc-preset': 'fast', 'crf': 28, 'ab-rate': '128k' },
    outputFormat: 'mp4', codec: 'libx264', crf: 28,
  },
  {
    id: 'downscale-720p',
    name: 'Downscale to 720p',
    category: 'video-editing',
    description: 'Resize to 1280×720 using lanczos scaling.',
    tags: ['resize', '720p', 'scale'],
    icon: '📐',
    settings: { 'enable-3': true, 'scale-w': 1280, 'scale-h': 720, 'scale-algo': 'lanczos' },
  },
  {
    id: 'downscale-480p',
    name: 'Downscale to 480p',
    category: 'video-editing',
    description: 'Resize to 854×480 using lanczos scaling.',
    tags: ['resize', '480p', 'scale'],
    icon: '📐',
    settings: { 'enable-3': true, 'scale-w': 854, 'scale-h': 480, 'scale-algo': 'lanczos' },
  },
  {
    id: 'downscale-360p',
    name: 'Downscale to 360p',
    category: 'video-editing',
    description: 'Resize to 640×360 using lanczos scaling.',
    tags: ['resize', '360p', 'scale'],
    icon: '📐',
    settings: { 'enable-3': true, 'scale-w': 640, 'scale-h': 360, 'scale-algo': 'lanczos' },
  },
  {
    id: 'fps-30',
    name: 'Change Frame Rate to 30fps',
    category: 'video-editing',
    description: 'Force the output to 30 frames per second.',
    tags: ['fps', '30', 'framerate'],
    icon: '🎞️',
    settings: { 'enable-14': true, 'out-fps': 30 },
  },
  {
    id: 'fps-24',
    name: 'Change Frame Rate to 24fps (Cinematic)',
    category: 'video-editing',
    description: 'The classic cinematic 24fps frame rate.',
    tags: ['fps', '24', 'cinematic', 'framerate'],
    icon: '🎞️',
    settings: { 'enable-14': true, 'out-fps': 24 },
  },
  {
    id: 'fps-60',
    name: 'Change Frame Rate to 60fps',
    category: 'video-editing',
    description: 'High-frame-rate 60fps for smooth motion.',
    tags: ['fps', '60', 'smooth', 'framerate'],
    icon: '🎞️',
    settings: { 'enable-14': true, 'out-fps': 60 },
  },
  {
    id: 'extract-frame',
    name: 'Extract Still Frame / Thumbnail',
    category: 'video-editing',
    description: 'Extract a single frame at the 2-second mark as a JPEG image.',
    tags: ['frame', 'thumbnail', 'still', 'jpeg'],
    icon: '🖼️',
    // Special: the apply function detects this and routes to extractFrame.
    settings: { 'enable-1': true, 'out-format': 'jpg' },
    outputFormat: 'jpg', codec: 'mjpeg',
    extractFrame: 2.0,
  },
  {
    id: 'rotate-90-cw',
    name: 'Rotate 90° Clockwise',
    category: 'video-editing',
    description: 'Rotate the video 90° clockwise.',
    tags: ['rotate', '90', 'clockwise'],
    icon: '↻',
    settings: { 'enable-5': true, 'rotate': '90cw' },
  },
  {
    id: 'rotate-90-ccw',
    name: 'Rotate 90° Counter-Clockwise',
    category: 'video-editing',
    description: 'Rotate the video 90° counter-clockwise.',
    tags: ['rotate', '90', 'counter-clockwise'],
    icon: '↺',
    settings: { 'enable-5': true, 'rotate': '90ccw' },
  },
  {
    id: 'rotate-180',
    name: 'Rotate 180°',
    category: 'video-editing',
    description: 'Flip the video upside down.',
    tags: ['rotate', '180', 'upside'],
    icon: '↕',
    settings: { 'enable-5': true, 'rotate': '180' },
  },
  {
    id: 'flip-horizontal',
    name: 'Flip Horizontal (Mirror)',
    category: 'video-editing',
    description: 'Mirror the video horizontally.',
    tags: ['flip', 'mirror', 'horizontal'],
    icon: '⇋',
    settings: { 'enable-5': true, 'hflip': true },
  },
  {
    id: 'flip-vertical',
    name: 'Flip Vertical',
    category: 'video-editing',
    description: 'Flip the video vertically.',
    tags: ['flip', 'vertical'],
    icon: '⇅',
    settings: { 'enable-5': true, 'vflip': true },
  },
  {
    id: 'mute-strip-audio',
    name: 'Mute Video (Strip Audio)',
    category: 'video-editing',
    description: 'Remove the audio track entirely from the video.',
    tags: ['mute', 'silent', 'strip', 'no-audio'],
    icon: '🔇',
    settings: { 'enable-12': true, 'strip-audio': true },
  },
  {
    id: 'max-quality-archive',
    name: 'Max Quality Archive Export',
    category: 'video-editing',
    description: 'CRF 15, slow preset, 320k audio — the highest quality export.',
    tags: ['quality', 'archive', 'master', 'best'],
    icon: '🏆',
    settings: { 'vcodec': 'libx264', 'enc-preset': 'slow', 'crf': 15, 'ab-rate': '320k', 'pix-fmt': 'yuv420p' },
    outputFormat: 'mp4', codec: 'libx264', crf: 15,
  },
];

// =============================================================================
// SPEED & TIME (20-26)
// =============================================================================
const SPEED_TIME_WORKFLOWS = [
  {
    id: 'slow-0_5x',
    name: 'Slow Motion 0.5×',
    category: 'speed-time',
    description: 'Half speed — video and audio slowed together.',
    tags: ['slow', 'slowmo', '0.5x', 'half'],
    icon: '⏪',
    settings: { 'enable-6': true, 'speed': 0.5, 'speed-video': true, 'speed-audio': true },
  },
  {
    id: 'slow-0_25x',
    name: 'Slow Motion 0.25×',
    category: 'speed-time',
    description: 'Quarter speed — extreme slow motion.',
    tags: ['slow', 'slowmo', '0.25x', 'quarter'],
    icon: '⏪',
    settings: { 'enable-6': true, 'speed': 0.25, 'speed-video': true, 'speed-audio': true },
  },
  {
    id: 'speed-2x',
    name: 'Speed Up 2×',
    category: 'speed-time',
    description: 'Double speed — video and audio sped up together.',
    tags: ['fast', '2x', 'speedup'],
    icon: '⏩',
    settings: { 'enable-6': true, 'speed': 2.0, 'speed-video': true, 'speed-audio': true },
  },
  {
    id: 'speed-4x',
    name: 'Speed Up 4× (Timelapse)',
    category: 'speed-time',
    description: '4× speed — classic timelapse.',
    tags: ['fast', '4x', 'timelapse'],
    icon: '⏩',
    settings: { 'enable-6': true, 'speed': 4.0, 'speed-video': true, 'speed-audio': true },
  },
  {
    id: 'speed-8x',
    name: 'Speed Up 8× (Fast Timelapse)',
    category: 'speed-time',
    description: '8× speed — fast timelapse. Strips audio.',
    tags: ['fast', '8x', 'timelapse', 'strip-audio'],
    icon: '⏩',
    settings: { 'enable-6': true, 'speed': 8.0, 'speed-video': true, 'speed-audio': false, 'enable-12': true, 'strip-audio': true },
  },
  {
    id: 'reverse-video',
    name: 'Reverse Video',
    category: 'speed-time',
    description: 'Play the video backwards. Both video and audio reversed.',
    tags: ['reverse', 'backwards'],
    icon: '⏮',
    settings: { 'enable-6': true, 'rev-video': true, 'rev-audio': true },
  },
  {
    id: 'boomerang',
    name: 'Boomerang Loop',
    category: 'speed-time',
    description: 'Creates a forward-then-reverse loop effect.',
    tags: ['boomerang', 'loop', 'ping-pong'],
    icon: '🔁',
    settings: { 'enable-1': true, 'vcodec': 'libx264', 'enc-preset': 'fast', 'crf': 23, 'ab-rate': '128k' },
    boomerang: true,
  },
];

// =============================================================================
// AUDIO (27-39)
// =============================================================================
const AUDIO_WORKFLOWS = [
  {
    id: 'extract-mp3',
    name: 'Extract Audio as MP3',
    category: 'audio',
    description: 'Rip the audio track to MP3 at 192kbps, 44.1kHz.',
    tags: ['extract', 'audio', 'mp3', 'rip'],
    icon: '🎵',
    settings: { 'enable-18': true, 'extract-audio': true, 'audio-format': 'mp3', 'audio-rate': 44100 },
    outputFormat: 'mp3',
  },
  {
    id: 'extract-wav',
    name: 'Extract Audio as WAV (Lossless)',
    category: 'audio',
    description: 'Rip the audio track to uncompressed WAV at 48kHz.',
    tags: ['extract', 'audio', 'wav', 'lossless'],
    icon: '🎵',
    settings: { 'enable-18': true, 'extract-audio': true, 'audio-format': 'wav', 'audio-rate': 48000 },
    outputFormat: 'wav',
  },
  {
    id: 'extract-aac',
    name: 'Extract Audio as AAC',
    category: 'audio',
    description: 'Rip the audio track to AAC at 256kbps.',
    tags: ['extract', 'audio', 'aac', 'm4a'],
    icon: '🎵',
    settings: { 'enable-18': true, 'extract-audio': true, 'audio-format': 'aac', 'audio-rate': 44100 },
    outputFormat: 'aac',
  },
  {
    id: 'normalize-audio',
    name: 'Normalize Audio (Loudness Standard)',
    category: 'audio',
    description: 'Apply EBU R128 loudness normalization.',
    tags: ['normalize', 'loudness', 'ebur128', 'loudnorm'],
    icon: '🔊',
    settings: { 'enable-12': true, 'loudnorm': true },
  },
  {
    id: 'podcast-processing',
    name: 'Podcast Processing',
    category: 'audio',
    description: 'Highpass 80Hz, lowpass 15kHz, loudnorm, neutral volume — the podcast chain.',
    tags: ['podcast', 'voice', 'speech', 'broadcast'],
    icon: '🎙️',
    settings: { 'enable-12': true, 'highpass': 80, 'lowpass': 15000, 'loudnorm': true, 'volume': 1.0 },
  },
  {
    id: 'bass-boost',
    name: 'Bass Boost',
    category: 'audio',
    description: '+12dB on the bass band.',
    tags: ['bass', 'boost', 'low-end'],
    icon: '🔊',
    settings: { 'enable-12': true, 'bass': 12 },
  },
  {
    id: 'treble-boost',
    name: 'Treble Boost',
    category: 'audio',
    description: '+10dB on the treble band.',
    tags: ['treble', 'boost', 'high-end'],
    icon: '🔊',
    settings: { 'enable-12': true, 'treble': 10 },
  },
  {
    id: 'add-echo',
    name: 'Add Echo Effect',
    category: 'audio',
    description: 'Cascade echo with 200ms delay and 0.4 decay.',
    tags: ['echo', 'delay', 'reverb'],
    icon: '🔁',
    settings: { 'enable-12': true, 'aecho': true, 'aecho-delay': 200, 'aecho-decay': 0.4 },
  },
  {
    id: 'add-flanger',
    name: 'Add Flanger Effect',
    category: 'audio',
    description: 'Jet-plane flanger modulation.',
    tags: ['flanger', 'modulation'],
    icon: '✈️',
    settings: { 'enable-12': true, 'flanger': true },
  },
  {
    id: 'tremolo-effect',
    name: 'Tremolo Effect',
    category: 'audio',
    description: '5Hz amplitude modulation at depth 0.7.',
    tags: ['tremolo', 'modulation', 'amplitude'],
    icon: '🌊',
    settings: { 'enable-12': true, 'tremolo': true, 'tremolo-f': 5, 'tremolo-d': 0.7 },
  },
  {
    id: 'vibrato-effect',
    name: 'Vibrato Effect',
    category: 'audio',
    description: '5Hz frequency modulation at depth 0.5.',
    tags: ['vibrato', 'modulation', 'frequency'],
    icon: '🎵',
    settings: { 'enable-12': true, 'vibrato': true, 'vibrato-f': 5, 'vibrato-d': 0.5 },
  },
  {
    id: 'audio-speed-1_5x',
    name: 'Audio Speed Up 1.5×',
    category: 'audio',
    description: 'Speed up just the audio track to 1.5× without affecting video.',
    tags: ['audio', 'speed', 'fast', '1.5x'],
    icon: '⏩',
    settings: { 'enable-12': true, 'audio-speed': 1.5 },
  },
  {
    id: 'audio-slow-0_75x',
    name: 'Audio Slow Down 0.75×',
    category: 'audio',
    description: 'Slow down just the audio track to 0.75× without affecting video.',
    tags: ['audio', 'slow', '0.75x'],
    icon: '⏪',
    settings: { 'enable-12': true, 'audio-speed': 0.75 },
  },
];

// =============================================================================
// COLOR GRADING (40-55)
// =============================================================================
const COLOR_GRADING_WORKFLOWS = [
  {
    id: 'blockbuster-orange-teal',
    name: 'Blockbuster Orange & Teal',
    category: 'color-grading',
    description: 'Hollywood-style warm highlights and cool shadows.',
    tags: ['orange', 'teal', 'blockbuster', 'cinematic'],
    icon: '🎨',
    settings: { 'enable-7': true, 'eq-contrast': 1.15, 'eq-saturation': 1.1, 'eq-brightness': -0.02,
                'enable-8': true, 'ccm-rr': 1.12, 'ccm-rg': -0.04, 'ccm-rb': -0.15,
                'ccm-gr': 0, 'ccm-gg': 1.0, 'ccm-gb': 0,
                'ccm-br': 0.08, 'ccm-bg': 0, 'ccm-bb': 0.88 },
  },
  {
    id: 'moody-dark-cinematic',
    name: 'Moody Dark Cinematic',
    category: 'color-grading',
    description: 'High-contrast, low-saturation, blue-shifted shadows.',
    tags: ['moody', 'dark', 'cinematic', 'blue'],
    icon: '🌑',
    settings: { 'enable-7': true, 'eq-contrast': 1.2, 'eq-brightness': -0.08, 'eq-saturation': 0.85, 'hue-h': 0,
                'enable-8': true, 'ccm-rr': 0.85, 'ccm-rg': 0, 'ccm-rb': 0,
                'ccm-gr': 0, 'ccm-gg': 1.0, 'ccm-gb': 0.05,
                'ccm-br': 0, 'ccm-bg': 0, 'ccm-bb': 1.15 },
  },
  {
    id: 'warm-golden-hour',
    name: 'Warm Golden Hour',
    category: 'color-grading',
    description: 'Warm sunset glow with extra red and yellow.',
    tags: ['warm', 'golden', 'sunset', 'gold'],
    icon: '🌅',
    settings: { 'enable-7': true, 'eq-brightness': 0.05, 'eq-saturation': 1.2, 'eq-gamma-r': 1.2, 'eq-gamma-b': 0.85 },
  },
  {
    id: 'cool-moonlight',
    name: 'Cool Moonlight',
    category: 'color-grading',
    description: 'Cool blue-dominant night-time palette.',
    tags: ['cool', 'blue', 'moonlight', 'night'],
    icon: '🌙',
    settings: { 'enable-7': true, 'eq-brightness': -0.05, 'eq-saturation': 0.8, 'eq-gamma-b': 1.3, 'eq-gamma-r': 0.85, 'eq-contrast': 1.1 },
  },
  {
    id: 'vhs-retro',
    name: 'VHS Retro Look',
    category: 'color-grading',
    description: 'Vintage VHS with color bleed, scan lines, and film grain.',
    tags: ['vhs', 'retro', 'vintage', 'analog', '80s', '90s'],
    icon: '📼',
    settings: { 'enable-7': true, 'eq-saturation': 1.2, 'eq-contrast': 0.95,
                'enable-13': true, 'add-noise': true, 'noise-strength': 15, 'noise-type': 't+u',
                'enable-19': true, 'g-geq-enable': true, 'g-geq-preset': 'scanline',
                'g-geq-spacing': 3, 'g-lagfun-enable': true, 'g-lagfun-decay': 0.92 },
  },
  {
    id: 'vintage-film',
    name: 'Vintage Film',
    category: 'color-grading',
    description: 'Faded, slightly desaturated film with a vignette.',
    tags: ['vintage', 'film', 'faded', 'old'],
    icon: '🎞️',
    settings: { 'enable-7': true, 'eq-saturation': 0.75, 'eq-contrast': 1.1, 'eq-brightness': -0.02, 'eq-gamma': 1.1,
                'enable-16': true, 'vignette': true, 'vignette-angle': 0.628 },
  },
  {
    id: 'sepia-tone',
    name: 'Sepia Tone',
    category: 'color-grading',
    description: 'Classic brownish sepia via channel mixer.',
    tags: ['sepia', 'brown', 'old', 'photograph'],
    icon: '🟫',
    settings: { 'enable-8': true,
                'ccm-rr': 0.393, 'ccm-rg': 0.769, 'ccm-rb': 0.189,
                'ccm-gr': 0.349, 'ccm-gg': 0.686, 'ccm-gb': 0.168,
                'ccm-br': 0.272, 'ccm-bg': 0.534, 'ccm-bb': 0.131 },
  },
  {
    id: 'high-contrast-bw',
    name: 'High Contrast Black & White',
    category: 'color-grading',
    description: 'Saturation to zero, contrast pushed to 1.4.',
    tags: ['bw', 'black', 'white', 'monochrome', 'contrast'],
    icon: '⚫',
    settings: { 'enable-7': true, 'eq-saturation': 0.0, 'eq-contrast': 1.4, 'eq-brightness': -0.03 },
  },
  {
    id: 'desaturated-bleach-bypass',
    name: 'Desaturated / Bleach Bypass',
    category: 'color-grading',
    description: 'Half-saturation, high-contrast bleach-bypass look.',
    tags: ['bleach', 'bypass', 'desaturated', 'gritty'],
    icon: '🩶',
    settings: { 'enable-7': true, 'eq-saturation': 0.5, 'eq-contrast': 1.3, 'eq-brightness': -0.02 },
  },
  {
    id: 'neon-cyberpunk',
    name: 'Neon Cyberpunk',
    category: 'color-grading',
    description: 'Cranked saturation, hue shift, channel split, and lagfun trails.',
    tags: ['cyberpunk', 'neon', 'futuristic', 'synthwave'],
    icon: '🌃',
    settings: { 'enable-7': true, 'eq-contrast': 1.3, 'eq-saturation': 1.5, 'eq-brightness': -0.05, 'hue-h': 20, 'hue-s': 1.5,
                'enable-9': true, 'sharpen-amt': 1.0,
                'enable-19': true, 'g-geq-enable': true, 'g-geq-preset': 'chansplit', 'g-geq-offset': 8,
                'g-lagfun-enable': true, 'g-lagfun-decay': 0.93 },
  },
  {
    id: 'dream-ethereal',
    name: 'Dream / Ethereal',
    category: 'color-grading',
    description: 'Soft glow, gentle blur, and a white fade-in.',
    tags: ['dream', 'ethereal', 'soft', 'glow', 'fuzzy'],
    icon: '☁️',
    settings: { 'enable-7': true, 'eq-brightness': 0.08, 'eq-saturation': 0.85, 'eq-gamma': 0.9,
                'enable-9': true, 'blur-type': 'gblur', 'blur-strength': 3,
                'enable-10': true, 'fade-in-dur': 1.5, 'fade-in-type': 'white' },
  },
  {
    id: 'night-vision',
    name: 'Night Vision',
    category: 'color-grading',
    description: 'Green-tinted low-light look with strong noise.',
    tags: ['night', 'vision', 'green', 'military'],
    icon: '🟢',
    settings: { 'enable-8': true, 'ccm-rr': 0.1, 'ccm-rg': 0.1, 'ccm-rb': 0,
                'ccm-gr': 0.2, 'ccm-gg': 1.5, 'ccm-gb': 0.2,
                'ccm-br': 0, 'ccm-bg': 0.1, 'ccm-bb': 0.1,
                'enable-13': true, 'add-noise': true, 'noise-strength': 20, 'noise-type': 't' },
  },
  {
    id: 'film-grain-vignette',
    name: 'Film Grain + Vignette',
    category: 'color-grading',
    description: 'Heavy grain with a subtle vignette.',
    tags: ['grain', 'vignette', 'film', 'texture'],
    icon: '🌫️',
    settings: { 'enable-13': true, 'grain-overlay': true,
                'enable-16': true, 'vignette': true, 'vignette-angle': 0.6,
                'enable-7': true, 'eq-saturation': 0.9, 'eq-contrast': 1.05 },
  },
  {
    id: 'cross-process',
    name: 'Cross Process',
    category: 'color-grading',
    description: 'Channel-mixed cross-processed look.',
    tags: ['cross', 'process', 'analog', 'experimental'],
    icon: '🌀',
    settings: { 'enable-8': true,
                'ccm-rr': 1.0, 'ccm-rg': 0.3, 'ccm-rb': -0.2,
                'ccm-gr': -0.1, 'ccm-gg': 1.0, 'ccm-gb': 0.1,
                'ccm-br': 0.2, 'ccm-bg': -0.2, 'ccm-bb': 1.2 },
  },
  {
    id: 'high-key-bright',
    name: 'High Key Bright',
    category: 'color-grading',
    description: 'Bright, low-contrast dreamy highlight look.',
    tags: ['high-key', 'bright', 'dreamy'],
    icon: '☀️',
    settings: { 'enable-7': true, 'eq-contrast': 0.9, 'eq-brightness': 0.1, 'eq-saturation': 0.9, 'eq-gamma': 0.85 },
  },
  {
    id: 'invert-negative',
    name: 'Invert / Negative',
    category: 'color-grading',
    description: 'Invert all colors (film negative).',
    tags: ['invert', 'negative', 'negate'],
    icon: '🔄',
    settings: { 'enable-7': true, 'negate': true },
  },
];

// =============================================================================
// GLITCH & CREATIVE (56-65)
// =============================================================================
const GLITCH_WORKFLOWS = [
  {
    id: 'datamosh-simulation',
    name: 'Datamosh Simulation',
    category: 'glitch',
    description: 'lagfun + tmix + tblend difference — fake datamoshing.',
    tags: ['datamosh', 'mash', 'frame', 'lagfun'],
    icon: '👾',
    settings: { 'enable-19': true, 'g-tmix-enable': true, 'g-tmix-frames': 8,
                'g-lagfun-enable': true, 'g-lagfun-decay': 0.97,
                'g-tblend-enable': true, 'g-tblend-mode': 'difference' },
  },
  {
    id: 'rgb-channel-split',
    name: 'RGB Channel Split',
    category: 'glitch',
    description: 'Split the R and B channels by 15 pixels.',
    tags: ['rgb', 'channel', 'split', 'chromatic'],
    icon: '🌈',
    settings: { 'enable-19': true, 'g-geq-enable': true, 'g-geq-preset': 'chansplit', 'g-geq-offset': 15 },
  },
  {
    id: 'scanline-corruption',
    name: 'Scanline Corruption',
    category: 'glitch',
    description: 'Inverted scanlines every 3 pixels.',
    tags: ['scanline', 'corruption', 'pixel'],
    icon: '🟥',
    settings: { 'enable-19': true, 'g-geq-enable': true, 'g-geq-preset': 'scanline', 'g-geq-spacing': 3, 'g-geq-intensity': 50 },
  },
  {
    id: 'vhs-tracking-error',
    name: 'VHS Tracking Error',
    category: 'glitch',
    description: 'Horizontal-shift glitch with VHS-style noise.',
    tags: ['vhs', 'tracking', 'error', 'horizontal'],
    icon: '📺',
    settings: { 'enable-19': true, 'g-geq-enable': true, 'g-geq-preset': 'hshift', 'g-geq-intensity': 40,
                'enable-13': true, 'add-noise': true, 'noise-strength': 25, 'noise-type': 't+u' },
  },
  {
    id: 'frame-ghosting',
    name: 'Frame Ghosting',
    category: 'glitch',
    description: 'tmix across 15 frames for heavy ghost trails.',
    tags: ['ghost', 'trail', 'tmix', 'blur'],
    icon: '👻',
    settings: { 'enable-19': true, 'g-tmix-enable': true, 'g-tmix-frames': 15 },
  },
  {
    id: 'warp-melt',
    name: 'Warp / Melt',
    category: 'glitch',
    description: 'Sin/cos warp distortion across the frame.',
    tags: ['warp', 'melt', 'distortion'],
    icon: '🫠',
    settings: { 'enable-19': true, 'g-geq-enable': true, 'g-geq-preset': 'warp', 'g-geq-freq': 15, 'g-geq-amp': 20 },
  },
  {
    id: 'edge-detect-wireframe',
    name: 'Edge Detect Wireframe',
    category: 'glitch',
    description: 'Sobel-style wireframe edge detection.',
    tags: ['edge', 'wireframe', 'sobel'],
    icon: '🔲',
    settings: { 'enable-16': true, 'edge-detect': true, 'edge-mode': 'wires', 'edge-low': 0.1, 'edge-high': 0.3 },
  },
  {
    id: 'posterize',
    name: 'Posterize (Limited Colors)',
    category: 'glitch',
    description: 'Quantize each color channel to 3 bits — 8 levels per channel.',
    tags: ['posterize', 'quantize', 'limited', 'colors'],
    icon: '🎨',
    settings: { 'enable-16': true, 'posterize': 3 },
  },
  {
    id: 'color-corruption',
    name: 'Color Corruption',
    category: 'glitch',
    description: 'Per-frame geq color corruption. Each frame re-evaluates the corruption expression using random(1+N), so the effect actually flickers and shifts per frame. This is a SLOW filter (FILTER_COST.geq = 100) and the cost guard will warn on long clips — recommended for clips under 30 seconds.',
    tags: ['color', 'corruption', 'random', 'animated', 'per-frame', 'geq'],
    icon: '🎭',
    // The per-frame geq expression this workflow produces:
    //   geq=r='if(between(r(X,Y),LO,HI),r(X,Y)+(random(1+N)*2-1)*AMP,r(X,Y))':g='...':b='...'
    // N is FFmpeg's 0-based frame index — random(1+N) re-evaluates per
    // frame, so the corruption actually flickers. LO, HI, AMP are filled
    // from g-cc-low, g-cc-high, g-cc-spread in app.js §19E.
    vf: "geq=r='if(between(r(X,Y),50,200),r(X,Y)+(random(1+N)*2-1)*40,r(X,Y))':g='if(between(g(X,Y),50,200),g(X,Y)+(random(1+N)*2-1)*40,g(X,Y))':b='if(between(b(X,Y),50,200),b(X,Y)+(random(1+N)*2-1)*40,b(X,Y))'",
    settings: { 'enable-19': true, 'g-cc-enable': true, 'g-cc-mode': 'animated', 'g-cc-low': 50, 'g-cc-high': 200, 'g-cc-spread': 40 },
  },
  {
    id: 'frame-amplify',
    name: 'Frame Amplify (Motion Trails)',
    category: 'glitch',
    description: 'Amplify inter-frame motion differences.',
    tags: ['amplify', 'motion', 'trail', 'radius'],
    icon: '📈',
    settings: { 'enable-19': true, 'g-amp-enable': true, 'g-amp-radius': 3, 'g-amp-factor': 8, 'g-amp-threshold': 10 },
  },
];

// =============================================================================
// SOCIAL MEDIA (66-71)
// =============================================================================
const SOCIAL_MEDIA_WORKFLOWS = [
  {
    id: 'instagram-post',
    name: 'Instagram Post (Square 1:1)',
    category: 'social-media',
    description: '1080×1080 square for Instagram posts.',
    tags: ['instagram', 'square', '1:1', 'post'],
    icon: '📱',
    settings: { 'enable-4': true, 'crop-w': 1080, 'crop-h': 1080, 'crop-center': true,
                'enable-14': true, 'out-fps': 30, 'ab-rate': '128k' },
    outputFormat: 'mp4', codec: 'libx264', crf: 23,
  },
  {
    id: 'instagram-reel-tiktok',
    name: 'Instagram Reel / TikTok (9:16)',
    category: 'social-media',
    description: '1080×1920 vertical for Reels and TikTok.',
    tags: ['instagram', 'reel', 'tiktok', 'vertical', '9:16'],
    icon: '📱',
    settings: { 'enable-3': true, 'scale-w': 1080, 'scale-h': 1920,
                'enable-14': true, 'out-fps': 30, 'ab-rate': '128k' },
    outputFormat: 'mp4', codec: 'libx264', crf: 23,
  },
  {
    id: 'youtube-short',
    name: 'YouTube Short (9:16 Vertical)',
    category: 'social-media',
    description: '1080×1920 vertical for YouTube Shorts with max quality.',
    tags: ['youtube', 'short', 'shorts', '9:16', 'vertical'],
    icon: '📱',
    settings: { 'enable-3': true, 'scale-w': 1080, 'scale-h': 1920,
                'enable-14': true, 'out-fps': 30, 'ab-rate': '192k' },
    outputFormat: 'mp4', codec: 'libx264', crf: 18,
  },
  {
    id: 'twitter-x',
    name: 'Twitter/X Video (16:9)',
    category: 'social-media',
    description: '1280×720 for Twitter/X. Note: max 2:20 duration.',
    tags: ['twitter', 'x', 'social', '16:9'],
    icon: '🐦',
    settings: { 'enable-3': true, 'scale-w': 1280, 'scale-h': 720,
                'enable-14': true, 'out-fps': 30, 'ab-rate': '128k' },
    outputFormat: 'mp4', codec: 'libx264', crf: 25,
  },
  {
    id: 'discord-embed',
    name: 'Discord Embed (< 8MB)',
    category: 'social-media',
    description: 'Aggressive compression to fit Discord\'s 8MB upload limit.',
    tags: ['discord', 'embed', 'compress', 'small'],
    icon: '💬',
    settings: { 'vcodec': 'libx264', 'enc-preset': 'veryfast', 'crf': 35,
                'enable-3': true, 'scale-w': 854, 'scale-h': 480, 'scale-algo': 'lanczos',
                'ab-rate': '64k' },
    outputFormat: 'mp4', codec: 'libx264', crf: 35,
  },
  {
    id: 'whatsapp-status',
    name: 'WhatsApp Status',
    category: 'social-media',
    description: '720p, 30 seconds max — fits WhatsApp status constraints.',
    tags: ['whatsapp', 'status', '720p'],
    icon: '📱',
    settings: { 'vcodec': 'libx264', 'enc-preset': 'fast', 'crf': 30,
                'enable-3': true, 'scale-w': 1280, 'scale-h': 720,
                'enable-2': true, 'trim-end': '00:00:30.000',
                'ab-rate': '96k' },
    outputFormat: 'mp4', codec: 'libx264', crf: 30,
  },
];

// =============================================================================
// GIF (72-75)
// =============================================================================
const GIF_WORKFLOWS = [
  {
    id: 'gif-standard',
    name: 'Video to GIF (Standard)',
    category: 'gif',
    description: '480px wide, 15fps, palette-optimized.',
    tags: ['gif', 'animated', 'loop', 'standard'],
    icon: '🎞️',
    settings: { 'enable-17': true, 'gif-enable': true, 'gif-w': 480, 'gif-fps': 15, 'gif-palette': true, 'gif-loop': 0 },
    outputFormat: 'gif',
  },
  {
    id: 'gif-high-quality',
    name: 'Video to GIF (High Quality)',
    category: 'gif',
    description: '640px wide, 24fps, palette-optimized.',
    tags: ['gif', 'hq', 'high-quality', 'smooth'],
    icon: '🎞️',
    settings: { 'enable-17': true, 'gif-enable': true, 'gif-w': 640, 'gif-fps': 24, 'gif-palette': true, 'gif-loop': 0 },
    outputFormat: 'gif',
  },
  {
    id: 'gif-tiny',
    name: 'Video to GIF (Tiny/Fast)',
    category: 'gif',
    description: '320px wide, 10fps — tiny and fast.',
    tags: ['gif', 'tiny', 'small', 'fast'],
    icon: '🎞️',
    settings: { 'enable-17': true, 'gif-enable': true, 'gif-w': 320, 'gif-fps': 10, 'gif-palette': true, 'gif-loop': 0 },
    outputFormat: 'gif',
  },
  {
    id: 'gif-reverse',
    name: 'Reverse GIF',
    category: 'gif',
    description: 'Reverse the video first, then export as a GIF.',
    tags: ['gif', 'reverse', 'backwards'],
    icon: '⏮',
    settings: { 'enable-6': true, 'rev-video': true,
                'enable-17': true, 'gif-enable': true, 'gif-w': 480, 'gif-fps': 15, 'gif-palette': true, 'gif-loop': 0 },
    outputFormat: 'gif',
  },
];

// =============================================================================
// UTILITY (76-80)
// =============================================================================
const UTILITY_WORKFLOWS = [
  {
    id: 'strip-metadata',
    name: 'Strip All Metadata (Privacy)',
    category: 'utility',
    description: 'Removes all metadata from the output file.',
    tags: ['metadata', 'privacy', 'strip', 'clean'],
    icon: '🧹',
    settings: { 'enable-22': true, 'strip-meta': true },
  },
  {
    id: 'add-watermark',
    name: 'Add Copyright Watermark',
    category: 'utility',
    description: 'Stamp "© Your Name 2026" in the bottom-right corner.',
    tags: ['watermark', 'text', 'copyright', 'stamp'],
    icon: '©️',
    settings: { 'enable-11': true, 'text-content': '© Your Name 2026', 'text-size': 18,
                'text-color': '#ffffff', 'text-bg': '#000000', 'text-bg-opacity': 0.5,
                'text-x-align': 'right', 'text-y-align': 'bottom',
                'text-x-offset': 16, 'text-y-offset': 16 },
  },
  {
    id: 'preview-10s',
    name: 'Preview First 10 Seconds',
    category: 'utility',
    description: 'Trim to the first 10 seconds and stream-copy (no re-encode).',
    tags: ['preview', 'trim', 'fast', 'copy'],
    icon: '⏯',
    settings: { 'enable-2': true, 'trim-start': '00:00:00.000', 'trim-end': '00:00:10.000',
                'vcodec': 'copy', 'acodec': 'copy' },
  },
  {
    id: 'fade-in-out',
    name: 'Fade In + Fade Out',
    category: 'utility',
    description: 'Black fade in (2s) and black fade out (2s) with matching audio fades.',
    tags: ['fade', 'intro', 'outro', 'audio'],
    icon: '🌗',
    settings: { 'enable-10': true, 'fade-in-dur': 2, 'fade-in-type': 'black',
                'fade-out-dur': 2, 'fade-out-type': 'black',
                'afade-in': 1.5, 'afade-out': 2 },
  },
  {
    id: 'letterbox',
    name: 'Letterbox (Add Black Bars)',
    category: 'utility',
    description: 'Pad to 1920×1080 with black bars around the video.',
    tags: ['letterbox', 'pad', 'bars', 'cinema'],
    icon: '🎞️',
    settings: { 'enable-15': true, 'pad-w': 1920, 'pad-h': 1080, 'pad-color': 'black', 'pad-center': true },
  },
];

// =============================================================================
// AUDIO MASTERING (81-99) — Each has a 'Full' chain and a 'Simplified' chain.
// The workflow card shows a "Full Chain" or "Simplified" badge at runtime.
// =============================================================================
const AUDIO_MASTERING_WORKFLOWS = [
  {
    id: 'am-bass-dubstep',
    name: 'Bass-Boosted Dubstep Mastering',
    category: 'audio-mastering',
    description: 'Heavy sub-bass boost with surgical EQ — for dubstep, trap, and bass music.',
    tags: ['bass', 'dubstep', 'trap', 'mastering', 'EQ'],
    icon: '🎛️',
    fullChain: 'equalizer=f=60:t=q:w=1:g=6,equalizer=f=100:t=q:w=1.5:g=4,equalizer=f=40:t=q:w=2:g=8,acompressor=threshold=-18dB:ratio=3:attack=5:release=80:makeup=2,loudnorm=I=-14:TP=-1:LRA=11,volume=1.3',
    simplifiedChain: 'equalizer=f=60:t=q:w=1:g=6,equalizer=f=100:t=q:w=1.5:g=4,equalizer=f=40:t=q:w=2:g=8,volume=1.3,lowpass=f=16000',
  },
  {
    id: 'am-country-trap',
    name: 'Country Trap Mastering',
    category: 'audio-mastering',
    description: 'Warm low-end with scooped mids and crisp highs.',
    tags: ['country', 'trap', 'mastering', 'warm'],
    icon: '🎛️',
    fullChain: 'equalizer=f=80:t=q:w=1.2:g=4,equalizer=f=250:t=q:w=1:g=-2,equalizer=f=2500:t=q:w=1:g=3,acompressor=threshold=-16dB:ratio=2.5:attack=10:release=100:makeup=2,aphaser=in_gain=0.4:out_gain=0.74:delay=3:decay=0.4:speed=0.5,chorus=0.5:0.9:50|60:0.4|0.32:0.25|0.4:1|2,loudnorm=I=-14:TP=-1:LRA=11,volume=1.2',
    simplifiedChain: 'equalizer=f=80:t=q:w=1.2:g=4,equalizer=f=250:t=q:w=1:g=-2,equalizer=f=2500:t=q:w=1:g=3,aecho=0.8:0.7:30|60:0.4|0.3,volume=1.2',
  },
  {
    id: 'am-slushwave',
    name: 'Slushwave Recipe',
    category: 'audio-mastering',
    description: 'Pitched-down, lo-fi, washed-out vaporwave — the canonical slushwave sound.',
    tags: ['slushwave', 'vaporwave', 'lofi', 'pitched', 'slow', 'dreamy'],
    icon: '🫧',
    fullChain: 'asetrate=44100*0.85,aresample=44100,lowpass=f=8000,highpass=f=80,equalizer=f=400:t=q:w=1:g=2,chorus=0.7:0.9:55|60:0.4|0.32:0.25|0.4:2|1,aecho=0.8:0.9:300|600:0.4|0.3,aphaser=in_gain=0.4:out_gain=0.7:delay=2:decay=0.3:speed=0.5,volume=1.2',
    simplifiedChain: 'asetrate=44100*0.85,aresample=44100,lowpass=f=8000,highpass=f=80,equalizer=f=400:t=q:w=1:g=2,aecho=0.8:0.9:300|600:0.4|0.3,volume=1.2',
  },
  {
    id: 'am-tidal-ghost',
    name: 'Tidal Ghost Ultimate',
    category: 'audio-mastering',
    description: 'Pitched-down ghostly texture with phaser, flanger, deep echo, and mastering.',
    tags: ['ghost', 'tidal', 'ethereal', 'phaser', 'flanger', 'haunted'],
    icon: '👻',
    fullChain: 'asetrate=44100*0.85,aresample=44100,flanger=delay=3:depth=4:speed=0.4,aecho=0.8:0.9:500|1000|1500:0.5|0.4|0.3,aphaser=in_gain=0.4:out_gain=0.7:delay=3:decay=0.4:speed=0.5,acompressor=threshold=-20dB:ratio=3:attack=5:release=80:makeup=2,loudnorm=I=-14:TP=-1:LRA=11,volume=1.1',
    simplifiedChain: 'asetrate=44100*0.85,aresample=44100,flanger=delay=3:depth=4:speed=0.4,aecho=0.8:0.9:500|1000|1500:0.5|0.4|0.3,volume=1.1',
  },
  {
    id: 'am-ultimate-cd',
    name: 'Ultimate CD Mastering',
    category: 'audio-mastering',
    description: 'Clean, professional CD-quality mastering chain. Multi-band EQ, compression, limiting, normalization.',
    tags: ['mastering', 'CD', 'professional', 'clean', 'broadcast'],
    icon: '💿',
    fullChain: 'highpass=f=20,lowpass=f=20000,equalizer=f=40:t=q:w=0.5:g=3,equalizer=f=80:t=q:w=1:g=2,equalizer=f=250:t=q:w=1:g=-1,equalizer=f=2500:t=q:w=1:g=1,equalizer=f=8000:t=q:w=1:g=2,acompressor=threshold=-18dB:ratio=3:attack=5:release=80:makeup=2,alimiter=limit=0.95,loudnorm=I=-14:TP=-1:LRA=11',
    simplifiedChain: 'highpass=f=20,lowpass=f=20000,equalizer=f=40:t=q:w=0.5:g=3,equalizer=f=80:t=q:w=1:g=2,equalizer=f=250:t=q:w=1:g=-1,equalizer=f=2500:t=q:w=1:g=1,equalizer=f=8000:t=q:w=1:g=2,loudnorm=I=-14:TP=-1:LRA=11,volume=1.3',
  },
  {
    id: 'am-cd-dual-comp',
    name: 'CD Mastering (Dual Compression)',
    category: 'audio-mastering',
    description: 'Two-stage compression for punch and glue. Radio-ready loudness.',
    tags: ['mastering', 'compression', 'radio', 'loud'],
    icon: '📻',
    fullChain: 'acompressor=threshold=-18dB:ratio=3:attack=5:release=80:makeup=2,acompressor=threshold=-12dB:ratio=2:attack=10:release=120:makeup=1.5,alimiter=limit=0.95,loudnorm=I=-14:TP=-1:LRA=11',
    simplifiedChain: 'loudnorm=I=-14:TP=-1:LRA=11,volume=1.3',
  },
  {
    id: 'am-slushwave-bass',
    name: 'Slushwave Bass Preservation',
    category: 'audio-mastering',
    description: 'Slushwave with extra bass body. Heavier than the standard recipe.',
    tags: ['slushwave', 'bass', 'heavy', 'warm'],
    icon: '🌊',
    fullChain: 'asetrate=44100*0.85,aresample=44100,lowpass=f=8000,highpass=f=80,equalizer=f=300:t=q:w=1:g=4,equalizer=f=60:t=q:w=1:g=3,chorus=0.5:0.9:50|60:0.4|0.32:0.25|0.4:2|1,aecho=0.8:0.9:400|800:0.4|0.3,aphaser=in_gain=0.4:out_gain=0.7:delay=2:decay=0.3:speed=0.5,volume=1.2',
    simplifiedChain: 'asetrate=44100*0.85,aresample=44100,lowpass=f=8000,highpass=f=80,equalizer=f=300:t=q:w=1:g=4,equalizer=f=60:t=q:w=1:g=3,aecho=0.8:0.9:400|800:0.4|0.3,volume=1.2',
  },
  {
    id: 'am-daycore-phonk',
    name: 'Daycore Phonk Slush',
    category: 'audio-mastering',
    description: 'Deep-pitched phonk with crushed dynamics and dark atmosphere.',
    tags: ['daycore', 'phonk', 'slush', 'dark', 'crushed', 'slow'],
    icon: '🥀',
    fullChain: 'asetrate=44100*0.75,aresample=44100,lowpass=f=6000,highpass=f=100,equalizer=f=200:t=q:w=1:g=-2,equalizer=f=80:t=q:w=1:g=4,acompressor=threshold=-15dB:ratio=4:attack=2:release=50:makeup=3,chorus=0.6:0.9:60|70:0.4|0.32:0.25|0.4:2|1,aecho=0.8:0.9:400|800:0.4|0.3,volume=1.1',
    simplifiedChain: 'asetrate=44100*0.75,aresample=44100,lowpass=f=6000,highpass=f=100,equalizer=f=80:t=q:w=1:g=4,aecho=0.8:0.9:400|800:0.4|0.3,volume=1.1',
  },
  {
    id: 'am-ambient-drone',
    name: 'Ambient Drone v4',
    category: 'audio-mastering',
    description: 'Transform any audio into an ambient, droning soundscape.',
    tags: ['ambient', 'drone', 'soundscape', 'meditation', 'echo'],
    icon: '🌌',
    fullChain: 'lowpass=f=3000,highpass=f=50,aecho=0.8:0.9:500|1000|1500:0.5|0.4|0.3,equalizer=f=400:t=q:w=1:g=2,chorus=0.7:0.9:55|60:0.4|0.32:0.25|0.4:2|1,aphaser=in_gain=0.4:out_gain=0.7:delay=3:decay=0.4:speed=0.5,volume=1.3',
    simplifiedChain: 'lowpass=f=3000,highpass=f=50,aecho=0.8:0.9:500|1000|1500:0.5|0.4|0.3,equalizer=f=400:t=q:w=1:g=2,volume=1.3',
  },
  {
    id: 'am-driftwave',
    name: 'DriftWave Mastering',
    category: 'audio-mastering',
    description: 'Slightly pitched-down with warm compression and smooth limiting.',
    tags: ['driftwave', 'mastering', 'warm', 'smooth'],
    icon: '🌊',
    fullChain: 'asetrate=44100*0.9,aresample=44100,highpass=f=60,lowpass=f=10000,equalizer=f=100:t=q:w=1:g=2,equalizer=f=400:t=q:w=1:g=1,acompressor=threshold=-18dB:ratio=2.5:attack=10:release=120:makeup=2,alimiter=limit=0.95,loudnorm=I=-14:TP=-1:LRA=11,volume=1.2',
    simplifiedChain: 'asetrate=44100*0.9,aresample=44100,highpass=f=60,lowpass=f=10000,equalizer=f=100:t=q:w=1:g=2,equalizer=f=400:t=q:w=1:g=1,volume=1.2',
  },
  {
    id: 'am-vhs-warp',
    name: 'VHS Warp Audio',
    category: 'audio-mastering',
    description: 'Audio equivalent of a worn VHS tape. Warbled, echoed, compressed.',
    tags: ['VHS', 'warp', 'analog', 'tape', 'retro', 'lo-fi'],
    icon: '📼',
    fullChain: 'highpass=f=100,lowpass=f=8000,aecho=0.8:0.7:30|60|120:0.5|0.4|0.3,tremolo=f=0.5:d=0.7,acompressor=threshold=-15dB:ratio=4:attack=2:release=50:makeup=3,vibrato=f=4:d=0.5,volume=1.0',
    simplifiedChain: 'highpass=f=100,lowpass=f=8000,aecho=0.8:0.7:30|60|120:0.5|0.4|0.3,tremolo=f=0.5:d=0.7,volume=1.0',
  },
  {
    id: 'am-cyber-grind',
    name: 'Cyber Grind Bass',
    category: 'audio-mastering',
    description: 'Extreme sub-bass boost for industrial, cyber, and grindcore aesthetics.',
    tags: ['cyber', 'grind', 'industrial', 'bass', 'extreme'],
    icon: '⚙️',
    fullChain: 'highpass=f=30,lowpass=f=15000,equalizer=f=50:t=q:w=0.7:g=8,equalizer=f=80:t=q:w=1:g=10,acompressor=threshold=-20dB:ratio=4:attack=2:release=50:makeup=3,volume=1.5',
    simplifiedChain: 'highpass=f=30,lowpass=f=15000,equalizer=f=50:t=q:w=0.7:g=8,equalizer=f=80:t=q:w=1:g=10,volume=1.5',
  },
  {
    id: 'am-ethereal-wash',
    name: 'Ethereal Wash',
    category: 'audio-mastering',
    description: 'Dreamy, washed-out audio with cascading echoes and chorus.',
    tags: ['ethereal', 'wash', 'dreamy', 'chorus', 'echo', 'celestial'],
    icon: '✨',
    fullChain: 'aecho=0.8:0.9:200|400|600:0.4|0.3|0.2,highpass=f=80,lowpass=f=6000,equalizer=f=400:t=q:w=1:g=2,chorus=0.7:0.9:55|60:0.4|0.32:0.25|0.4:2|1,aphaser=in_gain=0.4:out_gain=0.7:delay=2:decay=0.3:speed=0.5,volume=1.2',
    simplifiedChain: 'aecho=0.8:0.9:200|400|600:0.4|0.3|0.2,highpass=f=80,lowpass=f=6000,equalizer=f=400:t=q:w=1:g=2,volume=1.2',
  },
  {
    id: 'am-nightdrive',
    name: 'Nightdrive Echo',
    category: 'audio-mastering',
    description: 'Late-night driving soundtrack vibe. Long echoes, warm mids, gentle high-end.',
    tags: ['nightdrive', 'echo', 'warm', 'cruising', 'nocturnal'],
    icon: '🌃',
    fullChain: 'aecho=0.8:0.7:100|200|400:0.5|0.4|0.3,highpass=f=100,lowpass=f=12000,equalizer=f=200:t=q:w=1:g=1,equalizer=f=1500:t=q:w=1:g=1,volume=1.0',
    simplifiedChain: 'aecho=0.8:0.7:100|200|400:0.5|0.4|0.3,highpass=f=100,lowpass=f=12000,equalizer=f=200:t=q:w=1:g=1,volume=1.0',
  },
  {
    id: 'am-lofi-tape',
    name: 'Lo-Fi Tape Decay',
    category: 'audio-mastering',
    description: 'Degraded, decaying tape sound. Muffled highs, warm lows, flutter and hiss.',
    tags: ['lofi', 'tape', 'decay', 'degraded', 'hiss', 'warm'],
    icon: '🎞️',
    fullChain: 'highpass=f=200,lowpass=f=7000,equalizer=f=100:t=q:w=2:g=-2,equalizer=f=400:t=q:w=1:g=2,vibrato=f=6:d=0.6,tremolo=f=0.7:d=0.5,volume=1.0',
    simplifiedChain: 'highpass=f=200,lowpass=f=7000,equalizer=f=100:t=q:w=2:g=-2,equalizer=f=400:t=q:w=1:g=2,volume=1.0',
  },
  {
    id: 'am-digital-glitch',
    name: 'Digital Glitch Wash',
    category: 'audio-mastering',
    description: 'Stuttering, phased, tremolo-washed audio with micro-echoes.',
    tags: ['glitch', 'digital', 'wash', 'stutter', 'phaser', 'malfunction'],
    icon: '💾',
    fullChain: 'highpass=f=150,lowpass=f=10000,aecho=0.7:0.6:15|30|60:0.5|0.4|0.3,tremolo=f=0.7:d=0.8,aphaser=in_gain=0.4:out_gain=0.7:delay=2:decay=0.3:speed=0.7,volume=1.0',
    simplifiedChain: 'highpass=f=150,lowpass=f=10000,aecho=0.7:0.6:15|30|60:0.5|0.4|0.3,tremolo=f=0.7:d=0.8,volume=1.0',
  },
  {
    id: 'am-void-bass',
    name: 'Void Bass Texture',
    category: 'audio-mastering',
    description: 'Sub-harmonic bass enhancement for dark, void-like textures. Pure low-end power.',
    tags: ['void', 'bass', 'sub', 'dark', 'texture', 'power'],
    icon: '⚫',
    fullChain: 'highpass=f=25,lowpass=f=20000,equalizer=f=40:t=q:w=0.5:g=6,equalizer=f=60:t=q:w=0.7:g=8,equalizer=f=100:t=q:w=1:g=4,acompressor=threshold=-15dB:ratio=3:attack=5:release=80:makeup=2,volume=1.4',
    simplifiedChain: 'highpass=f=25,lowpass=f=20000,equalizer=f=40:t=q:w=0.5:g=6,equalizer=f=60:t=q:w=0.7:g=8,equalizer=f=100:t=q:w=1:g=4,volume=1.4',
  },
  {
    id: 'am-crystal-mesh',
    name: 'Crystal Mesh Wash',
    category: 'audio-mastering',
    description: 'Shimmering, crystalline audio with layered echoes and chorus.',
    tags: ['crystal', 'mesh', 'shimmer', 'bright', 'airy', 'chorus'],
    icon: '💎',
    fullChain: 'aecho=0.8:0.8:150|300|450:0.35|0.3|0.25,highpass=f=120,lowpass=f=8000,equalizer=f=2000:t=q:w=1:g=2,chorus=0.6:0.9:50|60:0.4|0.32:0.25|0.4:2|1,volume=1.1',
    simplifiedChain: 'aecho=0.8:0.8:150|300|450:0.35|0.3|0.25,highpass=f=120,lowpass=f=8000,equalizer=f=2000:t=q:w=1:g=2,volume=1.1',
  },
  {
    id: 'am-midnight-cascade',
    name: 'Midnight Cascade',
    category: 'audio-mastering',
    description: 'Pitched-down with cascading flanger and warm compression. Dark and flowing.',
    tags: ['midnight', 'cascade', 'flanger', 'dark', 'flowing', 'pitched'],
    icon: '🌑',
    fullChain: 'asetrate=44100*0.88,aresample=44100,highpass=f=70,lowpass=f=9000,equalizer=f=100:t=q:w=1:g=2,flanger=delay=4:depth=5:speed=0.3,acompressor=threshold=-18dB:ratio=3:attack=5:release=80:makeup=2,volume=1.2',
    simplifiedChain: 'asetrate=44100*0.88,aresample=44100,highpass=f=70,lowpass=f=9000,equalizer=f=100:t=q:w=1:g=2,flanger=delay=4:depth=5:speed=0.3,volume=1.2',
  },
];

// =============================================================================
// VIDEO GLITCH PIPELINES (100-110) — multi-step pipeline workflows
// =============================================================================
const VIDEO_GLITCH_PIPELINES = [
  {
    id: 'vgp-lagfun-massacre',
    name: 'LAGFUN MASSACRE MELTDOWN',
    category: 'video-glitch-pipelines',
    description: 'The complete 6-step visual destruction pipeline. Vaporwave color grade → lagfun ghost trails → RGB chromatic aberration → strobe cuts → rapid chop → final melt.',
    tags: ['lagfun', 'massacre', 'meltdown', 'pipeline', 'vaporwave', 'chaos', 'datamosh'],
    icon: '💥',
    pipelineSteps: [
      { name: '1. Vaporwave Color Grade', description: 'Saturate and shift hue.', args: (vfn, ofn) => ['-i', vfn, '-vf', 'eq=saturation=1.3:contrast=1.1,hue=h=30', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', ofn] },
      { name: '2. Lagfun Ghost Trails',  description: 'A*0.4 + B*0.6 pixel blend.', args: (vfn, ofn) => ['-i', vfn, '-vf', "tblend=all_expr='A*(1-0.6)+B*0.6'", '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', ofn] },
      { name: '3. RGB Chromatic Aberration', description: 'rgbashift with all three channels.', args: (vfn, ofn) => ['-i', vfn, '-vf', 'rgbashift=rh=4:rv=4:gh=-3:gv=-3:bh=2:bv=-2', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', ofn] },
      { name: '4. Noise & Grain',         description: 'Temporal uniform noise overlay.', args: (vfn, ofn) => ['-i', vfn, '-vf', 'noise=alls=20:allf=t', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', ofn] },
      { name: '5. Final Melt Blend',      description: 'A*0.5 + B*0.5 melt.',     args: (vfn, ofn) => ['-i', vfn, '-vf', "tblend=all_expr='A*(1-0.5)+B*0.5'", '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', ofn] },
      { name: '6. Encode Output',         description: 'Final encode to mp4.',     args: (vfn, ofn) => ['-i', vfn, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', ofn] },
    ],
  },
  {
    id: 'vgp-max-entropy',
    name: 'Maximum Entropy Lagfun Massacre',
    category: 'video-glitch-pipelines',
    description: 'tmix frame stacking + tblend averaging + cranked saturation + RGB shift. Pure visual chaos.',
    tags: ['entropy', 'lagfun', 'massacre', 'tmix', 'tblend', 'chaos'],
    icon: '🌀',
    pipelineSteps: [
      { name: '1. Apply Stacked Filter', description: 'tmix + tblend + eq + rgbashift.', args: (vfn, ofn) => ['-i', vfn, '-vf', "tmix=frames=8:weights='1 2 3 4 5 4 3 2',tblend=all_mode=average:all_opacity=0.85,eq=saturation=2.0:contrast=1.25,rgbashift=rh=4:rv=2:bh=-4:bv=-2", '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', ofn] },
    ],
    fallbackArgs: (vfn, ofn) => ['-i', vfn, '-vf', "tmix=frames=8:weights='1 2 3 4 5 4 3 2',tblend=all_mode=average:all_opacity=0.85,eq=saturation=2.0:contrast=1.25,geq=r='r(X+4,Y+2)':g='g(X,Y)':b='b(X-4,Y-2)'", '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', ofn],
  },
  {
    id: 'vgp-echo-ghost',
    name: 'Echo Ghost Video',
    category: 'video-glitch-pipelines',
    description: 'Triple-blend lighten effect creating ethereal motion ghost trails.',
    tags: ['echo', 'ghost', 'trails', 'lighten', 'blend', 'ethereal'],
    icon: '👻',
    pipelineSteps: [
      { name: '1. Frame Copy A',   description: 'Offset copy of input.',     args: (vfn, ofn) => ['-ss', '0.1', '-i', vfn, '-frames:v', '300', '-an', '-c:v', 'libx264', '-preset', 'fast', 'copy_a.mp4'] },
      { name: '2. Frame Copy B',   description: 'Further offset copy.',       args: (vfn, ofn) => ['-ss', '0.2', '-i', vfn, '-frames:v', '300', '-an', '-c:v', 'libx264', '-preset', 'fast', 'copy_b.mp4'] },
      { name: '3. Blend Lighten',  description: 'Lighten blend the three.',  args: (vfn, ofn) => ['-i', vfn, '-i', 'copy_a.mp4', '-i', 'copy_b.mp4', '-filter_complex', "[0:v]setpts=PTS-STARTPTS[v0];[1:v]setpts=PTS-STARTPTS[v1];[2:v]setpts=PTS-STARTPTS[v2];[v0][v1]blend=all_mode=lighten[v01];[v01][v2]blend=all_mode=lighten[v]", '-map', '[v]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', ofn] },
    ],
  },
  {
    id: 'vgp-lagfun-dynamic',
    name: 'Lagfun Dynamic Decay',
    category: 'video-glitch-pipelines',
    description: 'Lagfun with a sine-wave-modulated decay factor. Trails pulse in and out rhythmically.',
    tags: ['lagfun', 'dynamic', 'decay', 'pulse', 'rhythmic'],
    icon: '🌊',
    pipelineSteps: [
      { name: '1. Sine Modulated Lagfun', description: 'lagfun decay oscillates.', args: (vfn, ofn) => ['-i', vfn, '-vf', "lagfun=decay='0.7+0.25*sin(2*PI*0.25*t)'", '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', ofn] },
    ],
  },
  {
    id: 'vgp-tblend-diff',
    name: 'Stacked tblend Difference',
    category: 'video-glitch-pipelines',
    description: 'Triple-stacked tblend difference128 — extracts pure motion as neon wireframes.',
    tags: ['tblend', 'difference', 'stacked', 'motion', 'wireframe', 'neon'],
    icon: '🟪',
    pipelineSteps: [
      { name: '1. Triple Difference', description: 'Three passes of difference128.', args: (vfn, ofn) => ['-i', vfn, '-vf', 'scale=-2:720,tblend=all_mode=difference128,tblend=all_mode=difference128,tblend=all_mode=difference128', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', ofn] },
    ],
  },
  {
    id: 'vgp-flip-chaos',
    name: 'Flip/Mirror Chaos',
    category: 'video-glitch-pipelines',
    description: 'Frame-count-based alternating horizontal and vertical flips. Disorienting kaleidoscopic chaos.',
    tags: ['flip', 'mirror', 'chaos', 'kaleidoscope', 'alternating'],
    icon: '🔀',
    pipelineSteps: [
      { name: '1. Alternating Flips', description: 'hflip / vflip via frame number.', args: (vfn, ofn) => ['-i', vfn, '-vf', "hflip=enable='eq(mod(floor(n/15),2),1)',vflip=enable='eq(mod(floor(n/105),2),1)'", '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', ofn] },
    ],
  },
  {
    id: 'vgp-reverse-echo',
    name: 'Reverse Video + Audio Echo',
    category: 'video-glitch-pipelines',
    description: 'Reversed footage with layered audio echoes that play forward over the reversed visuals.',
    tags: ['reverse', 'echo', 'uncanny', 'disorienting'],
    icon: '⏮',
    pipelineSteps: [
      { name: '1. Reverse Video + Audio', description: 'Reverse, then layered echo.', args: (vfn, ofn) => ['-i', vfn, '-vf', 'reverse', '-af', 'areverse,aecho=0.8:0.9:500|1000|1500:0.5|0.4|0.3,areverse', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', ofn] },
    ],
  },
  {
    id: 'vgp-speed-bass',
    name: 'Speed Slowdown + Bass Boost',
    category: 'video-glitch-pipelines',
    description: '75% speed with pitch-shifted bass enhancement. Screwed & chopped aesthetic.',
    tags: ['slow', 'screwed', 'chopped', 'bass', 'pitched'],
    icon: '🎚️',
    pipelineSteps: [
      { name: '1. Slow + Bass Boost', description: 'setpts/0.75 + bass EQ.', args: (vfn, ofn) => ['-i', vfn, '-vf', 'setpts=PTS/0.75', '-af', 'asetrate=44100*0.75,aresample=44100,equalizer=f=60:t=h:w=50:g=8,equalizer=f=100:t=q:w=1:g=6', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', ofn] },
    ],
  },
  {
    id: 'vgp-3way-alternating',
    name: '3-Way Alternating FX',
    category: 'video-glitch-pipelines',
    description: 'Cycles between 3 different effect treatments every 24 frames. Hue-shifted → noisy lagfun → color-boosted tblend.',
    tags: ['alternating', 'cycling', 'multi-fx', 'complex'],
    icon: '🎭',
    pipelineSteps: [
      { name: '1. Filter Cycle', description: 'hue + noise + lagfun cycled.', args: (vfn, ofn) => ['-i', vfn, '-vf', "hue=h='30*mod(floor(n/24),3)',noise=alls='5*mod(floor(n/24),3)':allf=t,lagfun=decay='0.9+0.05*mod(floor(n/24),3)'", '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', ofn] },
    ],
  },
  {
    id: 'vgp-vhs-scanlines',
    name: 'VHS Scan Lines',
    category: 'video-glitch-pipelines',
    description: 'Interlaced scan line effect with drawbox + scale combination.',
    tags: ['VHS', 'scanlines', 'interlaced', 'retro', 'CRT'],
    icon: '📺',
    pipelineSteps: [
      { name: '1. Scanlines + EQ', description: 'drawbox + saturate.', args: (vfn, ofn) => ['-i', vfn, '-vf', "drawbox=y=ih*mod(t*20\\,1):w=iw:h=2:color=black@0.5:t=fill,eq=saturation=1.2:contrast=0.95", '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', ofn] },
    ],
  },
  {
    id: 'vgp-iframe-strip',
    name: 'I-Frame Strip (Datamosh Prep)',
    category: 'video-glitch-pipelines',
    description: 'Forces extreme keyframe distance for datamosh-style compression artifacts. Lower CRF = more artifacts.',
    tags: ['datamosh', 'iframe', 'compression', 'artifact', 'smear'],
    icon: '📛',
    pipelineSteps: [
      { name: '1. Extreme Keyint', description: 'keyint=300, crf 35, low bitrate.', args: (vfn, ofn) => ['-i', vfn, '-c:v', 'libx264', '-x264opts', 'keyint=300:scenecut=0', '-crf', '35', '-b:v', '20k', ofn] },
    ],
  },
];

// =============================================================================
// COMBINED CATALOG (exposed as global WORKFLOWS)
// =============================================================================
// PHASE 0.1 FIX: workflows_v3.js is loaded AFTER workflows.js (see
// index.html script order). When this const initializer runs, the global
// `window.WORKFLOWS_V3` is still undefined, so the original
// `... (window.WORKFLOWS_V3 || [])` would have silently dropped the 70
// v3 workflows. We solve this with a function that lazily reads
// `window.WORKFLOWS_V3` every time the catalog is needed, and expose
// `WORKFLOWS` as a Proxy that delegates to that function — so any
// legacy call site that reads `WORKFLOWS.length`, `WORKFLOWS.find(...)`,
// `WORKFLOWS.concat(...)`, etc. still works correctly.
function getAllBuiltInWorkflows() {
  return [
    ...VIDEO_EDITING_WORKFLOWS,
    ...SPEED_TIME_WORKFLOWS,
    ...AUDIO_WORKFLOWS,
    ...COLOR_GRADING_WORKFLOWS,
    ...GLITCH_WORKFLOWS,
    ...SOCIAL_MEDIA_WORKFLOWS,
    ...GIF_WORKFLOWS,
    ...UTILITY_WORKFLOWS,
    ...AUDIO_MASTERING_WORKFLOWS,
    ...VIDEO_GLITCH_PIPELINES,
    // v3 PART D: 70 new workflows 111-180 (loaded from workflows_v3.js).
    // Resolved lazily at call time so the script order does not matter.
    ...(window.WORKFLOWS_V3 || []),
    // v4/v5: the "new engine" workflows — TRUE bitstream datamosh, colour match,
    // the hardware path (v4) and real-time motion-vector datamosh (v5). These
    // were counted in build-info (the "186") but never merged here, so their
    // cards never rendered and their run() engines were unreachable. They
    // dispatch through wf.run() (see the card handler below), not a filter chain.
    ...(window.WORKFLOWS_V4 || []),
    ...(window.WORKFLOWS_V5 || []),
  ];
}

const CATEGORIES = [
  { id: 'all',                    label: 'All' },
  { id: 'video-editing',          label: 'Video Editing' },
  { id: 'speed-time',             label: 'Speed & Time' },
  { id: 'audio',                  label: 'Audio' },
  { id: 'audio-repair-utility',   label: 'Audio Repair & Utility' },
  { id: 'audio-visualization',    label: 'Audio Visualization' },
  { id: 'multi-file-composites',  label: 'Multi-File Composites' },
  { id: 'color-grading',          label: 'Color Grading' },
  { id: 'glitch',                 label: 'Glitch & Creative' },
  { id: 'retro-analog',           label: 'Retro & Analog' },
  { id: 'artistic-stylize',       label: 'Artistic & Stylize' },
  { id: 'motion-speed',           label: 'Motion & Speed' },
  { id: 'social-media',           label: 'Social Media' },
  { id: 'gif',                    label: 'GIF' },
  { id: 'utility',                label: 'Utility' },
  { id: 'audio-mastering',        label: 'Audio Mastering' },
  { id: 'video-glitch-pipelines', label: 'Video Glitch Pipelines' },
  { id: 'custom',                 label: 'My Custom' },
];

// =============================================================================
// UI: render workflow grid
// =============================================================================
// PHASE 0.1 FIX: default to 'all' (NOT 'my-custom') and an empty search
// query. The previous default of 'my-custom' filtered against an empty
// localStorage and produced a "no matching workflows" empty state on
// every fresh visit.
let _activeCategory = 'all';
let _searchQuery = '';

// v5 hotfix 2 — Bug 1: does this workflow's settings enable a slow
// filter? Slow = geq, minterpolate, reverse, tmix. We detect it by
// checking the control IDs that toggle these filters (matches the IDs
// in app.js and index.html) and by scanning the pipeline step args.
const SLOW_SETTING_IDS = new Set([
  'g-geq-enable',        // toggles the geq filter
  'g-tmix-enable',       // toggles the tmix filter
  'rev-video',           // reverse filter
  'rev-audio',
  'g-minterpolate-enable', // (reserved for future use; not in current UI)
]);
const SLOW_KEYWORDS = ['geq=', 'minterpolate=', 'reverse', 'tmix='];
function workflowHasSlowFilter(wf) {
  if (!wf || !wf.settings) {
    // Pipeline-style workflows don't expose a settings map; scan
    // their inline args for the keywords instead. The `args` field
    // is a function that returns the argv array, so we have to call
    // it with placeholder names to serialize the literal.
    if (wf && Array.isArray(wf.pipelineSteps)) {
      for (const step of wf.pipelineSteps) {
        let arr = null;
        try {
          if (typeof step.args === 'function') arr = step.args('input.mp4', 'output.mp4');
          else if (Array.isArray(step.args)) arr = step.args;
        } catch (_) { arr = null; }
        if (!arr) continue;
        const str = arr.map(a => String(a)).join(' ');
        for (const k of SLOW_KEYWORDS) if (str.includes(k)) return true;
      }
    }
    if (wf && typeof wf.fullChain === 'string') {
      for (const k of SLOW_KEYWORDS) if (wf.fullChain.includes(k)) return true;
    }
    return false;
  }
  for (const [id, val] of Object.entries(wf.settings)) {
    if (!val) continue;
    if (id === 'g-cc-mode') {
      // Only the 'animated' corruption mode is slow (it uses geq
      // with frame-seeded random). 'temporal' and 'static' are cheap.
      if (val === 'animated') return true;
      continue;
    }
    if (SLOW_SETTING_IDS.has(id)) return true;
  }
  return false;
}

function initWorkflowsUI() {
  renderCategoryPills();
  renderWorkflows();
  const search = document.getElementById('wf-search');
  if (search) {
    search.addEventListener('input', (e) => {
      _searchQuery = String(e.target.value || '').toLowerCase().trim();
      renderWorkflows();
    });
  }
}

// Count workflows per category id, derived live from the full catalog so
// counts stay in sync with whatever is currently loaded (incl. the 70 v3
// workflows that are now resolved lazily). The 'all' bucket is the grand
// total. The 'custom' bucket is computed at call time from localStorage
// so the count reflects the user's actual saved workflows.
function getCategoryCounts() {
  const counts = { all: 0, custom: 0 };
  const all = getAllBuiltInWorkflows();
  for (const wf of all) {
    counts.all += 1;
    if (wf.category) counts[wf.category] = (counts[wf.category] || 0) + 1;
  }
  // Custom workflows are stored separately in localStorage.
  let custom = [];
  try {
    if (typeof loadCustomWorkflows === 'function') {
      custom = loadCustomWorkflows() || [];
    }
  } catch (_) { custom = []; }
  counts.custom = custom.length;
  counts.all += custom.length;
  return counts;
}

function renderCategoryPills() {
  const el = document.getElementById('wf-categories');
  if (!el) return;
  const counts = getCategoryCounts();
  el.innerHTML = CATEGORIES.map(c => {
    const n = counts[c.id] || 0;
    // PHASE 0.1 FIX: show the count next to each pill label so users can
    // see at a glance how many workflows are in each category.
    const labelWithCount = `${escapeHtml(c.label)} (${n})`;
    return `<button type="button" class="wf-cat-pill ${c.id === _activeCategory ? 'active' : ''}" data-cat="${c.id}" aria-pressed="${c.id === _activeCategory}">${labelWithCount}</button>`;
  }).join('');
  el.querySelectorAll('.wf-cat-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeCategory = btn.dataset.cat;
      renderCategoryPills();
      renderWorkflows();
    });
  });
}

function renderWorkflows() {
  const grid = document.getElementById('workflows-grid');
  const empty = document.getElementById('workflows-empty');
  if (!grid) return;
  // PHASE 0.1 FIX: use the lazy getter so v3 workflows are included
  // even though they were not yet defined when the original const was
  // evaluated.
  const custom = (typeof loadCustomWorkflows === 'function') ? loadCustomWorkflows() : [];
  const all = getAllBuiltInWorkflows().concat(custom);
  let list = all;
  if (_activeCategory !== 'all') {
    list = list.filter(w => w.category === _activeCategory);
  }
  if (_searchQuery) {
    const q = _searchQuery;
    list = list.filter(w => {
      const hay = [w.name, w.description, w.category, ...(w.tags || [])].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  if (list.length === 0) {
    grid.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    // UX 2 + PHASE 0.1: a category-specific empty state when the user is
    // on the "My Custom" tab. The button jumps directly to the Chain
    // Builder agent (the most direct way to create a custom workflow)
    // and the text must not read like a search failure.
    const text = document.getElementById('workflows-empty-text');
    const hint = document.getElementById('workflows-empty-hint');
    const action = document.getElementById('workflows-empty-action');
    if (_activeCategory === 'custom') {
      if (text) text.textContent = "You haven't saved any custom workflows yet.";
      if (hint) hint.textContent = 'Open the Chain Builder agent to wire a visual pipeline and save it as a custom workflow.';
      if (action) {
        action.textContent = 'Open Chain Builder';
        action.classList.remove('hidden');
      }
    } else {
      if (text) text.textContent = 'No matching workflows.';
      if (hint) hint.textContent = 'Try a different search term or category.';
      if (action) action.classList.add('hidden');
    }
    return;
  }
  if (empty) empty.classList.add('hidden');
  grid.innerHTML = list.map(wf => {
    const badge = wf.fullChain ? '<span class="wf-badge full" title="Has a full audio mastering chain">⚡ Full Chain</span>' : '';
    // v5 hotfix 2 — Bug 1: badge any workflow whose settings include a
    // slow filter (geq, minterpolate, reverse, tmix). The tooltip
    // warns the user that the run is going to be long.
    const slow = workflowHasSlowFilter(wf);
    const slowBadge = slow
      ? `<span class="wf-badge slow" title="🐌 Slow — recommended on clips under 30 seconds.">🐌</span>`
      : '';
    return `
      <article class="wf-card" data-wf-id="${escapeHtml(wf.id)}" role="listitem">
        <header class="wf-card-head">
          <span class="wf-icon">${escapeHtml(wf.icon || '🎬')}</span>
          <span class="wf-name">${escapeHtml(wf.name)}</span>
          ${slowBadge}${badge}
          <button class="wf-info-btn" type="button" data-wf-info="${escapeHtml(wf.id)}" aria-label="Show command">ⓘ</button>
        </header>
        <span class="wf-cat-pill-card cat-${escapeHtml(wf.category)}">${escapeHtml(wf.category.replace(/-/g, ' '))}</span>
        <p class="wf-desc">${escapeHtml(wf.description)}</p>
        <div class="wf-tags">${(wf.tags || []).map(t => `<span class="wf-tag">${escapeHtml(t)}</span>`).join('')}</div>
        <div class="wf-detail" id="wf-detail-${escapeHtml(wf.id)}">${escapeHtml(generateWorkflowCommandString(wf))}</div>
        <div class="wf-actions">
          <button type="button" class="secondary-btn" data-wf-apply="${escapeHtml(wf.id)}">Apply &amp; Edit</button>
          <button type="button" class="primary-btn"   data-wf-run="${escapeHtml(wf.id)}">Apply &amp; Run</button>
        </div>
      </article>
    `;
  }).join('');
  // Bind info buttons
  grid.querySelectorAll('[data-wf-info]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.wfInfo;
      const det = document.getElementById('wf-detail-' + id);
      if (det) det.classList.toggle('show');
    });
  });
  // Apply & Edit
  grid.querySelectorAll('[data-wf-apply]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.wfApply;
      if (typeof applyAndEditWorkflow === 'function') applyAndEditWorkflow(id);
    });
  });
  // Apply & Run
  grid.querySelectorAll('[data-wf-run]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.wfRun;
      if (typeof applyAndRunWorkflow === 'function') {
        // For audio mastering / video glitch pipelines, route through dedicated runner
        // PHASE 0.1 FIX: use getAllBuiltInWorkflows() instead of WORKFLOWS
        // so v3 workflows are discoverable for the routing decision.
        const custom = (typeof loadCustomWorkflows === 'function') ? loadCustomWorkflows() : [];
        const wf = getAllBuiltInWorkflows().concat(custom).find(w => w.id === id);
        if (!wf) return;
        // v4/v5 workflows call a JS engine directly (TRUE datamosh, motion mosh,
        // colour match, hardware path) rather than emitting a filter chain. They
        // must dispatch through run() BEFORE the category routing below, which
        // only knows how to run pipelineStep/filter workflows.
        if (typeof wf.run === 'function') {
          if (!state.inputFile) { logToConsole('warn', 'Load a file first, then run this workflow.'); switchTab('editor'); return; }
          try { await wf.run(); }
          catch (e) { logToConsole('error', `${wf.name} failed: ${e && e.message || e}`); }
          return;
        }
        if (wf.category === 'audio-mastering' && typeof runAudioMasteringWorkflow === 'function') {
          await runAudioMasteringWorkflow(wf);
          return;
        }
        if (wf.category === 'video-glitch-pipelines' && typeof runVideoGlitchPipeline === 'function') {
          await runVideoGlitchPipeline(wf);
          return;
        }
        await applyAndRunWorkflow(id);
      }
    });
  });

  // UX — right-click / Shift+F10 context menu on each workflow card.
  if (window.FFContextMenu) {
    window.FFContextMenu.attach(grid, {
      itemSelector: '.wf-card',
      items: (card) => [
        { label: 'Apply & Run', icon: '▶', action: () => card.querySelector('[data-wf-run]')?.click() },
        { label: 'Apply & Edit', icon: '✎', action: () => card.querySelector('[data-wf-apply]')?.click() },
        { separator: true },
        { label: 'Show ffmpeg command', icon: 'ⓘ', action: () => card.querySelector('[data-wf-info]')?.click() },
      ],
    });
  }

  // UX — make the 215-card grid a single-tab-stop keyboard listbox: arrows move
  // between cards, Enter runs, 'e' applies-and-edits, 'i' toggles the command.
  // This collapses ~645 tab stops to one and gives the cards real focus.
  if (window.FFGridNav) {
    window.FFGridNav.enhance(grid, {
      itemSelector: '.wf-card',
      label: 'Workflow library',
      onActivate: (card) => card.querySelector('[data-wf-run]')?.click(),
      onKey: (e, card) => {
        if (e.key === 'e' || e.key === 'E') { card.querySelector('[data-wf-apply]')?.click(); return true; }
        if (e.key === 'i' || e.key === 'I') { card.querySelector('[data-wf-info]')?.click(); return true; }
        return false;
      },
    });
  }
}

// =============================================================================
// COMMAND STRING FOR WORKFLOW CARD DETAIL VIEW
// =============================================================================
function generateWorkflowCommandString(wf) {
  if (wf.boomerang) return 'ffmpeg -i INPUT -an -c:v libx264 -preset fast -crf 23 forward.mp4\nffmpeg -i forward.mp4 -vf reverse -an reversed.mp4\nffmpeg -i forward.mp4 -i reversed.mp4 -filter_complex "[0:v][1:v]concat=n=2:v=1[v]" -map "[v]" -c:v libx264 boomerang.mp4';
  if (wf.extractFrame) return `ffmpeg -ss ${wf.extractFrame} -i INPUT -frames:v 1 -q:v 2 output.jpg`;
  if (wf.fullChain) {
    return `# Full Chain:\nffmpeg -i INPUT -af "${wf.fullChain}" -ar 44100 -c:a pcm_s16le output.wav\n\n# Simplified Fallback:\nffmpeg -i INPUT -af "${wf.simplifiedChain}" -ar 44100 -c:a pcm_s16le output.wav`;
  }
  if (wf.pipelineSteps) {
    return wf.pipelineSteps.map((s, i) => `# Step ${i+1}: ${s.name}\n# ${s.description}\n# (intermediate file → step_${i+1}.mp4)`).join('\n\n');
  }
  // Generic: produce a placeholder command by temporarily applying settings and
  // reading the preview. This requires the editor + an input; we approximate.
  const settings = wf.settings || {};
  const filters = [];
  if (settings['enable-7'] && settings['eq-saturation']) filters.push('eq=saturation=' + settings['eq-saturation']);
  if (settings['enable-13'] && settings['add-noise'])      filters.push('noise=alls=' + settings['noise-strength']);
  if (settings['enable-19'] && settings['g-lagfun-enable']) filters.push('lagfun=decay=' + settings['g-lagfun-decay']);
  const filterStr = filters.length ? `-vf "${filters.join(',')}"` : '';
  const codec = wf.codec || 'libx264';
  const crf = wf.crf || 23;
  const ext = wf.outputFormat || 'mp4';
  return `ffmpeg -i INPUT ${filterStr} -c:v ${codec} -crf ${crf} output.${ext}`;
}

// =============================================================================
// Expose globals
// =============================================================================
// PHASE 0.1 FIX: expose `WORKFLOWS` as a Proxy that delegates to
// getAllBuiltInWorkflows() on every property read. This keeps the legacy
// `window.WORKFLOWS.length` / `WORKFLOWS.find(...)` / `WORKFLOWS.concat(...)`
// call sites working AND ensures the v3 workflows are always included.
const WORKFLOWS_PROXY = new Proxy({}, {
  get(_target, prop) {
    const arr = getAllBuiltInWorkflows();
    const v = arr[prop];
    if (typeof v === 'function') return v.bind(arr);
    return v;
  },
  has(_target, prop) {
    return prop in getAllBuiltInWorkflows();
  },
  ownKeys() {
    return Reflect.ownKeys(getAllBuiltInWorkflows());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(getAllBuiltInWorkflows(), prop);
  },
});
window.WORKFLOWS = WORKFLOWS_PROXY;
window.CATEGORIES = CATEGORIES;
window.initWorkflowsUI = initWorkflowsUI;
window.renderWorkflows = renderWorkflows;
window.getAllBuiltInWorkflows = getAllBuiltInWorkflows;
