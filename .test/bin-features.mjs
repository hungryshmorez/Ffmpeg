// =============================================================================
// bin-features.mjs — the other "produce a clip → Media Bin" features work now
// -----------------------------------------------------------------------------
// The same missing addBlobToBin that killed datamosh also silently dropped the
// output of the compress-to-target tool and the scene splitter. Both are wasm
// (libx264 / stream-copy) so both are verifiable here by DECODING what lands in
// the bin. This also covers two fixes made along the way:
//   • compress used a two-pass /dev/null encode that ffmpeg.wasm can't do (it
//     wrote an EMPTY file) — now single-pass, bitrate-constrained, audio-guarded
//   • compress bailed when the <video> duration probe came back empty — now it
//     falls back to the ffmpeg container probe
//
//   node .test/bin-features.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8173);
const BASE = process.env.BASE || `http://localhost:${PORT}`;
const USE_EXTERNAL = !!process.env.BASE;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.map': 'application/json', '.ttf': 'font/ttf' };

function startServer() {
  const srv = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const full = normalize(join(ROOT, p));
      if (!full.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
      const data = await readFile(full);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(full)] || 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch { res.writeHead(404).end('not found: ' + req.url); }
  });
  return new Promise((resolve, reject) => { srv.on('error', reject); srv.listen(PORT, () => resolve(srv)); });
}

let server, browser, code = 1;
const checks = [];
const ok = (name, pass, detail) => { checks.push(pass); durable(`  ${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`); };

try {
  if (!USE_EXTERNAL) { server = await startServer(); console.log(`[server] listening on ${BASE}`); }
  browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));

  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.engineReady === true, { timeout: 120000 });
  durable('[boot] engine ready');

  // A 4s / 30fps H.264 seed (video-only → also exercises the compress -an guard).
  await page.evaluate(async () => {
    const SEED = ['-f', 'lavfi', '-i', 'testsrc=duration=4:size=640x360:rate=30',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', 'seed.mp4'];
    await ff.exec(SEED, { raw: true });
    const seed = await ff.readFile('seed.mp4');
    const file = new File([seed], 'seed.mp4', { type: 'video/mp4' });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.querySelector('#file-input');
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
  });

  // decode helper: read a bin entry's blob back through ffmpeg and count frames
  const decodeEntry = (nameRe) => page.evaluate(async (reSrc) => {
    const re = new RegExp(reSrc, 'i');
    const entry = [...(window.state.mediaBin || [])].reverse().find((m) => re.test(m.name));
    if (!entry) return { ok: false, err: 'no matching bin entry' };
    const ab = await (await fetch(entry.blobUrl || entry.url)).arrayBuffer();
    const u8 = new Uint8Array(ab); const bytes = u8.length;
    await ff.writeFile('__d.mp4', u8);
    let buf = ''; const grab = ({ message }) => { buf += message + '\n'; };
    state.ffmpeg.on('log', grab);
    try { await ff.exec(['-hide_banner', '-i', '__d.mp4', '-f', 'null', '-'], { raw: true }); } catch (_) {}
    state.ffmpeg.off('log', grab);
    try { await ff.deleteFile('__d.mp4'); } catch (_) {}
    const all = [...buf.matchAll(/frame=\s*(\d+)/g)];
    return { ok: true, name: entry.name, bytes, frames: all.length ? parseInt(all[all.length - 1][1], 10) : 0 };
  }, nameRe.source);

  // ---- Compress to 1 MB ----
  const comp = await page.evaluate(async () => {
    try { return { r: await window.FFTools.encodeToTargetSize(1, {}) }; }
    catch (e) { return { err: e.message || String(e) }; }
  });
  ok('compress-to-target ran', comp.r && comp.r.ok, comp.err || (comp.r ? `${(comp.r.mb || 0).toFixed?.(3) ?? comp.r.mb} MB` : ''));
  const cd = await decodeEntry(/\(1MB\)/);
  ok('compressed output decodes to real frames', cd.ok && cd.frames >= 100, cd.ok ? `${cd.frames} frames · ${cd.bytes} B` : cd.err);
  ok('compressed output is under the 1 MB target', cd.ok && cd.bytes <= 1024 * 1024, cd.ok ? `${(cd.bytes / 1048576).toFixed(2)} MB` : cd.err);

  // ---- Scene split into 3 clips ----
  const scenes = await page.evaluate(async () => {
    // ensure duration is known (detect-scenes probes in the real flow)
    try { await window.analyzeMedia(window.state.inputFile.virtualName); } catch (_) {}
    const before = (window.state.mediaBin || []).filter((m) => /scene/i.test(m.name)).length;
    try { await window.FFAnalysis.splitScenes([1.5, 3.0]); } catch (e) { return { err: e.message || String(e) }; }
    const names = (window.state.mediaBin || []).filter((m) => /scene/i.test(m.name)).map((m) => m.name);
    return { added: names.length - before, names };
  });
  ok('scene-split produced 3 bin clips', scenes.added === 3, scenes.err || `added ${scenes.added}: ${(scenes.names || []).slice(-3).join(', ')}`);
  const sd = await decodeEntry(/scene 2/);
  ok('a scene clip decodes to real frames', sd.ok && sd.frames > 0, sd.ok ? `${sd.frames} frames · ${sd.bytes} B` : sd.err);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 5 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
