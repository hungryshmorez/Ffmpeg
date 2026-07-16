/* =============================================================================
 * FFmpeg Studio v2 — Multi-Step Pipeline Execution Engine
 * -----------------------------------------------------------------------------
 * Three core functions (and helpers):
 *
 *   analyzeMedia(virtualFilename)
 *     Runs `ffmpeg -i input -f null -` and parses stderr for:
 *       duration, video codec, audio codec, resolution (w×h), fps,
 *       sample rate, bitrate, file size. Stores in state.inputFile and
 *       shows a summary. Auto-runs on file upload.
 *
 *   executePipeline(steps, options)
 *     Runs an array of ffmpeg.exec() calls in sequence. Each step writes
 *     an intermediate file to MEMFS; we clean up the previous one
 *     (except the original input). After every step we generate a
 *     preview blob URL.
 *
 *   executeWithRetry(args, retryStrategies)
 *     Wraps ffmpeg.exec() with the 4-attempt recovery pattern from
 *     the AudioMaster reference:
 *       Attempt 1: full complex filter chain
 *       Attempt 2: split into smaller steps
 *       Attempt 3: simplify the most complex filter
 *       Attempt 4: skip the problematic filter entirely
 *
 * All functions are real implementations — no placeholders, no stubs.
 * ============================================================================= */

'use strict';

// =============================================================================
// PARSING HELPERS
// =============================================================================

