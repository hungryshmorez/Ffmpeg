/* =============================================================================
   datamosh.js — TRUE BITSTREAM DATAMOSH + AUTO COLOR MATCH
   -----------------------------------------------------------------------------
   Everything labelled "datamosh" in this app until now has been a tblend/lagfun
   APPROXIMATION. It looks like ghosting. It is not datamoshing.

   Real datamoshing is a BITSTREAM operation:

     • An I-frame is a complete picture. It resets the decoder.
     • A P-frame contains only MOTION VECTORS — "move these blocks from where
       they were." It has no picture of its own.
     • DELETE the I-frames, and the P-frames keep applying their motion vectors
       to whatever picture happens to be on screen. The old scene SMEARS along
       the new scene's motion.

     • DUPLICATE a P-frame, and its motion is applied twice — the "bloom" effect.

   We do it in three steps:
     1. ffmpeg.wasm encodes to AVI with `-g 9999 -sc_threshold 0` so we get one
        I-frame at the top and nothing but P-frames after it.
     2. We parse the AVI chunk index IN JAVASCRIPT and rewrite the byte stream —
        removing keyframe chunks, repeating delta chunks.
     3. ffmpeg.wasm remuxes the corrupted AVI to MP4.

   AVI is used deliberately: its frame boundaries are trivially parseable
   ('00dc' chunks with a keyframe flag in the index), where MP4 hides everything
   behind sample tables. This is the classic datamosh workflow.
   ========================================================================== */

