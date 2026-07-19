// =============================================================================
// opfs-stream.js  —  OPFS block streaming (Phase 1.3, behind FFAccel)
// =============================================================================
// opfs.js persists media to OPFS, but the app still reads a file back the
// RAM-heavy way: `new Uint8Array(await file.arrayBuffer())` materialises the
// whole thing in the JS heap on top of the MEMFS copy (the F1 double-residency
// that OOMs the tab on large files).
//
// This streams instead. Writing pipes a source into OPFS in fixed BLOCKS —
// never holding more than one block. Reading hands the consumer one block at a
// time (a callback or a ReadableStream), so a demuxer / WebCodecs / MEMFS
// loader can process the file without the whole thing ever being resident.
//
// It routes through FFAccel: where OPFS is unavailable it silently falls back
// to an in-memory store so every call still works (functional, if not
// memory-saving) — the "no workflow ever goes down" guarantee.
// =============================================================================

(function (global) {
  'use strict';

  const DIR = 'stream';
  const DEFAULT_CHUNK = 4 * 1024 * 1024;   // 4 MB blocks
  let dirHandle = null, ready = null;
  const memStore = new Map();              // fallback: name -> Uint8Array

  function opfsAvailable() { try { return !!(global.navigator && navigator.storage && navigator.storage.getDirectory); } catch (_) { return false; } }

  async function _dir() {
    if (dirHandle) return dirHandle;
    if (!ready) ready = (async () => {
      const root = await navigator.storage.getDirectory();
      dirHandle = await root.getDirectoryHandle(DIR, { create: true });
      return dirHandle;
    })();
    return ready;
  }

  // Normalise any source into an async iterator of Uint8Array BLOCKS of at most
  // `chunk` bytes — without ever holding the whole thing (for Blob/stream).
  async function* _blocks(source, chunk) {
    if (source == null) return;
    if (typeof source.getReader === 'function') {          // ReadableStream
      const rd = source.getReader();
      for (;;) { const { value, done } = await rd.read(); if (done) break; if (value && value.length) yield value.subarray ? value : new Uint8Array(value); }
      return;
    }
    if (typeof Blob !== 'undefined' && source instanceof Blob) {   // Blob / File
      for (let o = 0; o < source.size; o += chunk) yield new Uint8Array(await source.slice(o, Math.min(source.size, o + chunk)).arrayBuffer());
      return;
    }
    const u8 = source instanceof Uint8Array ? source : new Uint8Array(source);   // ArrayBuffer / TypedArray
    for (let o = 0; o < u8.length; o += chunk) yield u8.subarray(o, Math.min(u8.length, o + chunk));
  }

  // ---- write a source into OPFS, block by block ------------------------------
  function writeStream(name, source, opts) {
    opts = opts || {};
    const chunk = opts.chunkSize || DEFAULT_CHUNK;
    const onProgress = opts.onProgress;
    return runAccel('opfs.writeStream',
      async () => {                                        // accelerated: real OPFS
        const d = await _dir();
        const fh = await d.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        let bytes = 0;
        try {
          for await (const block of _blocks(source, chunk)) { await w.write(block); bytes += block.length; if (onProgress) onProgress(bytes); }
        } finally { await w.close(); }
        return { bytes, opfs: true };
      },
      async () => {                                        // fallback: in-memory
        const parts = []; let bytes = 0;
        for await (const block of _blocks(source, chunk)) { parts.push(block.slice()); bytes += block.length; if (onProgress) onProgress(bytes); }
        const all = new Uint8Array(bytes); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
        memStore.set(name, all);
        return { bytes, opfs: false };
      });
  }

  async function size(name) {
    if (opfsAvailable()) { try { const d = await _dir(); const fh = await d.getFileHandle(name); return (await fh.getFile()).size; } catch (_) {} }
    const m = memStore.get(name); return m ? m.length : 0;
  }

  // ---- read back block by block (never the whole file at once) ----------------
  function readChunks(name, onChunk, opts) {
    opts = opts || {};
    const chunk = opts.chunkSize || DEFAULT_CHUNK;
    return runAccel('opfs.readChunks',
      async () => {
        const d = await _dir();
        const fh = await d.getFileHandle(name);
        const file = await fh.getFile();
        for (let o = 0; o < file.size; o += chunk) {
          const block = new Uint8Array(await file.slice(o, Math.min(file.size, o + chunk)).arrayBuffer());
          await onChunk(block, o);                         // block released after each call
        }
        return { size: file.size, opfs: true };
      },
      async () => {
        const all = memStore.get(name); if (!all) throw new Error(`opfs-stream: no such entry "${name}"`);
        for (let o = 0; o < all.length; o += chunk) await onChunk(all.subarray(o, Math.min(all.length, o + chunk)), o);
        return { size: all.length, opfs: false };
      });
  }

  // A ReadableStream out — the natural input for a demuxer / WebCodecs pipeline.
  function readable(name, opts) {
    let closed = false;
    return new ReadableStream({
      async start(controller) {
        try { await readChunks(name, (block) => controller.enqueue(block.slice()), opts); }
        catch (e) { controller.error(e); return; }
        if (!closed) controller.close();
      },
      cancel() { closed = true; },
    });
  }

  // The concrete win: stream OPFS → MEMFS filling ONE destination buffer, so we
  // never hold a second full copy (the F1 arrayBuffer double). ffmpeg still
  // needs the file whole in MEMFS, but the JS-heap peak drops to a single alloc.
  async function toMemfs(ff, name, memfsName, opts) {
    const total = await size(name);
    const dest = new Uint8Array(total);
    await readChunks(name, (block, o) => { dest.set(block, o); }, opts);
    await ff.writeFile(memfsName, dest);
    return { bytes: total };
  }

  async function remove(name) {
    memStore.delete(name);
    if (opfsAvailable()) { try { const d = await _dir(); await d.removeEntry(name); } catch (_) {} }
  }

  // route through FFAccel when present; else pick directly on OPFS availability.
  function runAccel(name, accelerated, fallback) {
    if (global.FFAccel && typeof global.FFAccel.route === 'function') {
      return global.FFAccel.route({ name, need: 'opfs', accelerated, fallback });
    }
    return opfsAvailable() ? accelerated().catch(() => fallback()) : fallback();
  }

  const API = { writeStream, readChunks, readable, toMemfs, size, remove, available: opfsAvailable, DEFAULT_CHUNK, _memStore: memStore };
  global.FFOpfsStream = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