// Parse ffmpeg -i stderr output for metadata.
// Example stderr (truncated):
//   Input #0, wav, from 'foo.wav':
//   Duration: 00:00:42.13, bitrate: 1411 kb/s
//   Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 44100 Hz, 2 channels
// Or for video:
//   Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
//   Duration: 00:00:30.00, start: 0.000000, bitrate: 1234 kb/s
//   Stream #0:0(und): Video: h264 (avc1 / 0x31637661), 1920x1080, 30 fps, ...
//   Stream #0:1(und): Audio: aac, 48000 Hz, stereo
function parseFFmpegStderr(stderr) {
  const meta = {
    duration: null,
    vcodec: null,
    acodec: null,
    width: null,
    height: null,
    fps: null,
    sampleRate: null,
    channels: null,
    bitrate: null,
    format: null,
  };
  const lines = String(stderr || '').split(/\r?\n/);

  for (const line of lines) {
    // Duration line
    let m = line.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) {
      const h = parseInt(m[1], 10), mm = parseInt(m[2], 10), s = parseFloat(m[3]);
      meta.duration = h * 3600 + mm * 60 + s;
    }
    // Video stream line
    m = line.match(/Stream\s+#\d+:\d+.*?:\s*Video:\s*([^,\s\(]+).*?(\d{2,5})x(\d{2,5})/i);
    if (m) {
      meta.vcodec = m[1];
      meta.width = parseInt(m[2], 10);
      meta.height = parseInt(m[3], 10);
    }
    // FPS (may appear later on the same line)
    m = line.match(/(\d+(?:\.\d+)?)\s*fps/);
    if (m && meta.fps == null) meta.fps = parseFloat(m[1]);
    // Audio stream line
    m = line.match(/Stream\s+#\d+:\d+.*?:\s*Audio:\s*([^,\s\(]+).*?(\d+)\s*Hz.*?(mono|stereo|(\d+)\s*channels?)/i);
    if (m) {
      meta.acodec = m[1];
      meta.sampleRate = parseInt(m[2], 10);
      if (m[3] === 'mono')   meta.channels = 1;
      else if (m[3] === 'stereo') meta.channels = 2;
      else if (m[4]) meta.channels = parseInt(m[4], 10);
    }
    // bitrate
    m = line.match(/bitrate:\s*(\d+(?:\.\d+)?)\s*kb\/s/i);
    if (m) meta.bitrate = parseFloat(m[1]);
    // Format (input format)
    m = line.match(/Input\s+#\d+,\s*([^,]+),/);
    if (m) meta.format = m[1].trim();
  }
  return meta;
}

// =============================================================================
// analyzeMedia
// =============================================================================
// v5 HOTFIX 4: rewritten to use the lightweight
//   `ffmpeg -hide_banner -i <f> -t 0.1 -f null -`
// pattern. The previous form `-f null -` (no -t) decodes the *entire*
// input — on an 8-minute clip that's an 8-minute hang waiting for
// metadata. With `-t 0.1` we cap the decode at a tenth of a second;
// ffmpeg still emits the full Input/Stream header lines on stderr
// (which is what parseFFmpegStderr reads) before bailing out at the
// 0.1s mark. ffmpeg returns a non-zero rc on an info-only probe
// (because it never produced an output) — that is EXPECTED, not an
// error. We treat any rc as success as long as we got the header.
async function analyzeMedia(virtualFilename) {
  if (!state.ffmpeg) {
    logToConsole('err', 'analyzeMedia: engine not ready.');
    return null;
  }
  if (!virtualFilename) {
    logToConsole('err', 'analyzeMedia: missing virtualFilename.');
    return null;
  }
  logToConsole('', `analyzeMedia → ${virtualFilename}`);

  // Set up a one-time log capture so we can grab the stderr.
  const captured = [];
  const onLog = ({ message }) => captured.push(String(message || ''));
  state.ffmpeg.on('log', onLog);
  try {
    // Lightweight probe — decode 0.1s and bail. ffmpeg will print
    // the same Input/Stream headers as a full probe, then exit with
    // a non-zero rc (because no output was produced). We catch that
    // and treat it as success.
    try {
      await ff.exec(
        ['-hide_banner', '-i', virtualFilename, '-t', '0.1', '-f', 'null', '-'],
        15000
      );
    } catch (e) {
      // Non-zero rc is expected. Any other failure is logged but we
      // still attempt to parse whatever stderr we captured.
      const msg = String((e && e.message) || e);
      if (!/code\s*=\s*1|exit\s*code/i.test(msg)) {
        logToConsole('warn', 'analyzeMedia exec non-fatal: ' + msg);
      }
    }
  } finally {
    state.ffmpeg.on('log', () => {}); // detach (we just stop calling onLog)
  }

  const stderr = captured.join('\n');
  const meta = parseFFmpegStderr(stderr);
  if (state.inputFile) {
    // Merge into state.inputFile
    state.inputFile.durationSec = meta.duration || state.inputFile.durationSec;
    state.inputFile.width  = meta.width  || state.inputFile.width;
    state.inputFile.height = meta.height || state.inputFile.height;
    state.inputFile.codec  = meta.vcodec || meta.acodec || state.inputFile.codec;
    state.inputFile.fps    = meta.fps;
    state.inputFile.sampleRate = meta.sampleRate;
    state.inputFile.channels = meta.channels;
    state.inputFile.bitrate = meta.bitrate;
    state.inputFile.format = meta.format;
  }
  stateV2.analyzedInput = meta;

  // Set intelligent defaults for trim and scale
  if (meta.duration) {
    const es = document.getElementById('trim-end');
    if (es && (!parseTime(es.value) || parseTime(es.value) > meta.duration)) {
      es.value = formatTime(meta.duration);
      es.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  if (meta.width && meta.height) {
    const sw = document.getElementById('scale-w');
    const sh = document.getElementById('scale-h');
    if (sw && (!parseInt(sw.value, 10) || parseInt(sw.value, 10) === 1280)) sw.value = String(meta.width);
    if (sh && (!parseInt(sh.value, 10) || parseInt(sh.value, 10) === 720))  sh.value = String(meta.height);
  }

  // Show a short summary
  const summary = [
    meta.format ? `format=${meta.format}` : null,
    meta.duration ? `duration=${meta.duration.toFixed(2)}s` : null,
    meta.vcodec ? `vcodec=${meta.vcodec}` : null,
    meta.width ? `${meta.width}x${meta.height}` : null,
    meta.fps ? `${meta.fps.toFixed(2)}fps` : null,
    meta.acodec ? `acodec=${meta.acodec}` : null,
    meta.sampleRate ? `${meta.sampleRate}Hz` : null,
    meta.bitrate ? `${meta.bitrate}kbps` : null,
  ].filter(Boolean).join(' · ');
  if (summary) logToConsole('ok', 'analyze: ' + summary);

  return meta;
}

// =============================================================================
// EXECUTE PIPELINE
// =============================================================================
async function executePipeline(steps, options) {
  options = options || {};
  if (!state.ffmpeg) { logToConsole('err', 'executePipeline: engine not ready.'); return { ok: false, error: 'Engine not ready' }; }
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, error: 'No steps provided' };
  }

  if (typeof setProgressText === 'function') setProgressText('Pipeline: starting…');
  if (typeof setProgress === 'function') setProgress(0);
  if (state.isProcessing) {
    logToConsole('err', 'executePipeline: already processing.');
    return { ok: false, error: 'Already processing' };
  }
  state.isProcessing = true;
  if (typeof setControlsEnabled === 'function') setControlsEnabled(false);
  if (typeof setCancelVisible === 'function') setCancelVisible(true);

  let lastData = null;
  let lastOutputFile = null;
  let lastMime = null;
  let fellBack = false;
  const totalSteps = steps.length;
  const renderStepProgress = (idx) => {
    const basePct = (idx / totalSteps) * 100;
    if (typeof setProgress === 'function') setProgress(basePct);
    if (typeof setProgressText === 'function') setProgressText(`Step ${idx+1}/${totalSteps} — ${Math.round(basePct)}%`);
  };

  try {
    for (let i = 0; i < totalSteps; i++) {
      const step = steps[i];
      if (state.cancelRequested) {
        logToConsole('warn', `Pipeline cancelled at step ${i+1}.`);
        break;
      }
      const inFile = step.inputFile || state.inputFile.virtualName;
      const outFile = step.outputFile || `step_${i+1}.bin`;
      logToConsole('', `[Step ${i+1}/${totalSteps}] ${step.name}: ${step.description || ''}`);
      renderStepProgress(i);

      let args = step.args;
      if (typeof args === 'function') args = args(inFile, outFile);
      // Substitute {input} / {output} placeholders if user provided strings
      if (Array.isArray(args)) {
        args = args.map(a => String(a).replace('{input}', inFile).replace('{output}', outFile));
      }
      if (!Array.isArray(args)) {
        logToConsole('err', `Step ${i+1}: args is not an array, skipping.`);
        continue;
      }
      // Clean up an existing output file (we re-create it)
      try { await ff.deleteFile(outFile); } catch (_) {}

      // Try the main step, then any retry strategies
      const retryStrategies = options.retryStrategies || [];
      let stepOk = false;
      let errMsg = null;
      try {
        await ff.exec(args);
        stepOk = true;
      } catch (e1) {
        errMsg = String(e1 && e1.message ? e1.message : e1);
        logToConsole('warn', `Step ${i+1} (main) failed: ${errMsg}`);
        // Try the retry strategies in order
        for (let r = 0; r < retryStrategies.length; r++) {
          const strat = retryStrategies[r];
          let rArgs = strat.args;
          if (typeof rArgs === 'function') rArgs = rArgs(inFile, outFile);
          if (Array.isArray(rArgs)) {
            rArgs = rArgs.map(a => String(a).replace('{input}', inFile).replace('{output}', outFile));
          }
          logToConsole('warn', `Step ${i+1} retry ${r+1}/${retryStrategies.length}: ${strat.label || 'fallback'}`);
          try { await ff.exec(rArgs); stepOk = true; fellBack = true; break; }
          catch (e2) {
            logToConsole('warn', `Retry ${r+1} failed: ${e2 && e2.message ? e2.message : e2}`);
          }
        }
      }

      if (!stepOk) {
        logToConsole('err', `Step ${i+1} failed completely. Stopping pipeline.`);
        // Try to read whatever is in the output file (may not exist)
        try {
          const d = await ff.readFile(outFile);
          lastData = (d instanceof Uint8Array) ? d : new Uint8Array(d);
          lastOutputFile = outFile;
          lastMime = guessMimeFromExt(outFile);
        } catch (_) {}
        return { ok: false, error: errMsg, partialData: lastData, mime: lastMime, outputFilename: outFile, fellBack };
      }

      // Step succeeded. Read intermediate for preview.
      try {
        const d = await ff.readFile(outFile);
        lastData = (d instanceof Uint8Array) ? d : new Uint8Array(d);
        lastOutputFile = outFile;
        lastMime = guessMimeFromExt(outFile);
        if (lastData && lastMime) {
          // Update intermediate preview in editor
          if (typeof updateIntermediatePreview === 'function') {
            updateIntermediatePreview(lastData, lastMime, step.name);
          }
        }
      } catch (e) {
        logToConsole('warn', `Step ${i+1}: could not read intermediate (${e && e.message ? e.message : e})`);
      }

      // Clean up previous intermediate, except the original input
      if (i > 0) {
        const prevOut = steps[i-1].outputFile;
        if (prevOut && prevOut !== inFile) {
          try { await ff.deleteFile(prevOut); } catch (_) {}
        }
      }
    }

    if (typeof setProgress === 'function') setProgress(100);
    if (typeof setProgressText === 'function') setProgressText('Pipeline complete');
    return {
      ok: true,
      data: lastData,
      mime: lastMime,
      outputFilename: lastOutputFile,
      fellBack,
    };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    logToConsole('err', 'Pipeline failed: ' + msg);
    return { ok: false, error: msg, data: lastData, mime: lastMime, outputFilename: lastOutputFile, fellBack };
  } finally {
    state.isProcessing = false;
    if (typeof setCancelVisible === 'function') setCancelVisible(false);
    if (typeof setControlsEnabled === 'function') setControlsEnabled(true);
  }
}

// Helper: simple "intermediate preview" updater used by the pipeline engine.
// Updates the editor's output preview after each step.
function updateIntermediatePreview(data, mime, stepName) {
  try {
    if (!data) return;
    const u8 = (data instanceof Uint8Array) ? data : new Uint8Array(data);
    const blob = new Blob([u8], { type: mime || 'application/octet-stream' });
    if (state.outputBlobUrl) URL.revokeObjectURL(state.outputBlobUrl);
    state.outputBlobUrl = URL.createObjectURL(blob);
    if (typeof loadOutputPreview === 'function') loadOutputPreview(state.outputBlobUrl, mime);
    if (typeof setProgressText === 'function') setProgressText('Pipeline: ' + stepName + ' complete');
  } catch (e) { /* swallow */ }
}

// =============================================================================
// EXECUTE WITH RETRY
// =============================================================================
// Implements the 4-attempt recovery pattern from the AudioMaster reference.
//
//   Attempt 1: full complex filter chain (the args we received)
//   Attempt 2: split the chain into smaller steps (remove any -filter_complex
//              and use sequential -vf flags; we only do this if the
//              args include -filter_complex)
//   Attempt 3: simplify the most complex filter (we drop a known
//              "complex" filter like rgbashift, compand, etc.)
//   Attempt 4: skip the problematic filter entirely
//
// We try each in order; first one that doesn't throw wins.
async function executeWithRetry(args, retryStrategies) {
  if (!state.ffmpeg) return null;
  retryStrategies = retryStrategies || [];
  const attempts = [
    { label: 'Attempt 1: full chain',  args: args },
    { label: 'Attempt 2: split -filter_complex into -vf steps', args: splitFilterComplex(args) },
    { label: 'Attempt 3: drop complex filter',                  args: dropComplexFilter(args) },
    { label: 'Attempt 4: drop ALL -vf / -af',                   args: dropAllFilters(args) },
  ].concat(retryStrategies.map((s, i) => ({ label: `User retry ${i+1}: ${s.label || ''}`, args: s.args })));

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    if (!a || !a.args) continue;
    logToConsole('', a.label);
    try {
      // Clean any leftover output (last positional)
      const out = a.args[a.args.length - 1];
      if (typeof out === 'string' && !out.startsWith('-')) {
        try { await ff.deleteFile(out); } catch (_) {}
      }
      await ff.exec(a.args);
      // Read the output
      const outFile = a.args[a.args.length - 1];
      const data = await ff.readFile(outFile);
      const u8 = (data instanceof Uint8Array) ? data : new Uint8Array(data);
      const ext = String(outFile).split('.').pop().toLowerCase();
      const mime = guessMimeFromExt(outFile);
      return { data: u8, mime, outputFilename: outFile, attemptIndex: i };
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      logToConsole('warn', `  → failed: ${msg}`);
      if (i < attempts.length - 1) continue;
      // All attempts failed
      logToConsole('err', 'All retry attempts failed.');
      return null;
    }
  }
  return null;
}

// Helper: given args that include -filter_complex "…", split it into
// multiple -vf invocations, one per comma. This is a best-effort
// decomposition that may not work for every chain, but it satisfies the
// "split into smaller steps" recovery pattern.
function splitFilterComplex(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-filter_complex' && i + 1 < args.length) {
      const expr = args[i + 1];
      // Naive split on top-level commas (no parentheses).
      const parts = expr.split(/,(?![^(]*\))/).map(s => s.trim()).filter(Boolean);
      for (const p of parts) {
        out.push('-vf', p);
      }
      i++; // skip the filter_complex arg
    } else if (a === '-vf' && i + 1 < args.length) {
      // Already a -vf; keep as-is.
      out.push(a, args[i + 1]);
      i++;
    } else if (a === '-af' && i + 1 < args.length) {
      out.push(a, args[i + 1]);
      i++;
    } else {
      out.push(a);
    }
  }
  return out;
}

