/* =============================================================================
 * v4 PART B1 — WebGL Live Preview
 * -----------------------------------------------------------------------------
 * Overlays a <canvas> on top of the preview <video> and runs a fragment
 * shader that approximates the enabled ffmpeg filters in real time. The
 * final ffmpeg render is still the source of truth — this is a feedback
 * surface so the user can see what they're tweaking.
 *
 * Supported approximations:
 *   - eq       (brightness, contrast, saturation, gamma per channel)
 *   - hue      (hue rotation, saturation)
 *   - colorchannelmixer (3x3 matrix)
 *   - negate
 *   - curves   (1D LUT sampled from the curve points)
 *   - vignette (radial falloff)
 *   - noise    (hash-based per-pixel grain)
 *   - boxblur / gblur (separable)
 *   - chromashift / rgbashift (per-channel UV offset)
 *   - posterize
 *   - edgedetect (Sobel)
 *
 * Temporal effects (lagfun, tmix, tblend, reverse) are NOT previewed. We
 * show a "⚡ Live preview (temporal effects render on export)" badge and
 * a small "~approximate" watermark.
 *
 * Toggle: #webgl-live-toggle. When off, the canvas is hidden and the
 * <video> shows through unchanged.
 * ============================================================================= */

'use strict';

// =============================================================================
// STATE
// =============================================================================
const webgl = {
  ctx: null,                  // WebGL rendering context
  program: null,              // compiled program
  texture: null,              // video frame texture
  vbo: null,                  // quad vertex buffer
  blurFbo: null,              // FBO for separable blur ping-pong
  blurFboW: 0,
  blurFboH: 0,
  raf: 0,                     // requestAnimationFrame handle
  video: null,                // ref to the <video>
  canvas: null,               // ref to the <canvas>
  lastT: 0,                   // last decoded timestamp (skip identical frames)
  uniforms: {},               // current uniform values
  hasTemporalEffects: false,  // flips the badge
  enabled: true,              // controlled by the toggle
};

// =============================================================================
// SHADER SOURCES
// =============================================================================
// Vertex shader: a fullscreen quad. We pack the quad geometry once in JS
// and bind it as a VBO.
const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  // Flip Y so video orientation matches the <video> element.
  v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// Fragment shader: composes brightness/contrast/saturation/gamma, hue
// rotation, colorchannelmixer, negate, curves (via 1D LUT), vignette,
// noise, blur (sampled from a separate pre-pass frame), chromashift,
// rgbashift, posterize, and edgedetect (Sobel).
//
// Blur is handled by a separate "prepass" pass that writes the video
// frame blurred into a small FBO, then the main shader samples that.
// The simpler single-pass approximation (kernel size = strength) is used
// when blurStrength < 1.
//
// All operations are written to compose cleanly with eq/hue (the most
// commonly used filters). The math is in linear-ish RGB. We don't try
// to be a perfect ffmpeg; we try to be USEFUL.
const FS = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;           // the source video frame
uniform sampler2D u_blurTex;       // pre-blurred frame (1/2 size)
uniform float u_useBlur;           // 0 or 1 — blend pre-blurred vs source
uniform vec2  u_texSize;           // width, height of source

// eq
uniform float u_brightness;        // -1..1
uniform float u_contrast;          // 0..2
uniform float u_saturation;        // 0..3
uniform float u_gammaR, u_gammaG, u_gammaB;
uniform float u_useEq;             // 0/1

// hue
uniform float u_hueDeg;            // -180..180
uniform float u_hueSat;            // 0..3
uniform float u_useHue;            // 0/1

// colorchannelmixer
uniform mat3 u_ccm;
uniform float u_useCcm;            // 0/1

// negate
uniform float u_negate;            // 0/1

// curves — points are (x,y) packed into a vec2 array. We sample with
// linear interpolation between adjacent points.
uniform float u_curvesN;           // 0 = no curves, otherwise number of points
uniform vec2  u_curves[16];        // (x,y) control points in 0..1 space

// vignette
uniform float u_vigAmount;         // 0..1
uniform float u_useVignette;       // 0/1

// noise
uniform float u_noiseAmount;       // 0..1
uniform float u_useNoise;          // 0/1
uniform float u_seed;              // animated seed for noise

