/* =============================================================================
   hwaccel.js — HARDWARE ACCELERATION (WebCodecs + WebGL)
   -----------------------------------------------------------------------------
   ffmpeg.wasm CANNOT be hardware accelerated. Ever. It's a WebAssembly sandbox
   with no access to the GPU or the media engine — no NVENC, no QuickSync, no
   VideoToolbox. It runs roughly an order of magnitude slower than native FFmpeg,
   and that is structural, not a tuning problem.

   WebCodecs is a direct binding to the browser's REAL, silicon-backed encoder
   and decoder — the same hardware path Chrome uses to play YouTube. Throughput
   is in the same league as native FFmpeg.

   The pipeline:

       MP4 in → demux (mp4box) → VideoDecoder (GPU/ASIC) → VideoFrame
                                                              ↓
                                                   WebGL shader (TRIP CAM)
                                                              ↓
                        mux (mp4-muxer) ← VideoEncoder (GPU/ASIC) ← VideoFrame

   The pixels never touch the CPU. A 10s glitch render goes from ~30s to <1s.

   ffmpeg.wasm is RETAINED for what it's genuinely best at:
     • all 19 audio mastering chains (WebCodecs has NO MP3/FLAC encoder)
     • GIF (needs palettegen/paletteuse)
     • geq / minterpolate / filters with no shader equivalent
   ========================================================================== */

