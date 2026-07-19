// =============================================================================
// segment-encode.js  —  #21 Parallel segment encoding
// =============================================================================
// Splits a long render into independent time SEGMENTS, encodes them through a
// bounded-concurrency pool, then concatenates the pieces with a stream copy.
// Three wins: each segment is short so the wasm heap stays small (long renders
// stop OOM-ing), progress is per-segment, and — given more than one FFmpeg
// instance to hand the pool — segments encode genuinely in parallel.
//
// The planner, the arg rewriting, the concat list and the concurrency pool are
// all pure and injectable (they take an `exec`/`writeFile` interface), so they
// verify deterministically with a fake encoder AND drive the real ffmpeg.wasm
// for an end-to-end split → encode → concat.
// =============================================================================

(function (global) {
  'use strict';

  // Split [0, duration) into segments. opts: { segments:N } or { segmentSec:S }.
  // Returns [{ index, ss, t }] covering the whole duration with no gaps/overlaps.
  function planSegments(duration, opts) {
    const d = +duration;
    if (!(d > 0)) return [];
    let segLen;
    if (opts && opts.segmentSec > 0) segLen = +opts.segmentSec;
    else { const n = Math.max(1, (opts && opts.segments) | 0 || 1); segLen = d / n; }
    const out = [];
    let ss = 0, i = 0;
    // guard against fp drift accumulating a sliver segment at the end
    while (ss < d - 1e-6) {
      const t = Math.min(segLen, d - ss);
      out.push({ index: i++, ss: +ss.toFixed(6), t: +t.toFixed(6) });
      ss += segLen;
    }
    return out;
  }

  // Rewrite a single-shot arg array into args for ONE segment: fast input-seek
  // to `ss`, limit to `t`, write to `segOut`. Any existing -ss/-t/-to is dropped.
  function segmentArgs(baseArgs, seg, segOut) {
    const iIdx = baseArgs.indexOf('-i');
    if (iIdx < 0) throw new Error('segmentArgs: no -i in baseArgs');
    const inputName = baseArgs[iIdx + 1];
    const stripTimes = (arr) => {
      const o = [];
      for (let i = 0; i < arr.length; i++) {
        const t = arr[i];
        if (t === '-ss' || t === '-t' || t === '-to') { i++; continue; }  // drop token + value
        if (t === '-y') continue;
        o.push(t);
      }
      return o;
    };
    const inputOpts = stripTimes(baseArgs.slice(0, iIdx));
    const outOpts = stripTimes(baseArgs.slice(iIdx + 2, baseArgs.length - 1));  // minus filename
    return [
      ...inputOpts,
      '-ss', String(seg.ss), '-i', inputName,   // input seek (keyframe-independent under re-encode)
      '-t', String(seg.t),
      ...outOpts,
      '-y', segOut,
    ];
  }

  // ffconcat demuxer list. Names are single-quoted with quotes escaped.
  function concatList(files) {
    return files.map((f) => `file '${String(f).replace(/'/g, "'\\''")}'`).join('\n') + '\n';
  }

  // Bounded-concurrency pool. Runs `worker(item, i)` over items, at most
  // `concurrency` in flight, returns results in item order. Fails fast.
  function runPool(items, worker, concurrency) {
    const n = items.length;
    const results = new Array(n);
    const limit = Math.max(1, concurrency | 0);
    let idx = 0, active = 0, done = 0, settled = false;
    return new Promise((resolve, reject) => {
      if (n === 0) return resolve(results);
      const pump = () => {
        while (!settled && active < limit && idx < n) {
          const i = idx++; active++;
          Promise.resolve().then(() => worker(items[i], i)).then((r) => {
            results[i] = r; active--; done++;
            if (done === n) { if (!settled) { settled = true; resolve(results); } }
            else pump();
          }, (e) => { if (!settled) { settled = true; reject(e); } });
        }
      };
      pump();
    });
  }

  // Orchestrate: plan → encode each segment through the pool → concat copy.
  // io = { exec, writeFile, deleteFile } (deleteFile optional). exec(args)→Promise.
  // Returns { out, segFiles, plan }.
  async function encodeSegments(io, baseArgs, out, opts) {
    opts = opts || {};
    const plan = planSegments(opts.duration, opts);
    if (!plan.length) throw new Error('encodeSegments: bad duration');
    const ext = opts.segmentExt || 'mp4';
    const concurrency = opts.concurrency || 1;
    let done = 0;

    const worker = async (seg) => {
      const segOut = `__seg_${seg.index}.${ext}`;
      // A per-segment exec lets a caller hand each worker its OWN ffmpeg instance
      // for true parallelism; default is the shared io.exec.
      const exec = (opts.execFor && opts.execFor(seg.index)) || io.exec;
      await exec(segmentArgs(baseArgs, seg, segOut));
      done++;
      if (opts.onProgress) try { opts.onProgress(done, plan.length); } catch (_) {}
      return segOut;
    };

    const segFiles = await runPool(plan, worker, concurrency);

    // concat the pieces with a stream copy
    const listName = '__segments.txt';
    await io.writeFile(listName, new TextEncoder().encode(concatList(segFiles)));
    await io.exec(['-f', 'concat', '-safe', '0', '-i', listName, '-c', 'copy', '-y', out]);

    // best-effort cleanup
    if (io.deleteFile) { for (const f of segFiles.concat([listName])) { try { await io.deleteFile(f); } catch (_) {} } }
    return { out, segFiles, plan };
  }

  const API = { planSegments, segmentArgs, concatList, runPool, encodeSegments };
  global.FFSegment = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