// chromashift / rgbashift
uniform float u_chroma;            // 0..1
uniform float u_rgba;              // 0..1
uniform float u_useChroma;         // 0/1
uniform float u_useRgba;           // 0/1

// posterize
uniform float u_posterize;         // number of levels (2..32), 0 = off

// edgedetect (Sobel)
uniform float u_edgedetect;        // 0/1

// sRGB helpers (cheap gamma; not strict, but visually correct enough)
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSRGB(vec3 c)   { return pow(c, vec3(1.0/2.2)); }

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// RGB -> HSV -> RGB helpers (standard formulas).
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// Sample the source, optionally with a per-channel UV offset for chromashift.
vec3 sampleSource(vec2 uv) {
  // Blend the (pre-blurred) FBO into the source proportionally.
  vec3 base = texture2D(u_tex, uv).rgb;
  if (u_useBlur > 0.5) {
    vec3 blurred = texture2D(u_blurTex, uv).rgb;
    base = mix(base, blurred, u_useBlur);
  }
  if (u_useChroma > 0.5) {
    float dx = u_chroma * 4.0 / u_texSize.x;
    float r = texture2D(u_tex, uv + vec2( dx, 0.0)).r;
    float b = texture2D(u_tex, uv + vec2(-dx, 0.0)).b;
    base = vec3(r, base.g, b);
  }
  if (u_useRgba > 0.5) {
    float dx = u_rgba * 4.0 / u_texSize.x;
    base.r = texture2D(u_tex, uv + vec2( dx, 0.0)).r;
    base.g = texture2D(u_tex, uv).g;
    base.b = texture2D(u_tex, uv + vec2(-dx, 0.0)).b;
  }
  return base;
}

// Sample the curves LUT for a single channel.
float curvesSample(float v) {
  if (u_curvesN < 1.5) return v;
  if (v <= u_curves[0].x) return u_curves[0].y;
  for (int i = 1; i < 16; i++) {
    if (float(i) >= u_curvesN) break;
    vec2 a = u_curves[i-1];
    vec2 b = u_curves[i];
    if (v <= b.x) {
      float t = (v - a.x) / max(0.0001, (b.x - a.x));
      return mix(a.y, b.y, t);
    }
  }
  return u_curves[int(u_curvesN) - 1].y;
}

