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
    // --- mosh-family shaping (all default to neutral) ---
    directionX: 1,        // #58 directional mosh: axis bias. {1,0} = horizontal smear
    directionY: 1,        //     (the classic), {0,1} = vertical, {1,1} = free.
    amplify: 1,           // #60 vector-amplification curve exponent. >1 ignores small
                          //     motion and explodes large; <1 flattens.
    bloomIterations: 1,   // #61 bloom: apply the displacement N times (further smear).
    motionMask: false,    // #59 masking: low-motion blocks show the CLEAN frame instead
    maskMotion: 2,        //     of the smear. maskMotion = magnitude cutoff (px).
    hierarchical: false,  // #18 coarse-to-fine estimation (half-res estimate,
                          //     full-res refine) — fewer SAD ops on big frames.
  };

  class MotionMosher {
    constructor(canvas) {
      this.cv = canvas;
      // #18 — estimation (SAD / pyramid) needs no canvas, so allow a null one
      // for headless flow computation via FFMosh.estimateFlow.
      this.ctx = canvas ? canvas.getContext('2d', { willReadFrequently: true }) : null;
      this._sadCalls = 0;   // #18 instrumentation (cost accounting)
      this._sadPixels = 0;
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
      this._sadCalls++; this._sadPixels += n;   // #18 cost accounting
      return n ? cost / n : Infinity;
    }

    // #18 — box-downscale a luma plane 2× (2×2 average). Cheap and enough for a
    // coarse motion guess.
    _downscaleLuma(Y, w, h) {
      const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
      const out = new Float32Array(hw * hh);
      for (let y = 0; y < hh; y++) {
        const sy = y * 2, sy1 = Math.min(h - 1, sy + 1);
        for (let x = 0; x < hw; x++) {
          const sx = x * 2, sx1 = Math.min(w - 1, sx + 1);
          out[y * hw + x] = (Y[sy * w + sx] + Y[sy * w + sx1] + Y[sy1 * w + sx] + Y[sy1 * w + sx1]) * 0.25;
        }
      }
      return { Y: out, w: hw, h: hh };
    }

    // #18 — HALF-RES ESTIMATE, FULL-RES APPLY. Run the wide block search on a
    // half-size frame (¼ the pixels), then refine each full-res block in a tiny
    // window around 2× the coarse vector. Same motion field, far fewer SAD ops
    // than a full-radius search at native resolution.
    _estimateHierarchical(curY, prevY, w, h) {
      const bs = this.p.blockSize;
      const cols = Math.ceil(w / bs), rows = Math.ceil(h / bs);
      const vec = new Float32Array(cols * rows * 2);

      // 1) coarse RAW search at half resolution
      const cH = this._downscaleLuma(curY, w, h), pH = this._downscaleLuma(prevY, w, h);
      const hw = cH.w, hh = cH.h;
      const ccols = Math.ceil(hw / bs), crows = Math.ceil(hh / bs);
      const coarse = new Float32Array(ccols * crows * 2);
      const R = Math.max(2, this.p.motionRadius | 0);
      const cstep = bs >= 16 ? 2 : 1;
      for (let by = 0; by < crows; by++) {
        for (let bx = 0; bx < ccols; bx++) {
          const x0 = bx * bs, y0 = by * bs;
          const bw = Math.min(bs, hw - x0), bh = Math.min(bs, hh - y0);
          let gx = 0, gy = 0;
          if (bx > 0) { const i = (by * ccols + (bx - 1)) * 2; gx = coarse[i]; gy = coarse[i + 1]; }
          let bestDx = 0, bestDy = 0, best = Infinity;
          for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
              const c = this._sad(cH.Y, pH.Y, hw, hh, x0, y0, bw, bh, (gx + dx) | 0, (gy + dy) | 0, cstep);
              if (c < best) { best = c; bestDx = (gx + dx) | 0; bestDy = (gy + dy) | 0; }
            }
          }
          const i = (by * ccols + bx) * 2; coarse[i] = bestDx; coarse[i + 1] = bestDy;
        }
      }

      // 2) full-res refine around the 2× coarse predictor, with the same shaping
      const refineR = 2, step = bs >= 16 ? 2 : 1;
      let totalSAD = 0, blocks = 0;
      for (let by = 0; by < rows; by++) {
        for (let bx = 0; bx < cols; bx++) {
          const x0 = bx * bs, y0 = by * bs;
          const bw = Math.min(bs, w - x0), bh = Math.min(bs, h - y0);
          const cbx = Math.min(ccols - 1, bx >> 1), cby = Math.min(crows - 1, by >> 1);
          const ci = (cby * ccols + cbx) * 2;
          const gx = coarse[ci] * 2, gy = coarse[ci + 1] * 2;
          let bestDx = gx | 0, bestDy = gy | 0, best = Infinity;
          for (let dy = -refineR; dy <= refineR; dy++) {
            for (let dx = -refineR; dx <= refineR; dx++) {
              const c = this._sad(curY, prevY, w, h, x0, y0, bw, bh, (gx + dx) | 0, (gy + dy) | 0, step);
              if (c < best) { best = c; bestDx = (gx + dx) | 0; bestDy = (gy + dy) | 0; }
            }
          }
          const i = (by * cols + bx) * 2;
          if (best < this.p.threshold) { vec[i] = 0; vec[i + 1] = 0; }
          else {
            let vx = bestDx, vy = bestDy;
            const amp = this.p.amplify;
            if (amp !== 1) {
              const mag = Math.hypot(vx, vy);
              if (mag > 0) { const rr = Math.max(2, this.p.motionRadius); const shaped = Math.pow(Math.min(1, mag / rr), amp) * rr; const k = shaped / mag; vx *= k; vy *= k; }
            }
            vx *= this.p.directionX; vy *= this.p.directionY;
            vec[i] = vx; vec[i + 1] = vy;
          }
          totalSAD += best; blocks++;
        }
      }
      this.lastSAD = blocks ? totalSAD / blocks : 0;
      return { vec, cols, rows };
    }

    // -------------------------------------------------------------------------
    // MOTION ESTIMATION — hierarchical, coarse to fine.
    // Estimate on a half-size frame first, use that as the starting guess for
    // the full-size search. Without this the search is far too slow for video.
    // -------------------------------------------------------------------------
    _estimate(curY, prevY, w, h) {
      // #18 — coarse-to-fine when enabled (default off keeps the exact legacy
      // full-search behaviour for everything already relying on it).
      if (this.p.hierarchical) return this._estimateHierarchical(curY, prevY, w, h);
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
          else {
            let vx = bestDx, vy = bestDy;
            // #60 amplification: reshape the magnitude non-linearly. amplify>1
            // suppresses small motion and exaggerates large; <1 flattens.
            const amp = this.p.amplify;
            if (amp !== 1) {
              const mag = Math.hypot(vx, vy);
              if (mag > 0) {
                const rr = Math.max(2, this.p.motionRadius);
                const shaped = Math.pow(Math.min(1, mag / rr), amp) * rr;
                const k = shaped / mag;
                vx *= k; vy *= k;
              }
            }
            // #58 directional mosh: scale each axis (kill one for a pure smear).
            vx *= this.p.directionX; vy *= this.p.directionY;
            vec[i] = vx; vec[i + 1] = vy;
          }

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
    // MASK — where the motion vector is weak, overwrite the block with the CLEAN
    // current frame, so quiet areas stay sharp and only motion tears (#59).
    // -------------------------------------------------------------------------
    _maskLowMotion(out, cur, vec, cols, rows, w, h) {
      const bs = this.p.blockSize;
      const cut = this.p.maskMotion;
      for (let by = 0; by < rows; by++) {
        for (let bx = 0; bx < cols; bx++) {
          const i = (by * cols + bx) * 2;
          if (Math.hypot(vec[i], vec[i + 1]) >= cut) continue;   // moving → keep the smear
          const x0 = bx * bs, y0 = by * bs;
          const bw = Math.min(bs, w - x0), bh = Math.min(bs, h - y0);
          for (let y = 0; y < bh; y++) {
            let p = ((y0 + y) * w + x0) * 4;
            for (let x = 0; x < bw; x++) {
              out[p] = cur[p]; out[p + 1] = cur[p + 1]; out[p + 2] = cur[p + 2]; out[p + 3] = 255;
              p += 4;
            }
          }
        }
      }
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

        // #61 bloom: re-apply the same displacement N times so the smear pushes
        // further out with each pass.
        const iters = Math.max(1, this.p.bloomIterations | 0);
        for (let it = 1; it < iters; it++) moshed = this._apply(moshed, vec, cols, rows, w, h);

        // Blend a trace of the new frame back in, so it doesn't decay to mush.
        const k = this.p.persistence;
        for (let i = 0; i < moshed.length; i += 4) {
          moshed[i]     = moshed[i]     * k + cur.data[i]     * (1 - k);
          moshed[i + 1] = moshed[i + 1] * k + cur.data[i + 1] * (1 - k);
          moshed[i + 2] = moshed[i + 2] * k + cur.data[i + 2] * (1 - k);
        }

        // #59 masking: where motion is weak, drop the smear and show the clean
        // current frame, so only the moving parts tear.
        if (this.p.motionMask) this._maskLowMotion(moshed, cur.data, vec, cols, rows, w, h);

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

    // -------------------------------------------------------------------------
    // MOSH ACROSS — the classic two-clip datamosh (#62). Estimate the motion on
    // one clip and apply it to ANOTHER's pixels: clip A's movement drives clip
    // B's imagery. The estimator and the apply already compose — this just feeds
    // them from different frames. `pictureData` is the accumulated picture to
    // drag; returns the new one.
    // -------------------------------------------------------------------------
    moshAcross(motionSource, pictureData, w, h) {
      this._work.width = w; this._work.height = h;
      this._wctx.drawImage(motionSource, 0, 0, w, h);
      const curY = this._luma(this._wctx.getImageData(0, 0, w, h));
      if (!this.prevY) { this.prevY = curY; this.vec = null; return pictureData; }
      const { vec, cols, rows } = this._estimate(curY, this.prevY, w, h);
      this.prevY = curY; this.vec = vec;
      let out = this._apply(pictureData, vec, cols, rows, w, h);
      const iters = Math.max(1, this.p.bloomIterations | 0);
      for (let it = 1; it < iters; it++) out = this._apply(out, vec, cols, rows, w, h);
      if (this.p.motionMask) this._maskLowMotion(out, pictureData, vec, cols, rows, w, h);
      return out;
    }

    // -------------------------------------------------------------------------
    // CAPTURE — estimate one frame's motion field WITHOUT applying it, for
    // persistent recording (#63). Returns {vec,cols,rows} or null on the first
    // (priming) frame.
    // -------------------------------------------------------------------------
    captureField(source) {
      const w = this.cv.width, h = this.cv.height;
      this._work.width = w; this._work.height = h;
      this._wctx.drawImage(source, 0, 0, w, h);
      const curY = this._luma(this._wctx.getImageData(0, 0, w, h));
      if (!this.prevY) { this.prevY = curY; return null; }
      const { vec, cols, rows } = this._estimate(curY, this.prevY, w, h);
      this.prevY = curY; this.vec = vec;
      return { vec: vec.slice(), cols, rows };
    }

    // Apply an externally-supplied vector field (a recorded frame) to a picture.
    applyField(pictureData, vec, cols, rows, w, h) {
      let out = this._apply(pictureData, vec, cols, rows, w, h);
      const iters = Math.max(1, this.p.bloomIterations | 0);
      for (let it = 1; it < iters; it++) out = this._apply(out, vec, cols, rows, w, h);
      if (this.p.motionMask) this._maskLowMotion(out, pictureData, vec, cols, rows, w, h);
      return out;
    }

    // -------------------------------------------------------------------------
    // OPTICAL-FLOW DISPLACEMENT (#68) — use the motion field as a per-pixel
    // DISPLACEMENT MAP. Unlike _apply (which drags whole blocks of the WRONG
    // picture, tearing), this samples the SAME picture through a smoothly
    // bilinear-interpolated flow so it warps like liquid where the scene moves,
    // and stays put where it's still. `scale` exaggerates the warp.
    // -------------------------------------------------------------------------
    displaceByFlow(cur, vec, cols, rows, w, h, opts = {}) {
      const scale = opts.scale ?? 1;
      const bs = this.p.blockSize;
      const out = new Uint8ClampedArray(cur.length);
      const clamp = (v, m) => (v < 0 ? 0 : v > m ? m : v);
      const at = (gx, gy, c) => vec[(gy * cols + gx) * 2 + c];
      const lerp = (a, b, t) => a + (b - a) * t;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          // sample the block-grid field bilinearly at this pixel
          const fx = x / bs - 0.5, fy = y / bs - 0.5;
          const bx0 = Math.floor(fx), by0 = Math.floor(fy);
          const tx = fx - bx0, ty = fy - by0;
          const gx0 = clamp(bx0, cols - 1), gx1 = clamp(bx0 + 1, cols - 1);
          const gy0 = clamp(by0, rows - 1), gy1 = clamp(by0 + 1, rows - 1);
          const dx = lerp(lerp(at(gx0, gy0, 0), at(gx1, gy0, 0), tx), lerp(at(gx0, gy1, 0), at(gx1, gy1, 0), tx), ty);
          const dy = lerp(lerp(at(gx0, gy0, 1), at(gx1, gy0, 1), tx), lerp(at(gx0, gy1, 1), at(gx1, gy1, 1), tx), ty);
          const sx = clamp(Math.round(x - dx * scale), w - 1);
          const sy = clamp(Math.round(y - dy * scale), h - 1);
          const d = (y * w + x) * 4, s = (sy * w + sx) * 4;
          out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = 255;
        }
      }
      return out;
    }

    // -------------------------------------------------------------------------
    // OPTICAL-FLOW FRAME INTERPOLATION (#41) — synthesise the frame at time t in
    // between A and B by warping A FORWARD along the flow by t and B BACKWARD by
    // (1−t), then cross-dissolving. A moving object lands at its IN-BETWEEN
    // position — real slow-mo, not a duplicated (frozen) frame.
    // -------------------------------------------------------------------------
    interpolate(a, b, vec, cols, rows, w, h, t) {
      if (t <= 0) return Uint8ClampedArray.from(a);
      if (t >= 1) return Uint8ClampedArray.from(b);
      const wa = this.displaceByFlow(a, vec, cols, rows, w, h, { scale: t });         // A pushed +t·flow
      const wb = this.displaceByFlow(b, vec, cols, rows, w, h, { scale: -(1 - t) });  // B pulled −(1−t)·flow
      const out = new Uint8ClampedArray(a.length);
      for (let i = 0; i < out.length; i += 4) {
        out[i] = wa[i] * (1 - t) + wb[i] * t;
        out[i + 1] = wa[i + 1] * (1 - t) + wb[i + 1] * t;
        out[i + 2] = wa[i + 2] * (1 - t) + wb[i + 2] * t;
        out[i + 3] = 255;
      }
      return out;
    }

    // -------------------------------------------------------------------------
    // RETIME METHOD TOGGLE (#56) — the same in-between frame two ways. FLOW warps
    // along the motion so a moving object lands at ONE in-between position (sharp
    // slow-mo). BLEND cross-dissolves, so a moving object shows as TWO ghosts (the
    // cheap frame-mix look). Same call, one `method` switch — the choice a retime
    // panel offers.
    // -------------------------------------------------------------------------
    retime(a, b, vec, cols, rows, w, h, t, method = 'flow') {
      if (method === 'blend') {
        const out = new Uint8ClampedArray(a.length);
        for (let i = 0; i < out.length; i += 4) {
          out[i] = a[i] * (1 - t) + b[i] * t;
          out[i + 1] = a[i + 1] * (1 - t) + b[i + 1] * t;
          out[i + 2] = a[i + 2] * (1 - t) + b[i + 2] * t;
          out[i + 3] = 255;
        }
        return out;
      }
      return this.interpolate(a, b, vec, cols, rows, w, h, t);
    }

    // -------------------------------------------------------------------------
    // VECTOR OVERLAY (#57) — draw the current motion field as arrows. On by
    // default in the overlay render; genuinely useful for dialling a mosh in and
    // a good look in its own right. Draws onto ANY 2-D context (the mosher's own
    // canvas, or a compositing canvas in the offline render).
    // -------------------------------------------------------------------------
    drawVectors(ctx = this.ctx, opts = {}) {
      if (!this.vec) return;
      const { alpha = 0.85, color = '#00ff88', scale = 2, arrows = true, minMag = 0.5 } = opts;
      const bs = this.p.blockSize, w = this.cv.width, h = this.cv.height;
      const cols = Math.ceil(w / bs), rows = Math.ceil(h / bs);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = Math.max(1, bs / 16);
      ctx.beginPath();
      for (let by = 0; by < rows; by++) {
        for (let bx = 0; bx < cols; bx++) {
          const i = (by * cols + bx) * 2;
          const dx = this.vec[i], dy = this.vec[i + 1];
          if (Math.hypot(dx, dy) < minMag) continue;
          const x = bx * bs + bs / 2, y = by * bs + bs / 2;
          const ex = x + dx * scale, ey = y + dy * scale;
          ctx.moveTo(x, y); ctx.lineTo(ex, ey);
          if (arrows) {
            // little arrowhead at the tip, back along the vector
            const a = Math.atan2(ey - y, ex - x), hl = Math.min(bs / 3, Math.hypot(ex - x, ey - y) * 0.4);
            ctx.moveTo(ex, ey); ctx.lineTo(ex - hl * Math.cos(a - 0.4), ey - hl * Math.sin(a - 0.4));
            ctx.moveTo(ex, ey); ctx.lineTo(ex - hl * Math.cos(a + 0.4), ey - hl * Math.sin(a + 0.4));
          }
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    reset() {
      this.prevY = null; this.accum = null; this.vec = null;
      this.frameNo = 0; this.moshing = false;
    }
  }

  // ===========================================================================
  // STABILISATION (#44) — we already estimate a motion field per frame, so the
  // dominant translation of that field IS the camera's frame-to-frame motion.
  // Take the MEDIAN of the field (robust to a few moving objects), integrate it
  // into the camera PATH, smooth the path, and shift each frame by the gap
  // between the smooth path and the real one — the shake cancels, the intended
  // pan survives.
  // ===========================================================================

  /** Dominant translation of a block field: the median vector (outlier-robust). */
  function globalMotion(vec, cols, rows) {
    const n = cols * rows; if (!n) return [0, 0];
    const xs = new Array(n), ys = new Array(n);
    for (let i = 0; i < n; i++) { xs[i] = vec[i * 2]; ys[i] = vec[i * 2 + 1]; }
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    const med = (a) => a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
    return [med(xs), med(ys)];
  }

  /** Per-frame global motions → correction offsets. Integrate to the camera
   *  path, smooth it (centred moving average, radius r), correct = smooth−path. */
  function stabilizePath(motions, radius = 15) {
    const n = motions.length;
    const cx = new Float64Array(n), cy = new Float64Array(n);
    let ax = 0, ay = 0;
    for (let i = 0; i < n; i++) { ax += motions[i][0]; ay += motions[i][1]; cx[i] = ax; cy[i] = ay; }
    const corr = new Array(n);
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, c = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) { sx += cx[j]; sy += cy[j]; c++; }
      corr[i] = [sx / c - cx[i], sy / c - cy[i]];
    }
    return corr;
  }

  // ===========================================================================
  // AUTO-REFRAME (#45) — crop a vertical (9:16) window that TRACKS THE SUBJECT.
  // The subject is where the action is: the centre of mass of the motion field,
  // weighted by vector magnitude. Follow that (smoothed) with the crop window
  // and a horizontal 16:9 clip becomes a vertical one that keeps the moving
  // subject in frame instead of a dumb centre crop.
  // ===========================================================================

  /** Centre of motion mass of a block field (px), or [null,null] if it's still. */
  function motionCentroid(vec, cols, rows, blockSize) {
    let sx = 0, sy = 0, sw = 0;
    for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
      const i = (by * cols + bx) * 2, mag = Math.hypot(vec[i], vec[i + 1]);
      sx += (bx + 0.5) * blockSize * mag; sy += (by + 0.5) * blockSize * mag; sw += mag;
    }
    return sw > 1e-6 ? [sx / sw, sy / sw] : [null, null];
  }

  /** Offline auto-reframe: track the motion centroid, crop a vertical window
   *  around it (causal-smoothed), output a 9:16 clip → Media Bin. */
  async function renderReframe(media, params, onProgress) {
    const p = Object.assign({ blockSize: 16, motionRadius: 12, threshold: 0, aspect: 9 / 16, smoothRadius: 20, strength: 1 }, params || {});
    const v = document.createElement('video'); v.src = media.blobUrl; v.muted = true; v.playsInline = true;
    await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 5000); });
    const sw = v.videoWidth || 640, sh = v.videoHeight || 360;
    const outH = Math.round(Math.min(sh, 1280) / 2) * 2, outW = Math.round(outH * p.aspect / 2) * 2;
    const cropW = Math.min(sw, Math.round(sh * p.aspect));
    const cv = document.createElement('canvas'); cv.width = outW; cv.height = outH;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const est = document.createElement('canvas'); est.width = Math.min(320, sw); est.height = Math.round(est.width * sh / sw);
    const m = new MotionMosher(est); m.setParams(p);
    const alpha = 1 / Math.max(1, p.smoothRadius);
    let camX = sw / 2, first = true;
    const stream = cv.captureStream(30);
    const mime = (window.pickRecorderMime || (() => 'video/webm'))('video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=h264', 'video/mp4');
    const chunks = [];
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 10_000_000 } : { videoBitsPerSecond: 10_000_000 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });
    rec.start(200); await v.play().catch(() => {});
    await new Promise((res) => {
      let fin = false; const finish = () => { if (fin) return; fin = true; clearInterval(wd); res(); };
      let last = -1, stalls = 0;
      const wd = setInterval(() => { if (v.ended || v.paused) return finish(); if (v.currentTime === last) { if (++stalls >= 8) finish(); } else { last = v.currentTime; stalls = 0; } }, 100);
      const step = () => {
        if (fin) return; if (v.ended || v.paused) return finish();
        const field = m.captureField(v);
        if (field) {
          const [mx] = motionCentroid(field.vec, field.cols, field.rows, p.blockSize);
          if (mx != null) { const targetX = mx / est.width * sw; if (first) { camX = targetX; first = false; } else camX += (targetX - camX) * alpha * p.strength; }
        }
        const cropX = Math.max(0, Math.min(sw - cropW, camX - cropW / 2));
        ctx.drawImage(v, cropX, 0, cropW, sh, 0, 0, outW, outH);
        onProgress?.(v.currentTime / (v.duration || v.currentTime || 1), 0);
        v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
      };
      v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    });
    rec.stop(); await done;
    const type = (rec.mimeType || 'video/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    await window.addBlobToBin?.(blob, `${media.name} [VERTICAL].${ext}`, type);
    window.logToConsole?.('ok', `[reframe] auto-reframed → Media Bin (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    return blob;
  }

  /** Offline stabiliser render. Uses a CAUSAL low-pass of the camera path (a
   *  real-time-style smoother — no second pass / frame buffering), shifting each
   *  frame toward the smoothed path. The tested cores (globalMotion +
   *  stabilizePath) are the centred, higher-quality offline version. */
  async function renderStabilize(media, params, onProgress) {
    const p = Object.assign({ blockSize: 16, motionRadius: 14, threshold: 0, smoothRadius: 24, strength: 1 }, params || {});
    const v = document.createElement('video'); v.src = media.blobUrl; v.muted = true; v.playsInline = true;
    await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 5000); });
    const w = Math.min(1280, v.videoWidth || 640);
    const h = Math.round(w * ((v.videoHeight || 360) / (v.videoWidth || 640) / 2)) * 2;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const m = new MotionMosher(cv); m.setParams(p);
    const alpha = 1 / Math.max(1, p.smoothRadius);
    let cumX = 0, cumY = 0, smX = 0, smY = 0;
    const stream = cv.captureStream(30);
    const mime = (window.pickRecorderMime || (() => 'video/webm'))('video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=h264', 'video/mp4');
    const chunks = [];
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 10_000_000 } : { videoBitsPerSecond: 10_000_000 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });
    rec.start(200); await v.play().catch(() => {});
    await new Promise((res) => {
      let fin = false; const finish = () => { if (fin) return; fin = true; clearInterval(wd); res(); };
      let last = -1, stalls = 0;
      const wd = setInterval(() => { if (v.ended || v.paused) return finish(); if (v.currentTime === last) { if (++stalls >= 8) finish(); } else { last = v.currentTime; stalls = 0; } }, 100);
      const step = () => {
        if (fin) return; if (v.ended || v.paused) return finish();
        const field = m.captureField(v);
        const g = field ? globalMotion(field.vec, field.cols, field.rows) : [0, 0];
        cumX += g[0]; cumY += g[1];
        smX += (cumX - smX) * alpha; smY += (cumY - smY) * alpha;
        const sx = (smX - cumX) * p.strength, sy = (smY - cumY) * p.strength;
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(v, sx, sy, w, h);
        onProgress?.(v.currentTime / (v.duration || v.currentTime || 1), 0);
        v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
      };
      v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    });
    rec.stop(); await done;
    const type = (rec.mimeType || 'video/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    await window.addBlobToBin?.(blob, `${media.name} [STABILISED].${ext}`, type);
    window.logToConsole?.('ok', `[stab] stabilised → Media Bin (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    return blob;
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
    // iOS/Safari has no webm encoder — fall through to mp4 (see pickRecorderMime).
    const mime = (window.pickRecorderMime || (() => 'video/webm'))(
      'video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=h264', 'video/mp4');
    const chunks = [];
    const rec = new MediaRecorder(stream, mime
      ? { mimeType: mime, videoBitsPerSecond: 10_000_000 }
      : { videoBitsPerSecond: 10_000_000 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const done = new Promise((res) => { rec.onstop = res; });
    rec.start(200);
    await v.play();

    await new Promise((res) => {
      // Terminate on the source's own end signals, not just the rVFC loop. The
      // last requestVideoFrameCallback fires slightly BEFORE `ended` flips true,
      // so it schedules one more callback that never arrives (no further frames
      // are presented) — and the render hangs forever. This is worse for a
      // MediaRecorder-encoded clip whose container duration is unknown. Listening
      // for 'ended'/'pause' (plus a stall watchdog) guarantees we stop.
      let done = false;
      const finish = () => { if (done) return; done = true; cleanup(); res(); };
      const onEnd = () => finish();
      let lastT = -1, stalls = 0;
      const watchdog = setInterval(() => {
        if (v.ended || v.paused) return finish();
        if (v.currentTime === lastT) { if (++stalls >= 8) finish(); }   // ~800ms with no progress
        else { lastT = v.currentTime; stalls = 0; }
      }, 100);
      const cleanup = () => {
        clearInterval(watchdog);
        v.removeEventListener('ended', onEnd);
        v.removeEventListener('pause', onEnd);
      };
      v.addEventListener('ended', onEnd);
      v.addEventListener('pause', onEnd);
      const step = async () => {
        if (done) return;
        if (v.ended || v.paused) return finish();
        await m.processFrame(v);
        onProgress?.(v.currentTime / (v.duration || v.currentTime || 1), m.fps);
        v.requestVideoFrameCallback
          ? v.requestVideoFrameCallback(step)
          : requestAnimationFrame(step);
      };
      v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    });

    rec.stop();
    await done;

    const type = (rec.mimeType || 'video/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    await window.addBlobToBin?.(blob, `${media.name} [MOTION MOSH].${ext}`, type);
    window.logToConsole?.('ok',
      `[mosh] rendered ${(blob.size / 1024 / 1024).toFixed(1)} MB → Media Bin`);
    return blob;
  }

  // ===========================================================================
  // FLOW DISPLACEMENT (#68) — estimate each frame's optical flow and use it as a
  // per-pixel displacement map on THAT SAME frame. The scene warps like liquid
  // where it moves and stays sharp where it's still. Offline → Media Bin.
  // ===========================================================================

  // ===========================================================================
  // OPTICAL-FLOW SLOW-MO (#41) — insert `factor−1` interpolated frames between
  // each pair, so a clip plays back smoothly slowed rather than juddering on
  // duplicated frames. Offline → Media Bin.
  // ===========================================================================
  async function renderInterpolate(media, params, onProgress) {
    const p = Object.assign({ blockSize: 16, motionRadius: 16, threshold: 0, factor: 2 }, params || {});
    const factor = Math.max(2, Math.round(p.factor));
    const v = document.createElement('video');
    v.src = media.blobUrl; v.muted = true; v.playsInline = true;
    await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 5000); });
    const w = Math.min(1280, v.videoWidth || 640);
    const h = Math.round(w * ((v.videoHeight || 360) / (v.videoWidth || 640) / 2)) * 2;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const grab = document.createElement('canvas'); grab.width = w; grab.height = h;
    const gctx = grab.getContext('2d', { willReadFrequently: true });
    const m = new MotionMosher(cv); m.setParams(p);
    const stream = cv.captureStream(30);
    const mime = (window.pickRecorderMime || (() => 'video/webm'))('video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=h264', 'video/mp4');
    const chunks = [];
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 10_000_000 } : { videoBitsPerSecond: 10_000_000 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });
    rec.start(200); await v.play().catch(() => {});
    let prev = null;
    await new Promise((res) => {
      let fin = false; const finish = () => { if (fin) return; fin = true; clearInterval(wd); res(); };
      let last = -1, stalls = 0;
      const wd = setInterval(() => { if (v.ended || v.paused) return finish(); if (v.currentTime === last) { if (++stalls >= 8) finish(); } else { last = v.currentTime; stalls = 0; } }, 100);
      const step = () => {
        if (fin) return; if (v.ended || v.paused) return finish();
        gctx.drawImage(v, 0, 0, w, h);
        const cur = gctx.getImageData(0, 0, w, h);
        const field = m.captureField(v);          // flow prev→cur
        if (prev && field) {
          for (let k = 1; k < factor; k++) {       // the in-between frames
            const t = k / factor;
            const mid = m.interpolate(prev.data, cur.data, field.vec, field.cols, field.rows, w, h, t);
            ctx.putImageData(new ImageData(mid, w, h), 0, 0);
          }
        }
        ctx.putImageData(cur, 0, 0);               // the real frame
        prev = cur;
        onProgress?.(v.currentTime / (v.duration || v.currentTime || 1), 0);
        v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
      };
      v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    });
    rec.stop(); await done;
    const type = (rec.mimeType || 'video/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    await window.addBlobToBin?.(blob, `${media.name} [${factor}x SLOMO].${ext}`, type);
    window.logToConsole?.('ok', `[slomo] ${factor}× optical-flow → Media Bin (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    return blob;
  }

  async function renderFlowDisplace(media, params, onProgress) {
    const p = Object.assign({ blockSize: 16, motionRadius: 12, threshold: 1, scale: 3 }, params || {});
    const v = document.createElement('video');
    v.src = media.blobUrl; v.muted = true; v.playsInline = true;
    await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 5000); });
    const w = Math.min(1280, v.videoWidth || 640);
    const h = Math.round(w * ((v.videoHeight || 360) / (v.videoWidth || 640) / 2)) * 2;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const src = document.createElement('canvas'); src.width = w; src.height = h;
    const sctx = src.getContext('2d', { willReadFrequently: true });
    const m = new MotionMosher(cv); m.setParams(p);

    const stream = cv.captureStream(30);
    const mime = (window.pickRecorderMime || (() => 'video/webm'))(
      'video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=h264', 'video/mp4');
    const chunks = [];
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 10_000_000 } : { videoBitsPerSecond: 10_000_000 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });
    rec.start(200); await v.play().catch(() => {});
    await new Promise((res) => {
      let fin = false; const finish = () => { if (fin) return; fin = true; clearInterval(wd); res(); };
      let last = -1, stalls = 0;
      const wd = setInterval(() => { if (v.ended || v.paused) return finish(); if (v.currentTime === last) { if (++stalls >= 8) finish(); } else { last = v.currentTime; stalls = 0; } }, 100);
      const step = () => {
        if (fin) return; if (v.ended || v.paused) return finish();
        sctx.drawImage(v, 0, 0, w, h);
        const cur = sctx.getImageData(0, 0, w, h);
        const field = m.captureField(v);   // null on the priming frame
        if (field) {
          const out = m.displaceByFlow(cur.data, field.vec, field.cols, field.rows, w, h, { scale: p.scale });
          ctx.putImageData(new ImageData(out, w, h), 0, 0);
        } else {
          ctx.putImageData(cur, 0, 0);
        }
        onProgress?.(v.currentTime / (v.duration || v.currentTime || 1), 0);
        v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
      };
      v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    });
    rec.stop(); await done;
    const type = (rec.mimeType || 'video/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    await window.addBlobToBin?.(blob, `${media.name} [FLOW WARP].${ext}`, type);
    window.logToConsole?.('ok', `[flow] displaced ${(blob.size / 1024 / 1024).toFixed(1)} MB → Media Bin`);
    return blob;
  }

  // ===========================================================================
  // VECTOR-OVERLAY RENDER (#57) — draw the estimated motion field as arrows on
  // top of the real frame. The overlay is ON by default. Offline → Media Bin.
  // ===========================================================================

  async function renderVectorOverlay(media, params, onProgress) {
    const p = Object.assign({ blockSize: 16, motionRadius: 12, threshold: 1, dim: 0.55, color: '#00ff88', scale: 2.5 }, params || {});
    const v = document.createElement('video');
    v.src = media.blobUrl; v.muted = true; v.playsInline = true;
    await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 5000); });
    const w = Math.min(1280, v.videoWidth || 640);
    const h = Math.round(w * ((v.videoHeight || 360) / (v.videoWidth || 640) / 2)) * 2;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const m = new MotionMosher(cv); m.setParams(p);

    const stream = cv.captureStream(30);
    const mime = (window.pickRecorderMime || (() => 'video/webm'))(
      'video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=h264', 'video/mp4');
    const chunks = [];
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 10_000_000 } : { videoBitsPerSecond: 10_000_000 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });
    rec.start(200); await v.play().catch(() => {});
    await new Promise((res) => {
      let fin = false; const finish = () => { if (fin) return; fin = true; clearInterval(wd); res(); };
      let last = -1, stalls = 0;
      const wd = setInterval(() => { if (v.ended || v.paused) return finish(); if (v.currentTime === last) { if (++stalls >= 8) finish(); } else { last = v.currentTime; stalls = 0; } }, 100);
      const step = () => {
        if (fin) return; if (v.ended || v.paused) return finish();
        m.captureField(v);                          // estimate this frame's field
        ctx.drawImage(v, 0, 0, w, h);               // the real frame …
        if (p.dim > 0) { ctx.save(); ctx.globalAlpha = p.dim; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); ctx.restore(); } // … dimmed …
        m.drawVectors(ctx, { color: p.color, scale: p.scale });   // … arrows on top
        onProgress?.(v.currentTime / (v.duration || v.currentTime || 1), 0);
        v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
      };
      v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    });
    rec.stop(); await done;
    const type = (rec.mimeType || 'video/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    await window.addBlobToBin?.(blob, `${media.name} [VECTORS].${ext}`, type);
    window.logToConsole?.('ok', `[vectors] overlay ${(blob.size / 1024 / 1024).toFixed(1)} MB → Media Bin`);
    return blob;
  }

  // ===========================================================================
  // TWO-CLIP DATAMOSH (#62) — clip A's motion, clip B's pixels. Play both in
  // step; each frame, estimate A's motion and drag B's accumulated picture along
  // it, blending a trace of B back in for persistence. Records → Media Bin.
  // ===========================================================================
  async function renderTwoClips(motionMedia, pictureMedia, params, onProgress) {
    const load = (src) => {
      const v = document.createElement('video');
      v.src = src; v.muted = true; v.playsInline = true;
      return new Promise((r) => { v.onloadedmetadata = () => r(v); setTimeout(() => r(v), 5000); });
    };
    const mv = await load(motionMedia.blobUrl);
    const pv = await load(pictureMedia.blobUrl);

    const w = Math.min(960, pv.videoWidth || mv.videoWidth || 640);
    const h = Math.round(w * ((pv.videoHeight || 360) / (pv.videoWidth || 640) / 2)) * 2;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const m = new MotionMosher(cv); m.setParams(params);

    const stream = cv.captureStream(30);
    const mime = (window.pickRecorderMime || (() => 'video/webm'))(
      'video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=h264', 'video/mp4');
    const chunks = [];
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 10_000_000 } : { videoBitsPerSecond: 10_000_000 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });

    // Seed the accumulator with clip B's first frame.
    ctx.drawImage(pv, 0, 0, w, h);
    let accum = ctx.getImageData(0, 0, w, h).data;
    const k = (params.persistence != null) ? params.persistence : 0.9;

    rec.start(200);
    await Promise.all([mv.play().catch(() => {}), pv.play().catch(() => {})]);

    await new Promise((res) => {
      let finished = false;
      const finish = () => { if (finished) return; finished = true; clearInterval(watchdog); res(); };
      // stop when EITHER clip ends (or stalls) — the mosh only lasts as long as
      // there's both motion and picture to combine.
      let lastP = -1, stalls = 0;
      const watchdog = setInterval(() => {
        if (mv.ended || pv.ended) return finish();
        if (pv.currentTime === lastP) { if (++stalls >= 8) finish(); } else { lastP = pv.currentTime; stalls = 0; }
      }, 100);
      const step = () => {
        if (finished) return;
        if (mv.ended || pv.ended) return finish();
        ctx.drawImage(pv, 0, 0, w, h);
        const pic = ctx.getImageData(0, 0, w, h).data;
        let moshed = m.moshAcross(mv, accum, w, h);
        for (let i = 0; i < moshed.length; i += 4) {
          moshed[i]     = moshed[i]     * k + pic[i]     * (1 - k);
          moshed[i + 1] = moshed[i + 1] * k + pic[i + 1] * (1 - k);
          moshed[i + 2] = moshed[i + 2] * k + pic[i + 2] * (1 - k);
        }
        accum = moshed;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(accum), w, h), 0, 0);
        onProgress?.(pv.currentTime / (pv.duration || pv.currentTime || 1), m.fps);
        pv.requestVideoFrameCallback ? pv.requestVideoFrameCallback(step) : requestAnimationFrame(step);
      };
      pv.requestVideoFrameCallback ? pv.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    });

    rec.stop(); await done;
    const type = (rec.mimeType || 'video/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    await window.addBlobToBin?.(blob, `${pictureMedia.name} ✕ ${motionMedia.name} [DATAMOSH A→B].${ext}`, type);
    window.logToConsole?.('ok', `[mosh] two-clip datamosh → Media Bin (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    return blob;
  }

  // ===========================================================================
  // PERSISTENT VECTOR RECORDING (#63) — capture a clip's motion field ONCE, then
  // replay it over any other footage. The recording is serialisable, so a motion
  // signature can be saved and reused.
  // ===========================================================================
  function loadVideo(src) {
    const v = document.createElement('video');
    v.src = src; v.muted = true; v.playsInline = true;
    return new Promise((r) => { v.onloadedmetadata = () => r(v); setTimeout(() => r(v), 5000); });
  }

  async function recordVectors(motionMedia, params, onProgress) {
    const v = await loadVideo(motionMedia.blobUrl);
    const w = Math.min(640, v.videoWidth || 640);
    const h = Math.round(w * ((v.videoHeight || 360) / (v.videoWidth || 640) / 2)) * 2;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const m = new MotionMosher(cv); m.setParams(params);
    const rec = { w, h, blockSize: m.p.blockSize, cols: 0, rows: 0, frames: [], name: motionMedia.name };

    await v.play().catch(() => {});
    await new Promise((res) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearInterval(wd); res(); };
      let last = -1, stalls = 0;
      const wd = setInterval(() => {
        if (v.ended || v.paused) return finish();
        if (v.currentTime === last) { if (++stalls >= 8) finish(); } else { last = v.currentTime; stalls = 0; }
      }, 100);
      const step = () => {
        if (done) return;
        if (v.ended || v.paused) return finish();
        const f = m.captureField(v);
        if (f) { rec.cols = f.cols; rec.rows = f.rows; rec.frames.push(f.vec); }
        onProgress?.(v.currentTime / (v.duration || v.currentTime || 1), rec.frames.length);
        v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
      };
      v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    });
    window.logToConsole?.('ok', `[mosh] recorded ${rec.frames.length} motion fields from ${motionMedia.name}`);
    return rec;
  }

  async function replayVectors(recording, pictureMedia, params, onProgress) {
    if (!recording?.frames?.length) throw new Error('No recorded motion to replay.');
    const pv = await loadVideo(pictureMedia.blobUrl);
    const w = recording.w, h = recording.h;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const m = new MotionMosher(cv); m.setParams(Object.assign({ blockSize: recording.blockSize }, params));

    const stream = cv.captureStream(30);
    const mime = (window.pickRecorderMime || (() => 'video/webm'))(
      'video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=h264', 'video/mp4');
    const chunks = [];
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 10_000_000 } : { videoBitsPerSecond: 10_000_000 });
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { mr.onstop = res; });

    ctx.drawImage(pv, 0, 0, w, h);
    let accum = ctx.getImageData(0, 0, w, h).data;
    const k = (params.persistence != null) ? params.persistence : 0.92;
    let fi = 0;

    mr.start(200);
    await pv.play().catch(() => {});
    await new Promise((res) => {
      let done2 = false;
      const finish = () => { if (done2) return; done2 = true; clearInterval(wd); res(); };
      let last = -1, stalls = 0;
      const wd = setInterval(() => {
        if (pv.ended) return finish();
        if (pv.currentTime === last) { if (++stalls >= 8) finish(); } else { last = pv.currentTime; stalls = 0; }
      }, 100);
      const step = () => {
        if (done2) return;
        if (pv.ended) return finish();
        ctx.drawImage(pv, 0, 0, w, h);
        const pic = ctx.getImageData(0, 0, w, h).data;
        const vec = recording.frames[fi % recording.frames.length]; fi++;   // loop the motion
        let moshed = m.applyField(accum, vec, recording.cols, recording.rows, w, h);
        for (let i = 0; i < moshed.length; i += 4) {
          moshed[i] = moshed[i] * k + pic[i] * (1 - k);
          moshed[i + 1] = moshed[i + 1] * k + pic[i + 1] * (1 - k);
          moshed[i + 2] = moshed[i + 2] * k + pic[i + 2] * (1 - k);
        }
        accum = moshed;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(accum), w, h), 0, 0);
        onProgress?.(pv.currentTime / (pv.duration || pv.currentTime || 1), 0);
        pv.requestVideoFrameCallback ? pv.requestVideoFrameCallback(step) : requestAnimationFrame(step);
      };
      pv.requestVideoFrameCallback ? pv.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    });
    mr.stop(); await done;
    const type = (mr.mimeType || 'video/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    await window.addBlobToBin?.(blob, `${pictureMedia.name} [MOTION REPLAY].${ext}`, type);
    window.logToConsole?.('ok', `[mosh] replayed ${recording.frames.length} fields over ${pictureMedia.name}`);
    return blob;
  }

  // Serialise a recording to a compact string (Int16 vectors, base64) so a motion
  // signature can be saved / loaded.
  function serializeVectors(rec) {
    const per = rec.cols * rec.rows * 2;
    const flat = new Int16Array(rec.frames.length * per);
    rec.frames.forEach((f, i) => { for (let j = 0; j < per; j++) flat[i * per + j] = Math.round(f[j]); });
    let bin = '';
    const bytes = new Uint8Array(flat.buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return JSON.stringify({ w: rec.w, h: rec.h, blockSize: rec.blockSize, cols: rec.cols, rows: rec.rows, count: rec.frames.length, name: rec.name, data: btoa(bin) });
  }

  function deserializeVectors(str) {
    const o = JSON.parse(str);
    const bin = atob(o.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const flat = new Int16Array(bytes.buffer);
    const per = o.cols * o.rows * 2;
    const frames = [];
    for (let i = 0; i < o.count; i++) frames.push(Float32Array.from(flat.subarray(i * per, (i + 1) * per)));
    return { w: o.w, h: o.h, blockSize: o.blockSize, cols: o.cols, rows: o.rows, frames, name: o.name };
  }

  // #18 — headless flow estimation for a luma pair. mode 'full' | 'half'
  // (coarse-to-fine). Returns the field plus SAD-cost accounting so callers /
  // tests can compare the two paths.
  function estimateFlow(curY, prevY, w, h, opts) {
    const m = new MotionMosher(null);
    m.setParams(Object.assign({}, opts, { hierarchical: (opts && opts.mode === 'half') }));
    m._sadCalls = 0; m._sadPixels = 0;
    const res = m._estimate(curY, prevY, w, h);
    return { vec: res.vec, cols: res.cols, rows: res.rows, sadCalls: m._sadCalls, sadPixels: m._sadPixels, lastSAD: m.lastSAD };
  }

  // ===========================================================================
  // #15 — MOTION ESTIMATION IN A WORKER
  // ---------------------------------------------------------------------------
  // Block-matching (SAD) is embarrassingly parallel and pure CPU — but on the
  // main thread it janks the UI while it runs. This moves it off-thread.
  //
  // `flowKernel` is a SELF-CONTAINED, faithful port of MotionMosher._estimate /
  // _estimateHierarchical / _sad / _downscaleLuma (verified byte-identical to
  // the on-thread estimateFlow by .test/motion-worker.mjs). It is the single
  // source of truth: the Worker body is generated from flowKernel.toString(), so
  // the two can never drift. The existing renderers keep using the class code
  // untouched — this is a NEW, opt-in async primitive with a main-thread
  // fallback (no Worker, or forced 'main' mode), so nothing battle-tested moves.
  // ===========================================================================
  function flowKernel(curY, prevY, w, h, p) {
    const acc = { calls: 0, pixels: 0 };
    const sad = (cur, prev, W, H, x0, y0, bw, bh, dx, dy, step) => {
      let cost = 0, n = 0;
      for (let y = 0; y < bh; y += step) {
        const cy = y0 + y;
        const py = Math.min(H - 1, Math.max(0, cy - dy));
        const bc = cy * W + x0;
        const bp = py * W + (x0 - dx);
        for (let x = 0; x < bw; x += step) {
          const px = bp + Math.min(W - 1, Math.max(0, x));
          cost += Math.abs(cur[bc + x] - prev[px]);
          n++;
        }
      }
      acc.calls++; acc.pixels += n;
      return n ? cost / n : Infinity;
    };
    const downscale = (Y, W, H) => {
      const hw = Math.max(1, W >> 1), hh = Math.max(1, H >> 1);
      const out = new Float32Array(hw * hh);
      for (let y = 0; y < hh; y++) {
        const sy = y * 2, sy1 = Math.min(H - 1, sy + 1);
        for (let x = 0; x < hw; x++) {
          const sx = x * 2, sx1 = Math.min(W - 1, sx + 1);
          out[y * hw + x] = (Y[sy * W + sx] + Y[sy * W + sx1] + Y[sy1 * W + sx] + Y[sy1 * W + sx1]) * 0.25;
        }
      }
      return { Y: out, w: hw, h: hh };
    };
    const bs = p.blockSize;
    const cols = Math.ceil(w / bs), rows = Math.ceil(h / bs);
    const vec = new Float32Array(cols * rows * 2);
    let lastSAD = 0;

    if (p.hierarchical) {
      const cH = downscale(curY, w, h), pH = downscale(prevY, w, h);
      const hw = cH.w, hh = cH.h;
      const ccols = Math.ceil(hw / bs), crows = Math.ceil(hh / bs);
      const coarse = new Float32Array(ccols * crows * 2);
      const R = Math.max(2, p.motionRadius | 0);
      const cstep = bs >= 16 ? 2 : 1;
      for (let by = 0; by < crows; by++) {
        for (let bx = 0; bx < ccols; bx++) {
          const x0 = bx * bs, y0 = by * bs;
          const bw = Math.min(bs, hw - x0), bh = Math.min(bs, hh - y0);
          let gx = 0, gy = 0;
          if (bx > 0) { const i = (by * ccols + (bx - 1)) * 2; gx = coarse[i]; gy = coarse[i + 1]; }
          let bestDx = 0, bestDy = 0, best = Infinity;
          for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
              const c = sad(cH.Y, pH.Y, hw, hh, x0, y0, bw, bh, (gx + dx) | 0, (gy + dy) | 0, cstep);
              if (c < best) { best = c; bestDx = (gx + dx) | 0; bestDy = (gy + dy) | 0; }
            }
          }
          const i = (by * ccols + bx) * 2; coarse[i] = bestDx; coarse[i + 1] = bestDy;
        }
      }
      const refineR = 2, step = bs >= 16 ? 2 : 1;
      let totalSAD = 0, blocks = 0;
      for (let by = 0; by < rows; by++) {
        for (let bx = 0; bx < cols; bx++) {
          const x0 = bx * bs, y0 = by * bs;
          const bw = Math.min(bs, w - x0), bh = Math.min(bs, h - y0);
          const cbx = Math.min(ccols - 1, bx >> 1), cby = Math.min(crows - 1, by >> 1);
          const ci = (cby * ccols + cbx) * 2;
          const gx = coarse[ci] * 2, gy = coarse[ci + 1] * 2;
          let bestDx = gx | 0, bestDy = gy | 0, best = Infinity;
          for (let dy = -refineR; dy <= refineR; dy++) {
            for (let dx = -refineR; dx <= refineR; dx++) {
              const c = sad(curY, prevY, w, h, x0, y0, bw, bh, (gx + dx) | 0, (gy + dy) | 0, step);
              if (c < best) { best = c; bestDx = (gx + dx) | 0; bestDy = (gy + dy) | 0; }
            }
          }
          const i = (by * cols + bx) * 2;
          if (best < p.threshold) { vec[i] = 0; vec[i + 1] = 0; }
          else {
            let vx = bestDx, vy = bestDy;
            const amp = p.amplify;
            if (amp !== 1) {
              const mag = Math.hypot(vx, vy);
              if (mag > 0) { const rr = Math.max(2, p.motionRadius); const shaped = Math.pow(Math.min(1, mag / rr), amp) * rr; const k = shaped / mag; vx *= k; vy *= k; }
            }
            vx *= p.directionX; vy *= p.directionY;
            vec[i] = vx; vec[i + 1] = vy;
          }
          totalSAD += best; blocks++;
        }
      }
      lastSAD = blocks ? totalSAD / blocks : 0;
      return { vec, cols, rows, lastSAD, sadCalls: acc.calls, sadPixels: acc.pixels };
    }

    const r = Math.max(2, p.motionRadius | 0);
    const step = bs >= 16 ? 2 : 1;
    let totalSAD = 0, blocks = 0;
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        const x0 = bx * bs, y0 = by * bs;
        const bw = Math.min(bs, w - x0), bh = Math.min(bs, h - y0);
        let gx = 0, gy = 0;
        if (bx > 0) { const i = (by * cols + (bx - 1)) * 2; gx = vec[i]; gy = vec[i + 1]; }
        let bestDx = 0, bestDy = 0, best = Infinity;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const c = sad(curY, prevY, w, h, x0, y0, bw, bh, (gx + dx) | 0, (gy + dy) | 0, step);
            if (c < best) { best = c; bestDx = (gx + dx) | 0; bestDy = (gy + dy) | 0; }
          }
        }
        const i = (by * cols + bx) * 2;
        if (best < p.threshold) { vec[i] = 0; vec[i + 1] = 0; }
        else {
          let vx = bestDx, vy = bestDy;
          const amp = p.amplify;
          if (amp !== 1) {
            const mag = Math.hypot(vx, vy);
            if (mag > 0) { const rr = Math.max(2, p.motionRadius); const shaped = Math.pow(Math.min(1, mag / rr), amp) * rr; const k = shaped / mag; vx *= k; vy *= k; }
          }
          vx *= p.directionX; vy *= p.directionY;
          vec[i] = vx; vec[i + 1] = vy;
        }
        totalSAD += best; blocks++;
      }
    }
    lastSAD = blocks ? totalSAD / blocks : 0;
    return { vec, cols, rows, lastSAD, sadCalls: acc.calls, sadPixels: acc.pixels };
  }

  const FFMotion = (() => {
    let _worker = null, _blobUrl = null, _nextId = 1, _mode = 'auto', _lastPath = '';
    const _pending = new Map();
    const mergeParams = (opts) => Object.assign({}, DEFAULTS, opts, { hierarchical: !!(opts && opts.mode === 'half') });
    const workerAvailable = () => _mode !== 'main' && typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && !!URL.createObjectURL;

    function ensureWorker() {
      if (_worker) return _worker;
      const src = `
        const flowKernel = ${flowKernel.toString()};
        self.onmessage = (e) => {
          const d = e.data;
          try {
            const r = flowKernel(new Uint8ClampedArray(d.curY), new Uint8ClampedArray(d.prevY), d.w, d.h, d.p);
            self.postMessage({ id: d.id, vec: r.vec.buffer, cols: r.cols, rows: r.rows, lastSAD: r.lastSAD, sadCalls: r.sadCalls, sadPixels: r.sadPixels }, [r.vec.buffer]);
          } catch (err) { self.postMessage({ id: d.id, error: String(err && err.message || err) }); }
        };`;
      _blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      _worker = new Worker(_blobUrl);
      _worker.onmessage = (e) => {
        const { id, vec, cols, rows, lastSAD, sadCalls, sadPixels, error } = e.data;
        const job = _pending.get(id);
        if (!job) return;
        _pending.delete(id);
        if (error) { job.reject(new Error(error)); return; }
        job.resolve({ vec: new Float32Array(vec), cols, rows, lastSAD, sadCalls, sadPixels, path: 'worker' });
      };
      _worker.onerror = () => { for (const [, job] of _pending) job.reject(new Error('motion worker crashed')); _pending.clear(); };
      return _worker;
    }

    function runInWorker(curY, prevY, w, h, p) {
      const wk = ensureWorker();
      const id = _nextId++;
      // copy → transfer so the caller's arrays stay valid
      const c = new Uint8ClampedArray(curY).buffer.slice(0);
      const q = new Uint8ClampedArray(prevY).buffer.slice(0);
      return new Promise((resolve, reject) => {
        _pending.set(id, { resolve, reject });
        wk.postMessage({ id, curY: c, prevY: q, w, h, p }, [c, q]);
      });
    }

    async function estimateAsync(curY, prevY, w, h, opts = {}) {
      const p = mergeParams(opts);
      if (workerAvailable()) {
        try { const r = await runInWorker(curY, prevY, w, h, p); _lastPath = 'worker'; return r; }
        catch (_) { /* fall through to main thread */ }
      }
      const r = flowKernel(curY, prevY, w, h, p);
      _lastPath = 'main';
      return Object.assign({ path: 'main' }, r);
    }

    return {
      estimateAsync, flowKernel,
      setMode: (m) => { _mode = (m === 'main' || m === 'worker') ? m : 'auto'; },
      available: () => workerAvailable(),
      lastPath: () => _lastPath,
      terminate: () => { try { _worker && _worker.terminate(); } catch (_) {} _worker = null; if (_blobUrl) { try { URL.revokeObjectURL(_blobUrl); } catch (_) {} _blobUrl = null; } _pending.clear(); },
    };
  })();

  window.FFMotion = FFMotion;

  window.FFMosh = { MotionMosher, DEFAULTS, estimateFlow, flowKernel, renderFile, renderTwoClips, renderFlowDisplace,
    renderVectorOverlay, globalMotion, stabilizePath, renderStabilize,
    motionCentroid, renderReframe, renderInterpolate,
    recordVectors, replayVectors, serializeVectors, deserializeVectors };
})();
