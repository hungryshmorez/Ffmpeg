/* =============================================================================
   audio-studio.js — THE AUDIO STUDIO TAB
   -----------------------------------------------------------------------------
   A modular rack. Drag a knob, HEAR IT IMMEDIATELY. No render, no wait.

   ffmpeg.wasm is used exactly once, at the end, to encode the bounce — and only
   because Web Audio can't write MP3/AAC/FLAC. Everything else is real-time.
   ========================================================================== */

(function () {
  'use strict';

  const RACK = [
    {
      id: 'transport', name: 'Transport', icon: '⏱',
      desc: 'Speed and pitch. Slowed + reverb starts here.',
      params: [
        ['speed',  'Speed',  0.5,  1.5,  0.01, (v) => `${v.toFixed(2)}×`],
        ['pitch',  'Pitch',  -12,  12,   1,    (v) => `${v > 0 ? '+' : ''}${v} st`],
        ['volume', 'Volume', 0,    2,    0.01, (v) => `${Math.round(v * 100)}%`],
      ],
    },
    {
      id: 'eq', name: 'EQ & Filter', icon: '🎚',
      desc: 'Shape the tone. Roll off the highs for that underwater feel.',
      params: [
        ['bassBoostDb', 'Bass Boost', -12, 18,    0.5, (v) => `${v > 0 ? '+' : ''}${v} dB`],
        ['eqLowDb',     'Low',        -18, 18,    0.5, (v) => `${v > 0 ? '+' : ''}${v} dB`],
        ['eqMidDb',     'Mid',        -18, 18,    0.5, (v) => `${v > 0 ? '+' : ''}${v} dB`],
        ['eqHighDb',    'High',       -18, 18,    0.5, (v) => `${v > 0 ? '+' : ''}${v} dB`],
        ['lowpassFreq', 'Low-Pass',   200, 20000, 100, (v) => v >= 20000 ? 'off' : `${(v / 1000).toFixed(1)} kHz`],
      ],
    },
    {
      id: 'reverb', name: 'Reverb', icon: '🌫',
      desc: 'Space. Turn Mix up and the room appears.',
      params: [
        ['reverbMix',   'Mix',   0,   1,  0.01, (v) => `${Math.round(v * 100)}%`],
        ['reverbRoom',  'Room',  0.5, 5,  0.1,  (v) => v.toFixed(1)],
        ['reverbDecay', 'Decay', 0.2, 10, 0.1,  (v) => `${v.toFixed(1)}s`],
      ],
    },
    {
      id: 'delay', name: 'Delay', icon: '🔁',
      desc: 'Echo. Feedback above 0.6 starts to run away.',
      params: [
        ['delayMix',      'Mix',      0, 1,   0.01, (v) => `${Math.round(v * 100)}%`],
        ['delayTime',     'Time',     0, 1.5, 0.01, (v) => `${(v * 1000).toFixed(0)} ms`],
        ['delayFeedback', 'Feedback', 0, 0.9, 0.01, (v) => `${Math.round(v * 100)}%`],
      ],
    },
    {
      id: 'chorus', name: 'Chorus', icon: '〰️',
      desc: 'Thickens and detunes. This is the tape-warble knob.',
      params: [
        ['chorusMix',   'Mix',   0,     1,     0.01,  (v) => `${Math.round(v * 100)}%`],
        ['chorusRate',  'Rate',  0.1,   8,     0.1,   (v) => `${v.toFixed(1)} Hz`],
        ['chorusDepth', 'Depth', 0,     1,     0.01,  (v) => `${Math.round(v * 100)}%`],
        ['chorusDelay', 'Delay', 0.005, 0.08,  0.001, (v) => `${(v * 1000).toFixed(0)} ms`],
      ],
    },
    {
      id: 'phaser', name: 'Phaser', icon: '🌀',
      desc: 'Sweeping notches. Slow rates sound seasick, in a good way.',
      params: [
        ['phaserRate',     'Rate',     0.05, 5,   0.05, (v) => `${v.toFixed(2)} Hz`],
        ['phaserDepth',    'Depth',    0,    1,   0.01, (v) => `${Math.round(v * 100)}%`],
        ['phaserFeedback', 'Feedback', 0,    0.9, 0.01, (v) => `${Math.round(v * 100)}%`],
      ],
    },
    {
      id: 'drive', name: 'Distortion', icon: '🔥',
      desc: 'Saturation and grit. A little goes a long way.',
      params: [
        ['distortionAmount', 'Drive', 0, 100, 1,    (v) => v === 0 ? 'off' : String(v)],
        ['distortionTone',   'Tone',  0, 1,   0.01, (v) => `${Math.round(v * 100)}%`],
      ],
    },
    {
      id: 'stereo', name: 'Stereo', icon: '🎧',
      desc: '100% is neutral, 0% is mono, above widens. Watch the correlation meter.',
      params: [
        ['width', 'Width', 0, 2, 0.01, (v) => `${Math.round(v * 100)}%`],
      ],
    },
    {
      id: 'master', name: 'Master Limiter', icon: '🧱',
      desc: 'Lookahead brickwall on the bounce. Ceiling at 0 dB is off; pull it down to catch peaks without clipping.',
      params: [
        ['limiterCeiling', 'Ceiling', -12, 0, 0.1, (v) => v >= -0.05 ? 'off' : `${v.toFixed(1)} dB`],
      ],
    },
  ];

  let eng = null, media = null, vizRaf = 0;
  let armedChain = null;   // an ffmpeg mastering chain to apply at bounce time

  // ---------------------------------------------------------------------------
  // BUILD
  // ---------------------------------------------------------------------------

  function build() {
    const tab = document.getElementById('tab-audio');
    if (!tab || tab.dataset.built) return;
    tab.dataset.built = '1';

    tab.innerHTML = `
      <div class="as-wrap">

        <!-- LEFT: presets -->
        <aside class="as-presets">
          <h3>Presets</h3>
          <p class="as-sub">Start here. Then turn knobs.</p>
          <div id="as-preset-list"></div>
          <button type="button" class="mini-btn wide" id="as-reset">↺ Reset all</button>

          <div id="audio-intel" class="audio-intel"></div>
          <div id="macro-panel" class="macro-panel"></div>
        </aside>

        <!-- CENTER: player + rack -->
        <main class="as-main">
          <section class="as-player">
            <div class="as-drop" id="as-drop">
              <div class="as-drop-inner">
                <div class="as-icon">🎵</div>
                <p><strong>Drop an audio file</strong> or click to browse</p>
                <p class="dim">MP3 · WAV · FLAC · OGG · M4A — or pick one from the Media Bin</p>
              </div>
            </div>

            <div class="as-now" id="as-now" hidden>
              <div class="as-viz-tabs">
                <button type="button" class="as-viz-tab active" data-viz="bars">Bars</button>
                <button type="button" class="as-viz-tab" data-viz="spec">Spectrogram</button>
              </div>
              <canvas id="as-viz" height="120"></canvas>
              <div class="as-transport">
                <button type="button" class="as-play" id="as-play">▶</button>
                <div class="as-scrub-wrap">
                  <div class="as-title" id="as-title">—</div>
                  <input type="range" id="as-scrub" min="0" max="1000" value="0" class="as-scrub">
                  <div class="as-time"><span id="as-cur">0:00</span> / <span id="as-dur">0:00</span></div>
                </div>
              </div>
              <p class="as-live">🔊 <strong>Live.</strong> Every knob you turn is heard instantly — nothing is rendered until you Bounce.</p>
            </div>
          </section>

          <section class="as-rack" id="as-rack"></section>
        </main>

        <!-- RIGHT: bounce -->
        <aside class="as-out">
          <h3>Bounce</h3>
          <p class="as-sub">Render what you're hearing to a file.</p>

          <label class="as-field">
            <span>Format</span>
            <select id="as-format" class="ctrl">
              <option value="wav">WAV — lossless, instant</option>
              <option value="mp3" selected>MP3 320k</option>
              <option value="aac">AAC 256k (m4a)</option>
              <option value="flac">FLAC — lossless</option>
            </select>
          </label>

          <label class="as-check">
            <input type="checkbox" id="as-normalize" checked>
            <span>Normalise to −14 LUFS <small>(streaming)</small></span>
          </label>

          <label class="as-check" title="Bounce uses ffmpeg atempo (phase vocoder) so speed changes time but not pitch">
            <input type="checkbox" id="as-preserve-pitch">
            <span>Time-stretch, keep pitch <small>(#34 — atempo)</small></span>
          </label>

          <button type="button" class="primary-btn wide" id="as-bounce">⬇ Bounce to file</button>
          <div id="as-bounce-status" class="as-status"></div>

          <div id="lufs-meter-audio" class="lufs-meter"></div>

          <details class="as-adv">
            <summary>FFmpeg mastering chains</summary>
            <p class="dim">These run through ffmpeg instead of the live engine — the 19 chains from your reference library.</p>
            <select id="as-chain" class="ctrl">
              <option value="">— none —</option>
            </select>
            <p id="as-chain-note" class="as-chain-note"></p>
            <button type="button" class="mini-btn wide" id="as-run-chain">Run chain now (offline)</button>
          </details>
        </aside>
      </div>

      <input type="file" id="as-file" accept="audio/*" hidden>`;

    // Presets
    document.getElementById('as-preset-list').innerHTML = window.FFAudio.PRESETS
      .map((p) => `<button type="button" class="as-preset" data-n="${p.name}">
          <strong>${p.name}</strong><span>${p.desc}</span></button>`).join('');

    // Rack
    document.getElementById('as-rack').innerHTML = RACK.map((mod) => `
      <div class="as-module" data-m="${mod.id}">
        <header class="as-mod-head">
          <span class="as-mod-icon">${mod.icon}</span>
          <div><strong>${mod.name}</strong><small>${mod.desc}</small></div>
        </header>
        <div class="as-knobs">
          ${mod.params.map(([k, label, min, max, step]) => `
            <div class="as-knob">
              <label for="as-${k}">${label}</label>
              <input type="range" id="as-${k}" data-p="${k}"
                     min="${min}" max="${max}" step="${step}"
                     value="${window.FFAudio.DEFAULT_PARAMS[k]}">
              <output id="as-${k}-v">—</output>
            </div>`).join('')}
        </div>
      </div>`).join('');

    // Correlation meter (#31) lives inside the Stereo module.
    const stereoMod = document.querySelector('.as-module[data-m="stereo"]');
    if (stereoMod) {
      const meter = document.createElement('div');
      meter.className = 'as-corr';
      meter.innerHTML = `<label>Correlation</label>
        <div class="as-corr-track"><div class="as-corr-fill" id="as-corr-fill"></div><div class="as-corr-zero"></div></div>
        <output id="as-corr-v">—</output>`;
      stereoMod.appendChild(meter);
    }

    // Mastering chains (from the ffmpeg workflow library)
    const chains = (window.ALL_WORKFLOWS || []).filter((w) => w.category === 'audio-mastering');
    const sel = document.getElementById('as-chain');
    if (sel) sel.innerHTML = '<option value="">— none —</option>' +
      chains.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');

    bind();
    refreshOutputs();
    window.FFAudioIntel?.buildMacroUI(document.getElementById('macro-panel'), null);
  }

  const FMT = {};
  RACK.forEach((m) => m.params.forEach(([k, , , , , f]) => { FMT[k] = f; }));

  function refreshOutputs() {
    const P = eng ? eng.params : window.FFAudio.DEFAULT_PARAMS;
    for (const k of Object.keys(FMT)) {
      const r = document.getElementById(`as-${k}`);
      const o = document.getElementById(`as-${k}-v`);
      if (r) r.value = P[k];
      if (o) o.textContent = FMT[k](Number(P[k]));
      // Dim a module whose "Mix" is at zero — instant visual read of what's on.
      const mod = r?.closest('.as-module');
      if (mod) {
        const mixKey = ['reverbMix', 'delayMix', 'chorusMix'].find((mk) => mod.querySelector(`#as-${mk}`));
        if (mixKey) mod.classList.toggle('off', Number(P[mixKey]) === 0);
        if (mod.dataset.m === 'drive') mod.classList.toggle('off', Number(P.distortionAmount) === 0);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // LOAD / PLAY
  // ---------------------------------------------------------------------------

  async function load(fileOrMedia) {
    const file = fileOrMedia.file || fileOrMedia;
    const name = fileOrMedia.name || file.name;

    eng = eng || new window.FFAudio.AudioEngine();
    window.logToConsole?.('', `[audio] decoding ${name}…`);
    const info = await eng.loadFile(file);

    media = { file, name, ...info };
    document.getElementById('as-drop').hidden = true;
    document.getElementById('as-now').hidden = false;
    document.getElementById('as-title').textContent = name;
    document.getElementById('as-dur').textContent = fmtTime(info.duration);

    eng.onTime = (t, d) => {
      document.getElementById('as-cur').textContent = fmtTime(t);
      document.getElementById('as-scrub').value = String(Math.round((t / d) * 1000));
    };

    startViz();
    window.logToConsole?.('ok', `[audio] ${name} — ${fmtTime(info.duration)} · ${info.sampleRate} Hz · ${info.channels}ch`);

    // The app should KNOW what the music is: key and tempo, from the audio itself.
    // Beat positions go straight onto the waveform and into the VJ sequencer.
    window.FFAudioIntel?.analyse(eng.buffer).catch(() => {});
  }

  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function togglePlay() {
    if (!eng?.buffer) return;
    const btn = document.getElementById('as-play');
    if (eng.playing) { eng.stop(); btn.textContent = '▶'; }
    else { eng.play(); btn.textContent = '⏸'; }
  }

  // ---------------------------------------------------------------------------
  // VISUALIZER
  // ---------------------------------------------------------------------------

  function startViz() {
    const cv = document.getElementById('as-viz');
    const ctx = cv.getContext('2d');
    cancelAnimationFrame(vizRaf);

    let vizMode = 'bars';   // 'bars' or 'spec'
    document.querySelectorAll('.as-viz-tab').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.as-viz-tab').forEach(x => x.classList.toggle('active', x === b));
        vizMode = b.dataset.viz;
        // Clear canvas on mode switch
        ctx.fillStyle = '#0d0d0d';
        ctx.fillRect(0, 0, cv.clientWidth, cv.clientHeight);
      });
    });

    // #25 spectrogram: scroll a one-pixel-wide column from the right each frame.
    // Time on X (rightward = older). Frequency on Y (low at bottom).
    const specHistory = [];   // array of Uint8Array(64), newest at end

    const loop = () => {
      const w = cv.clientWidth, h = 120;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.fillStyle = '#0d0d0d';
      ctx.fillRect(0, 0, w, h);

      const spec = eng?.getSpectrum();
      if (spec) {
        if (vizMode === 'bars') {
          const bars = 64;
          const bw = w / bars;
          for (let i = 0; i < bars; i++) {
            const idx = Math.floor(Math.pow(i / bars, 2) * spec.length);
            const v = spec[idx] / 255;
            const bh = v * h * 0.92;
            const hue = 190 - v * 90;
            ctx.fillStyle = `hsl(${hue}, 100%, ${45 + v * 20}%)`;
            ctx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
          }
        } else {
          // Spectrogram: downsample to 64 bins, push to history, draw scrolling
          const bins = 64;
          const col = new Uint8Array(bins);
          for (let i = 0; i < bins; i++) {
            const idx = Math.floor(Math.pow(i / bins, 2) * spec.length);
            col[i] = spec[idx] || 0;
          }
          specHistory.push(col);
          if (specHistory.length > w) specHistory.shift();

          // Draw: oldest at left, newest at right
          for (let x = 0; x < specHistory.length; x++) {
            const c = specHistory[x];
            for (let y = 0; y < bins; y++) {
              const v = c[y] / 255;
              // Hue from violet (top, high freq) to red (bottom, low freq)
              const hue = 280 - (y / bins) * 280;
              const lightness = v * 50;
              ctx.fillStyle = `hsl(${hue}, 100%, ${lightness}%)`;
              const py = h - (y / bins) * h;
              ctx.fillRect(x, py - (h / bins) - 1, 1, (h / bins) + 1);
            }
          }
        }
      }
      // Correlation meter (#31): -1 (out of phase) … 0 … +1 (mono). Fill grows
      // from the centre; red when negative (phase trouble), green when positive.
      const corr = eng?.getCorrelation?.();
      if (corr != null) {
        const fill = document.getElementById('as-corr-fill');
        const out = document.getElementById('as-corr-v');
        if (fill) {
          const pct = Math.abs(corr) * 50;                 // half-width max
          fill.style.width = pct + '%';
          fill.style.left = corr >= 0 ? '50%' : (50 - pct) + '%';
          fill.style.background = corr < 0 ? '#e0533f' : (corr < 0.4 ? '#e0a53f' : '#4caf70');
        }
        if (out) out.textContent = corr.toFixed(2);
      }
      vizRaf = requestAnimationFrame(loop);
    };
    loop();
  }

  // ---------------------------------------------------------------------------
  // BOUNCE
  // ---------------------------------------------------------------------------

  async function bounce() {
    if (!eng?.buffer) return;
    const fmt = document.getElementById('as-format').value;
    const norm = document.getElementById('as-normalize').checked;
    const preservePitch = document.getElementById('as-preserve-pitch')?.checked;
    const status = document.getElementById('as-bounce-status');
    const wasPlaying = eng.playing;
    eng.stop();
    document.getElementById('as-play').textContent = '▶';

    try {
      status.textContent = 'Rendering (offline, faster than real time)…';
      const rendered = await eng.bounce((p) => { status.textContent = `Rendering… ${Math.round(p * 100)}%`; }, { playbackRate: preservePitch ? 1 : undefined });

      const wav = window.FFAudio.AudioEngine.toWav(rendered);
      status.textContent = `Rendered ${(wav.size / 1024 / 1024).toFixed(1)} MB.`;

      // WAV needs no ffmpeg at all.
      if (fmt === 'wav' && !norm) return finish(wav, 'wav', status);

      // Everything else: ONE ffmpeg pass, purely to encode (and normalise).
      status.textContent = 'Encoding…';
      await window.ff.writeFile('bounce.wav', new Uint8Array(await wav.arrayBuffer()));

      // Build the bounce's -af chain: [armed mastering chain] → [two-pass loudnorm]
      const afParts = [];
      const speed = eng.params.speed;

      // #34: pitch-preserved time stretch. The Web Audio render is at
      // playbackRate=1 (preserves pitch, original duration). atempo is a
      // phase vocoder that changes duration without shifting pitch.
      // atempo accepts 0.5–2.0; we chain multiple atempo=N if the speed
      // is outside that range.
      if (preservePitch && speed !== 1) {
        let r = speed;
        while (r > 2) { afParts.push('atempo=2.0'); r /= 2; }
        while (r < 0.5) { afParts.push('atempo=0.5'); r *= 2; }
        afParts.push(`atempo=${r.toFixed(3)}`);
        status.textContent = 'Pitch-preserved time-stretching…';
        window.logToConsole?.('', `[bounce] preservePitch: atempo chain = ${afParts[afParts.length - 1]}`);
      }

      if (armedChain) {
        const chainAf = armedChain.af || armedChain.audioChain || armedChain.rawAf;
        if (chainAf) {
          afParts.push(chainAf);
          status.textContent = `Applying “${armedChain.name}”…`;
          window.logToConsole?.('', `[bounce] chain: ${chainAf}`);
        }
      }

      if (norm) {
        status.textContent = 'Measuring loudness (two-pass)…';
        const ln = await window.FFAnalysis.buildTwoPassLoudnorm('bounce.wav', 'stream');
        if (ln) afParts.push(ln);
      }

      const af = afParts.length ? afParts.join(',') : null;

      const codec = { mp3: ['-c:a', 'libmp3lame', '-b:a', '320k'],
                      aac: ['-c:a', 'aac', '-b:a', '256k'],
                      flac:['-c:a', 'flac'],
                      wav: ['-c:a', 'pcm_s16le'] }[fmt];
      const ext = fmt === 'aac' ? 'm4a' : fmt;
      const out = `bounce.${ext}`;

      await window.ff.exec([
        '-i', 'bounce.wav',
        ...(af ? ['-af', af] : []),
        ...codec, '-y', out,
      ]);

      const data = await window.ff.readFile(out);
      const blob = new Blob([data.buffer], { type: `audio/${fmt}` });

      // ---------------------------------------------------------------------
      // PROVE IT.
      // ---------------------------------------------------------------------
      // Measure the ENCODED OUTPUT — after loudnorm, before we delete anything.
      // (The old code measured `bounce.wav` — the PRE-loudnorm file — and did it
      // AFTER deleting it, so it silently returned null and the meter never
      // moved. A claim of "-14 LUFS" that is never verified is just a claim.)
      if (norm) {
        status.textContent = 'Verifying loudness…';
        try {
          const r = await window.FFAnalysis.measureLoudness(out);
          if (r && r.integrated != null) {
            window.FFAnalysis.renderMeter(r, 'stream');
            const el = document.getElementById('lufs-meter-audio');
            if (el && document.getElementById('lufs-meter')) {
              el.innerHTML = document.getElementById('lufs-meter').innerHTML;
            }
            const hit = Math.abs(r.integrated - (-14)) <= 1.0;
            window.logToConsole?.(hit ? 'ok' : 'warn',
              `[bounce] measured ${r.integrated.toFixed(1)} LUFS · TP ${r.truePeak?.toFixed(1) ?? '—'} dBFS ` +
              `— target −14 ${hit ? '✔ hit' : '✗ MISSED'}`);
          }
        } catch (e) {
          window.logToConsole?.('warn', `[bounce] loudness verification failed: ${e.message}`);
        }
      }

      // Only NOW is it safe to delete.
      await window.ff.deleteFile('bounce.wav').catch(() => {});
      await window.ff.deleteFile(out).catch(() => {});

      finish(blob, ext, status);
    } catch (e) {
      status.textContent = `✗ ${e.message}`;
      window.logToConsole?.('error', `[audio] bounce failed: ${e.message}`);
    } finally {
      if (wasPlaying) { eng.play(); document.getElementById('as-play').textContent = '⏸'; }
    }
  }

  async function finish(blob, ext, status) {
    const name = `${(media?.name || 'audio').replace(/\.[^.]+$/, '')} [processed].${ext}`;
    await window.addBlobToBin?.(blob, name, blob.type);

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();

    status.innerHTML = `<span class="ok">✔ ${name} — ${(blob.size / 1024 / 1024).toFixed(1)} MB → downloaded &amp; added to the Media Bin</span>`;
    window.logToConsole?.('ok', `[audio] bounced ${name}`);
  }

  // ---------------------------------------------------------------------------
  // BIND
  // ---------------------------------------------------------------------------

  function bind() {
    const drop = document.getElementById('as-drop');
    const inp = document.getElementById('as-file');

    drop.addEventListener('click', () => inp.click());
    inp.addEventListener('change', () => { if (inp.files[0]) load(inp.files[0]); });

    ['dragover', 'dragenter'].forEach((e) =>
      drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((e) =>
      drop.addEventListener(e, () => drop.classList.remove('over')));
    drop.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const f = ev.dataTransfer.files[0];
      if (f?.type.startsWith('audio/')) load(f);
    });

    document.getElementById('as-play').addEventListener('click', togglePlay);

    document.getElementById('as-scrub').addEventListener('input', (e) => {
      if (!eng?.buffer) return;
      const t = (e.target.value / 1000) * eng.buffer.duration;
      eng.offset = t;
      if (eng.playing) eng.play(t);
    });

    // THE POINT: every knob is live.
    document.getElementById('as-rack').addEventListener('input', (e) => {
      const k = e.target.dataset.p;
      if (!k || !eng) return;
      eng.applyParams({ [k]: Number(e.target.value) });
      const o = document.getElementById(`as-${k}-v`);
      if (o && FMT[k]) o.textContent = FMT[k](Number(e.target.value));
      refreshOutputs();
    });

    document.getElementById('as-preset-list').addEventListener('click', (e) => {
      const b = e.target.closest('.as-preset');
      if (!b || !eng) return;
      eng.applyPreset(b.dataset.n);
      refreshOutputs();
      document.querySelectorAll('.as-preset').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      window.logToConsole?.('', `[audio] preset: ${b.dataset.n}`);
    });

    document.getElementById('as-reset').addEventListener('click', () => {
      eng?.reset();
      refreshOutputs();
      document.querySelectorAll('.as-preset').forEach((x) => x.classList.remove('active'));
    });

    document.getElementById('as-bounce').addEventListener('click', bounce);

    // An ffmpeg mastering chain is an OFFLINE filter chain. It CANNOT run in the
    // live Web Audio rack — different engine entirely. So we don't pretend:
    // selecting one arms it, and it is applied as an `-af` during the Bounce,
    // on top of whatever the rack is doing.
    document.getElementById('as-chain').addEventListener('change', (e) => {
      const id = e.target.value;
      const note = document.getElementById('as-chain-note');
      if (!id) {
        armedChain = null;
        if (note) note.textContent = '';
        return;
      }
      const wf = (window.ALL_WORKFLOWS || []).find((w) => w.id === id);
      armedChain = wf || null;
      if (note) {
        note.innerHTML = wf
          ? `<span class="ok">✔ Armed.</span> “${wf.name}” will be applied during Bounce ` +
            `(offline, on top of the live rack). It cannot run in the real-time preview.`
          : '';
      }
      window.logToConsole?.('', `[audio] chain armed: ${wf?.name || id}`);
    });

    document.getElementById('as-run-chain').addEventListener('click', () => {
      const id = document.getElementById('as-chain').value;
      if (!id) {
        window.logToConsole?.('warn', 'No mastering chain selected.');
        return;
      }
      // Run it right now, offline, against the loaded file — and put the result
      // in the Media Bin. This is what the button always claimed to do.
      window.applyWorkflow?.(id);
      window.executeFromUI?.();
    });

    // Space = play/pause, but only while this tab is active and not typing.
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space') return;
      if (!document.getElementById('tab-audio')?.classList.contains('active')) return;
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      e.preventDefault();
      togglePlay();
    });
  }

  /** Load a file that's already in the Media Bin. */
  function loadFromBin(id) {
    const m = (window.state?.mediaBin || []).find((x) => x.id === id);
    if (m) { build(); load(m); }
  }

  window.FFAudioStudio = { build, load, loadFromBin, engine: () => eng, refresh: refreshOutputs };

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('[data-tab="audio"]')?.addEventListener('click', build);
  });
})();