void main() {
  vec3 col = sampleSource(v_uv);

  // --- colorchannelmixer (3x3 matrix)
  if (u_useCcm > 0.5) {
    col = u_ccm * col;
  }

  // --- eq
  if (u_useEq > 0.5) {
    // Brightness: add to each channel.
    col = col + vec3(u_brightness);
    // Contrast: scale around 0.5.
    col = (col - 0.5) * u_contrast + 0.5;
    // Saturation: blend with luma.
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(luma), col, u_saturation);
    // Gamma: per-channel.
    col = pow(max(col, 0.0), vec3(1.0/u_gammaR, 1.0/u_gammaG, 1.0/u_gammaB));
  }

  // --- hue rotation
  if (u_useHue > 0.5) {
    vec3 hsv = rgb2hsv(col);
    hsv.x = fract(hsv.x + u_hueDeg / 360.0);
    hsv.y *= u_hueSat;
    col = hsv2rgb(hsv);
  }

  // --- curves
  if (u_curvesN > 0.5) {
    col.r = curvesSample(col.r);
    col.g = curvesSample(col.g);
    col.b = curvesSample(col.b);
  }

  // --- negate
  if (u_negate > 0.5) {
    col = vec3(1.0) - col;
  }

  // --- posterize
  if (u_posterize > 1.5) {
    float p = u_posterize;
    col = floor(col * p) / (p - 1.0);
  }

  // --- vignette
  if (u_useVignette > 0.5) {
    vec2 d = v_uv - vec2(0.5);
    float r = length(d) * 1.4;
    float v = smoothstep(0.8, 0.2, r);
    col *= mix(1.0, v, u_vigAmount);
  }

  // --- noise (per-pixel hash)
  if (u_useNoise > 0.5) {
    float n = hash(v_uv * u_texSize + u_seed) - 0.5;
    col += vec3(n) * u_noiseAmount * 0.5;
  }

  // --- edgedetect (Sobel) — sampled from the source, NOT after the
  //     other transforms. ffmpeg's edgedetect operates on luma, and so
  //     do we.
  if (u_edgedetect > 0.5) {
    vec2 px = 1.0 / u_texSize;
    float tl = dot(texture2D(u_tex, v_uv + vec2(-px.x, -px.y)).rgb, vec3(0.299, 0.587, 0.114));
    float t_ = dot(texture2D(u_tex, v_uv + vec2( 0.0,  -px.y)).rgb, vec3(0.299, 0.587, 0.114));
    float tr = dot(texture2D(u_tex, v_uv + vec2( px.x, -px.y)).rgb, vec3(0.299, 0.587, 0.114));
    float l_ = dot(texture2D(u_tex, v_uv + vec2(-px.x,   0.0)).rgb, vec3(0.299, 0.587, 0.114));
    float r_ = dot(texture2D(u_tex, v_uv + vec2( px.x,   0.0)).rgb, vec3(0.299, 0.587, 0.114));
    float bl = dot(texture2D(u_tex, v_uv + vec2(-px.x,  px.y)).rgb, vec3(0.299, 0.587, 0.114));
    float b_ = dot(texture2D(u_tex, v_uv + vec2( 0.0,   px.y)).rgb, vec3(0.299, 0.587, 0.114));
    float br = dot(texture2D(u_tex, v_uv + vec2( px.x,  px.y)).rgb, vec3(0.299, 0.587, 0.114));
    float gx = -tl - 2.0*l_ - bl + tr + 2.0*r_ + br;
    float gy = -tl - 2.0*t_ - tr + bl + 2.0*b_ + br;
    float edge = clamp(sqrt(gx*gx + gy*gy), 0.0, 1.0);
    col = vec3(1.0 - edge);
  }

  // Clamp and write.
  col = clamp(col, 0.0, 1.0);
  gl_FragColor = vec4(col, 1.0);
}
`;

// Blur shader: a single 9-tap horizontal/vertical separable blur. Run
// twice (H then V) into a small FBO. The main shader then samples that
// FBO when u_useBlur > 0.5.
const BLUR_VS = VS;
const BLUR_FS = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2  u_texSize;
uniform float u_strength;          // 0..1 — controls kernel radius
uniform vec2  u_dir;               // (1,0) for H pass, (0,1) for V pass
void main() {
  vec3 sum = vec3(0.0);
  float weightSum = 0.0;
  float r = u_strength * 6.0;
  for (int i = -6; i <= 6; i++) {
    float t = float(i) / 6.0;
    float w = exp(-t * t * 2.0);
    vec2 off = u_dir * (t * r) / u_texSize;
    sum += texture2D(u_tex, v_uv + off).rgb * w;
    weightSum += w;
  }
  gl_FragColor = vec4(sum / weightSum, 1.0);
}
`;

// =============================================================================
// GL HELPERS
// =============================================================================
function compileShader(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile failed: ' + log);
  }
  return sh;
}
function linkProgram(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('Program link failed: ' + log);
  }
  return p;
}
function getUniforms(gl, program, names) {
  const out = {};
  for (const n of names) out[n] = gl.getUniformLocation(program, n);
  return out;
}