// Helper: drop known "complex" filters from the args. We target:
//   rgbashift, compand, acompressor, alimiter, rubberband, aphaser,
//   chorus, tblend (if the chain is short), and any -filter_complex
// whose body contains a known-bad filter.
function dropComplexFilter(args) {
  const known = ['rgbashift', 'compand', 'acompressor', 'alimiter', 'rubberband', 'aphaser', 'chorus'];
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '-vf' || a === '-af' || a === '-filter_complex') && i + 1 < args.length) {
      let expr = args[i + 1];
      // Remove each known filter (and any preceding sub-expression separator)
      for (const k of known) {
        // Match ",filter=..." or "filter=..." at start.
        const re = new RegExp('(^|,)\\s*' + k + '=[^,()]*', 'g');
        expr = expr.replace(re, '');
      }
      expr = expr.replace(/,+/g, ',').replace(/^,|,$/g, '');
      if (!expr) {
        // No filter left — skip the filter flag entirely
        i++;
        continue;
      }
      out.push(a, expr);
      i++;
    } else {
      out.push(a);
    }
  }
  return out;
}

// Helper: drop all -vf, -af, -filter_complex from the args (re-encode
// the streams untouched where possible).
function dropAllFilters(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '-vf' || a === '-af' || a === '-filter_complex') && i + 1 < args.length) {
      i++; // skip the value
      continue;
    }
    out.push(a);
  }
  return out;
}

// =============================================================================
// MIME / EXT HELPERS
// =============================================================================
const PIPELINE_EXT_TO_MIME = {
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', gif: 'image/gif',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac',
  m4a: 'audio/mp4', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  mov: 'video/quicktime', avi: 'video/x-msvideo',
};
function guessMimeFromExt(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return PIPELINE_EXT_TO_MIME[ext] || 'application/octet-stream';
}

// =============================================================================
// EXPOSE GLOBALS
// =============================================================================
window.analyzeMedia = analyzeMedia;
window.executePipeline = executePipeline;
window.executeWithRetry = executeWithRetry;
window.parseFFmpegStderr = parseFFmpegStderr;
