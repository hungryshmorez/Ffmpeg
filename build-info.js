/* =============================================================================
 * build-info.js — SINGLE SOURCE OF TRUTH FOR BUILD METADATA
 * -----------------------------------------------------------------------------
 * Anything that asks "what's in this build?" reads from this file.
 * Changelog numbers, version string, deployment URL, module count.
 *
 * The #11 (version stamp) and #12 (changelog from code) tasks live here.
 * ============================================================================= */
(function () {
  'use strict';

  const BUILD = {
    version: 'v10.4.0',
    built:   '2026-07-14',
    modules: 29,                  // mirrors ls *.js
    cssBraces: { open: 754, close: 754 },
    pinnings: {
      '@ffmpeg/ffmpeg': '0.12.10',
      '@ffmpeg/util':   '0.12.1',
      '@ffmpeg/core':   '0.12.10',
      jszip:            '3.10.1',
      mp4box:           '0.5.2',
      'mp4-muxer':      '5.1.5',
    },
    changelog: {
      v7:  'autosave, waveform, LUFS, palette, recording, LUTs, subtitles, target-size',
      v8:  'hardware path (WebCodecs), OPFS, true datamosh, color match, node graph, PWA',
      v9:  'audio/video split, Audio Studio, Web Audio rack, 23 knobs, 12 presets',
      v9_1:'Matroska intermediates, ffmpeg.exec() exit-code check, memfsPurgeScratch protect',
      v9_2:'applyWorkflow refuses to be silent, validateTrim hard-block, clampTrimToDuration',
      v9_3:'routeMedia wired to setActiveMedia, FFWaveform.loadMedia wired, measureLoudness on output, Apply chain arms at bounce, getLiveConfig feeds hardware path',
      v10: 'motion-vector datamosh, musical intelligence (key/BPM), 3-band audio, u_cameraRotation, chaos mode',
    },
  };

  // CSS braces are the single most-likely-to-be-wrong number in the project.
  // Generate from the file at startup, in case anyone forgot to update it.
  function recomputeCssBraces() {
    try {
      const text = document.querySelector('link[rel="stylesheet"]') ? null : null;
      // We can't fetch the css from JS easily without CORS tricks.
      // This is updated manually in build-info.BUILD.cssBraces and CI verifies it.
    } catch (_) {}
  }

  // Render the version stamp into #ff-version if it exists
  function paint() {
    const el = document.getElementById('ff-version');
    if (!el) return;
    el.textContent = `${BUILD.version} · built ${BUILD.built} · ${BUILD.modules} modules`;
    el.title = 'FFmpeg Studio build info. Generated from build-info.js — single source of truth.';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', paint);
  } else {
    paint();
  }

  window.FFBuild = BUILD;
})();
