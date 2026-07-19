// =============================================================================
// hover-preview.js  —  #94 Hover-preview a workflow on the canvas
// =============================================================================
// Hovering a workflow card paints a *fast approximation* of that workflow's
// look onto a small floating canvas, so you can see roughly what "Bleach
// Bypass" or "Warm Vintage" does before you commit a full ffmpeg run.
//
// The look is DERIVED, not hand-keyed per workflow:
//   1. we parse the workflow's real generated ffmpeg command for known video
//      filters (eq, hue, negate, curves, vignette, noise, colortemperature…)
//   2. and fall back to keyword heuristics on the name/category/tags.
// Each match becomes one or more pure per-pixel "ops". `applyLook` runs those
// ops over an ImageData in place. That core is deterministic and unit-tested;
// the DOM/overlay glue on top is a thin presentation layer.
//
// This is an APPROXIMATION shown as "≈ preview" — a browser canvas can't run
// the real ffmpeg filtergraph instantly. It is honest about that in the label.
// =============================================================================

(function (global) {
  'use strict';

  const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  // ---- Pure per-image pixel operations ---------------------------------------
  // Each op is { type, ...params }. Appliers mutate the RGBA Uint8ClampedArray
  // in place. `w`/`h` are passed for spatial ops (vignette, blur).
  const OPS = {
    grayscale(d) {
      for (let i = 0; i < d.length; i += 4) {
        const l = luma(d[i], d[i + 1], d[i + 2]);
        d[i] = d[i + 1] = d[i + 2] = l;
      }
    },
    invert(d) {
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2];
      }
    },
    saturate(d, op) {
      const k = op.amount;
      for (let i = 0; i < d.length; i += 4) {
        const l = luma(d[i], d[i + 1], d[i + 2]);
        d[i]     = clamp8(l + (d[i]     - l) * k);
        d[i + 1] = clamp8(l + (d[i + 1] - l) * k);
        d[i + 2] = clamp8(l + (d[i + 2] - l) * k);
      }
    },
    mul(d, op) { // gain / brightness (multiplicative)
      const k = op.amount;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = clamp8(d[i] * k); d[i + 1] = clamp8(d[i + 1] * k); d[i + 2] = clamp8(d[i + 2] * k);
      }
    },
    add(d, op) { // brightness (additive offset in 0-255 units)
      const k = op.amount;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = clamp8(d[i] + k); d[i + 1] = clamp8(d[i + 1] + k); d[i + 2] = clamp8(d[i + 2] + k);
      }
    },
    contrast(d, op) {
      const k = op.amount;
      for (let i = 0; i < d.length; i += 4) {
        d[i]     = clamp8((d[i]     - 128) * k + 128);
        d[i + 1] = clamp8((d[i + 1] - 128) * k + 128);
        d[i + 2] = clamp8((d[i + 2] - 128) * k + 128);
      }
    },
    gamma(d, op) {
      const g = 1 / op.amount, lut = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) lut[v] = clamp8(255 * Math.pow(v / 255, g));
      for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
    },
    channelGain(d, op) { // per-channel multiply — tint / temperature / sepia-ish
      const [kr, kg, kb] = op.rgb;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = clamp8(d[i] * kr); d[i + 1] = clamp8(d[i + 1] * kg); d[i + 2] = clamp8(d[i + 2] * kb);
      }
    },
    tint(d, op) { // blend toward a colour by amount [0..1]
      const [tr, tg, tb] = op.rgb, a = op.amount, ia = 1 - a;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = clamp8(d[i] * ia + tr * a); d[i + 1] = clamp8(d[i + 1] * ia + tg * a); d[i + 2] = clamp8(d[i + 2] * ia + tb * a);
      }
    },
    sepia(d) {
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        d[i]     = clamp8(0.393 * r + 0.769 * g + 0.189 * b);
        d[i + 1] = clamp8(0.349 * r + 0.686 * g + 0.168 * b);
        d[i + 2] = clamp8(0.272 * r + 0.534 * g + 0.131 * b);
      }
    },
    posterize(d, op) {
      const n = op.levels, step = 255 / (n - 1);
      for (let i = 0; i < d.length; i += 4) {
        d[i]     = clamp8(Math.round(d[i]     / step) * step);
        d[i + 1] = clamp8(Math.round(d[i + 1] / step) * step);
        d[i + 2] = clamp8(Math.round(d[i + 2] / step) * step);
      }
    },
    noise(d, op) { // deterministic (seeded) grain so a preview is reproducible
      let s = (op.seed || 1) >>> 0;
      const amt = op.amount;
      const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
      for (let i = 0; i < d.length; i += 4) {
        const n = (rnd() - 0.5) * 2 * amt;
        d[i] = clamp8(d[i] + n); d[i + 1] = clamp8(d[i + 1] + n); d[i + 2] = clamp8(d[i + 2] + n);
      }
    },
    vignette(d, op, w, h) {
      const cx = w / 2, cy = h / 2, maxD = Math.hypot(cx, cy), amt = op.amount;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dist = Math.hypot(x - cx, y - cy) / maxD;
          const f = 1 - amt * dist * dist, i = (y * w + x) * 4;
          d[i] = clamp8(d[i] * f); d[i + 1] = clamp8(d[i + 1] * f); d[i + 2] = clamp8(d[i + 2] * f);
        }
      }
    },
    blur(d, op, w, h) { // cheap separable box blur (radius r), approximates gblur/boxblur
      const r = Math.max(1, op.radius | 0);
      const tmp = new Uint8ClampedArray(d.length);
      const pass = (src, dst, stride, count, lineLen) => {
        for (let line = 0; line < count; line++) {
          for (let p = 0; p < lineLen; p++) {
            let sr = 0, sg = 0, sb = 0, n = 0;
            for (let k = -r; k <= r; k++) {
              const q = p + k; if (q < 0 || q >= lineLen) continue;
              const idx = (line * lineLen + q) * 4; // logical; remapped by caller stride
              sr += src[idx]; sg += src[idx + 1]; sb += src[idx + 2]; n++;
            }
            const o = (line * lineLen + p) * 4;
            dst[o] = sr / n; dst[o + 1] = sg / n; dst[o + 2] = sb / n; dst[o + 3] = src[o + 3];
          }
        }
      };
      // horizontal (lines = rows, lineLen = w)
      pass(d, tmp, 1, h, w);
      // vertical: reuse pass by transposing indexing — simplest correct route is
      // a second horizontal pass over a transposed buffer.
      const trans = (src, dst) => {
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const s = (y * w + x) * 4, t = (x * h + y) * 4;
          dst[t] = src[s]; dst[t + 1] = src[s + 1]; dst[t + 2] = src[s + 2]; dst[t + 3] = src[s + 3];
        }
      };
      const tb = new Uint8ClampedArray(d.length), tb2 = new Uint8ClampedArray(d.length);
      trans(tmp, tb);            // now w↔h swapped, lines = w, lineLen = h
      pass(tb, tb2, 1, w, h);
      // transpose back into d
      for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
        const s = (x * h + y) * 4, o = (y * w + x) * 4;
        d[o] = tb2[s]; d[o + 1] = tb2[s + 1]; d[o + 2] = tb2[s + 2]; d[o + 3] = tb2[s + 3];
      }
    },
  };

  // ---- Apply a look (list of ops) to an ImageData in place -------------------
  function applyLook(imageData, ops) {
    if (!ops || !ops.length) return imageData;
    const d = imageData.data, w = imageData.width, h = imageData.height;
    for (const op of ops) {
      const fn = OPS[op.type];
      if (fn) fn(d, op, w, h);
    }
    return imageData;
  }

  // ---- Derive a look from a workflow ----------------------------------------
  // Returns { ops:[...], label, audio:bool }. Grounded first in the real
  // ffmpeg command (so the preview tracks the actual filters), then keywords.
  function deriveLook(wf) {
    if (!wf) return { ops: [], label: '≈ preview' };
    const ops = [];
    let cmd = '';
    try {
      if (typeof global.generateWorkflowCommandString === 'function') {
        cmd = String(global.generateWorkflowCommandString(wf) || '');
      }
    } catch (_) { cmd = ''; }
    const cat = String(wf.category || '');
    const isAudio = /audio/.test(cat) || wf.fullChain || wf.simplifiedChain;
    // An audio-only workflow (mastering chain, no -vf) has no visual to show.
    const hasVideoFilter = /-vf|-filter_complex|eq=|hue=|negate|curves=|vignette|noise=|colortemperature|colorbalance|gblur|boxblur|unsharp|lut/i.test(cmd);
    if (isAudio && !hasVideoFilter) {
      return { ops: [], label: 'audio — no visual preview', audio: true };
    }

    // --- Filter-string parsing (authoritative where present) ---
    const eq = /eq=([^"',]+(?::[^"',]+)*)/i.exec(cmd);
    if (eq) {
      const params = eq[1];
      const num = (name) => {
        const m = new RegExp(name + '=(-?[0-9.]+)').exec(params);
        return m ? parseFloat(m[1]) : null;
      };
      const sat = num('saturation'); if (sat != null) ops.push({ type: 'saturate', amount: sat });
      const con = num('contrast');   if (con != null) ops.push({ type: 'contrast', amount: con });
      const bri = num('brightness'); if (bri != null) ops.push({ type: 'add', amount: bri * 128 });
      const gam = num('gamma');      if (gam != null && gam > 0) ops.push({ type: 'gamma', amount: gam });
    }
    if (/hue=s=0|format=gray|colorchannelmixer=\.?3/i.test(cmd)) ops.push({ type: 'grayscale' });
    if (/\bnegate\b/i.test(cmd)) ops.push({ type: 'invert' });
    if (/vignette/i.test(cmd)) ops.push({ type: 'vignette', amount: 0.6 });
    const noiseM = /noise=alls=([0-9.]+)/i.exec(cmd);
    if (noiseM) ops.push({ type: 'noise', amount: Math.min(60, parseFloat(noiseM[1]) * 2), seed: 7 });
    const tempM = /colortemperature=temperature=([0-9.]+)/i.exec(cmd);
    if (tempM) {
      const t = parseFloat(tempM[1]);
      ops.push(t > 6500 ? { type: 'channelGain', rgb: [0.92, 0.98, 1.12] }   // cooler
                        : { type: 'channelGain', rgb: [1.12, 1.0, 0.9] });    // warmer
    }
    if (/gblur|boxblur/i.test(cmd)) ops.push({ type: 'blur', radius: 2 });
    if (/unsharp/i.test(cmd)) ops.push({ type: 'contrast', amount: 1.15 });
    const curves = /curves=(?:preset=)?([a-z_]+)/i.exec(cmd);
    if (curves) {
      const preset = curves[1].toLowerCase();
      if (/negative/.test(preset)) ops.push({ type: 'invert' });
      else if (/vintage/.test(preset)) { ops.push({ type: 'channelGain', rgb: [1.1, 1.0, 0.85] }, { type: 'contrast', amount: 0.9 }); }
      else if (/darker/.test(preset)) ops.push({ type: 'mul', amount: 0.8 });
      else if (/lighter/.test(preset)) ops.push({ type: 'mul', amount: 1.2 });
      else if (/increase_contrast|strong_contrast/.test(preset)) ops.push({ type: 'contrast', amount: 1.3 });
    }

    // --- Keyword heuristics (fallback / enrichment) ---
    const hay = [wf.name, wf.description, cat, ...(wf.tags || [])].join(' ').toLowerCase();
    const kw = (re) => re.test(hay);
    const had = ops.length > 0;
    if (!had) {
      if (kw(/black.?and.?white|grayscale|greyscale|\bb\s?&\s?w\b|\bnoir\b|monochrome|\bmono\b/)) ops.push({ type: 'grayscale' });
      else if (kw(/sepia/)) ops.push({ type: 'sepia' });
      else if (kw(/invert|negative/)) ops.push({ type: 'invert' });
      else if (kw(/bleach/)) ops.push({ type: 'saturate', amount: 0.4 }, { type: 'contrast', amount: 1.4 });
      else if (kw(/cyberpunk|neon/)) ops.push({ type: 'saturate', amount: 1.6 }, { type: 'channelGain', rgb: [1.05, 0.95, 1.18] });
      else if (kw(/vintage|retro|faded|super.?8|old.?film|nostalg/)) ops.push({ type: 'channelGain', rgb: [1.1, 1.0, 0.85] }, { type: 'contrast', amount: 0.9 }, { type: 'add', amount: 10 });
      else if (kw(/vhs|glitch|datamosh|databend|corrupt/)) ops.push({ type: 'noise', amount: 22, seed: 11 }, { type: 'saturate', amount: 1.2 }, { type: 'channelGain', rgb: [1.05, 1.0, 1.05] });
      else if (kw(/golden|sunset|warm|amber/)) ops.push({ type: 'channelGain', rgb: [1.12, 1.0, 0.88] });
      else if (kw(/cold|cool|blue|teal|winter|icy/)) ops.push({ type: 'channelGain', rgb: [0.9, 1.0, 1.12] });
      else if (kw(/vibrant|vivid|saturat|punchy|\bpop\b|color.?boost/)) ops.push({ type: 'saturate', amount: 1.55 });
      else if (kw(/desaturat|muted|pastel|faded/)) ops.push({ type: 'saturate', amount: 0.6 });
      else if (kw(/bright|lighten/)) ops.push({ type: 'mul', amount: 1.15 });
      else if (kw(/dark|moody|dramatic|cinematic/)) ops.push({ type: 'mul', amount: 0.85 }, { type: 'contrast', amount: 1.15 });
      else if (kw(/contrast|punch|hdr/)) ops.push({ type: 'contrast', amount: 1.3 });
      else if (kw(/poster|comic|cartoon/)) ops.push({ type: 'posterize', levels: 4 }, { type: 'saturate', amount: 1.2 });
      else if (kw(/blur|dream|soft|hazy|glow/)) ops.push({ type: 'blur', radius: 2 });
      else if (kw(/sharp|crisp|clarity|detail/)) ops.push({ type: 'contrast', amount: 1.12 });
      else if (kw(/vignette/)) ops.push({ type: 'vignette', amount: 0.6 });
    }

    // Nothing matched → a gentle default so the card still shows a change.
    const label = ops.length ? '≈ approximate preview' : '≈ preview (no strong visual filter)';
    if (!ops.length && !isAudio) ops.push({ type: 'contrast', amount: 1.06 });
    return { ops, label, audio: false };
  }

  // ===========================================================================
  // DOM / overlay presentation layer
  // ===========================================================================
  let _overlay = null, _canvas = null, _caption = null;
  let _srcFrame = null; // cached ImageData of the current source at preview size
  let _hideTimer = null;
  const PREVIEW_W = 220, PREVIEW_H = 124;

  function ensureOverlay() {
    if (_overlay) return _overlay;
    if (typeof document === 'undefined') return null;
    _overlay = document.createElement('div');
    _overlay.id = 'wf-hover-preview';
    _overlay.setAttribute('role', 'status');
    _overlay.style.cssText = [
      'position:fixed', 'z-index:9000', 'pointer-events:none',
      'background:#0d0f14', 'border:1px solid #2a2f3a', 'border-radius:10px',
      'padding:6px', 'box-shadow:0 8px 28px rgba(0,0,0,.55)',
      'display:none', 'width:' + (PREVIEW_W + 12) + 'px',
    ].join(';');
    _canvas = document.createElement('canvas');
    _canvas.width = PREVIEW_W; _canvas.height = PREVIEW_H;
    _canvas.style.cssText = 'width:100%;display:block;border-radius:6px;background:#000';
    _caption = document.createElement('div');
    _caption.style.cssText = 'font:11px/1.4 system-ui,sans-serif;color:#9aa4b2;margin-top:4px;text-align:center';
    _overlay.appendChild(_canvas);
    _overlay.appendChild(_caption);
    document.body.appendChild(_overlay);
    return _overlay;
  }

  // Draw a synthetic colour-bars + gradient test frame (used when no source is
  // loaded, so the preview always shows something representative).
  function drawTestFrame(ctx, w, h) {
    const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
    const bw = w / bars.length;
    for (let i = 0; i < bars.length; i++) { ctx.fillStyle = bars[i]; ctx.fillRect(i * bw, 0, bw + 1, h * 0.66); }
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#000'); grad.addColorStop(1, '#fff');
    ctx.fillStyle = grad; ctx.fillRect(0, h * 0.66, w, h * 0.34);
    // a warm skin-tone patch so temperature/saturation reads are visible
    ctx.fillStyle = '#c98a5e'; ctx.fillRect(w * 0.38, h * 0.2, w * 0.24, h * 0.24);
  }

  // Return the synthetic reference frame as an ImageData at any size. Shared
  // with the workflow-thumbnail engine (#93) so both show the same canonical
  // subject (colour bars + skin patch + gradient).
  function testFrame(w, h) {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    drawTestFrame(x, w, h);
    return x.getImageData(0, 0, w, h);
  }

  // Capture the current source frame into an offscreen ImageData at preview size.
  function captureSourceFrame() {
    if (typeof document === 'undefined') return null;
    const cnv = document.createElement('canvas');
    cnv.width = PREVIEW_W; cnv.height = PREVIEW_H;
    const ctx = cnv.getContext('2d');
    const v = document.getElementById('video-preview');
    let drew = false;
    try {
      if (v && (v.videoWidth || (v.tagName === 'IMG' && v.naturalWidth))) {
        ctx.drawImage(v, 0, 0, PREVIEW_W, PREVIEW_H);
        drew = true;
      } else {
        const img = document.querySelector('#tab-editor img, .bin-card-thumb img');
        if (img && img.naturalWidth) { ctx.drawImage(img, 0, 0, PREVIEW_W, PREVIEW_H); drew = true; }
      }
    } catch (_) { drew = false; }
    if (!drew) drawTestFrame(ctx, PREVIEW_W, PREVIEW_H);
    return ctx.getImageData(0, 0, PREVIEW_W, PREVIEW_H);
  }

  // Render `wf`'s look onto the overlay canvas and position near `cardEl`.
  function showFor(wf, cardEl) {
    const ov = ensureOverlay();
    if (!ov) return null;
    if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
    const look = deriveLook(wf);
    const ctx = _canvas.getContext('2d');
    if (look.audio) {
      ctx.fillStyle = '#0d0f14'; ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
      ctx.fillStyle = '#3a6ea5';
      for (let x = 0; x < PREVIEW_W; x += 3) {
        const a = Math.sin(x * 0.18) * Math.sin(x * 0.03) * (PREVIEW_H * 0.4);
        ctx.fillRect(x, PREVIEW_H / 2 - Math.abs(a), 2, Math.abs(a) * 2);
      }
    } else {
      // fresh source capture each hover so it tracks the loaded clip
      _srcFrame = captureSourceFrame();
      const work = ctx.createImageData(PREVIEW_W, PREVIEW_H);
      work.data.set(_srcFrame.data);
      applyLook(work, look.ops);
      ctx.putImageData(work, 0, 0);
    }
    _caption.textContent = (wf && wf.name ? wf.name + ' — ' : '') + look.label;
    // position: right of the card if room, else left
    ov.style.display = 'block';
    if (cardEl && cardEl.getBoundingClientRect) {
      const r = cardEl.getBoundingClientRect();
      const ow = PREVIEW_W + 12;
      let left = r.right + 10;
      if (left + ow > global.innerWidth - 8) left = r.left - ow - 10;
      if (left < 8) left = 8;
      let top = r.top;
      const oh = PREVIEW_H + 34;
      if (top + oh > global.innerHeight - 8) top = global.innerHeight - oh - 8;
      ov.style.left = left + 'px';
      ov.style.top = Math.max(8, top) + 'px';
    }
    return look;
  }

  function hide() {
    if (!_overlay) return;
    _hideTimer = setTimeout(() => { if (_overlay) _overlay.style.display = 'none'; }, 60);
  }

  // Attach delegated hover handlers to the workflows grid. Idempotent.
  function attach(gridEl) {
    if (typeof document === 'undefined') return;
    const grid = gridEl || document.getElementById('workflows-grid');
    if (!grid || grid._hoverPreviewBound) return;
    grid._hoverPreviewBound = true;
    const lookup = (id) => {
      try {
        const custom = (typeof global.loadCustomWorkflows === 'function') ? global.loadCustomWorkflows() : [];
        const all = (typeof global.getAllBuiltInWorkflows === 'function')
          ? global.getAllBuiltInWorkflows().concat(custom)
          : (global.WORKFLOWS ? Array.from(global.WORKFLOWS) : []);
        return all.find((w) => w.id === id);
      } catch (_) { return null; }
    };
    grid.addEventListener('mouseover', (e) => {
      const card = e.target.closest && e.target.closest('.wf-card');
      if (!card || !grid.contains(card)) return;
      // Don't fire while hovering the action buttons.
      if (e.target.closest('button')) return;
      const wf = lookup(card.dataset.wfId);
      if (wf) showFor(wf, card);
    });
    grid.addEventListener('mouseout', (e) => {
      const to = e.relatedTarget;
      if (to && to.closest && to.closest('.wf-card')) return; // moving within cards
      hide();
    });
    // Hide on scroll so the overlay never detaches from its card.
    grid.addEventListener('scroll', hide, { passive: true });
  }

  // Auto-attach once the grid exists.
  if (typeof document !== 'undefined') {
    const boot = () => {
      const grid = document.getElementById('workflows-grid');
      if (grid) attach(grid);
      // re-bind not needed: delegation survives grid.innerHTML rewrites because
      // the grid element itself is stable.
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  const API = { OPS, applyLook, deriveLook, showFor, hide, attach, captureSourceFrame, testFrame, PREVIEW_W, PREVIEW_H };
  global.FFHoverPreview = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
