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
  {
    id: 'databend',
    name: 'Databend',
    category: 'video-glitch-pipelines',
    description: 'Real databending — corrupt the raw bytes of the encoded stream and decode through the damage with error concealment on. Genuine byte-level glitch, not a filter.',
    tags: ['databend', 'corrupt', 'bytes', 'glitch', 'true'],
    icon: '🧨', slow: true,
    run: () => window.FFDatamosh.databend({ rate: 0.0008 }),
  },

  // ---- MASKED / ANGLED PIXEL SORT ----
  {
    id: 'pixel-sort-masked',
    name: 'Pixel Sort — Masked',
    category: 'video-glitch-pipelines',
    description: 'Sorts only the pixels whose brightness falls inside a mid-tone band, leaving shadows and highlights intact — the selective look, not the whole-frame smear. A real per-frame sort applied to every frame.',
    tags: ['pixelsort', 'sort', 'glitch', 'mask', 'band'],
    icon: '🌈', slow: true,
    run: () => {
      const m = window.state?.inputFile;
      if (!m) return window.logToConsole?.('warn', 'No file selected.');
      return window.FFShaderPlus.renderPixelSort(m, { lo: 0.25, hi: 0.85, mode: 'brightness', angle: 0, order: 'asc' }, (p) => {
        window.setProgress?.(p);
        window.setProgressText?.(`Pixel sorting — ${Math.round(p * 100)}%`);
      });
    },
  },
  {
    id: 'pixel-sort-diagonal',
    name: 'Pixel Sort — Diagonal',
    category: 'video-glitch-pipelines',
    description: 'The masked sort, run along a 45° axis so the streaks fall on the diagonal instead of the scanline. Rotate → sort the band → rotate back.',
    tags: ['pixelsort', 'sort', 'glitch', 'diagonal', 'angle'],
    icon: '📐', slow: true,
    run: () => {
      const m = window.state?.inputFile;
      if (!m) return window.logToConsole?.('warn', 'No file selected.');
      return window.FFShaderPlus.renderPixelSort(m, { lo: 0.2, hi: 0.9, mode: 'brightness', angle: 45, order: 'asc' }, (p) => {
        window.setProgress?.(p);
        window.setProgressText?.(`Pixel sorting — ${Math.round(p * 100)}%`);
      });
    },
  },

  // ---- REAL FILM GRAIN ----
  {
    id: 'film-grain',
    name: 'Film Grain',
    category: 'retro-analog',
    description: 'Real plate-based film grain — silver-halide clumps with actual spatial structure, luma-weighted so it lives in the mids and fades in the blacks and highlights. The plate shifts each frame like a physical negative. Not per-pixel digital noise.',
    tags: ['grain', 'film', 'analog', 'plate', 'texture', '35mm'],
    icon: '🎞️', slow: true,
    run: () => {
      const m = window.state?.inputFile;
      if (!m) return window.logToConsole?.('warn', 'No file selected.');
      return window.FFShaderPlus.renderFilmGrain(m, { intensity: 0.14, size: 2, seed: 1337 }, (p) => {
        window.setProgress?.(p);
        window.setProgressText?.(`Film grain — ${Math.round(p * 100)}%`);
      });
    },
  },

  // ---- HALATION & BLOOM ----
  {
    id: 'halation-bloom',
    name: 'Halation & Bloom',
    category: 'artistic-stylize',
    description: 'A physical light-bleed pass — the brightest highlights are thresholded, blurred, tinted red, and screened back so they bloom and bleed into their surroundings the way real film halates around blown-out light. Not procedural noise.',
    tags: ['halation', 'bloom', 'glow', 'film', 'highlight', 'light'],
    icon: '🌟', slow: true,
    run: () => {
      const m = window.state?.inputFile;
      if (!m) return window.logToConsole?.('warn', 'No file selected.');
      return window.FFShaderPlus.renderHalation(m, { threshold: 0.72, radius: 8, intensity: 0.9, passes: 3, tint: [1.0, 0.55, 0.35] }, (p) => {
        window.setProgress?.(p);
        window.setProgressText?.(`Halation — ${Math.round(p * 100)}%`);
      });
    },
  },

  // ---- FEEDBACK TUNNEL ----
  {
    id: 'feedback-tunnel',
    name: 'Feedback Tunnel',
    category: 'video-glitch-pipelines',
    description: 'The infinite video-feedback tunnel. Each frame re-draws the last one zoomed and rotated a touch, fading as it goes, so any detail spirals outward forever. Runs offline over the whole clip.',
    tags: ['feedback', 'tunnel', 'zoom', 'rotate', 'trippy', 'psychedelic'],
    icon: '🌀', slow: true,
    run: () => {
      const m = window.state?.inputFile;
      if (!m) return window.logToConsole?.('warn', 'No file selected.');
      return window.FFShaderPlus.renderFeedback(m, { zoom: 1.03, rotate: 0.015, decay: 0.9, mix: 0.75, blend: 'lighter' }, (p) => {
        window.setProgress?.(p);
        window.setProgressText?.(`Feedback tunnel — ${Math.round(p * 100)}%`);
      });
    },
  },
  {
    id: 'feedback-vortex',
    name: 'Feedback Vortex',
    category: 'video-glitch-pipelines',
    description: 'The tunnel wound tighter — stronger zoom, faster spin, longer trails. Everything gets pulled into the swirl.',
    tags: ['feedback', 'vortex', 'spiral', 'zoom', 'rotate', 'trippy'],
    icon: '🌪️', slow: true,
    run: () => {
      const m = window.state?.inputFile;
      if (!m) return window.logToConsole?.('warn', 'No file selected.');
      return window.FFShaderPlus.renderFeedback(m, { zoom: 1.06, rotate: 0.05, decay: 0.94, mix: 0.6, blend: 'lighter' }, (p) => {
        window.setProgress?.(p);
        window.setProgressText?.(`Feedback vortex — ${Math.round(p * 100)}%`);
      });
    },
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
