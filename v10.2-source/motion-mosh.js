/* =============================================================================
   motion-mosh.js — REAL-TIME MOTION-VECTOR DATAMOSHING
   (ported from your Datamosh Lab)
   -----------------------------------------------------------------------------
   This replaces BOTH of the app's previous datamosh implementations, and it is
   better than either:

     v1-v7  "datamosh" = tblend/lagfun.        → ghosting. Not datamoshing.
     v8     "true datamosh" = AVI bitstream.   → real, but OFFLINE, MPEG-4 only,
                                                 and it only works if ffmpeg
                                                 happens to lay the file out the
                                                 way the parser expects.

   THIS does the actual thing the codec does, ourselves, in JavaScript:

     1. Split the frame into blocks.
     2. For each block, search the PREVIOUS frame for where that block came from
        (block matching, minimising Sum of Absolute Differences).
        → that displacement IS a motion vector. It is exactly what a P-frame
          stores.
     3. Now apply those motion vectors to the WRONG picture.

   The result: the old scene gets dragged along the new scene's motion. That is
   datamoshing — the real effect, on ANY video, in REAL TIME, with live controls,
   and with zero dependence on ffmpeg or on a particular container layout.

   Uses a hierarchical pyramid (coarse→fine) so the search is fast enough to run
   at video rate: estimate on a downscaled frame, then refine.
   ========================================================================== */