// =============================================================================
// INIT
// =============================================================================
function initWebGLPreview() {
  const canvas = document.getElementById('webgl-preview-canvas');
  if (!canvas) return false;
  const video = document.getElementById('video-preview');
  if (!video) return false;
  webgl.canvas = canvas;
  webgl.video  = video;

  // Try to get a WebGL context. Some platforms (older Android, certain
  // embedded browsers) only expose WebGL 1 — that's what we want.
  const opts = { preserveDrawingBuffer: false, premultipliedAlpha: false, antialias: false };
  // powerPreference: on dual-GPU machines the browser defaults to the
  // integrated chip. Ask for the discrete one. Free performance.
  const _o = Object.assign({ powerPreference: 'high-performance', desynchronized: true }, opts || {});
  const gl = canvas.getContext('webgl2', _o)
          || canvas.getContext('webgl', _o)
          || canvas.getContext('experimental-webgl', _o);
  if (!gl) {
    logToConsole('warn', 'WebGL not available — live preview disabled.');
    document.body.classList.remove('webgl-live-on');
    return false;
  }
  webgl.ctx = gl;

  // F3 — recover from WebGL context loss instead of freezing on a dead context.
  if (!canvas._previewCtxWired) {
    canvas._previewCtxWired = true;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();                         // REQUIRED for the context to be restorable
      webgl.contextLost = true;
      if (webgl.raf) { cancelAnimationFrame(webgl.raf); webgl.raf = 0; }
      try { console.warn('[webgl-preview] context lost — halting'); } catch (_) {}
    }, false);
    canvas.addEventListener('webglcontextrestored', () => {
      try { console.warn('[webgl-preview] context restored — rebuilding'); } catch (_) {}
      webgl.contextLost = false;
      webgl.program = null; webgl.vbo = null; webgl.texture = null; webgl.blurFbo = null; webgl.blurTex = null;
      if (initWebGLPreview() && webgl.enabled) startWebGLLoop();
    }, false);
  }

  try {
    const vs = compileShader(gl, gl.VERTEX_SHADER, VS);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FS);
    webgl.program = linkProgram(gl, vs, fs);
  } catch (e) {
    logToConsole('err', 'WebGL preview: ' + e.message);
    return false;
  }

  // Quad geometry: a pair of triangles covering NDC (-1..1).
  const verts = new Float32Array([
    -1, -1,   1, -1,  -1,  1,
    -1,  1,   1, -1,   1,  1,
  ]);
  webgl.vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, webgl.vbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

  // Source frame texture.
  webgl.texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, webgl.texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // Locate the attribute and the uniforms once.
  const aPos = gl.getAttribLocation(webgl.program, 'a_pos');
  webgl.uniforms = getUniforms(gl, webgl.program, [
    'u_tex', 'u_blurTex', 'u_useBlur', 'u_texSize',
    'u_brightness', 'u_contrast', 'u_saturation',
    'u_gammaR', 'u_gammaG', 'u_gammaB', 'u_useEq',
    'u_hueDeg', 'u_hueSat', 'u_useHue',
    'u_ccm', 'u_useCcm',
    'u_negate',
    'u_curvesN', 'u_curves[0]', 'u_curves[1]', 'u_curves[2]', 'u_curves[3]',
    'u_curves[4]', 'u_curves[5]', 'u_curves[6]', 'u_curves[7]',
    'u_curves[8]', 'u_curves[9]', 'u_curves[10]', 'u_curves[11]',
    'u_curves[12]', 'u_curves[13]', 'u_curves[14]', 'u_curves[15]',
    'u_vigAmount', 'u_useVignette',
    'u_noiseAmount', 'u_useNoise', 'u_seed',
    'u_chroma', 'u_rgba', 'u_useChroma', 'u_useRgba',
    'u_posterize', 'u_edgedetect',
  ]);
  webgl.aPos = aPos;

  // Compile the blur program. Used for boxblur / gblur.
  try {
    const bvs = compileShader(gl, gl.VERTEX_SHADER, BLUR_VS);
    const bfs = compileShader(gl, gl.FRAGMENT_SHADER, BLUR_FS);
    webgl.blurProgram = linkProgram(gl, bvs, bfs);
    webgl.blurUniforms = getUniforms(gl, webgl.blurProgram, [
      'u_tex', 'u_texSize', 'u_strength', 'u_dir',
    ]);
    webgl.blurFbo = gl.createFramebuffer();
    webgl.blurTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, webgl.blurTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, webgl.blurFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT_0, gl.TEXTURE_2D, webgl.blurTex, 0);
  } catch (e) {
    // Blur is non-critical. We can still preview without it.
    logToConsole('warn', 'WebGL blur program failed: ' + e.message);
    webgl.blurProgram = null;
  }

  // Hook the toggle.
  const toggle = document.getElementById('webgl-live-toggle');
  if (toggle) {
    webgl.enabled = !!toggle.checked;
    toggle.addEventListener('change', () => {
      webgl.enabled = !!toggle.checked;
      document.body.classList.toggle('webgl-live-on', webgl.enabled);
      // Show / hide the watermark + temporal badge.
      const wm = document.getElementById('webgl-watermark');
      const tb = document.getElementById('webgl-temporal-badge');
      if (wm) wm.hidden = !webgl.enabled;
      if (tb) tb.hidden = !webgl.enabled || !webgl.hasTemporalEffects;
      if (webgl.enabled) startWebGLLoop();
    });
  }
  document.body.classList.add('webgl-live-on');
  const wm = document.getElementById('webgl-watermark');
  if (wm) wm.hidden = false;
  startWebGLLoop();
  return true;
}