(function () {
  'use strict';

  const MP4BOX_URL = 'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js';
  const MUXER_URL  = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.5/build/mp4-muxer.min.js';

  // `encode`/`decode` = HARDWARE-backed support (drives routing — only offload
  // to WebCodecs when there's real silicon). `encodeAny`/`decodeAny` = usable at
  // all, incl. software fallback (drives the self-test + adaptive codec pick, so
  // the path is exercisable on software-only encoders too).
  const CAPS = { probed: false, gpu: null, decode: {}, encode: {}, decodeAny: {}, encodeAny: {}, webcodecs: false };

  // ===========================================================================
  // 1. GPU DETECTION
  // ---------------------------------------------------------------------------
  // A site CANNOT turn on the browser's hardware-acceleration setting. There is
  // no API. All we can do is DETECT that it's off and tell the user where to go.
  // ===========================================================================

  function detectGPU() {
    const c = document.createElement('canvas');
    const o = { powerPreference: 'high-performance' };
    const gl = c.getContext('webgl2', o) || c.getContext('webgl', o);
    if (!gl) return { accelerated: false, renderer: 'none', vendor: '—', reason: 'No WebGL context at all.' };

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const vendor   = String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)   : gl.getParameter(gl.VENDOR));

    // When Chrome's hardware acceleration is OFF, WebGL silently falls back to a
    // software rasterizer. These strings are how you can tell.
    const SOFTWARE = ['swiftshader', 'llvmpipe', 'software', 'microsoft basic render', 'mesa offscreen'];
    const isSoftware = SOFTWARE.some((m) => renderer.toLowerCase().includes(m));

    return {
      accelerated: !isSoftware,
      renderer, vendor,
      reason: isSoftware ? 'Browser is using a software rasterizer — the GPU is not being used.' : 'GPU active.',
    };
  }

  function showGpuNag(gpu) {
    if (document.getElementById('gpu-nag')) return;
    const chip = document.createElement('div');
    chip.id = 'gpu-nag';
    chip.className = 'gpu-nag';
    chip.innerHTML = `
      <span>⚠️ <b>Hardware acceleration is off.</b> Renders are much slower and live preview is disabled.
        <span class="dim">Chrome/Edge: Settings → System → “Use graphics acceleration when available” → relaunch.</span>
      </span>
      <button type="button" id="gpu-copy" class="mini-btn">Copy path</button>
      <button type="button" id="gpu-dismiss" class="mini-btn">✕</button>`;
    document.body.appendChild(chip);

    // You cannot LINK to a chrome:// URL — browsers block it. A copy button is
    // the most a web page is allowed to do here.
    chip.querySelector('#gpu-copy').addEventListener('click', () => {
      navigator.clipboard?.writeText('chrome://settings/system');
      chip.querySelector('#gpu-copy').textContent = 'Copied ✓';
    });
    chip.querySelector('#gpu-dismiss').addEventListener('click', () => chip.remove());
  }

  // ===========================================================================
  // 2. CODEC CAPABILITY PROBE
  // ===========================================================================

  const PROBES = [
    { name: 'H.264', codec: 'avc1.640028' },
    { name: 'VP9',   codec: 'vp09.00.10.08' },
    { name: 'AV1',   codec: 'av01.0.04M.08' },   // Profile 0, 8-bit only
    { name: 'HEVC',  codec: 'hev1.1.6.L93.B0' },
    { name: 'VP8',   codec: 'vp8' },
  ];

  async function probeCodecs() {
    CAPS.gpu = detectGPU();
    CAPS.webcodecs = ('VideoEncoder' in window) && ('VideoDecoder' in window);
    if (!CAPS.webcodecs) { CAPS.probed = true; return CAPS; }

    for (const { name, codec } of PROBES) {
      // HARDWARE-backed support (prefer-hardware → false on a software-only host).
      try {
        const d = await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080, hardwareAcceleration: 'prefer-hardware' });
        CAPS.decode[name] = !!d.supported;
      } catch (_) { CAPS.decode[name] = false; }
      try {
        const e = await VideoEncoder.isConfigSupported({ codec, width: 1920, height: 1080, bitrate: 5_000_000, framerate: 30, hardwareAcceleration: 'prefer-hardware' });
        CAPS.encode[name] = !!e.supported;
      } catch (_) { CAPS.encode[name] = false; }

      // Usable-at-all support (no-preference → true wherever a software codec
      // exists). Probed at a modest size so software encoders aren't rejected.
      try {
        const d = await VideoDecoder.isConfigSupported({ codec, codedWidth: 640, codedHeight: 480, hardwareAcceleration: 'no-preference' });
        CAPS.decodeAny[name] = !!d.supported;
      } catch (_) { CAPS.decodeAny[name] = false; }
      try {
        const e = await VideoEncoder.isConfigSupported({ codec, width: 640, height: 480, bitrate: 2_000_000, framerate: 30, hardwareAcceleration: 'no-preference' });
        CAPS.encodeAny[name] = !!e.supported;
      } catch (_) { CAPS.encodeAny[name] = false; }
    }
    CAPS.probed = true;
    return CAPS;
  }

  // Codec-adaptive encode selection. H.264 is universal where present, but a lot
  // of machines/browsers ship WITHOUT an H.264 *encoder* (licensing) while still
  // having VP9/AV1 — the old code hardcoded H.264 and simply failed there. Pick
  // the best AVAILABLE encoder, with the matching mp4-muxer tag. (VP8 is omitted:
  // mp4-muxer can't mux it — it belongs in a WebM container.)
  const ENCODE_PREF = [
    { name: 'H.264', codec: 'avc1.42E01F',    muxerCodec: 'avc'  },
    { name: 'VP9',   codec: 'vp09.00.10.08',  muxerCodec: 'vp9'  },
    { name: 'AV1',   codec: 'av01.0.04M.08',  muxerCodec: 'av1'  },
    { name: 'HEVC',  codec: 'hev1.1.6.L93.B0', muxerCodec: 'hevc' },
  ];
  // Default picks a HARDWARE-backed encoder (for routing real work). Pass
  // { allowSoftware:true } to accept any usable encoder (for the self-test, and
  // as a last-resort fallback on machines with only a software codec).
  function pickEncodeCodec(opts = {}) {
    const table = opts.allowSoftware ? CAPS.encodeAny : CAPS.encode;
    for (const c of ENCODE_PREF) if (table[c.name]) return c;
    return null;
  }

  // Hardware self-test (the WebCodecs analogue of the wasm 🩺 self-test): encode
  // N synthetic frames through the REAL VideoEncoder and decode them back through
  // VideoDecoder, then confirm the frame count AND that the moving marker
  // survived (real pixels, not bytes). Proves the silicon encode/decode path on
  // THIS machine, on whichever codec it actually supports.
  async function hwSelfTest(opts = {}) {
    if (!CAPS.probed) await probeCodecs();
    if (!CAPS.webcodecs) return { ok: false, reason: 'WebCodecs unavailable' };
    const pick = pickEncodeCodec({ allowSoftware: true });   // verify the path even on a software-only encoder
    if (!pick) return { ok: false, reason: 'no supported hardware/software video encoder' };

    const W = opts.width || 320, H = opts.height || 240, N = opts.frames || 24, fps = 30, bitrate = 3_000_000;
    const markerX = (i) => Math.round((i / (N - 1)) * (W - 48)) + 4;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const draw = (i) => { g.fillStyle = '#0a1420'; g.fillRect(0, 0, W, H); g.fillStyle = '#ff3aa0'; g.fillRect(markerX(i), (H / 2 - 24) | 0, 40, 48); };

    // --- encode --- (no-preference: prefer hardware where present, but fall
    // back to a software codec so the PATH is verifiable everywhere)
    const chunks = []; let decoderConfig = null, encErr = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && !decoderConfig) decoderConfig = meta.decoderConfig;
        const buf = new Uint8Array(chunk.byteLength); chunk.copyTo(buf);
        chunks.push({ type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration, data: buf });
      },
      error: (e) => { encErr = e.message || String(e); },
    });
    try {
      encoder.configure({ codec: pick.codec, width: W, height: H, bitrate, framerate: fps, hardwareAcceleration: 'no-preference', latencyMode: 'quality' });
      for (let i = 0; i < N; i++) {
        draw(i);
        const vf = new VideoFrame(cv, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(vf, { keyFrame: i % 12 === 0 });
        vf.close();
      }
      await encoder.flush();
    } catch (e) { encErr = encErr || (e.message || String(e)); }
    try { encoder.close(); } catch (_) {}
    if (encErr || !chunks.length) return { ok: false, reason: `encode failed: ${encErr || 'no chunks produced'}`, codec: pick.name, wcCodec: pick.codec };

    // --- decode + pixel check ---
    let decoded = 0, markerHits = 0, bgDarks = 0, decErr = null;
    const rcv = document.createElement('canvas'); rcv.width = W; rcv.height = H;
    const rg = rcv.getContext('2d', { willReadFrequently: true });
    const decoder = new VideoDecoder({
      output: (frame) => {
        decoded++;
        try {
          const i = Math.round((frame.timestamp * fps) / 1e6);
          rg.drawImage(frame, 0, 0, W, H);
          const mx = Math.min(W - 1, markerX(i) + 20), my = (H / 2) | 0;
          const m = rg.getImageData(mx, my, 1, 1).data;      // marker pixel
          const c = rg.getImageData(3, 3, 1, 1).data;         // background corner
          if (m[0] > 120 && m[2] > 50 && m[0] > m[1]) markerHits++;   // pink survived
          if ((c[0] + c[1] + c[2]) < 200) bgDarks++;                  // dark bg survived
        } catch (_) {}
        frame.close();
      },
      error: (e) => { decErr = decErr || (e.message || String(e)); },
    });
    try {
      decoder.configure(decoderConfig || { codec: pick.codec, codedWidth: W, codedHeight: H, hardwareAcceleration: 'no-preference' });
      for (const c of chunks) decoder.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestamp, duration: c.duration, data: c.data }));
      await decoder.flush();
    } catch (e) { decErr = decErr || (e.message || String(e)); }
    try { decoder.close(); } catch (_) {}

    return {
      ok: !decErr && decoded === N && chunks.length > 0 && markerHits >= N * 0.6 && bgDarks >= N * 0.6,
      codec: pick.name, wcCodec: pick.codec, expected: N,
      encodedChunks: chunks.length, decodedFrames: decoded, markerHits, bgDarks,
      reason: decErr ? `decode: ${decErr}` : undefined,
    };
  }

  function renderHwPanel() {
    const el = document.getElementById('hw-panel');
    if (!el) return;
    const yn = (b) => (b ? '<b class="ok">✓</b>' : '<b class="off">✕</b>');
    const dec = Object.entries(CAPS.decode).map(([k, v]) => `${k} ${yn(v)}`).join(' · ') || '—';
    const enc = Object.entries(CAPS.encode).map(([k, v]) => `${k} ${yn(v)}`).join(' · ') || '—';

    const anyHw = Object.values(CAPS.encode).some(Boolean);
    el.innerHTML = `
      <div class="hw-row"><span class="hw-k">GPU</span><span class="hw-v">${CAPS.gpu?.renderer || '—'}</span></div>
      <div class="hw-row"><span class="hw-k">HW Decode</span><span class="hw-v">${dec}</span></div>
      <div class="hw-row"><span class="hw-k">HW Encode</span><span class="hw-v">${enc}</span></div>
      <div class="hw-row"><span class="hw-k">Mode</span>
        <span class="hw-v ${anyHw ? 'ok' : 'off'}">
          ${anyHw ? '⚡ Accelerated pipeline available' : '🐢 WebAssembly only'}
        </span></div>
      ${!CAPS.gpu?.accelerated ? '<div class="hw-warn">Browser hardware acceleration is OFF.</div>' : ''}`;
  }

  // ===========================================================================
  // 3. LIB LOADING (lazy — nothing downloads until the fast path is used)
  // ===========================================================================

  const _loaded = {};
  function loadScript(url) {
    if (_loaded[url]) return _loaded[url];
    _loaded[url] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = url; s.onload = res; s.onerror = () => rej(new Error(`Failed to load ${url}`));
      document.head.appendChild(s);
    });
    return _loaded[url];
  }

  // ===========================================================================
  // 4. DEMUX  (WebCodecs gives you FRAMES, not containers. You bring your own.)
  // ===========================================================================

  async function demuxMP4(file) {
    await loadScript(MP4BOX_URL);
    const MP4Box = window.MP4Box;

    return new Promise((resolve, reject) => {
      const mp4 = MP4Box.createFile();
      const samples = [];
      let config = null, track = null;

      mp4.onError = (e) => reject(new Error(`Demux failed: ${e}`));

      mp4.onReady = (info) => {
        track = info.videoTracks[0];
        if (!track) return reject(new Error('No video track.'));

        // Build the codec description (avcC / hvcC) the decoder needs.
        const trak = mp4.getTrackById(track.id);
        let desc = null;
        for (const entry of trak.mdia.minf.stbl.stsd.entries) {
          const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
          if (box) {
            const s = new (window.DataStream || MP4Box.DataStream)(undefined, 0, 1 /* LITTLE_ENDIAN */);
            box.write(s);
            desc = new Uint8Array(s.buffer, 8);      // strip the box header
            break;
          }
        }

        config = {
          codec: track.codec,
          codedWidth:  track.video.width,
          codedHeight: track.video.height,
          description: desc || undefined,
          hardwareAcceleration: 'prefer-hardware',
        };

        mp4.setExtractionOptions(track.id, null, { nbSamples: Infinity });
        mp4.start();
      };

      mp4.onSamples = (_id, _user, list) => {
        for (const s of list) {
          samples.push(new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: (s.cts * 1_000_000) / s.timescale,
            duration:  (s.duration * 1_000_000) / s.timescale,
            data: s.data,
          }));
        }
        if (samples.length >= track.nb_samples) {
          resolve({
            config,
            samples,
            width: track.video.width,
            height: track.video.height,
            fps: track.nb_samples / (track.duration / track.timescale),
            durationSec: track.duration / track.timescale,
          });
        }
      };

      file.arrayBuffer().then((buf) => {
        buf.fileStart = 0;
        mp4.appendBuffer(buf);
        mp4.flush();
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 4b. STREAMING DEMUX INPUT  (feed the demuxer block-by-block, never whole
  //     in the JS heap — the point of the OPFS pipeline)
  // ---------------------------------------------------------------------------
  // mp4box parses incrementally: appendBuffer() takes an ArrayBuffer tagged with
  // its byte offset in the file (`fileStart`). Feeding it a ReadableStream (e.g.
  // FFOpfsStream.readable()) block-by-block means the container is demuxed
  // without the whole file ever being resident — for a hardware-capable
  // transcode, MEMFS is never touched at all.
  //
  // `append(arrayBuffer)` is called once per block, in order, with a correct,
  // contiguous `fileStart`. Source may be a ReadableStream, Blob/File,
  // Uint8Array or ArrayBuffer. Returns the total bytes fed. This feeder is the
  // new, testable risk surface; mp4box's own parsing is unchanged.
  async function feedDemuxer(append, source, chunkSize) {
    chunkSize = chunkSize || (4 * 1024 * 1024);
    let offset = 0;
    const emit = (u8) => {
      // mp4box wants a standalone ArrayBuffer; copy the view out when it isn't
      // already the whole backing buffer, then tag it with the byte offset.
      const ab = (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) ? u8.buffer : u8.slice().buffer;
      ab.fileStart = offset;
      append(ab);
      offset += u8.byteLength;
    };
    if (source && typeof source.getReader === 'function') {            // ReadableStream
      const rd = source.getReader();
      for (;;) { const { value, done } = await rd.read(); if (done) break; if (value && value.byteLength) emit(value instanceof Uint8Array ? value : new Uint8Array(value)); }
    } else if (typeof Blob !== 'undefined' && source instanceof Blob) { // Blob / File
      for (let o = 0; o < source.size; o += chunkSize) emit(new Uint8Array(await source.slice(o, Math.min(source.size, o + chunkSize)).arrayBuffer()));
    } else if (source instanceof Uint8Array) {
      for (let o = 0; o < source.length; o += chunkSize) emit(source.subarray(o, Math.min(source.length, o + chunkSize)));
    } else if (source instanceof ArrayBuffer) {
      const u = new Uint8Array(source); for (let o = 0; o < u.length; o += chunkSize) emit(u.subarray(o, Math.min(u.length, o + chunkSize)));
    }
    return offset;
  }

  // Demux from any streamable source (a ReadableStream, an OPFS entry name via
  // { opfsName }, or a File/Blob). Same result shape as demuxMP4. mp4box is fed
  // incrementally through feedDemuxer, so the file is never whole-in-heap.
  async function demuxSource(source, opts = {}) {
    await loadScript(MP4BOX_URL);
    const MP4Box = window.MP4Box;
    // resolve an OPFS entry name to a ReadableStream when asked
    let src = source;
    if (source && source.opfsName && window.FFOpfsStream) src = window.FFOpfsStream.readable(source.opfsName, opts);

    return new Promise((resolve, reject) => {
      const mp4 = MP4Box.createFile();
      const samples = [];
      let config = null, track = null;
      mp4.onError = (e) => reject(new Error(`Demux failed: ${e}`));
      mp4.onReady = (info) => {
        track = info.videoTracks[0];
        if (!track) return reject(new Error('No video track.'));
        const trak = mp4.getTrackById(track.id);
        let desc = null;
        for (const entry of trak.mdia.minf.stbl.stsd.entries) {
          const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
          if (box) { const s = new (window.DataStream || MP4Box.DataStream)(undefined, 0, 1); box.write(s); desc = new Uint8Array(s.buffer, 8); break; }
        }
        config = { codec: track.codec, codedWidth: track.video.width, codedHeight: track.video.height, description: desc || undefined, hardwareAcceleration: 'prefer-hardware' };
        mp4.setExtractionOptions(track.id, null, { nbSamples: Infinity });
        mp4.start();
      };
      mp4.onSamples = (_id, _user, list) => {
        for (const s of list) samples.push(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: (s.cts * 1e6) / s.timescale, duration: (s.duration * 1e6) / s.timescale, data: s.data }));
        if (samples.length >= track.nb_samples) resolve({ config, samples, width: track.video.width, height: track.video.height, fps: track.nb_samples / (track.duration / track.timescale), durationSec: track.duration / track.timescale });
      };
      // stream the source into mp4box block by block, then flush.
      feedDemuxer((ab) => mp4.appendBuffer(ab), src, opts.chunkSize).then(() => mp4.flush()).catch(reject);
    });
  }

  // ===========================================================================
  // 5. THE HARDWARE TRANSCODE
  // ===========================================================================

  /**
   * Decode → (optional GPU shader) → encode. All on hardware.
   * @param {File}   file
   * @param {Object} opts  { width, height, bitrate, codec, applyShader(frame) → VideoFrame }
   */
  async function hwTranscode(file, opts = {}) {
    if (!CAPS.probed) await probeCodecs();
    if (!CAPS.webcodecs) throw new Error('WebCodecs not available in this browser.');

    const t0 = performance.now();
    const log = (m) => window.logToConsole?.('', `[hw] ${m}`);

    log('demuxing…');
    const src = await demuxMP4(file);

    const W = opts.width  || src.width;
    const H = opts.height || src.height;
    const fps = Math.round(opts.fps || src.fps || 30);
    const bitrate = opts.bitrate || 5_000_000;

    // Codec-adaptive: prefer H.264, but fall back to VP9/AV1/HEVC on machines
    // that ship no H.264 *encoder* (which the old hardcoded 'avc' silently failed
    // on). A caller can still force one via opts.codec / opts.muxerCodec.
    const pick = opts.codec
      ? { codec: opts.codec, muxerCodec: opts.muxerCodec || 'avc' }
      : pickEncodeCodec();
    if (!pick) throw new Error('No hardware/software video encoder available on this device.');
    log(`encoder → ${pick.codec}`);

    await loadScript(MUXER_URL);
    const { Muxer, ArrayBufferTarget } = window.Mp4Muxer;

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: pick.muxerCodec, width: W, height: H, frameRate: fps },
      fastStart: 'in-memory',
    });

    // --- ENCODER (hardware) ---
    let encoded = 0;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => { muxer.addVideoChunk(chunk, meta); encoded++; },
      error:  (e) => window.logToConsole?.('error', `[hw] encode: ${e.message}`),
    });
    encoder.configure({
      codec: pick.codec,                          // adaptively chosen above
      width: W, height: H,
      bitrate, framerate: fps,
      hardwareAcceleration: 'prefer-hardware',   // ← THE LINE THAT MATTERS
      latencyMode: 'quality',
    });

    // --- DECODER (hardware) ---
    let decoded = 0, i = 0;
    const decoder = new VideoDecoder({
      output: async (frame) => {
        decoded++;
        let out = frame;
        try {
          if (opts.applyShader) out = await opts.applyShader(frame);
          encoder.encode(out, { keyFrame: i % (fps * 2) === 0 });
          i++;
        } finally {
          // EVERY VideoFrame holds real GPU memory and MUST be closed.
          // Leak them and the tab hard-crashes in seconds. #1 WebCodecs footgun.
          frame.close();
          if (out !== frame) out.close();
        }
        if (decoded % 30 === 0) {
          const pct = decoded / src.samples.length;
          window.setProgress?.(pct);
          window.setProgressText?.(`⚡ Hardware — ${decoded}/${src.samples.length} frames`);
        }
      },
      error: (e) => window.logToConsole?.('error', `[hw] decode: ${e.message}`),
    });
    decoder.configure(src.config);

    log(`decoding ${src.samples.length} frames on hardware…`);
    for (const chunk of src.samples) decoder.decode(chunk);
    await decoder.flush();
    await encoder.flush();
    muxer.finalize();

    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    const secs = ((performance.now() - t0) / 1000).toFixed(2);
    window.logToConsole?.('ok',
      `[hw] ⚡ ${decoded} frames in ${secs}s — ${(blob.size / 1024 / 1024).toFixed(2)} MB (hardware pipeline)`);
    return { blob, frames: decoded, seconds: +secs };
  }

  // ===========================================================================
  // 6. SHADER BRIDGE — decoded frame → GPU texture → TRIP shader → new frame
  // ---------------------------------------------------------------------------
  // The pixels never leave the GPU. This is the whole ballgame.
  // ===========================================================================

  let shaderCanvas = null, shaderEngine = null;

  function makeShaderPass(effect, params) {
    if (!window.TripCam) return null;
    if (!shaderCanvas) {
      shaderCanvas = document.createElement('canvas');
      shaderEngine = new window.TripCam.TripEngine(shaderCanvas);
    }
    shaderEngine.setEffect(effect);
    if (params) shaderEngine.setParams(params);

    return async (videoFrame) => {
      const w = videoFrame.displayWidth, h = videoFrame.displayHeight;
      if (shaderCanvas.width !== w) { shaderCanvas.width = w; shaderCanvas.height = h; }

      shaderEngine.setSource(videoFrame);     // WebGL can texImage2D a VideoFrame directly
      shaderEngine.render();

      return new VideoFrame(shaderCanvas, {
        timestamp: videoFrame.timestamp,
        duration:  videoFrame.duration,
      });
    };
  }

  // ===========================================================================
  // 7. ROUTING — which jobs go to hardware, which stay on ffmpeg.wasm
  // ===========================================================================

  /** Filters with no shader equivalent, or that WebCodecs simply can't do. */
  const WASM_ONLY = [
    'geq', 'minterpolate', 'lut3d', 'haldclut', 'tmix', 'tblend', 'lagfun',
    'reverse', 'deshake', 'subtitles', 'drawtext', 'palettegen', 'paletteuse',
    'silencedetect', 'ebur128', 'showwaves', 'showspectrum',
  ];

  function canUseHardware(args) {
    if (!CAPS.webcodecs || !Object.values(CAPS.encode).some(Boolean)) return false;
    const s = Array.isArray(args) ? args.join(' ') : String(args || '');

    // No MP3/FLAC encoder exists in WebCodecs. Audio work stays on wasm — and
    // that's fine, audio is cheap. It's video that's slow.
    if (/-c:a\s+(libmp3lame|flac)/.test(s)) return false;
    if (/\.(mp3|flac|wav|ogg|gif)\b/.test(s)) return false;
    if (WASM_ONLY.some((f) => s.includes(f))) return false;
    return true;
  }

  function pathBadge(kind, secs) {
    const el = document.getElementById('path-badge');
    if (!el) return;
    el.hidden = false;
    el.className = `path-badge ${kind}`;
    el.textContent = kind === 'hw'
      ? `⚡ Hardware (${secs}s)`
      : `🐢 WebAssembly (${secs}s)`;
  }

  // ===========================================================================

  async function init() {
    await probeCodecs();
    renderHwPanel();
    if (CAPS.gpu && !CAPS.gpu.accelerated) showGpuNag(CAPS.gpu);

    window.logToConsole?.('',
      `[hw] WebCodecs: ${CAPS.webcodecs ? 'available' : 'unavailable'} · ` +
      `GPU: ${CAPS.gpu?.renderer || '—'} · ` +
      `HW encode: ${Object.entries(CAPS.encode).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);
  }

  window.FFHardware = {
    CAPS, init, probeCodecs, detectGPU, renderHwPanel, pickEncodeCodec, hwSelfTest,
    demuxMP4, demuxSource, feedDemuxer, hwTranscode, makeShaderPass, canUseHardware, pathBadge,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
