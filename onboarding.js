// =============================================================================
// onboarding.js  —  #90 Real onboarding tour
// =============================================================================
// A short, dismissible, localStorage-gated guided tour that spotlights the four
// things a new user needs to know: add media, browse the recipe library, search
// / hover to preview, and fine-tune + export in the editor. It runs once (after
// the mode picker, if present), never nags again, and is replayable from the
// keyboard cheat sheet ("Take the tour").
//
// Each step anchors to a real element by selector. If a target is missing the
// tooltip centres itself instead of pointing at nothing. The whole thing is a
// thin DOM layer over a tiny state machine (index + gate) that the test drives
// directly.
// =============================================================================

(function (global) {
  'use strict';

  const KEY = 'ffstudio.tour.v1';

  const STEPS = [
    {
      sel: '#global-bin-add',
      title: 'Add your media',
      body: 'Start here — add a video, audio file or image from disk (or just drop it anywhere). Everything runs in your browser; nothing is ever uploaded.',
    },
    {
      sel: '.tab-btn[data-tab="workflows"]',
      title: 'Pick a recipe',
      body: 'The Workflows tab has hundreds of one-click recipes — colour grades, glitch looks, audio masters. Each card shows a thumbnail of what it does.',
    },
    {
      sel: '#wf-search',
      title: 'Search & preview',
      body: 'Search by name or vibe, and hover any card to see an instant approximate preview of the look on your clip before you commit to a full render.',
    },
    {
      sel: '.tab-btn[data-tab="editor"]',
      title: 'Fine-tune & export',
      body: 'Open the Editor to trim, adjust and stack effects by hand, then export. Press ? any time for the full keyboard cheat sheet. That’s the tour!',
    },
  ];

  let _idx = 0;
  let _root = null;      // overlay root
  let _spot = null;      // spotlight ring
  let _card = null;      // tooltip card
  let _active = false;

  const gated = () => { try { return !!global.localStorage && localStorage.getItem(KEY) === 'done'; } catch (_) { return false; } };
  const setGate = () => { try { if (global.localStorage) localStorage.setItem(KEY, 'done'); } catch (_) {} };
  const clearGate = () => { try { if (global.localStorage) localStorage.removeItem(KEY); } catch (_) {} };
  const shouldShow = () => !gated();

  function buildDom() {
    if (_root) return;
    _root = document.createElement('div');
    _root.id = 'ff-tour';
    _root.setAttribute('role', 'dialog');
    _root.setAttribute('aria-label', 'Getting-started tour');
    _root.style.cssText = 'position:fixed;inset:0;z-index:9500;display:none';

    _spot = document.createElement('div');
    // A transparent ring whose gigantic box-shadow dims everything else,
    // leaving the target element visibly "lit".
    _spot.style.cssText = [
      'position:absolute', 'border-radius:10px', 'pointer-events:none',
      'box-shadow:0 0 0 9999px rgba(6,8,12,.68)', 'transition:all .22s ease',
      'outline:2px solid var(--accent,#00d4ff)', 'outline-offset:2px',
    ].join(';');

    _card = document.createElement('div');
    _card.className = 'ff-tour-card';
    _card.style.cssText = [
      'position:absolute', 'width:300px', 'max-width:calc(100vw - 24px)',
      'background:#12151c', 'border:1px solid #2a2f3a', 'border-radius:12px',
      'padding:16px', 'box-shadow:0 12px 40px rgba(0,0,0,.6)',
      'font:14px/1.5 system-ui,sans-serif', 'color:#e6e9ef',
    ].join(';');

    _root.appendChild(_spot);
    _root.appendChild(_card);
    document.body.appendChild(_root);

    // Click on the dimmed backdrop (not the card) advances, like most tours.
    _root.addEventListener('click', (e) => { if (e.target === _root || e.target === _spot) next(); });
    document.addEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (!_active) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  }

  function place(step) {
    const pad = 6;
    const el = step && step.sel ? document.querySelector(step.sel) : null;
    const vw = global.innerWidth, vh = global.innerHeight;
    if (el && el.getBoundingClientRect) {
      const r = el.getBoundingClientRect();
      _spot.style.display = 'block';
      _spot.style.left = (r.left - pad) + 'px';
      _spot.style.top = (r.top - pad) + 'px';
      _spot.style.width = (r.width + pad * 2) + 'px';
      _spot.style.height = (r.height + pad * 2) + 'px';
      // place card below the target if room, else above, else beside.
      const cardW = 300, cardH = 190;
      let left = Math.min(Math.max(8, r.left), vw - cardW - 8);
      let top = r.bottom + 12;
      if (top + cardH > vh - 8) top = Math.max(8, r.top - cardH - 12);
      _card.style.left = left + 'px';
      _card.style.top = top + 'px';
    } else {
      // no target → centre, hide the spotlight ring
      _spot.style.display = 'none';
      _card.style.left = Math.max(8, (vw - 300) / 2) + 'px';
      _card.style.top = Math.max(8, (vh - 190) / 2) + 'px';
    }
  }

  function renderCard() {
    const step = STEPS[_idx];
    const last = _idx === STEPS.length - 1;
    const first = _idx === 0;
    _card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <strong style="font-size:15px">${step.title}</strong>
        <span style="font-size:12px;color:#8a93a2">${_idx + 1} / ${STEPS.length}</span>
      </div>
      <p style="margin:0 0 14px;color:#c3c9d4">${step.body}</p>
      <div style="display:flex;gap:8px;align-items:center">
        <button type="button" data-tour="skip" style="background:none;border:0;color:#8a93a2;font-size:13px;cursor:pointer;padding:6px 2px">Skip tour</button>
        <span style="flex:1"></span>
        <button type="button" data-tour="prev" ${first ? 'disabled' : ''} style="background:#20242e;border:1px solid #2f3441;color:#e6e9ef;border-radius:8px;padding:7px 12px;cursor:pointer;${first ? 'opacity:.4;cursor:default' : ''}">Back</button>
        <button type="button" data-tour="next" style="background:var(--accent,#00d4ff);border:0;color:#04121a;font-weight:600;border-radius:8px;padding:7px 14px;cursor:pointer">${last ? 'Done' : 'Next'}</button>
      </div>`;
    _card.querySelector('[data-tour="skip"]').addEventListener('click', dismiss);
    _card.querySelector('[data-tour="prev"]').addEventListener('click', prev);
    _card.querySelector('[data-tour="next"]').addEventListener('click', next);
  }

  function show() {
    const step = STEPS[_idx];
    // If the step targets a tab, switch to it so the spotlight lands on live UI.
    try {
      if (step.sel.includes('data-tab="editor"') && typeof global.switchTab === 'function') global.switchTab('editor');
      if (step.sel.includes('data-tab="workflows"') && typeof global.switchTab === 'function') global.switchTab('workflows');
    } catch (_) {}
    renderCard();
    place(step);
  }

  function start(force) {
    if (typeof document === 'undefined') return false;
    if (!force && gated()) return false;
    buildDom();
    _idx = 0;
    _active = true;
    _root.style.display = 'block';
    show();
    return true;
  }

  function goTo(i) {
    if (!_active) return;
    _idx = Math.max(0, Math.min(STEPS.length - 1, i));
    show();
  }

  function next() {
    if (!_active) return;
    if (_idx >= STEPS.length - 1) { finish(); return; }
    goTo(_idx + 1);
  }
  function prev() { if (_active) goTo(_idx - 1); }

  function close() {
    _active = false;
    if (_root) _root.style.display = 'none';
  }
  function finish() { setGate(); close(); }   // completed the tour
  function dismiss() { setGate(); close(); }  // skipped — also don't nag again

  // Keep the spotlight glued to its target on resize/scroll while active.
  if (typeof global.addEventListener === 'function') {
    const reposition = () => { if (_active) place(STEPS[_idx]); };
    global.addEventListener('resize', reposition);
    global.addEventListener('scroll', reposition, true);
  }

  // Auto-start once, after the first-run mode picker (if any) is dismissed.
  function autoStart() {
    if (!shouldShow()) return;
    let tries = 0;
    const tick = () => {
      if (!shouldShow()) return;                 // gated in the meantime
      const picker = document.querySelector('.firstrun');
      if (picker && ++tries < 200) { setTimeout(tick, 150); return; } // wait it out
      if (!_active) start(false);
    };
    setTimeout(tick, 400);
  }

  if (typeof document !== 'undefined') {
    const boot = () => {
      autoStart();
      // Wire the "Take the tour" affordance in the cheat sheet, if present.
      const host = document.querySelector('#shortcuts-modal .modal-body');
      if (host && !document.getElementById('tour-replay')) {
        const b = document.createElement('button');
        b.id = 'tour-replay';
        b.type = 'button';
        b.textContent = '↪ Take the getting-started tour';
        b.style.cssText = 'margin-top:6px;background:#20242e;border:1px solid #2f3441;color:#e6e9ef;border-radius:8px;padding:8px 12px;cursor:pointer;font:13px system-ui';
        b.addEventListener('click', () => {
          document.getElementById('shortcuts-modal')?.classList.add('hidden');
          start(true);
        });
        host.insertBefore(b, host.firstChild);
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  const API = { KEY, STEPS, start, next, prev, goTo, finish, dismiss, shouldShow,
    isActive: () => _active, currentStep: () => _idx, _clearGate: clearGate };
  global.FFOnboarding = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