function startWebGLLoop() {
  if (webgl.raf) cancelAnimationFrame(webgl.raf);
  const loop = () => {
    webgl.raf = requestAnimationFrame(loop);
    drawWebGLFrame();
  };
  webgl.raf = requestAnimationFrame(loop);
}

// =============================================================================
// FRAME LOOP
// =============================================================================
function drawWebGLFrame() {
  if (!webgl.enabled || !webgl.ctx || !webgl.canvas || !webgl.video) return;
  if (webgl.contextLost || (webgl.ctx.isContextLost && webgl.ctx.isContextLost())) return;  // F3
  const video = webgl.video;
  // We need a frame to draw. readyState >= HAVE_CURRENT_DATA (2) means
  // there is data for the current playback position.
  if (!video.src || video.readyState < 2) {
    // Clear the canvas so the underlying video shows through.
    const gl = webgl.ctx;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  // Skip identical frames (e.g. paused). currentTime is in seconds.
  const tNow = video.currentTime;
  if (tNow === webgl.lastT && !video.paused === false) return;
  webgl.lastT = tNow;

  // Resize the canvas to the video's natural size. We cap to viewport
  // size so a 4K source doesn't try to allocate a 4K canvas.
  const wrap = document.getElementById('preview-wrapper');
  const maxW = (wrap && wrap.clientWidth)  || 1280;
  const maxH = (wrap && wrap.clientHeight) || 720;
  const ar = (video.videoWidth && video.videoHeight) ? (video.videoWidth / video.videoHeight) : 1;
  let W = video.videoWidth || 1280;
  let H = video.videoHeight || 720;
  if (W > maxW) { H = Math.round(maxW / ar); W = maxW; }
  if (H > maxH) { W = Math.round(maxH * ar); H = maxH; }
  if (webgl.canvas.width !== W || webgl.canvas.height !== H) {
    webgl.canvas.width  = W;
    webgl.canvas.height = H;
    if (wrap) {
      webgl.canvas.style.width  = '100%';
      webgl.canvas.style.height = '100%';
    }
  }

  const gl = webgl.ctx;
  gl.viewport(0, 0, W, H);

  // Pull enabled-filter settings from the live DOM controls. This is
  // the entire "telemetry" the preview cares about.
  const u = collectWebGLUniforms();

  // Optional blur prepass.
  let useBlur = 0;
  if (u.blurStrength > 0.01 && webgl.blurProgram) {
    useBlur = 1;
    runBlurPrepass(W, H, u.blurStrength);
  }

  // Upload the video frame.
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, webgl.texture);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  } catch (_) {
    // texImage2D can throw on cross-origin frames or zero-size videos.
    return;
  }

  // Bind the blur texture to unit 1 if used.
  if (useBlur > 0.5) {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, webgl.blurTex);
  }

  // Use the main program.
  gl.useProgram(webgl.program);
  gl.bindBuffer(gl.ARRAY_BUFFER, webgl.vbo);
  gl.enableVertexAttribArray(webgl.aPos);
  gl.vertexAttribPointer(webgl.aPos, 2, gl.FLOAT, false, 0, 0);

  // Set all the uniforms.
  setUniforms(gl, u, useBlur, W, H);
  // Show the temporal badge if any temporal filter is enabled.
  updateTemporalBadge(u);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function setUniforms(gl, u, useBlur, W, H) {
  const U = webgl.uniforms;
  gl.uniform1i(U['u_tex'], 0);
  if (useBlur > 0.5) gl.uniform1i(U['u_blurTex'], 1);
  gl.uniform1f(U['u_useBlur'], useBlur);
  gl.uniform2f(U['u_texSize'], W, H);

  gl.uniform1f(U['u_brightness'], u.brightness);
  gl.uniform1f(U['u_contrast'],   u.contrast);
  gl.uniform1f(U['u_saturation'], u.saturation);
  gl.uniform1f(U['u_gammaR'],     u.gammaR);
  gl.uniform1f(U['u_gammaG'],     u.gammaG);
  gl.uniform1f(U['u_gammaB'],     u.gammaB);
  gl.uniform1f(U['u_useEq'],      u.useEq);

  gl.uniform1f(U['u_hueDeg'], u.hueDeg);
  gl.uniform1f(U['u_hueSat'], u.hueSat);
  gl.uniform1f(U['u_useHue'], u.useHue);

  gl.uniformMatrix3fv(U['u_ccm'], false, u.ccm);
  gl.uniform1f(U['u_useCcm'], u.useCcm);
  gl.uniform1f(U['u_negate'], u.negate);

  // Curves. We always pass all 16 slots; u_curvesN tells the shader how
  // many to actually use.
  gl.uniform1f(U['u_curvesN'], u.curvesN);
  for (let i = 0; i < 16; i++) {
    const p = u.curves[i] || [0, 0];
    gl.uniform2f(U[`u_curves[${i}]`], p[0], p[1]);
  }

  gl.uniform1f(U['u_vigAmount'],   u.vigAmount);
  gl.uniform1f(U['u_useVignette'], u.useVignette);

  gl.uniform1f(U['u_noiseAmount'], u.noiseAmount);
  gl.uniform1f(U['u_useNoise'],    u.useNoise);
  // u_seed animates over time so noise doesn't look static when the
  // video is paused.
  gl.uniform1f(U['u_seed'], (performance.now() % 100000) / 1000.0);

  gl.uniform1f(U['u_chroma'],     u.chroma);
  gl.uniform1f(U['u_rgba'],       u.rgba);
  gl.uniform1f(U['u_useChroma'],  u.useChroma);
  gl.uniform1f(U['u_useRgba'],    u.useRgba);

  gl.uniform1f(U['u_posterize'],  u.posterize);
  gl.uniform1f(U['u_edgedetect'], u.edgedetect);
}

