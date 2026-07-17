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

  window.FFMosh = { MotionMosher, DEFAULTS, renderFile, renderTwoClips, renderFlowDisplace,
    renderVectorOverlay, recordVectors, replayVectors, serializeVectors, deserializeVectors };
})();