(function () {
  'use strict';

  // ===========================================================================
  // AVI PARSING
  // ===========================================================================

  const fourcc = (dv, off) => String.fromCharCode(
    dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));

  /**
   * Walk the AVI 'movi' list and return every video chunk with its byte range
   * and whether it's a keyframe.
   */
  function parseAVI(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (fourcc(dv, 0) !== 'RIFF' || fourcc(dv, 8) !== 'AVI ') {
      throw new Error('Not an AVI file.');
    }

    let movi = -1, moviEnd = -1;
    let p = 12;
    while (p < dv.byteLength - 8) {
      const id = fourcc(dv, p);
      const size = dv.getUint32(p + 4, true);
      if (id === 'LIST') {
        const type = fourcc(dv, p + 8);
        if (type === 'movi') { movi = p + 12; moviEnd = p + 8 + size; break; }
        p += 12;                       // descend into other LISTs
        continue;
      }
      p += 8 + size + (size & 1);
    }
    if (movi < 0) throw new Error('No movi list found.');

    // Walk the chunks. '##dc' = compressed video, '##wb' = audio.
    const frames = [];
    p = movi;
    while (p < moviEnd - 8 && p < dv.byteLength - 8) {
      const id = fourcc(dv, p);
      const size = dv.getUint32(p + 4, true);
      if (/^\d\ddc$/.test(id)) {
        // For MPEG-4 Part 2 (which is what we encode to), a keyframe (I-VOP)
        // starts with the VOP start code 00 00 01 B6 followed by 2 bits of
        // vop_coding_type == 00. A P-VOP has 01.
        let isKey = false;
        const d = p + 8;
        for (let i = d; i < Math.min(d + 64, d + size - 4); i++) {
          if (dv.getUint8(i) === 0 && dv.getUint8(i + 1) === 0 &&
              dv.getUint8(i + 2) === 1 && dv.getUint8(i + 3) === 0xB6) {
            isKey = ((dv.getUint8(i + 4) >> 6) & 0x03) === 0;   // 00 = I-VOP
            break;
          }
        }
        frames.push({ start: p, end: p + 8 + size + (size & 1), size, isKey, id });
      }
      p += 8 + size + (size & 1);
    }

    return { dv, bytes, movi, moviEnd, frames, header: bytes.slice(0, movi), tail: bytes.slice(moviEnd) };
  }

  /**
   * Rewrite the byte stream.
   *   mode 'smear'  — delete every I-frame after the first. Old scene smears
   *                   along the new scene's motion vectors. The classic look.
   *   mode 'bloom'  — duplicate P-frames. Their motion is applied repeatedly,
   *                   pushing the image outward. The "blooming" look.
   *   mode 'both'   — smear + bloom.
   */
  function rebuildAVI(parsed, { mode = 'smear', bloomFactor = 3, bloomEvery = 12 } = {}) {
    const { frames, header, tail, bytes } = parsed;
    const parts = [header];
    let removed = 0, duplicated = 0, seenFirstKey = false;

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const chunk = bytes.slice(f.start, f.end);

      if (f.isKey) {
        if (!seenFirstKey) {
          // Keep exactly ONE I-frame — the decoder needs a picture to start from.
          seenFirstKey = true;
          parts.push(chunk);
        } else if (mode === 'smear' || mode === 'both') {
          // DELETE it. This is the datamosh.
          removed++;
          continue;
        } else {
          parts.push(chunk);
        }
      } else {
        parts.push(chunk);
        if ((mode === 'bloom' || mode === 'both') && i % bloomEvery === 0) {
          for (let k = 1; k < bloomFactor; k++) { parts.push(chunk); duplicated++; }
        }
      }
    }
    parts.push(tail);

    // Concatenate.
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }

    return { bytes: out, removed, duplicated, kept: frames.length - removed };
  }

  // ===========================================================================
  // THE PIPELINE
  // ===========================================================================

  async function trueDatamosh(opts = {}) {
    const {
      mode = 'smear',
      bloomFactor = 3,
      bloomEvery = 12,
      quality = 6,               // mpeg4 -q:v (2=best, 31=worst). Higher = more artifacts.
    } = opts;

    const m = window.state?.inputFile;
    if (!m) { window.logToConsole?.('warn', 'No file selected.'); return null; }

    const ff = window.ff;
    const log = (s, k = '') => window.logToConsole?.(k, `[mosh] ${s}`);

    try {
      // ---- 1. Encode to AVI with NO scene-cut keyframes. ----
      // -g 9999      : keyframe interval so long there's effectively one at the top
      // -sc_threshold 0 : never insert a keyframe on a scene change
      // mpeg4        : simple, parseable VOP headers. This is the datamosh codec.
      log('1/3 encoding to keyframeless AVI…');
      await ff.exec([
        '-i', m.virtualName,
        '-c:v', 'mpeg4', '-q:v', String(quality),
        '-g', '9999', '-sc_threshold', '0',
        '-an', '-y', 'mosh_src.avi',
      ]);

      // ---- 2. Corrupt the bitstream. In JavaScript. ----
      log('2/3 rewriting the bitstream…');
      const raw = await ff.readFile('mosh_src.avi');
      const parsed = parseAVI(raw);
      log(`parsed ${parsed.frames.length} frames · ${parsed.frames.filter(f => f.isKey).length} I-frames`);

      const rebuilt = rebuildAVI(parsed, { mode, bloomFactor, bloomEvery });
      log(`removed ${rebuilt.removed} I-frame(s) · duplicated ${rebuilt.duplicated} P-frame(s)`,
          rebuilt.removed || rebuilt.duplicated ? 'ok' : 'warn');

      if (!rebuilt.removed && !rebuilt.duplicated) {
        log('nothing to mosh — the source had no removable keyframes.', 'warn');
      }

      await ff.writeFile('mosh_out.avi', rebuilt.bytes);
      await ff.deleteFile('mosh_src.avi').catch(() => {});

      // ---- 3. Remux the corrupted stream to MP4. ----
      // The decoder now applies orphaned motion vectors to whatever picture is
      // on screen. That smear IS the datamosh.
      log('3/3 remuxing…');
      await ff.exec([
        '-fflags', '+genpts+igndts',
        '-i', 'mosh_out.avi',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1',
        '-pix_fmt', 'yuv420p', '-y', 'mosh_final.mp4',
      ]);

      const data = await ff.readFile('mosh_final.mp4');
      if (!data?.length) throw new Error('Mosh produced no output.');

      const blob = new Blob([data.buffer], { type: 'video/mp4' });
      await window.addBlobToBin?.(blob, `${m.name} [DATAMOSH ${mode}]`, 'video/mp4');

      await ff.deleteFile('mosh_out.avi').catch(() => {});
      await ff.deleteFile('mosh_final.mp4').catch(() => {});

      log(`✔ done — ${(blob.size / 1024 / 1024).toFixed(2)} MB → Media Bin`, 'ok');
      return { blob, ...rebuilt };
    } catch (e) {
      window.logToConsole?.('error', `[mosh] ${e.message}`);
      throw e;
    }
  }

  // ===========================================================================
  // AUTO COLOR MATCH — generate a 3D LUT from a reference image.
  // ---------------------------------------------------------------------------
  // "Make my footage look like this."
  // Pure math. No model. Reinhard statistical colour transfer in Lαβ space:
  // match the mean and standard deviation of each channel to the reference.
  // ===========================================================================

  function imageStats(imgData) {
    const d = imgData.data;
    const n = d.length / 4;
    // Work in a decorrelated log space — this is what makes the transfer stable.
    let sum = [0, 0, 0], sum2 = [0, 0, 0];
    const lab = new Float32Array(n * 3);

    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
      const R = Math.max(1, d[i]) / 255, G = Math.max(1, d[i + 1]) / 255, B = Math.max(1, d[i + 2]) / 255;
      // RGB → LMS → log → Lαβ (Ruderman)
      const L = Math.log(0.3811 * R + 0.5783 * G + 0.0402 * B + 1e-6);
      const M = Math.log(0.1967 * R + 0.7244 * G + 0.0782 * B + 1e-6);
      const S = Math.log(0.0241 * R + 0.1288 * G + 0.8444 * B + 1e-6);
      const l = (L + M + S) / Math.sqrt(3);
      const a = (L + M - 2 * S) / Math.sqrt(6);
      const b = (L - M) / Math.sqrt(2);
      lab[j] = l; lab[j + 1] = a; lab[j + 2] = b;
      sum[0] += l; sum[1] += a; sum[2] += b;
      sum2[0] += l * l; sum2[1] += a * a; sum2[2] += b * b;
    }
    const mean = sum.map((s) => s / n);
    const std  = sum2.map((s2, i) => Math.sqrt(Math.max(1e-6, s2 / n - mean[i] * mean[i])));
    return { mean, std };
  }

  function labToRgb(l, a, b) {
    const L = l / Math.sqrt(3) + a / Math.sqrt(6) + b / Math.sqrt(2);
    const M = l / Math.sqrt(3) + a / Math.sqrt(6) - b / Math.sqrt(2);
    const S = l / Math.sqrt(3) - (2 * a) / Math.sqrt(6);
    const eL = Math.exp(L), eM = Math.exp(M), eS = Math.exp(S);
    return [
      Math.min(1, Math.max(0,  4.4679 * eL - 3.5873 * eM + 0.1193 * eS)),
      Math.min(1, Math.max(0, -1.2186 * eL + 2.3809 * eM - 0.1624 * eS)),
      Math.min(1, Math.max(0,  0.0497 * eL - 0.2439 * eM + 1.2045 * eS)),
    ];
  }

  function rgbToLab(R, G, B) {
    R = Math.max(1 / 255, R); G = Math.max(1 / 255, G); B = Math.max(1 / 255, B);
    const L = Math.log(0.3811 * R + 0.5783 * G + 0.0402 * B + 1e-6);
    const M = Math.log(0.1967 * R + 0.7244 * G + 0.0782 * B + 1e-6);
    const S = Math.log(0.0241 * R + 0.1288 * G + 0.8444 * B + 1e-6);
    return [
      (L + M + S) / Math.sqrt(3),
      (L + M - 2 * S) / Math.sqrt(6),
      (L - M) / Math.sqrt(2),
    ];
  }

  async function toImageData(fileOrBlob, maxDim = 256) {
    const bmp = await createImageBitmap(fileOrBlob);
    const s = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width  = Math.max(1, Math.round(bmp.width  * s));
    c.height = Math.max(1, Math.round(bmp.height * s));
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return g.getImageData(0, 0, c.width, c.height);
  }

  /** Grab a representative frame from the active source, with no ffmpeg call. */
  async function grabSourceFrame(media, atSec = 1) {
    if (media.type !== 'video') return await toImageData(media.file);
    const v = document.createElement('video');
    v.src = media.blobUrl; v.muted = true;
    await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 4000); });
    v.currentTime = Math.min(atSec, (v.duration || 2) * 0.4);
    await new Promise((r) => { v.onseeked = r; setTimeout(r, 3000); });
    const c = document.createElement('canvas');
    c.width = 256; c.height = Math.round(256 * (v.videoHeight / v.videoWidth)) || 144;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.getContext('2d').getImageData(0, 0, c.width, c.height);
  }

  /**
   * Build a .cube LUT that transforms the SOURCE's colour statistics into the
   * REFERENCE's. One click: "make my footage look like this."
   */
  async function generateMatchLUT(referenceFile, size = 17) {
    const m = window.state?.inputFile;
    if (!m) throw new Error('No source file selected.');

    window.logToConsole?.('', '[match] analysing reference…');
    const refStats = imageStats(await toImageData(referenceFile));
    window.logToConsole?.('', '[match] analysing source…');
    const srcStats = imageStats(await grabSourceFrame(m));

    // Reinhard: shift to zero-mean, rescale by the std ratio, shift to the ref mean.
    const gain = refStats.std.map((s, i) => s / Math.max(1e-4, srcStats.std[i]));

    let cube = `# Auto colour match\nTITLE "Colour Match"\nLUT_3D_SIZE ${size}\n`;
    for (let b = 0; b < size; b++) {
      for (let g = 0; g < size; g++) {
        for (let r = 0; r < size; r++) {
          const R = r / (size - 1), G = g / (size - 1), B = b / (size - 1);
          const [l, a, bb] = rgbToLab(R, G, B);
          const L2 = (l  - srcStats.mean[0]) * gain[0] + refStats.mean[0];
          const A2 = (a  - srcStats.mean[1]) * gain[1] + refStats.mean[1];
          const B2 = (bb - srcStats.mean[2]) * gain[2] + refStats.mean[2];
          const [R2, G2, B3] = labToRgb(L2, A2, B2);
          cube += `${R2.toFixed(6)} ${G2.toFixed(6)} ${B3.toFixed(6)}\n`;
        }
      }
    }

    await window.ff.writeFile('match.cube', new TextEncoder().encode(cube));
    window.logToConsole?.('ok', '[match] LUT generated → match.cube (apply with lut3d, intensity slider works)');
    return { file: 'match.cube', cube, refStats, srcStats, gain };
  }

  window.FFDatamosh = {
    parseAVI, rebuildAVI, trueDatamosh,
    generateMatchLUT, imageStats, toImageData,
  };
})();