function runBlurPrepass(W, H, strength) {
  const gl = webgl.ctx;
  // Resize the FBO if necessary. The FBO lives at half-res to keep this
  // cheap on big frames.
  const fW = Math.max(1, Math.floor(W / 2));
  const fH = Math.max(1, Math.floor(H / 2));
  if (webgl.blurFboW !== fW || webgl.blurFboH !== fH) {
    gl.bindTexture(gl.TEXTURE_2D, webgl.blurTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fW, fH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    webgl.blurFboW = fW;
    webgl.blurFboH = fH;
  }
  gl.useProgram(webgl.blurProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, webgl.vbo);
  gl.enableVertexAttribArray(webgl.aPos);
  gl.vertexAttribPointer(webgl.aPos, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, webgl.texture);
  // Re-upload the current video frame to TEXTURE0 (in case it was
  // uploaded to a different unit by the main pass).
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, webgl.video);
  } catch (_) {}
  gl.uniform1i(webgl.blurUniforms['u_tex'], 0);
  gl.uniform2f(webgl.blurUniforms['u_texSize'], fW, fH);
  gl.uniform1f(webgl.blurUniforms['u_strength'], strength);
  // First pass: horizontal, into the FBO.
  gl.bindFramebuffer(gl.FRAMEBUFFER, webgl.blurFbo);
  gl.viewport(0, 0, fW, fH);
  gl.uniform2f(webgl.blurUniforms['u_dir'], 1, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  // Second pass: vertical, sampling from the FBO, drawing to the default
  // framebuffer. We use TEXTURE1 for the input here.
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, webgl.blurTex);
  gl.uniform1i(webgl.blurUniforms['u_tex'], 1);
  gl.uniform2f(webgl.blurUniforms['u_texSize'], fW, fH);
  gl.bindFramebuffer(gl.FRAMEBUFFER, webgl.blurFbo);
  gl.uniform2f(webgl.blurUniforms['u_dir'], 0, 1);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  // Re-bind TEXTURE0 for the main pass.
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, webgl.texture);
}

