#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..');

function countModuleFiles() {
  return fs.readdirSync(APP).filter(f => f.endsWith('.js') && !f.startsWith('.')).length;
}

function countCssBraces() {
  const css = fs.readFileSync(path.join(APP, 'style.css'), 'utf8');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return {
    open: (stripped.match(/{/g) || []).length,
    close: (stripped.match(/}/g) || []).length,
    total: css.length,
  };
}

function countNodeLib() {
  const src = fs.readFileSync(path.join(APP, 'nodegraph.js'), 'utf8');
  const m = src.match(/const LIB = \{([\s\S]*?)\n  \};/);
  if (!m) return 0;
  const keys = new Set();
  for (const line of m[1].split('\n')) {
    const km = line.match(/^\s{4,5}([a-zA-Z][a-zA-Z0-9]*):\s*\{/);
    if (km) keys.add(km[1]);
  }
  return keys.size;
}

function countAudioStudio() {
  const src = fs.readFileSync(path.join(APP, 'audio-studio.js'), 'utf8');
  const m = src.match(/const RACK = \[([\s\S]*?)\n  \];/);
  if (!m) return { modules: 0, knobs: 0 };
  const body = m[1];
  const modules = (body.match(/^\s{2,8}id:\s*'[^']+'/gm) || []).length;
  const knobs = (body.match(/^\s{4,12}\[/gm) || []).length;
  return { modules, knobs };
}

function countAudioPresets() {
  const src = fs.readFileSync(path.join(APP, 'audio-engine.js'), 'utf8');
  const m = src.match(/const PRESETS = \[([\s\S]*?)\n  \];/);
  if (!m) return 0;
  return (m[1].match(/name:\s*'[^']+'/g) || []).length;
}

function countTripCam() {
  const src = fs.readFileSync(path.join(APP, 'tripcam.js'), 'utf8');

  const effMatch = src.match(/const EFFECTS = \[([\s\S]*?)\n  \];/);
  const effects = effMatch ? (effMatch[1].match(/"id":\s*"[^"]+"/g) || []).length : 0;

  const preMatch = src.match(/const PRESETS = \{([\s\S]*?)\n\s{2}\};/);
  let presets = 0;
  if (preMatch) {
    const keys = new Set();
    for (const line of preMatch[1].split('\n')) {
      const km = line.match(/^\s{6,16}([a-zA-Z][a-zA-Z0-9]*):\s*\{/);
      if (km) keys.add(km[1]);
    }
    presets = keys.size;
  }

  const defMatch = src.match(/const DEFAULTS = \{([\s\S]*?)\n  \};/);
  let sliders = 0;
  if (defMatch) {
    const keys = new Set();
    for (const line of defMatch[1].split('\n')) {
      // Catch ALL keys per line, since DEFAULTS uses comma-separated values
      const re = /([a-zA-Z_]\w*):\s*[\d.\-]+/g;
      let km;
      while ((km = re.exec(line)) !== null) {
        if (km[1] !== 'params') keys.add(km[1]);
      }
    }
    sliders = keys.size;
  }

  return { effects, presets, sliders };
}

function countWorkflows() {
  let total = 0;
  const byCat = {};
  for (const f of ['workflows.js', 'workflows_v3.js', 'workflows_v4.js', 'workflows_v5.js']) {
    const p = path.join(APP, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    // v5 builds each workflow from a _mosh(...) factory call, so the single
    // literal id inside the factory is a template — not one workflow per call.
    // Count the factory invocations instead, and attribute them to the factory's
    // fixed category. (Otherwise the "total" undercounts v5 by six.)
    const factory = (src.match(/^\s*_mosh\(/gm) || []).length;
    if (factory) {
      total += factory;
      const catm = src.match(/category: '([^']+)'/);
      const cat = catm ? catm[1] : 'video-glitch-pipelines';
      byCat[cat] = (byCat[cat] || 0) + factory;
      continue;
    }
    const ids = src.match(/^\s{4}id: '[^']+'/gm) || [];
    total += ids.length;
    const catMatches = src.match(/^\s{2,8}category: '[^']+'/gm) || [];
    for (const c of catMatches) {
      const cm = c.match(/category: '([^']+)'/);
      if (cm) byCat[cm[1]] = (byCat[cm[1]] || 0) + 1;
    }
  }
  return { total, byCategory: byCat };
}

const report = {
  modules: countModuleFiles(),
  css: countCssBraces(),
  nodeGraph: { nodeTypes: countNodeLib() },
  audio: {
    modules: countAudioStudio().modules,
    knobs: countAudioStudio().knobs,
    presets: countAudioPresets(),
  },
  tripcam: countTripCam(),
  workflows: countWorkflows(),
  generated: new Date().toISOString(),
};

console.log(JSON.stringify(report, null, 2));

const buildInfoPath = path.join(APP, 'build-info.js');
if (fs.existsSync(buildInfoPath)) {
  let text = fs.readFileSync(buildInfoPath, 'utf8');
  text = text.replace(/modules: \d+/, `modules: ${report.modules}`);
  text = text.replace(/open: \d+, close: \d+/,
    `open: ${report.css.open}, close: ${report.css.close}`);
  fs.writeFileSync(buildInfoPath, text);
  console.error('[generate-changelog] updated build-info.js');
}
