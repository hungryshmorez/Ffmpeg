/* =============================================================================
   workflows_v4.js — PHASE 4 WORKFLOWS
   These call into the new engines rather than emitting a plain filter chain.
   ========================================================================== */

window.WORKFLOWS_V4 = [
  // ---- TRUE BITSTREAM DATAMOSH ----
  {
    id: 'true-datamosh-smear',
    name: 'TRUE Datamosh — Smear',
    category: 'video-glitch-pipelines',
    description: 'Real bitstream datamoshing. Deletes the I-frames so orphaned motion vectors smear the old scene along the new one. This is NOT a tblend approximation — it is the actual effect.',
    tags: ['datamosh', 'bitstream', 'iframe', 'smear', 'true', 'glitch'],
    icon: '🌀', slow: true,
    run: () => window.FFDatamosh.trueDatamosh({ mode: 'smear' }),
  },
  {
    id: 'true-datamosh-bloom',
    name: 'TRUE Datamosh — Bloom',
    category: 'video-glitch-pipelines',
    description: 'Duplicates P-frames so their motion vectors are applied repeatedly, pushing the image outward. The classic datamosh "bloom".',
    tags: ['datamosh', 'bitstream', 'pframe', 'bloom', 'true'],
    icon: '💥', slow: true,
    run: () => window.FFDatamosh.trueDatamosh({ mode: 'bloom', bloomFactor: 4, bloomEvery: 10 }),
  },
  {
    id: 'true-datamosh-both',
    name: 'TRUE Datamosh — Total Destruction',
    category: 'video-glitch-pipelines',
    description: 'I-frame removal AND P-frame duplication. Maximum bitstream corruption.',
    tags: ['datamosh', 'bitstream', 'chaos', 'destruction', 'true'],
    icon: '☠️', slow: true,
    run: () => window.FFDatamosh.trueDatamosh({ mode: 'both', bloomFactor: 3, bloomEvery: 8, quality: 10 }),
  },

  // ---- AUTO COLOUR MATCH ----
  {
    id: 'color-match',
    name: 'Match Colour to a Reference',
    category: 'color-grading',
    description: 'Upload a still from a film you like. Generates a 3D LUT that transforms your footage into its colour palette. Pure statistics — no model.',
    tags: ['lut', 'color', 'match', 'reference', 'grade', 'film'],
    icon: '🎨',
    run: async () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = async () => {
        if (!inp.files[0]) return;
        await window.FFDatamosh.generateMatchLUT(inp.files[0]);
        const m = window.state.inputFile;
        await window.executeFFmpeg([
          '-i', m.virtualName, '-vf', 'lut3d=file=match.cube',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1',
          '-pix_fmt', 'yuv420p', '-y', 'matched.mp4',
        ]);
      };
      inp.click();
    },
  },

  // ---- HARDWARE FAST PATH ----
  {
    id: 'hw-transcode',
    name: '⚡ Hardware Transcode',
    category: 'video-editing',
    description: 'Re-encode on the GPU via WebCodecs — the same silicon Chrome uses to play YouTube. 10–50× faster than WebAssembly.',
    tags: ['hardware', 'webcodecs', 'fast', 'gpu', 'transcode'],
    icon: '⚡', fast: true,
    run: async () => {
      const m = window.state.inputFile;
      if (!m?.file) return;
      const r = await window.FFHardware.hwTranscode(m.file, { bitrate: 6_000_000 });
      await window.addBlobToBin(r.blob, `${m.name} [⚡ hw]`, 'video/mp4');
    },
  },
  {
    id: 'hw-glitch',
    name: '⚡ Hardware Glitch (GPU shader)',
    category: 'video-glitch-pipelines',
    description: 'Decode on hardware → run a TRIP CAM shader on the GPU → encode on hardware. The pixels never touch the CPU.',
    tags: ['hardware', 'webcodecs', 'shader', 'gpu', 'glitch', 'fast'],
    icon: '⚡', fast: true,
    run: async () => {
      const m = window.state.inputFile;
      if (!m?.file) return;
      const shader = window.FFHardware.makeShaderPass('datamosh', { trailPersistence: 0.95, glitchStrength: 0.6 });
      const r = await window.FFHardware.hwTranscode(m.file, { bitrate: 8_000_000, applyShader: shader });
      await window.addBlobToBin(r.blob, `${m.name} [⚡ hw glitch]`, 'video/mp4');
    },
  },
];