// =============================================================================
// UNIFORM COLLECTION (read live controls)
// =============================================================================
function valOf(id, def) {
  const el = document.getElementById(id);
  if (!el) return def;
  const v = parseFloat(el.value);
  return isFinite(v) ? v : def;
}
function checkedOf(id) {
  const el = document.getElementById(id);
  return !!(el && el.checked);
}
// The Section X toggles are <input class="section-enable" id="enable-N">.
function sectionEnabled(n) {
  const el = document.getElementById('enable-' + n);
  return !!(el && el.checked);
}

function collectWebGLUniforms() {
  // Section 7 (color)
  const useEq = sectionEnabled(7) && (valOf('eq-brightness', 0) !== 0
    || valOf('eq-contrast', 1) !== 1
    || valOf('eq-saturation', 1) !== 1
    || valOf('eq-gamma', 1) !== 1
    || valOf('eq-gamma-r', 1) !== 1
    || valOf('eq-gamma-g', 1) !== 1
    || valOf('eq-gamma-b', 1) !== 1);
  // Hue (within section 7 too)
  const useHue = sectionEnabled(7) && (valOf('hue-h', 0) !== 0 || valOf('hue-s', 1) !== 1);
  // Colorchannelmixer
  const useCcm = sectionEnabled(8);
  // Negate (also section 7 in v3)
  const negate = sectionEnabled(7) && checkedOf('negate');
  // Curves (also section 7). For curves we just sample the prebaked
  // identity LUT — a real implementation would need to parse the curve
  // preset (e.g. "vintage") and produce control points.
  // We expose a single set of "control points" derived from the
  // 'curves-preset' <select>, if any.
  let curvesN = 0;
  const curves = new Array(16).fill(null).map(() => [0, 0]);
  if (sectionEnabled(7)) {
    const preset = (document.getElementById('curves-preset') || {}).value || 'none';
    const pts = curvesPresetPoints(preset);
    if (pts) {
      curvesN = pts.length;
      for (let i = 0; i < pts.length && i < 16; i++) curves[i] = pts[i];
    }
  }
  // Vignette (section 16, control id 'vignette' is a checkbox).
  const vig = sectionEnabled(16) && checkedOf('vignette');
  const vigAmount = valOf('vignette-angle', 0.628) / Math.PI;        // 0..2 → 0..1
  // Noise (section 13, control id 'add-noise' is the enable checkbox).
  const noise = sectionEnabled(13) && (checkedOf('add-noise') || checkedOf('grain-overlay'));
  const noiseAmount = valOf('noise-strength', 10) / 100.0;
  // Chroma / rgba shift (section 19).
  // We use the standard named controls if they exist; otherwise we
  // fall back to a small default amount driven by the section toggle.
  const chroma = sectionEnabled(19) && (checkedOf('chromashift-enable') || checkedOf('chromashift'));
  const chromaAmount = valOf('chromashift-amount', 0.05);
  const rgba = sectionEnabled(19) && (checkedOf('rgbashift-enable') || checkedOf('rgbashift'));
  const rgbaAmount = valOf('rgbashift-amount', 0.05);
  // Blur (section 9, control id 'blur-strength' is the strength).
  const blur = sectionEnabled(9) && valOf('blur-strength', 0) > 0;
  const blurStrength = Math.min(1, valOf('blur-strength', 0) / 20.0);
  // Posterize / edge (section 16: 'posterize' is a slider, 'edge-detect'
  // is a checkbox).
  const posterize = sectionEnabled(16) && checkedOf('posterize-enable')
    ? valOf('posterize', 8) : 0;
  const edgedetect = sectionEnabled(16) && (checkedOf('edge-detect') || checkedOf('sobel')) ? 1 : 0;
  // Temporal effects that we explicitly DON'T preview live.
  // The control IDs in the actual HTML are g-lagfun-enable / g-tmix-enable
  // / g-tblend-enable (glitch section), not lagfun-enable etc.
  const hasTemporal = (sectionEnabled(6) && (checkedOf('rev-video') || checkedOf('rev-audio')))
                   || checkedOf('g-lagfun-enable')
                   || checkedOf('g-tmix-enable')
                   || checkedOf('g-tblend-enable');

  return {
    brightness: valOf('eq-brightness', 0),
    contrast:   valOf('eq-contrast', 1),
    saturation: valOf('eq-saturation', 1),
    gammaR:     valOf('eq-gamma-r', 1) * valOf('eq-gamma', 1),
    gammaG:     valOf('eq-gamma-g', 1) * valOf('eq-gamma', 1),
    gammaB:     valOf('eq-gamma-b', 1) * valOf('eq-gamma', 1),
    useEq:      useEq ? 1 : 0,
    hueDeg:     valOf('hue-h', 0),
    hueSat:     valOf('hue-s', 1),
    useHue:     useHue ? 1 : 0,
    ccm: ccmMatrix(),
    useCcm:     useCcm ? 1 : 0,
    negate:     negate ? 1 : 0,
    curvesN, curves,
    vigAmount:  vig ? vigAmount : 0,
    useVignette: vig ? 1 : 0,
    noiseAmount: noise ? noiseAmount : 0,
    useNoise:    noise ? 1 : 0,
    chroma:      chroma ? chromaAmount : 0,
    useChroma:   chroma ? 1 : 0,
    rgba:        rgba ? rgbaAmount : 0,
    useRgba:     rgba ? 1 : 0,
    posterize:   posterize,
    edgedetect:  edgedetect,
    blurStrength: blur ? blurStrength : 0,
    hasTemporal,
  };
}

