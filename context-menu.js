// =============================================================================
// context-menu.js  —  right-click / keyboard context menus (UX redesign)
// =============================================================================
// Core tasks in the bin and the workflow grid took a hunt-and-click across
// small on-card buttons. A context menu puts every action for a card one
// right-click (or one Shift+F10 / ContextMenu keypress) away, cutting mouse
// travel. One reusable, accessible menu (role=menu, arrow-key navigation,
// Escape / click-outside to close) drives every surface.
//
//   FFContextMenu.attach(container, {
//     itemSelector,                 // cards that own a menu
//     items(target) -> [ {label, icon?, action(target), disabled?} | {separator:true} ]
//   })
// =============================================================================

(function (global) {
  'use strict';

  let menuEl = null, openForTarget = null, lastFocus = null;

  function ensureMenu() {
    if (menuEl) return menuEl;
    menuEl = document.createElement('div');
    menuEl.id = 'ff-context-menu';
    menuEl.className = 'ff-context-menu';
    menuEl.setAttribute('role', 'menu');
    menuEl.hidden = true;
    document.body.appendChild(menuEl);
    // dismissal
    document.addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.hidden && !menuEl.contains(e.target)) close(); }, true);
    document.addEventListener('keydown', (e) => { if (menuEl && !menuEl.hidden && e.key === 'Escape') { e.stopPropagation(); close(true); } }, true);
    global.addEventListener('resize', () => close());
    global.addEventListener('scroll', () => close(), true);
    return menuEl;
  }

  function close(restoreFocus) {
    if (!menuEl) return;
    menuEl.hidden = true;
    menuEl.innerHTML = '';
    openForTarget = null;
    if (restoreFocus && lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (_) {} }
  }

  function itemsOf(menu) { return Array.from(menu.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')); }
  function focusItem(menu, i) {
    const its = itemsOf(menu); if (!its.length) return;
    i = (i + its.length) % its.length;
    its.forEach((el, j) => { el.tabIndex = j === i ? 0 : -1; });
    its[i].focus();
  }

  function open(defs, x, y, target) {
    const menu = ensureMenu();
    lastFocus = document.activeElement;
    openForTarget = target;
    menu.innerHTML = '';
    (defs || []).forEach((d) => {
      if (d.separator) { const s = document.createElement('div'); s.className = 'ctx-sep'; s.setAttribute('role', 'separator'); menu.appendChild(s); return; }
      const it = document.createElement('button');
      it.type = 'button';
      it.className = 'ctx-item';
      it.setAttribute('role', 'menuitem');
      it.tabIndex = -1;
      if (d.disabled) it.setAttribute('aria-disabled', 'true');
      it.innerHTML = `${d.icon ? `<span class="ctx-icon" aria-hidden="true">${d.icon}</span>` : ''}<span class="ctx-label">${d.label}</span>`;
      it.addEventListener('click', () => { if (!d.disabled && d.action) { const t = openForTarget; close(true); try { d.action(t); } catch (_) {} } });
      menu.appendChild(it);
    });

    menu.hidden = false;
    // position, keeping the menu on-screen
    const r = menu.getBoundingClientRect();
    const vw = global.innerWidth, vh = global.innerHeight;
    let left = x, top = y;
    if (left + r.width > vw - 6) left = Math.max(6, vw - r.width - 6);
    if (top + r.height > vh - 6) top = Math.max(6, vh - r.height - 6);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    // roving-tabindex keyboard nav within the menu
    if (!menu.__navBound) {
      menu.__navBound = true;
      menu.addEventListener('keydown', (e) => {
        const its = itemsOf(menu);
        const cur = its.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(menu, cur + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(menu, cur - 1); }
        else if (e.key === 'Home') { e.preventDefault(); focusItem(menu, 0); }
        else if (e.key === 'End') { e.preventDefault(); focusItem(menu, its.length - 1); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.activeElement.click(); }
      });
    }
    focusItem(menu, 0);
    return menu;
  }

  function attach(container, opts) {
    if (!container || typeof document === 'undefined' || !opts || !opts.itemSelector) return;
    if (container.__ctxBound) return;
    container.__ctxBound = true;
    const build = (target) => (typeof opts.items === 'function' ? opts.items(target) : []) || [];

    container.addEventListener('contextmenu', (e) => {
      const target = e.target.closest(opts.itemSelector);
      if (!target || !container.contains(target)) return;
      const defs = build(target);
      if (!defs.length) return;
      e.preventDefault();
      open(defs, e.clientX, e.clientY, target);
    });

    // Keyboard: the ContextMenu key or Shift+F10 opens the menu at the focused
    // card (WAI pattern) so it's reachable without a mouse.
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
      const target = (document.activeElement && document.activeElement.closest)
        ? document.activeElement.closest(opts.itemSelector) : null;
      if (!target || !container.contains(target)) return;
      const defs = build(target);
      if (!defs.length) return;
      e.preventDefault();
      const r = target.getBoundingClientRect();
      open(defs, r.left + 12, r.top + 12, target);
    });
  }

  const API = { attach, open, close, ensureMenu, isOpen: () => !!(menuEl && !menuEl.hidden) };
  global.FFContextMenu = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
