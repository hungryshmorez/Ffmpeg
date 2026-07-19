// =============================================================================
// wf-thumbs.js  —  #93 Workflow thumbnails
// =============================================================================
// Every workflow card gets a small static thumbnail showing what the workflow
// does — the effect applied to a canonical reference frame (colour bars + a
// skin-tone patch + a b/w gradient). So "Bleach Bypass" reads as a washed,
// high-contrast tile and "Warm Vintage" reads amber at a glance, before you
// hover or run anything.
//
// It reuses the #94 look engine: FFHoverPreview.deriveLook(wf) → ops, and
// FFHoverPreview.applyLook(referenceFrame, ops). The reference frame comes
// from FFHoverPreview.testFrame so hover-preview and the baked thumbnail show
// the exact same subject. Audio-only workflows get a small waveform tile.
// =============================================================================

(function (global) {
  'use strict';

  const THUMB_W = 120, THUMB_H = 68;
  let _canonCache = null;

  const HP = () => global.FFHoverPreview;

  // Cached reference frame (ImageData) at thumbnail size.
  function canon() {
    if (_canonCache) return _canonCache;
    const hp = HP();
    if (hp && hp.testFrame) _canonCache = hp.testFrame(THUMB_W, THUMB_H);
    return _canonCache;
  }

  // Draw a workflow's look thumbnail onto `canvas`. Returns the look.
  function renderThumb(canvas, wf) {
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const hp = HP();
    const look = hp && hp.deriveLook ? hp.deriveLook(wf) : { ops: [], audio: false };
    if (look.audio || !canon()) {
      // audio (or engine missing) → a small stylised waveform tile
      ctx.fillStyle = '#0d0f14'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#3a6ea5';
      for (let x = 0; x < canvas.width; x += 2) {
        const a = Math.abs(Math.sin(x * 0.22) * Math.sin(x * 0.05)) * (canvas.height * 0.42);
        ctx.fillRect(x, canvas.height / 2 - a, 1, a * 2);
      }
      return look;
    }
    const src = canon();
    const work = ctx.createImageData(src.width, src.height);
    work.data.set(src.data);
    hp.applyLook(work, look.ops);
    // canon is THUMB_W×THUMB_H so it maps 1:1
    ctx.putImageData(work, 0, 0);
    return look;
  }

  function dataURLFor(wf) {
    if (typeof document === 'undefined') return '';
    const c = document.createElement('canvas'); c.width = THUMB_W; c.height = THUMB_H;
    renderThumb(c, wf);
    try { return c.toDataURL('image/png'); } catch (_) { return ''; }
  }

  // Look up a workflow object by id (built-in + custom).
  function lookupWf(id) {
    try {
      const custom = (typeof global.loadCustomWorkflows === 'function') ? global.loadCustomWorkflows() : [];
      const all = (typeof global.getAllBuiltInWorkflows === 'function')
        ? global.getAllBuiltInWorkflows().concat(custom)
        : (global.WORKFLOWS ? Array.from(global.WORKFLOWS) : []);
      return all.find((w) => w.id === id);
    } catch (_) { return null; }
  }

  // Inject + render a thumbnail into every card in the grid that lacks one.
  // Rendering is cheap (a 120×68 pixel pass) so we do it synchronously.
  function decorate(gridEl) {
    if (typeof document === 'undefined') return 0;
    const grid = gridEl || document.getElementById('workflows-grid');
    if (!grid || !HP()) return 0;
    let n = 0;
    grid.querySelectorAll('.wf-card').forEach((card) => {
      if (card.querySelector('.wf-thumb')) return; // already decorated
      const wf = lookupWf(card.dataset.wfId);
      if (!wf) return;
      const cnv = document.createElement('canvas');
      cnv.className = 'wf-thumb';
      cnv.width = THUMB_W; cnv.height = THUMB_H;
      cnv.style.cssText = 'width:100%;height:auto;display:block;border-radius:7px;margin-bottom:8px;background:#000;image-rendering:auto';
      cnv.setAttribute('aria-hidden', 'true');
      cnv.title = 'Approximate look preview';
      try { renderThumb(cnv, wf); } catch (_) {}
      card.insertBefore(cnv, card.firstChild);
      n++;
    });
    return n;
  }

  // Auto-decorate after the workflow grid (re)renders. workflows.js rewrites
  // grid.innerHTML on search/category change, wiping thumbnails, so we watch
  // the grid with a MutationObserver and re-decorate on the next frame.
  if (typeof document !== 'undefined') {
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = (global.requestAnimationFrame || ((f) => setTimeout(f, 16)))(() => { raf = 0; decorate(); });
    };
    const boot = () => {
      const grid = document.getElementById('workflows-grid');
      if (!grid) return;
      decorate(grid);
      if (!grid._thumbObserver && global.MutationObserver) {
        const mo = new MutationObserver(schedule);
        mo.observe(grid, { childList: true });
        grid._thumbObserver = mo;
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  const API = { THUMB_W, THUMB_H, canon, renderThumb, dataURLFor, decorate };
  global.FFWfThumb = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