function ccmMatrix() {
  // Section 8 — 9 numbers. ffmpeg uses rr/rg/rb/gr/gg/gb/br/bg/bb.
  // We build a mat3 in column-major order for WebGL.
  const rr = valOf('ccm-rr', 1), rg = valOf('ccm-rg', 0), rb = valOf('ccm-rb', 0);
  const gr = valOf('ccm-gr', 0), gg = valOf('ccm-gg', 1), gb = valOf('ccm-gb', 0);
  const br = valOf('ccm-br', 0), bg = valOf('ccm-bg', 0), bb = valOf('ccm-bb', 1);
  return new Float32Array([
    rr, gr, br,
    rg, gg, bg,
    rb, gb, bb,
  ]);
}

// A handful of common curves presets expressed as 4 control points
// (start, mid-low, mid-high, end) in normalized 0..1 space. The shader
// linearly interpolates between adjacent points. The preset names
// match the <option value="..."> in the curves-preset <select>.
function curvesPresetPoints(preset) {
  switch (preset) {
    case 'none':              return null;            // identity
    case 'vintage':           return [[0, 0.05], [0.33, 0.30], [0.66, 0.70], [1, 0.95]];
    case 'cross_process':     return [[0, 0.10], [0.33, 0.25], [0.66, 0.75], [1, 0.95]];
    case 'darker':            return [[0, 0], [0.33, 0.20], [0.66, 0.55], [1, 0.85]];
    case 'lighter':           return [[0, 0.15], [0.33, 0.45], [0.66, 0.80], [1, 1]];
    case 'increase_contrast': return [[0, 0], [0.33, 0.20], [0.66, 0.80], [1, 1]];
    case 'strong_contrast':   return [[0, 0], [0.33, 0.10], [0.66, 0.90], [1, 1]];
    case 'negative':          return [[0, 1], [0.33, 0.66], [0.66, 0.33], [1, 0]];
    default:                  return null;
  }
}

function updateTemporalBadge(u) {
  const tb = document.getElementById('webgl-temporal-badge');
  if (!tb) return;
  const show = u.hasTemporal && webgl.enabled;
  tb.hidden = !show;
  webgl.hasTemporalEffects = show;
}

// =============================================================================
// BOOT
// =============================================================================
function bootWebGLPreview() {
  // Defer the GL init until the document has rendered the <video> +
  // <canvas>. We retry once if the elements aren't there yet (e.g. COI
  // service worker is still reloading the page into an isolated context).
  if (!document.getElementById('webgl-preview-canvas')) {
    return setTimeout(bootWebGLPreview, 50);
  }
  if (!initWebGLPreview()) {
    // Disable the toggle and leave the canvas hidden.
    const t = document.getElementById('webgl-live-toggle');
    if (t) { t.disabled = true; t.checked = false; }
    document.body.classList.remove('webgl-live-on');
  }
}

// Hook the boot. We attach to DOMContentLoaded if the document is still
// loading; otherwise we boot immediately.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootWebGLPreview);
} else {
  bootWebGLPreview();
}
