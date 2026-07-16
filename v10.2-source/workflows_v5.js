/* =============================================================================
   workflows_v5.js — REAL-TIME MOTION-VECTOR DATAMOSH
   -----------------------------------------------------------------------------
   These do the thing the codec does — estimate motion vectors, then apply them
   to the wrong picture. No ffmpeg. No bitstream hacking. Works on ANY video.
   ========================================================================== */

const _mosh = (name, params, desc, icon, tags) => ({
  id: `mosh-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  name: `Motion Mosh — ${name}`,
  category: 'video-glitch-pipelines',
  description: desc,
  tags: ['datamosh', 'motion', 'realtime', 'true', ...tags],
  icon, slow: true,
  run: () => {
    const m = window.state?.inputFile;
    if (!m) return window.logToConsole?.('warn', 'No file selected.');
    return window.FFMosh.renderFile(m, params, (p, fps) => {
      window.setProgress?.(p);
      window.setProgressText?.(`Motion moshing — ${Math.round(p * 100)}% (${Math.round(fps)} fps)`);
    });
  },
});

window.WORKFLOWS_V5 = [
  _mosh('Classic Smear',
    { blockSize: 16, motionRadius: 6, motionStrength: 1.0, persistence: 0.96, iFrameInterval: 0, autoMoshOnCut: true },
    'The real thing. Motion vectors from each new frame, applied to the old picture. The scene drags itself into the next one.',
    '🌀', ['smear', 'classic']),

  _mosh('Total Liquefaction',
    { blockSize: 8, motionRadius: 10, motionStrength: 1.8, persistence: 0.99, iFrameInterval: 0, threshold: 4 },
    'Small blocks, long search, nothing ever refreshes. The image never recovers.',
    '🫠', ['extreme', 'liquid', 'chaos']),

  _mosh('Pulse',
    { blockSize: 16, motionRadius: 6, motionStrength: 1.2, persistence: 0.94, iFrameInterval: 24 },
    'Moshes for 24 frames, then lets a clean frame back in. Breathes. Good over a beat.',
    '💓', ['rhythmic', 'pulse', 'beat']),

  _mosh('Bloom',
    { blockSize: 32, motionRadius: 4, motionStrength: 2.0, persistence: 0.97, iFrameInterval: 0 },
    'Big blocks, hard vectors. The picture pushes outward and blooms.',
    '💥', ['bloom', 'push', 'expand']),

  _mosh('Compression Death',
    { blockSize: 16, motionRadius: 6, motionStrength: 1.0, persistence: 0.95,
      jpegArtifacts: true, jpegQuality: 0.2, iFrameInterval: 0 },
    'Motion mosh PLUS a real JPEG re-encode every frame at quality 0.2. Genuine DCT blocking, because it is genuine DCT blocking.',
    '🧱', ['jpeg', 'compression', 'artifacts', 'blocky']),

  _mosh('Ghost Trails',
    { blockSize: 16, motionRadius: 8, motionStrength: 0.5, persistence: 0.985, threshold: 20, iFrameInterval: 0 },
    'Gentle vectors, very long persistence. Motion leaves a trail instead of tearing the frame apart.',
    '👻', ['ghost', 'trails', 'subtle']),

  _mosh('Scene-Cut Only',
    { blockSize: 16, motionRadius: 6, motionStrength: 1.4, persistence: 0.97,
      iFrameInterval: 6, autoMoshOnCut: true, sceneCut: 0.28 },
    'Clean most of the time — then detonates on every scene change. Cuts are where moshing looks best, because that is exactly where the codec would have inserted a keyframe and we refuse to.',
    '✂️', ['scene', 'cut', 'transition', 'smart']),
];
