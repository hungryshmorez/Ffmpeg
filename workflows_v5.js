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

  // --- mosh-family shaping (#58–61) ---
  _mosh('Horizontal Smear',
    { blockSize: 16, motionRadius: 8, motionStrength: 1.2, persistence: 0.97, directionY: 0, iFrameInterval: 0 },
    'Directional mosh — the vertical component of every motion vector is killed, so the whole image drags sideways. The classic horizontal datamosh streak.',
    '↔️', ['directional', 'horizontal', 'smear', 'classic']),

  _mosh('Vertical Drip',
    { blockSize: 16, motionRadius: 8, motionStrength: 1.2, persistence: 0.97, directionX: 0, iFrameInterval: 0 },
    'Directional mosh biased to the vertical axis — motion bleeds up and down like the picture is melting off the screen.',
    '↕️', ['directional', 'vertical', 'drip']),

  _mosh('Masked Mosh',
    { blockSize: 16, motionRadius: 6, motionStrength: 1.3, persistence: 0.97, motionMask: true, maskMotion: 2, iFrameInterval: 0 },
    'Only the moving parts tear — everything still stays sharp. Motion-magnitude masking keeps the background clean while the subject smears.',
    '🎭', ['mask', 'motion', 'selective']),

  _mosh('Amplified Chaos',
    { blockSize: 16, motionRadius: 12, motionStrength: 1.4, persistence: 0.98, amplify: 0.5, iFrameInterval: 0 },
    'A non-linear amplification curve pushes every motion vector toward the max — even gentle motion detonates into a full smear.',
    '💢', ['amplify', 'curve', 'extreme']),

  _mosh('Bloom Push',
    { blockSize: 24, motionRadius: 6, motionStrength: 1.2, persistence: 0.97, bloomIterations: 4, iFrameInterval: 0 },
    'Applies each frame’s displacement four times over, pushing the picture outward and blooming with every pass.',
    '🌸', ['bloom', 'repeat', 'push', 'expand']),

  // --- optical-flow displacement (#68) — the field warps its OWN frame ---
  (() => {
    const flow = (name, params, desc, icon, tags) => ({
      id: `flow-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name: `Flow Warp — ${name}`,
      category: 'video-glitch-pipelines',
      description: desc,
      tags: ['flow', 'displacement', 'warp', 'optical', ...tags],
      icon, slow: true,
      run: () => {
        const m = window.state?.inputFile;
        if (!m) return window.logToConsole?.('warn', 'No file selected.');
        return window.FFMosh.renderFlowDisplace(m, params, (p) => {
          window.setProgress?.(p);
          window.setProgressText?.(`Flow warp — ${Math.round(p * 100)}%`);
        });
      },
    });
    return [
      flow('Liquid',
        { blockSize: 16, motionRadius: 12, threshold: 1, scale: 3 },
        'Uses each frame’s own optical flow as a displacement map — the picture warps like liquid exactly where the scene moves, and stays sharp where it’s still. Not a datamosh tear; a smooth bilinear warp.',
        '💧', ['liquid', 'smooth']),
      flow('Heat Haze',
        { blockSize: 24, motionRadius: 8, threshold: 2, scale: 1.5 },
        'A gentler flow warp — subtle shimmer that ripples the moving parts like heat off tarmac.',
        '🔥', ['haze', 'shimmer', 'subtle']),
      flow('Riptide',
        { blockSize: 12, motionRadius: 16, threshold: 0, scale: 6 },
        'Small blocks, long search, heavy scale — the whole frame is dragged into the current. Everything that moves smears violently.',
        '🌊', ['extreme', 'drag', 'current']),
    ];
  })(),

  // --- motion-vector overlay (#57), arrows ON by default ---
  {
    id: 'vector-overlay',
    name: 'Motion Vectors — Overlay',
    category: 'video-glitch-pipelines',
    description: 'Draws the estimated motion field as green arrows over a dimmed version of the frame — the codec’s-eye view of your footage. The overlay is on by default; genuinely useful for dialling a mosh in, and a striking look on its own.',
    tags: ['motion', 'vectors', 'overlay', 'debug', 'flow', 'arrows'],
    icon: '🧭', slow: true,
    run: () => {
      const m = window.state?.inputFile;
      if (!m) return window.logToConsole?.('warn', 'No file selected.');
      return window.FFMosh.renderVectorOverlay(m, { blockSize: 16, motionRadius: 12, threshold: 1, dim: 0.55, scale: 2.5 }, (p) => {
        window.setProgress?.(p);
        window.setProgressText?.(`Motion vectors — ${Math.round(p * 100)}%`);
      });
    },
  },
].flat();
