/* =============================================================================
   opfs.js — ORIGIN PRIVATE FILE SYSTEM (persistent media bin)
   -----------------------------------------------------------------------------
   Until now, a page reload destroyed the media bin. Re-upload your 500 MB file
   because you fumbled a refresh.

   OPFS is a real, persistent, high-performance filesystem in the browser. Files
   survive reloads, survive crashes, and — critically — can be STREAMED into
   ffmpeg instead of being held entirely in the wasm heap, which is what will
   otherwise OOM you on anything past ~1 GB.

   Quota is typically a large fraction of free disk, not the 5 MB localStorage
   cap. It is the correct place for media.
   ========================================================================== */

(function () {
  'use strict';

  const DIR = 'media';
  const MANIFEST = '_manifest.json';
  let root = null, dir = null, available = false;

  async function init() {
    if (!navigator.storage?.getDirectory) {
      window.logToConsole?.('warn', '[opfs] Not supported — the media bin will not survive a reload.');
      return false;
    }
    try {
      root = await navigator.storage.getDirectory();
      dir  = await root.getDirectoryHandle(DIR, { create: true });
      available = true;

      // Ask the browser to make this storage persistent (not evictable under pressure).
      if (navigator.storage.persist) {
        const granted = await navigator.storage.persisted() || await navigator.storage.persist();
        window.logToConsole?.('', `[opfs] persistent storage: ${granted ? 'granted' : 'best-effort'}`);
      }

      const est = await navigator.storage.estimate?.();
      if (est) {
        window.logToConsole?.('ok',
          `[opfs] ready — ${fmt(est.usage)} used of ${fmt(est.quota)} available.`);
      }
      return true;
    } catch (e) {
      window.logToConsole?.('warn', `[opfs] init failed: ${e.message}`);
      return false;
    }
  }

  const fmt = (b) => {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return `${(b / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
  };

  // ---------------------------------------------------------------------------
  // FILE I/O
  // ---------------------------------------------------------------------------

  async function save(name, blobOrFile) {
    if (!available) return false;
    try {
      const fh = await dir.getFileHandle(name, { create: true });
      const w  = await fh.createWritable();
      await w.write(blobOrFile);
      await w.close();
      return true;
    } catch (e) {
      window.logToConsole?.('warn', `[opfs] save "${name}" failed: ${e.message}`);
      return false;
    }
  }

  async function load(name) {
    if (!available) return null;
    try {
      const fh = await dir.getFileHandle(name);
      return await fh.getFile();          // a real File object
    } catch (_) { return null; }
  }

  async function remove(name) {
    if (!available) return;
    try { await dir.removeEntry(name); } catch (_) {}
  }

  async function list() {
    if (!available) return [];
    const out = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file' || name === MANIFEST) continue;
      const f = await h.getFile();
      out.push({ name, size: f.size, lastModified: f.lastModified });
    }
    return out;
  }

  async function usage() {
    const est = await navigator.storage?.estimate?.();
    return est ? { used: est.usage, quota: est.quota, pct: est.usage / est.quota } : null;
  }

  async function clear() {
    if (!available) return;
    for (const { name } of await list()) await remove(name);
    await remove(MANIFEST);
    window.logToConsole?.('ok', '[opfs] cleared.');
  }

  // ---------------------------------------------------------------------------
  // MEDIA BIN PERSISTENCE
  // ---------------------------------------------------------------------------

  /** Persist a bin item's bytes + a manifest entry. Called on every upload. */
  async function persistMedia(media) {
    if (!available || !media?.file) return;
    const key = `${media.id}__${media.name}`;
    const ok = await save(key, media.file);
    if (!ok) return;

    const man = await readManifest();
    man[media.id] = {
      key,
      name: media.name, size: media.size, type: media.type, mime: media.mime,
      durationSec: media.durationSec, width: media.width, height: media.height,
      virtualName: media.virtualName,
      isOutput: !!media.isOutput,
      savedAt: Date.now(),
    };
    await writeManifest(man);
  }

  async function forgetMedia(id) {
    if (!available) return;
    const man = await readManifest();
    if (man[id]) { await remove(man[id].key); delete man[id]; await writeManifest(man); }
  }

  async function readManifest() {
    const f = await load(MANIFEST);
    if (!f) return {};
    try { return JSON.parse(await f.text()); } catch (_) { return {}; }
  }

  async function writeManifest(m) {
    await save(MANIFEST, new Blob([JSON.stringify(m)], { type: 'application/json' }));
  }

  /**
   * Rehydrate the media bin from OPFS on page load.
   * This is the payoff: the bin survives a refresh.
   */
  async function restoreBin() {
    if (!available) return 0;
    const man = await readManifest();
    const ids = Object.keys(man);
    if (!ids.length) return 0;

    let n = 0;
    for (const id of ids) {
      const e = man[id];
      const file = await load(e.key);
      if (!file) { delete man[id]; continue; }

      // Re-wrap as a File with the original name, then hand it to the app's
      // normal upload path so MEMFS, thumbnails and metadata all come back.
      const f = new File([file], e.name, { type: e.mime || file.type });
      try {
        await window.handleFilesUpload?.([f], { fromOPFS: true });
        n++;
      } catch (err) {
        window.logToConsole?.('warn', `[opfs] restore "${e.name}" failed: ${err.message}`);
      }
    }
    await writeManifest(man);

    if (n) {
      window.logToConsole?.('ok', `[opfs] restored ${n} file(s) from persistent storage.`);
      showRestoredChip(n);
    }
    return n;
  }

  function showRestoredChip(n) {
    const el = document.getElementById('opfs-chip');
    if (!el) return;
    el.hidden = false;
    el.textContent = `💾 ${n} file${n === 1 ? '' : 's'} restored`;
    setTimeout(() => { el.hidden = true; }, 6000);
  }

  window.FFOPFS = {
    init, available: () => available,
    save, load, remove, list, usage, clear,
    persistMedia, forgetMedia, restoreBin, readManifest,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else init();
})();
