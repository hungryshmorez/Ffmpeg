// =============================================================================
// fx-chain.js  —  #73 Effect chains (stack multiple effects in order)
// =============================================================================
// Turns the single-effect Live FX preview into an ordered STACK of effects —
// each stage its own effect + amount + on/off — applied top-to-bottom, so you
// can layer e.g. VHS → Vignette → Film Grain. This is the per-layer effect
// chain: one Chain instance drives the preview FX surface; more instances can
// drive individual compositor layers later.
//
// Each stage delegates to FFPreviewFX.applyEffect (the shared effect engine), so
// the chain automatically has every effect the Live FX surface does. The chain
// serialises cleanly and registers as a #89 undo provider, so Ctrl+Z steps back
// through chain edits.
// =============================================================================

(function (global) {
  'use strict';

  const FX = () => global.FFPreviewFX;

  class Chain {
    constructor(stages) { this.stages = Array.isArray(stages) ? stages.map(normStage) : []; }

    get length() { return this.stages.length; }
    enabled() { return this.stages.filter((s) => s.on); }
    hasActive() { return this.stages.some((s) => s.on); }

    add(id, amt) { this.stages.push(normStage({ id, amt: amt == null ? 1 : amt, on: true })); return this; }
    remove(i) { if (i >= 0 && i < this.stages.length) this.stages.splice(i, 1); return this; }
    clear() { this.stages = []; return this; }
    toggle(i, on) { const s = this.stages[i]; if (s) s.on = on == null ? !s.on : !!on; return this; }
    setAmount(i, v) { const s = this.stages[i]; if (s) s.amt = +v; return this; }
    // move a stage by delta (-1 up, +1 down); clamped, returns the new index.
    move(i, delta) {
      const j = i + delta;
      if (i < 0 || i >= this.stages.length || j < 0 || j >= this.stages.length) return i;
      const [s] = this.stages.splice(i, 1);
      this.stages.splice(j, 0, s);
      return j;
    }

    // Apply the enabled stages, in order, to an ImageData (mutated + returned).
    apply(img) {
      const fx = FX();
      if (!fx || !fx.applyEffect) return img;
      for (const s of this.stages) if (s.on) img = fx.applyEffect(img, s.id, s.amt);
      return img;
    }

    serialize() { return this.stages.map((s) => ({ id: s.id, amt: s.amt, on: s.on })); }
    restore(data) { this.stages = Array.isArray(data) ? data.map(normStage) : []; return this; }
  }

  function normStage(s) {
    return { id: String(s && s.id != null ? s.id : 'none'), amt: s && s.amt != null ? +s.amt : 1, on: s && s.on != null ? !!s.on : true };
  }

  // Pure helper — apply an arbitrary stage list to an ImageData.
  function applyChain(img, stages) { return new Chain(stages).apply(img); }

  // The default chain that drives the Live FX preview surface.
  const preview = new Chain();

  // ---- UI: render the chain as reorderable chips in the FX panel ------------
  function renderChainUI() {
    if (typeof document === 'undefined') return;
    const host = document.getElementById('pv-fx-chain');
    if (!host) return;
    if (!preview.stages.length) {
      host.innerHTML = '<span class="muted small" style="opacity:.7">No effects stacked — pick one and press ＋ Add.</span>';
      return;
    }
    const nameOf = (id) => { const e = FX() && FX().EFFECTS.find((x) => x.id === id); return e ? e.name : id; };
    host.innerHTML = preview.stages.map((s, i) => `
      <span class="fx-chip${s.on ? '' : ' off'}" data-i="${i}" style="display:inline-flex;align-items:center;gap:4px;background:${s.on ? '#20242e' : '#171a20'};border:1px solid #2f3441;border-radius:14px;padding:3px 6px 3px 10px;margin:3px 4px 0 0;font:12px system-ui;color:${s.on ? '#e6e9ef' : '#6b7280'}">
        <button type="button" data-act="up" title="Move up" style="background:none;border:0;color:#8a93a2;cursor:pointer;padding:0 2px">▲</button>
        <button type="button" data-act="down" title="Move down" style="background:none;border:0;color:#8a93a2;cursor:pointer;padding:0 2px">▼</button>
        <button type="button" data-act="toggle" title="Enable/disable" style="background:none;border:0;color:inherit;cursor:pointer;padding:0 2px">${s.on ? '●' : '○'}</button>
        <span>${nameOf(s.id)}</span>
        <button type="button" data-act="rm" title="Remove" style="background:none;border:0;color:#e06c6c;cursor:pointer;padding:0 4px 0 2px">×</button>
      </span>`).join('');
  }

  function flagUndo() { try { global.scheduleUndoSnapshot && global.scheduleUndoSnapshot(); } catch (_) {} }

  function bind() {
    if (typeof document === 'undefined') return;
    const addBtn = document.getElementById('pv-fx-add');
    if (addBtn && !addBtn._bound) {
      addBtn._bound = true;
      addBtn.addEventListener('click', () => {
        const sel = document.getElementById('pv-fx-effect');
        const amt = document.getElementById('pv-fx-amt');
        const id = sel ? sel.value : 'none';
        if (id === 'none') return;
        preview.add(id, amt ? +amt.value : 1);
        renderChainUI(); flagUndo();
      });
    }
    const host = document.getElementById('pv-fx-chain');
    if (host && !host._bound) {
      host._bound = true;
      host.addEventListener('click', (e) => {
        const chip = e.target.closest('.fx-chip'); if (!chip) return;
        const i = +chip.dataset.i; const act = e.target.dataset.act;
        if (act === 'up') preview.move(i, -1);
        else if (act === 'down') preview.move(i, +1);
        else if (act === 'toggle') preview.toggle(i);
        else if (act === 'rm') preview.remove(i);
        else return;
        renderChainUI(); flagUndo();
      });
      renderChainUI();
    }
    // register the chain with the app-wide undo stack (#89)
    if (typeof global.registerUndoProvider === 'function') {
      global.registerUndoProvider('fx-chain', {
        capture: () => (preview.stages.length ? preview.serialize() : null),
        restore: (d) => { preview.restore(d || []); renderChainUI(); },
      });
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
  }

  const API = { Chain, applyChain, preview, renderChainUI, bind };
  global.FFFxChain = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