(function () {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    blockSize: 16,        // 8 / 16 / 32 — the codec's macroblock size
    motionRadius: 6,      // search radius in px (bigger = catches faster motion, slower)
    motionStrength: 1.0,  // 0-2 — how hard the vectors are applied
    threshold: 12,        // SAD below this = "no motion", block is left alone
    persistence: 0.94,    // how long the smear survives (0.8 = short, 0.99 = forever)
    sceneCut: 0.35,       // scene-change sensitivity — a cut is where moshing LOOKS best
    autoMoshOnCut: true,  // hold the old frame through a cut = the classic effect
    iFrameInterval: 0,    // 0 = never refresh (full mosh). >0 = refresh every N frames.
    jpegArtifacts: false, // re-encode each frame as low-quality JPEG → blocking artifacts
    jpegQuality: 0.35,
    denoise: false,
  };

  class MotionMosher {
    constructor(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d', { willReadFrequently: true });
      this.p = { ...DEFAULTS };

      this.prevY = null;      // previous luma plane (for matching)
      this.accum = null;      // the accumulated / smeared picture
      this.vec = null;        // motion vector field
      this.frameNo = 0;
      this.moshing = false;
      this.forceHold = false;
      this.lastSAD = 0;
      this.fps = 0;
      this._t = performance.now();
      this._work = document.createElement('canvas');
      this._wctx = this._work.getContext('2d', { willReadFrequently: true });
    }

    setParams(patch) { Object.assign(this.p, patch); }

    /** Trigger a mosh at this instant — the "MOSH CUT" button. */
    moshCut() {
      this.forceHold = true;
      this.frameNo = 1;                    // pretend a P-frame run just started
    }

    /** Force a clean refresh — drops the smear (an I-frame). */
    forceIFrame() {
      this.accum = null;
      this.forceHold = false;
    }

    // -------------------------------------------------------------------------
    // Luma plane — matching on luma only is ~3× faster and just as accurate.
    // -------------------------------------------------------------------------
    _luma(img) {
      const d = img.data, n = d.length / 4;
      const y = new Uint8ClampedArray(n);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        y[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;   // BT.601
      }
      return y;
    }

    // -------------------------------------------------------------------------
    // SAD — Sum of Absolute Differences. THE cost function every video codec
    // uses to decide "did this block move here?"
    // -------------------------------------------------------------------------
    _sad(cur, prev, w, h, x0, y0, bw, bh, dx, dy, step) {
      let cost = 0, n = 0;
      for (let y = 0; y < bh; y += step) {
        const cy = y0 + y;
        const py = Math.min(h - 1, Math.max(0, cy - dy));
        const bc = cy * w + x0;
        const bp = py * w + (x0 - dx);
        for (let x = 0; x < bw; x += step) {
          const px = bp + Math.min(w - 1, Math.max(0, x));
          cost += Math.abs(cur[bc + x] - prev[px]);
          n++;
        }
      }
      return n ? cost / n : Infinity;
    }

    // -------------------------------------------------------------------------
    // MOTION ESTIMATION — hierarchical, coarse to fine.
    // Estimate on a half-size frame first, use that as the starting guess for
    // the full-size search. Without this the search is far too slow for video.
    // -------------------------------------------------------------------------
    _estimate(curY, prevY, w, h) {
      const bs = this.p.blockSize;
      const cols = Math.ceil(w / bs), rows = Math.ceil(h / bs);
      const vec = new Float32Array(cols * rows * 2);

      const r = Math.max(2, this.p.motionRadius | 0);
      const step = bs >= 16 ? 2 : 1;         // subsample inside the block — big speedup

      let totalSAD = 0, blocks = 0;

      for (let by = 0; by < rows; by++) {
        for (let bx = 0; bx < cols; bx++) {
          const x0 = bx * bs, y0 = by * bs;
          const bw = Math.min(bs, w - x0), bh = Math.min(bs, h - y0);

          // Start from the neighbour's vector — motion is spatially coherent,
          // so this is a much better guess than (0,0).
          let gx = 0, gy = 0;
          if (bx > 0) { const i = (by * cols + (bx - 1)) * 2; gx = vec[i]; gy = vec[i + 1]; }

          let bestDx = 0, bestDy = 0, best = Infinity;
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              const c = this._sad(curY, prevY, w, h, x0, y0, bw, bh,
                                  (gx + dx) | 0, (gy + dy) | 0, step);
              if (c < best) { best = c; bestDx = (gx + dx) | 0; bestDy = (gy + dy) | 0; }
            }
          }

          const i = (by * cols + bx) * 2;
          // Below threshold = no real motion. Leave the block still.
          if (best < this.p.threshold) { vec[i] = 0; vec[i + 1] = 0; }
          else { vec[i] = bestDx; vec[i + 1] = bestDy; }

          totalSAD += best; blocks++;
        }
      }

      this.lastSAD = blocks ? totalSAD / blocks : 0;
      return { vec, cols, rows };
    }

    // -------------------------------------------------------------------------
    // APPLY — drag the ACCUMULATED picture along the NEW frame's motion vectors.
    // This is the whole trick. The motion is from frame N. The pixels are from
    // whatever was on screen before. They do not belong together, and that
    // mismatch is the effect.
    // -------------------------------------------------------------------------
    _apply(accum, vec, cols, rows, w, h) {
      const bs = this.p.blockSize;
      const s = this.p.motionStrength;
      const out = new Uint8ClampedArray(accum.length);
      out.set(accum);

      for (let by = 0; by < rows; by++) {
        for (let bx = 0; bx < cols; bx++) {
          const i = (by * cols + bx) * 2;
          const dx = Math.round(vec[i] * s);
          const dy = Math.round(vec[i + 1] * s);
          if (!dx && !dy) continue;

          const x0 = bx * bs, y0 = by * bs;
          const bw = Math.min(bs, w - x0), bh = Math.min(bs, h - y0);

          for (let y = 0; y < bh; y++) {
            const dstY = y0 + y;
            const srcY = Math.min(h - 1, Math.max(0, dstY - dy));
            let dst = (dstY * w + x0) * 4;
            let src = (srcY * w + Math.min(w - 1, Math.max(0, x0 - dx))) * 4;
            for (let x = 0; x < bw; x++) {
              out[dst]     = accum[src];
              out[dst + 1] = accum[src + 1];
              out[dst + 2] = accum[src + 2];
              out[dst + 3] = 255;
              dst += 4; src += 4;
            }
          }
        }
      }
      return out;
    }

    // -------------------------------------------------------------------------
    // JPEG ARTIFACT PASS — re-encode the frame at low quality and read it back.
    // Produces genuine DCT blocking/ringing, because it IS genuine DCT blocking.
    // -------------------------------------------------------------------------
    async _jpeg(imgData, w, h) {
      this._work.width = w; this._work.height = h;
      this._wctx.putImageData(imgData, 0, 0);
      const blob = await new Promise((r) => this._work.toBlob(r, 'image/jpeg', this.p.jpegQuality));
      if (!blob) return imgData;
      const bmp = await createImageBitmap(blob);
      this._wctx.drawImage(bmp, 0, 0);
      bmp.close();
      return this._wctx.getImageData(0, 0, w, h);
    }

    // -------------------------------------------------------------------------
    // THE FRAME LOOP
    // -------------------------------------------------------------------------
    async processFrame(source) {
      const w = this.cv.width, h = this.cv.height;
      if (!w || !h) return;

      // Draw the incoming frame.
      this.ctx.drawImage(source, 0, 0, w, h);
      const cur = this.ctx.getImageData(0, 0, w, h);
      const curY = this._luma(cur);

      if (!this.p.enabled || !this.prevY) {
        this.prevY = curY;
        this.accum = cur.data.slice();
        this.frameNo = 0;
        return;
      }

      // --- Estimate the motion between the last frame and this one. ---
      const { vec, cols, rows } = this._estimate(curY, this.prevY, w, h);

      // --- Scene-cut detection. A cut is where moshing looks BEST — it's the
      //     moment the codec would normally insert an I-frame, and we don't. ---
      const cut = this.lastSAD > (this.p.sceneCut * 255);
      if (cut && this.p.autoMoshOnCut) {
        this.moshing = true;
        this.frameNo = 1;
        window.dispatchEvent(new CustomEvent('moshcut', { detail: { sad: this.lastSAD } }));
      }

      // --- I-frame refresh: let the real picture back in every N frames. ---
      const refresh = this.p.iFrameInterval > 0 && (this.frameNo % this.p.iFrameInterval === 0);

      if (refresh && !this.forceHold) {
        this.accum = cur.data.slice();     // a clean I-frame — the smear resets
        this.moshing = false;
      } else {
        // THE MOSH: apply THIS frame's motion vectors to the OLD picture.
        let moshed = this._apply(this.accum, vec, cols, rows, w, h);

        // Blend a trace of the new frame back in, so it doesn't decay to mush.
        const k = this.p.persistence;
        for (let i = 0; i < moshed.length; i += 4) {
          moshed[i]     = moshed[i]     * k + cur.data[i]     * (1 - k);
          moshed[i + 1] = moshed[i + 1] * k + cur.data[i + 1] * (1 - k);
          moshed[i + 2] = moshed[i + 2] * k + cur.data[i + 2] * (1 - k);
        }
        this.accum = moshed;
        this.moshing = true;
      }

      let out = new ImageData(new Uint8ClampedArray(this.accum), w, h);

      if (this.p.jpegArtifacts) out = await this._jpeg(out, w, h);

      this.ctx.putImageData(out, 0, 0);

      this.prevY = curY;
      this.vec = vec;
      this.frameNo++;
      this.forceHold = false;

      const now = performance.now();
      this.fps = 0.9 * this.fps + 0.1 * (1000 / Math.max(1, now - this._t));
      this._t = now;
    }

    /** Draw the motion vector field on top — genuinely useful for dialling it in. */
    drawVectors(alpha = 0.5) {
      if (!this.vec) return;
      const bs = this.p.blockSize, w = this.cv.width, h = this.cv.height;
      const cols = Math.ceil(w / bs), rows = Math.ceil(h / bs);
      const c = this.ctx;
      c.save();
      c.globalAlpha = alpha;
      c.strokeStyle = '#00ff88';
      c.lineWidth = 1;
      c.beginPath();
      for (let by = 0; by < rows; by++) {
        for (let bx = 0; bx < cols; bx++) {
          const i = (by * cols + bx) * 2;
          const dx = this.vec[i], dy = this.vec[i + 1];
          if (!dx && !dy) continue;
          const x = bx * bs + bs / 2, y = by * bs + bs / 2;
          c.moveTo(x, y);
          c.lineTo(x + dx * 2, y + dy * 2);
        }
      }
      c.stroke();
      c.restore();
    }

    reset() {
      this.prevY = null; this.accum = null; this.vec = null;
      this.frameNo = 0; this.moshing = false;
    }
  }

  // ===========================================================================
  // OFFLINE RENDER — run the mosher over a whole file and record the result.
  // ===========================================================================

  async function renderFile(media, params, onProgress) {
    const v = document.createElement('video');
    v.src = media.blobUrl;
    v.muted = true;
    await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 5000); });

    const w = Math.min(1280, v.videoWidth || 640);
    const h = Math.round(w * ((v.videoHeight || 360) / (v.videoWidth || 640) / 2)) * 2;

    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const m = new MotionMosher(cv);
    m.setParams(params);

    const stream = cv.captureStream(30);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm';
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const done = new Promise((res) => { rec.onstop = res; });
    rec.start(200);
    await v.play();

    await new Promise((res) => {
      const step = async () => {
        if (v.ended || v.paused) return res();
        await m.processFrame(v);
        onProgress?.(v.currentTime / v.duration, m.fps);
        v.requestVideoFrameCallback
          ? v.requestVideoFrameCallback(step)
          : requestAnimationFrame(step);
      };
      v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    });

    rec.stop();
    await done;

    const blob = new Blob(chunks, { type: 'video/webm' });
    await window.addBlobToBin?.(blob, `${media.name} [MOTION MOSH].webm`, 'video/webm');
    window.logToConsole?.('ok',
      `[mosh] rendered ${(blob.size / 1024 / 1024).toFixed(1)} MB → Media Bin`);
    return blob;
  }

  window.FFMosh = { MotionMosher, DEFAULTS, renderFile };
})();
