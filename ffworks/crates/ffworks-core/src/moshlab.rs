//! Mosh lab: real motion-vector datamosh with FFglitch (https://ffglitch.org, GPL, run as separate programs, never linked).
//!
//! The classic datamosh preset only drops keyframes. This edits the *motion vectors* inside the compressed stream, which
//! stock FFmpeg cannot do. It is a lab, not a live effect: the clip's source range is turned into a **new file** through a
//! disposable lossy MPEG-4 intermediate (FFglitch edits MPEG-4 Part 2, MPEG-2 and MJPEG, not H.264), the vectors are
//! rewritten, and the result is stored losslessly (FFV1) so it can be imported and placed like any other media. Originals
//! are never touched.
//!
//! Pipeline: `ffmpeg` (decode, scale to project size, raw frames) → `ffgac` (all-P MPEG-4 with a wide vector range) →
//! `ffedit` (script rewrites vectors; or applies another clip's vectors) → `ffmpeg` (decode to FFV1).

use crate::error::{Error, Result};
use crate::jobs::{kill_pid, CancelToken};
use crate::process::{explain_failure, suppress_console_window, Tools};
use crate::time::{Fps, Rational};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Environment variable naming the folder that holds `ffedit` and `ffgac`.
pub const ENV_DIR: &str = "FFWORKS_FFGLITCH";

/// Vectors the intermediate can hold (`-fcode 6`: ±1024 half-pixel units); scripts clamp to this.
const MAX_VECTOR: i32 = 1000;

#[derive(Clone, Debug, PartialEq)]
pub struct GlitchTools {
    pub ffedit: PathBuf,
    pub ffgac: PathBuf,
}

impl GlitchTools {
    /// Where the tools are: `dir` (a saved setting, or the folder shipped with the installer) first, then the folder named
    /// by [`ENV_DIR`], then `PATH`. None when FFglitch is not installed.
    pub fn discover(dir: Option<&Path>) -> Option<GlitchTools> {
        let exe = |n: &str| if cfg!(windows) { format!("{n}.exe") } else { n.to_string() };
        let in_dir = |d: &Path| {
            let (a, b) = (d.join(exe("ffedit")), d.join(exe("ffgac")));
            (a.is_file() && b.is_file()).then_some(GlitchTools { ffedit: a, ffgac: b })
        };
        if let Some(t) = dir.filter(|d| !d.as_os_str().is_empty()).and_then(in_dir) {
            return Some(t);
        }
        if let Some(t) = std::env::var_os(ENV_DIR).map(PathBuf::from).and_then(|d| in_dir(&d)) {
            return Some(t);
        }
        std::env::split_paths(&std::env::var_os("PATH")?).find_map(|d| in_dir(&d))
    }
}

/// A stretch of one source file.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Source {
    pub path: PathBuf,
    pub start: Rational,
    pub duration: Rational,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Mode {
    /// Multiply every motion vector: movement overshoots and the error compounds frame after frame.
    Amplify { factor: f64 },
    /// Add a constant push to every vector (half-pixel units): the picture slides while its own movement continues.
    Drift { x: i32, y: i32 },
    /// Move this picture with the motion of another clip (same length is used; the shorter of the two wins).
    Transfer { donor: Source },
    /// One of the vector effects in [`FX`] (mirror, noise, shake, zoom …); `params` holds that effect's numbers by id, anything
    /// left out takes its default.
    Fx { fx: String, params: serde_json::Map<String, serde_json::Value> },
}

/// One number a vector effect takes.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct FxParam {
    pub id: &'static str,
    pub label: &'static str,
    pub min: f64,
    pub max: f64,
    pub default: f64,
    pub step: f64,
}

/// A motion-vector effect: a script over the vectors of every predicted frame.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct FxDef {
    pub id: &'static str,
    pub name: &'static str,
    pub about: &'static str,
    pub params: &'static [FxParam],
}

const fn num(id: &'static str, label: &'static str, min: f64, max: f64, default: f64, step: f64) -> FxParam {
    FxParam { id, label, min, max, default, step }
}
const SEED: FxParam = num("seed", "Random seed", 0.0, 1_000_000.0, 1.0, 1.0);

/// The vector effects (the techniques of Datamosher Pro's FFglitch effects, reimplemented as our own scripts; see
/// `THIRD_PARTY_NOTICES.md`). Vectors are in half-pixel units; a P-frame block is predicted from the previous picture at its
/// position plus its vector, so errors keep compounding frame after frame. That compounding *is* the look.
pub const FX: &[FxDef] = &[
    FxDef { id: "mirror", name: "Mirror", about: "Horizontal movement is reversed: everything that moves left moves right", params: &[] },
    FxDef { id: "noise", name: "Noise", about: "Every block gets a random push: a noisy, grainy mosh", params: &[num("amount", "Push (half-pixels)", 1.0, 64.0, 8.0, 1.0), SEED] },
    FxDef { id: "shake", name: "Shake", about: "The whole picture is thrown about a little differently every frame", params: &[num("amount", "Shake (half-pixels)", 1.0, 64.0, 12.0, 1.0), SEED] },
    FxDef { id: "vibrate", name: "Vibrate", about: "Some blocks move the opposite way, chosen at random every frame", params: &[num("share", "Share of blocks", 0.05, 1.0, 0.5, 0.05), SEED] },
    FxDef { id: "zoom", name: "Zoom", about: "Blocks are pushed away from the centre (or toward it with a negative number): the picture zooms as it moshes", params: &[num("strength", "Zoom (half-pixels at the edge)", -32.0, 32.0, 3.0, 0.5)] },
    FxDef { id: "stretch", name: "Stretch", about: "Movement is scaled differently across and down: smears one way", params: &[num("x", "Across ×", -8.0, 8.0, 2.0, 0.5), num("y", "Down ×", -8.0, 8.0, 1.0, 0.5)] },
    FxDef { id: "shear", name: "Shear", about: "Movement across grows from the top to the bottom: the picture tilts as it moshes", params: &[num("strength", "Tilt (half-pixels at the edge)", -32.0, 32.0, 4.0, 0.5)] },
    FxDef { id: "shift", name: "Shift", about: "A random share of blocks is pushed downward every frame", params: &[num("amount", "Push (half-pixels)", 1.0, 64.0, 16.0, 1.0), num("share", "Share of blocks", 0.05, 1.0, 0.3, 0.05), SEED] },
    FxDef { id: "stop", name: "Stop", about: "All movement is removed: only the colour changes keep arriving, so the old picture freezes in place", params: &[] },
    FxDef { id: "fluid", name: "Fluid", about: "Neighbouring blocks are averaged: movement turns smooth and liquid", params: &[num("passes", "Smoothing passes", 1.0, 8.0, 2.0, 1.0)] },
    FxDef { id: "delay", name: "Delay", about: "Each frame moves the way the picture did a few frames ago", params: &[num("frames", "Frames behind", 1.0, 60.0, 8.0, 1.0)] },
    FxDef { id: "sink", name: "Sink", about: "Blocks are pushed downward, more toward the bottom: the picture melts and slides down", params: &[num("strength", "Sink (half-pixels at the bottom)", -32.0, 32.0, 6.0, 0.5)] },
    FxDef { id: "slam", name: "Slam zoom", about: "A zoom that builds up over a run of frames then snaps back, over and over", params: &[num("strength", "Zoom at the peak (half-pixels at the edge)", -32.0, 32.0, 8.0, 0.5), num("period", "Frames per slam", 2.0, 240.0, 25.0, 1.0)] },
    FxDef { id: "slice", name: "Slice", about: "Alternate bands of blocks are pushed opposite ways across: the picture shears into strips", params: &[num("amount", "Push (half-pixels)", 1.0, 64.0, 12.0, 1.0), num("band", "Band height (block rows)", 1.0, 30.0, 2.0, 1.0)] },
    FxDef { id: "echo", name: "Echo", about: "Each frame keeps part of the previous frame's movement: movement lingers and builds into long trails", params: &[num("mix", "How much carries over", 0.0, 0.98, 0.8, 0.02)] },
];

/// The effect's numbers with defaults filled in, every one range-checked; unknown ids are refused.
pub fn resolve_fx(fx: &str, params: &serde_json::Map<String, serde_json::Value>) -> Result<serde_json::Map<String, serde_json::Value>> {
    let def = FX.iter().find(|d| d.id == fx).ok_or_else(|| Error::validation(format!("unknown motion effect '{fx}'")))?;
    if let Some(extra) = params.keys().find(|k| !def.params.iter().any(|p| p.id == k.as_str())) {
        return Err(Error::validation(format!("{} has no setting called '{extra}'", def.name)));
    }
    let mut out = serde_json::Map::new();
    out.insert("fx".into(), fx.into());
    for p in def.params {
        let v = match params.get(p.id) {
            None => p.default,
            Some(v) => v.as_f64().filter(|v| v.is_finite()).ok_or_else(|| Error::validation(format!("{} must be a number", p.label)))?,
        };
        if !(p.min..=p.max).contains(&v) {
            return Err(Error::validation(format!("{} must be from {} to {}", p.label, p.min, p.max)));
        }
        out.insert(p.id.into(), v.into());
    }
    Ok(out)
}

#[derive(Clone, Debug)]
pub struct Request {
    pub source: Source,
    pub mode: Mode,
    pub width: u32,
    pub height: u32,
    pub fps: Fps,
    /// The finished FFV1 file (`.mkv`).
    pub output: PathBuf,
}

const AMPLIFY_JS: &str = r#"
let factor = 2;
export function setup(args) {
  // FFglitch hands the -sp JSON over as args.params
  const p = args && args.params;
  if (p && p.factor !== undefined) factor = p.factor;
  return { features: ["mv"], mb_type: false };
}
export function glitch_frame(frame) {
  const fwd = frame.mv?.forward;
  if (!fwd) return;
  for (let r = 0; r < fwd.length; r++) {
    const row = fwd[r];
    for (let c = 0; c < row.length; c++) {
      const mv = row[c];
      if (mv === null) continue;
      mv[0] = Math.max(-MAX, Math.min(MAX, Math.round(mv[0] * factor)));
      mv[1] = Math.max(-MAX, Math.min(MAX, Math.round(mv[1] * factor)));
    }
  }
}
"#;

const DRIFT_JS: &str = r#"
let dx = 0, dy = 0;
export function setup(args) {
  const p = args && args.params;
  if (p) { dx = p.x || 0; dy = p.y || 0; }
  return { features: ["mv"], mb_type: false };
}
export function glitch_frame(frame) {
  const fwd = frame.mv?.forward;
  if (!fwd) return;
  for (let r = 0; r < fwd.length; r++) {
    const row = fwd[r];
    for (let c = 0; c < row.length; c++) {
      const mv = row[c];
      if (mv === null) continue;
      mv[0] = Math.max(-MAX, Math.min(MAX, mv[0] + dx));
      mv[1] = Math.max(-MAX, Math.min(MAX, mv[1] + dy));
    }
  }
}
"#;

/// All vector effects in one script; `args.params.fx` picks one. FFglitch arrays are indexable but not iterable, so loops are
/// indexed; `rnd()` is a seeded generator so the same settings always give the same picture.
const FX_JS: &str = r#"
let P = { fx: "stop" };
let rnd = Math.random;
let history = [];
let frameNo = 0;
let carry = null;
function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clamp(v) { return Math.max(-MAX, Math.min(MAX, Math.round(v))); }
export function setup(args) {
  const p = args && args.params;
  if (p) {
    P = p;
    // numbers arrive as strings (FFglitch's -sp JSON has no floating point)
    const names = ["amount", "seed", "share", "strength", "x", "y", "passes", "frames", "period", "band", "mix"];
    for (let i = 0; i < names.length; i++) if (P[names[i]] !== undefined) P[names[i]] = Number(P[names[i]]);
  }
  rnd = seeded(P.seed === undefined ? 1 : P.seed);
  return { features: ["mv"], mb_type: false };
}
function snapshot(fwd, rows) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    const row = fwd[r], line = [];
    for (let c = 0; c < row.length; c++) line.push(row[c] === null ? null : [row[c][0], row[c][1]]);
    out.push(line);
  }
  return out;
}
function fluid(fwd, rows) {
  let cur = snapshot(fwd, rows);
  for (let pass = 0; pass < P.passes; pass++) {
    const next = [];
    for (let r = 0; r < rows; r++) {
      const line = [];
      for (let c = 0; c < cur[r].length; c++) {
        if (cur[r][c] === null) { line.push(null); continue; }
        let sx = 0, sy = 0, n = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || rr >= rows || cc < 0 || cc >= cur[rr].length || cur[rr][cc] === null) continue;
            sx += cur[rr][cc][0]; sy += cur[rr][cc][1]; n++;
          }
        }
        line.push([sx / n, sy / n]);
      }
      next.push(line);
    }
    cur = next;
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cur[r].length; c++) {
      if (cur[r][c] === null || fwd[r][c] === null) continue;
      fwd[r][c][0] = clamp(cur[r][c][0]);
      fwd[r][c][1] = clamp(cur[r][c][1]);
    }
  }
}
function delay(fwd, rows) {
  history.push(snapshot(fwd, rows));
  if (history.length > P.frames + 1) history.shift();
  if (history.length <= P.frames) return;
  const old = history[0];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < fwd[r].length; c++) {
      if (fwd[r][c] === null || old[r][c] === null) continue;
      fwd[r][c][0] = clamp(old[r][c][0]);
      fwd[r][c][1] = clamp(old[r][c][1]);
    }
  }
}
function echo(fwd, rows) {
  const cur = snapshot(fwd, rows);
  if (carry !== null) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cur[r].length; c++) {
        if (cur[r][c] === null || carry[r][c] === null) continue;
        cur[r][c][0] = cur[r][c][0] * (1 - P.mix) + carry[r][c][0] * P.mix;
        cur[r][c][1] = cur[r][c][1] * (1 - P.mix) + carry[r][c][1] * P.mix;
      }
    }
  }
  carry = cur;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cur[r].length; c++) {
      if (cur[r][c] === null || fwd[r][c] === null) continue;
      fwd[r][c][0] = clamp(cur[r][c][0]);
      fwd[r][c][1] = clamp(cur[r][c][1]);
    }
  }
}
export function glitch_frame(frame) {
  const fwd = frame.mv?.forward;
  if (!fwd) return;
  const rows = fwd.length;
  const fx = P.fx;
  const n = frameNo++;
  if (fx === "fluid") { fluid(fwd, rows); return; }
  if (fx === "delay") { delay(fwd, rows); return; }
  if (fx === "echo") { echo(fwd, rows); return; }
  const slam = fx === "slam" ? P.strength * ((n % P.period) / P.period) : 0;
  const jx = fx === "shake" ? (rnd() * 2 - 1) * P.amount : 0;
  const jy = fx === "shake" ? (rnd() * 2 - 1) * P.amount : 0;
  for (let r = 0; r < rows; r++) {
    const row = fwd[r];
    const cols = row.length;
    for (let c = 0; c < cols; c++) {
      const mv = row[c];
      if (mv === null) continue;
      const nx = ((c + 0.5) / cols) * 2 - 1;
      const ny = ((r + 0.5) / rows) * 2 - 1;
      let x = mv[0], y = mv[1];
      if (fx === "mirror") x = -x;
      else if (fx === "noise") { x += (rnd() * 2 - 1) * P.amount; y += (rnd() * 2 - 1) * P.amount; }
      else if (fx === "shake") { x += jx; y += jy; }
      else if (fx === "vibrate") { if (rnd() < P.share) { x = -x; y = -y; } }
      else if (fx === "zoom") { x -= nx * P.strength; y -= ny * P.strength; }
      else if (fx === "stretch") { x *= P.x; y *= P.y; }
      else if (fx === "shear") { x += ny * P.strength; }
      else if (fx === "shift") { if (rnd() < P.share) y -= P.amount; }
      else if (fx === "stop") { x = 0; y = 0; }
      else if (fx === "sink") { y -= ((ny + 1) / 2) * P.strength; }
      else if (fx === "slam") { x -= nx * slam; y -= ny * slam; }
      else if (fx === "slice") { x += (Math.floor(r / P.band) % 2 === 0 ? 1 : -1) * P.amount; }
      mv[0] = clamp(x);
      mv[1] = clamp(y);
    }
  }
}
"#;

fn script(body: &str) -> String {
    format!("const MAX = {MAX_VECTOR};\n{body}")
}

/// Check the request without running anything.
pub fn validate(req: &Request) -> Result<()> {
    let bad_len = |s: &Source| s.duration <= Rational::ZERO || s.start < Rational::ZERO;
    if bad_len(&req.source) {
        return Err(Error::validation("the part of the clip to mosh is empty"));
    }
    if req.width < 16 || req.height < 16 || !req.width.is_multiple_of(2) || !req.height.is_multiple_of(2) {
        return Err(Error::validation("the project picture size must be even and at least 16 pixels"));
    }
    match &req.mode {
        Mode::Amplify { factor } if !factor.is_finite() || !(0.0..=16.0).contains(factor) => Err(Error::validation("motion amount must be between 0 and 16")),
        Mode::Drift { x, y } if x.abs() > 256 || y.abs() > 256 => Err(Error::validation("drift must be within ±256 (half-pixel units per frame)")),
        Mode::Transfer { donor } if bad_len(donor) => Err(Error::validation("the clip lending its motion is empty")),
        Mode::Fx { fx, params } => resolve_fx(fx, params).map(|_| ()),
        _ => Ok(()),
    }
}

/// Children that are running right now, so a cancel can kill them all.
#[derive(Clone, Default)]
struct Pids(Arc<Mutex<Vec<u32>>>);
impl Pids {
    fn add(&self, c: &Child) {
        self.0.lock().unwrap().push(c.id());
    }
    fn clear(&self) {
        self.0.lock().unwrap().clear();
    }
    fn kill_all(&self) {
        for p in self.0.lock().unwrap().iter() {
            kill_pid(*p);
        }
    }
}

fn drain(mut r: impl Read + Send + 'static) -> (Arc<Mutex<String>>, std::thread::JoinHandle<()>) {
    let buf = Arc::new(Mutex::new(String::new()));
    let b = Arc::clone(&buf);
    let h = std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        while let Ok(n) = r.read(&mut chunk) {
            if n == 0 {
                break;
            }
            let mut s = b.lock().unwrap();
            s.push_str(&String::from_utf8_lossy(&chunk[..n]));
            if s.len() > 64 * 1024 {
                let cut = (s.len() - 32 * 1024..s.len()).find(|i| s.is_char_boundary(*i)).unwrap_or(s.len());
                s.drain(..cut);
            }
        }
    });
    (buf, h)
}

fn secs(t: Rational) -> String {
    crate::ffmpeg::secs(t)
}

fn tool_error(tool: &Path, e: std::io::Error) -> Error {
    Error::ToolUnavailable { tool: tool.display().to_string(), reason: e.to_string() }
}

/// Run a finished-when-it-exits program; its stderr becomes the error text on failure.
fn run_plain(program: &Path, args: &[String], what: &str, pids: &Pids, cancel: &CancelToken) -> Result<String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    suppress_console_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| tool_error(program, e))?;
    pids.add(&child);
    let (err, th) = drain(child.stderr.take().expect("piped"));
    let status = child.wait().map_err(|e| tool_error(program, e))?;
    let _ = th.join();
    pids.clear();
    let text = err.lock().unwrap().clone();
    if cancel.is_canceled() {
        return Err(Error::Canceled);
    }
    if !status.success() {
        return Err(Error::ToolFailed { tool: program.display().to_string(), code: status.code(), hint: format!("{what}: {}", explain_failure(&text)) });
    }
    Ok(text)
}

/// Source stretch → all-P MPEG-4 AVI at the project's size and rate, through a pipe (no raw file on disk).
fn make_intermediate(tools: &Tools, g: &GlitchTools, req: &Request, s: &Source, out: &Path, pids: &Pids, cancel: &CancelToken) -> Result<()> {
    let (w, h) = (req.width, req.height);
    let fps = format!("{}/{}", req.fps.num(), req.fps.den());
    let vf = format!("fps={fps},scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p");
    let mut dec = Command::new(&tools.ffmpeg);
    dec.args(["-v", "error", "-nostdin", "-ss", &secs(s.start), "-t", &secs(s.duration), "-i"]).arg(&s.path).args(["-an", "-vf", &vf, "-f", "rawvideo", "-pix_fmt", "yuv420p", "pipe:1"]);
    dec.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    suppress_console_window(&mut dec);
    let mut dec = dec.spawn().map_err(|e| tool_error(&tools.ffmpeg, e))?;
    pids.add(&dec);
    let (dec_err, dec_th) = drain(dec.stderr.take().expect("piped"));

    let mut enc = Command::new(&g.ffgac);
    enc.args(["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s"]).arg(format!("{w}x{h}")).args(["-r", &fps, "-i", "-"]);
    // all P-frames with forced vectors and a wide vector range (`-fcode`, which stock FFmpeg lacks), so edits can be large
    enc.args(["-c:v", "mpeg4", "-mpv_flags", "+nopimb+forcemv", "-qscale:v", "2", "-g", "9999", "-bf", "0", "-sc_threshold", "0", "-fcode", "6"]).arg(out);
    enc.stdin(Stdio::from(dec.stdout.take().expect("piped"))).stdout(Stdio::null()).stderr(Stdio::piped());
    suppress_console_window(&mut enc);
    let mut enc = match enc.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = dec.kill();
            let _ = dec.wait();
            pids.clear();
            return Err(tool_error(&g.ffgac, e));
        }
    };
    pids.add(&enc);
    let (enc_err, enc_th) = drain(enc.stderr.take().expect("piped"));
    let enc_status = enc.wait().map_err(|e| tool_error(&g.ffgac, e));
    let dec_status = dec.wait().map_err(|e| tool_error(&tools.ffmpeg, e));
    let _ = (dec_th.join(), enc_th.join());
    pids.clear();
    if cancel.is_canceled() {
        return Err(Error::Canceled);
    }
    let (dec_status, enc_status) = (dec_status?, enc_status?);
    if !dec_status.success() {
        return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: dec_status.code(), hint: format!("reading the clip: {}", explain_failure(&dec_err.lock().unwrap())) });
    }
    if !enc_status.success() {
        return Err(Error::ToolFailed { tool: g.ffgac.display().to_string(), code: enc_status.code(), hint: format!("preparing the clip for motion editing: {}", explain_failure(&enc_err.lock().unwrap())) });
    }
    Ok(())
}

/// The part of a video clip that gets moshed: its own source range at normal speed. Speed changes, reverse, freeze, titles,
/// stills and generated clips are refused with the reason, rather than moshing something other than what the clip shows.
pub fn source_of(eng: &crate::engine::Engine, clip: &str) -> Result<Source> {
    source_for(eng, clip, "mosh lab")
}

/// [`source_of`] for any lab that rewrites a clip's own source range (`lab` names it in the error messages).
pub fn source_for(eng: &crate::engine::Engine, clip: &str, lab: &str) -> Result<Source> {
    let seq = eng.project.active()?;
    let (_, c) = seq.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
    if c.kind != crate::project::TrackKind::Video {
        return Err(Error::validation(format!("the {lab} works on video clips only")));
    }
    let m = eng.project.media(&c.media)?;
    if c.title.is_some() || m.is_generated() || m.info.still || crate::imgseq::is_pattern(&m.path) {
        return Err(Error::validation(format!("titles, solid colours, stills and image sequences cannot go through the {lab}")));
    }
    if c.speed != Rational::from_int(1) || c.reverse || c.freeze.is_some() {
        return Err(Error::validation(format!("the {lab} works on the clip at normal speed: reset speed, reverse and freeze first")));
    }
    Ok(Source { path: PathBuf::from(&m.path), start: c.source_in, duration: c.duration })
}

/// Import the finished file and put it on a new video track at the same place and length as `clip`. Returns the new media id.
/// Three undo steps (import, new track, placement); the original clip is left as it was.
pub fn place(eng: &mut crate::engine::Engine, clip: &str, output: &Path) -> Result<String> {
    place_on_track(eng, clip, output, "Datamosh")
}

/// [`place`] onto a new track called `track_name`.
pub fn place_on_track(eng: &mut crate::engine::Engine, clip: &str, output: &Path, track_name: &str) -> Result<String> {
    use crate::commands::Command;
    let (start, duration) = {
        let (_, c) = eng.project.active()?.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
        (c.start, c.duration)
    };
    let media = eng.import_media(output)?;
    eng.dispatch(Command::AddTrack { kind: crate::project::TrackKind::Video, name: Some(track_name.into()) })?;
    let track = eng.project.active()?.tracks.iter().rev().find(|t| t.kind == crate::project::TrackKind::Video && t.name == track_name).map(|t| t.id.clone()).ok_or_else(|| Error::validation("the new track was not created"))?;
    eng.dispatch(Command::PlaceClip { media: media.clone(), track, start, source_in: Some(Rational::ZERO), duration: Some(duration), with_audio: false, audio_track: None })?;
    Ok(media)
}

/// Removes the working folder however the run ends.
struct Work(PathBuf);
impl Drop for Work {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Run the lab. `on_progress` gets 0..=1 (by stage: the stages are not individually measurable). Writes `req.output`
/// atomically (a partial file never appears there); nothing is left behind on failure or cancel.
pub fn run(tools: &Tools, g: &GlitchTools, req: &Request, cancel: &CancelToken, on_progress: &mut dyn FnMut(f64)) -> Result<()> {
    validate(req)?;
    if let Some(dir) = req.output.parent() {
        std::fs::create_dir_all(dir).map_err(|e| Error::io(dir, e))?;
    }
    let work = Work(std::env::temp_dir().join(format!("ffworks-mosh-{}", uuid::Uuid::new_v4().simple())));
    std::fs::create_dir_all(&work.0).map_err(|e| Error::io(&work.0, e))?;
    let pids = Pids::default();
    let done = Arc::new(AtomicBool::new(false));
    let watchdog = {
        let (cancel, done, pids) = (cancel.clone(), Arc::clone(&done), pids.clone());
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                if cancel.is_canceled() {
                    pids.kill_all();
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        })
    };
    let result = run_stages(tools, g, req, &work.0, &pids, cancel, on_progress);
    done.store(true, Ordering::SeqCst);
    let _ = watchdog.join();
    result
}

fn run_stages(tools: &Tools, g: &GlitchTools, req: &Request, work: &Path, pids: &Pids, cancel: &CancelToken, on_progress: &mut dyn FnMut(f64)) -> Result<()> {
    on_progress(0.0);
    // a donor and its target must have the same number of frames: both use the shorter length
    let mut source = req.source.clone();
    if let Mode::Transfer { donor } = &req.mode {
        source.duration = source.duration.min(donor.duration);
    }
    let base = work.join("base.avi");
    make_intermediate(tools, g, req, &source, &base, pids, cancel)?;
    on_progress(0.35);

    let edited = work.join("edited.avi");
    let ffedit = |args: Vec<String>, what: &str| -> Result<String> { run_plain(&g.ffedit, &args, what, pids, cancel) };
    let s = |p: &Path| p.to_string_lossy().into_owned();
    let log = match &req.mode {
        Mode::Amplify { factor } => {
            let js = work.join("mosh.js");
            std::fs::write(&js, script(AMPLIFY_JS)).map_err(|e| Error::io(&js, e))?;
            ffedit(vec!["-i".into(), s(&base), "-f".into(), "mv".into(), "-sp".into(), format!("{{\"factor\":{factor}}}"), "-s".into(), s(&js), "-o".into(), s(&edited), "-y".into()], "editing the motion")?
        }
        Mode::Drift { x, y } => {
            let js = work.join("mosh.js");
            std::fs::write(&js, script(DRIFT_JS)).map_err(|e| Error::io(&js, e))?;
            ffedit(vec!["-i".into(), s(&base), "-f".into(), "mv".into(), "-sp".into(), format!("{{\"x\":{x},\"y\":{y}}}"), "-s".into(), s(&js), "-o".into(), s(&edited), "-y".into()], "editing the motion")?
        }
        Mode::Fx { fx, params } => {
            let js = work.join("mosh.js");
            std::fs::write(&js, script(FX_JS)).map_err(|e| Error::io(&js, e))?;
            // FFglitch's -sp JSON has no floating point numbers: every value goes over as a string and the script converts it
            let json = serde_json::Value::Object(resolve_fx(fx, params)?.into_iter().map(|(k, v)| (k, if v.is_number() { v.to_string().into() } else { v })).collect()).to_string();
            ffedit(vec!["-i".into(), s(&base), "-f".into(), "mv".into(), "-sp".into(), json, "-s".into(), s(&js), "-o".into(), s(&edited), "-y".into()], "editing the motion")?
        }
        Mode::Transfer { donor } => {
            let donor_src = Source { duration: source.duration, ..donor.clone() };
            let donor_avi = work.join("donor.avi");
            make_intermediate(tools, g, req, &donor_src, &donor_avi, pids, cancel)?;
            let json = work.join("donor_mv.json");
            ffedit(vec!["-i".into(), s(&donor_avi), "-f".into(), "mv".into(), "-e".into(), s(&json), "-y".into()], "reading the donor's motion")?;
            ffedit(vec!["-i".into(), s(&base), "-f".into(), "mv".into(), "-a".into(), s(&json), "-o".into(), s(&edited), "-y".into()], "applying the donor's motion")?
        }
    };
    if log.contains("outside of range") {
        return Err(Error::validation("the edited motion went beyond what the stream can hold; use a smaller amount"));
    }
    on_progress(0.7);

    let partial = req.output.with_file_name(format!("{}.{}.partial.mkv", req.output.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "mosh".into()), uuid::Uuid::new_v4().simple()));
    let r = run_plain(
        &tools.ffmpeg,
        &["-v".into(), "error".into(), "-nostdin".into(), "-y".into(), "-i".into(), s(&edited), "-an".into(), "-c:v".into(), "ffv1".into(), "-level".into(), "3".into(), "-g".into(), "1".into(), s(&partial)],
        "storing the result",
        pids,
        cancel,
    );
    if let Err(e) = r {
        let _ = std::fs::remove_file(&partial);
        return Err(e);
    }
    std::fs::rename(&partial, &req.output).map_err(|e| {
        let _ = std::fs::remove_file(&partial);
        Error::io(&req.output, e)
    })?;
    on_progress(1.0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(mode: Mode) -> Request {
        let src = Source { path: "a.mp4".into(), start: Rational::ZERO, duration: Rational::from_int(2) };
        Request { source: src, mode, width: 320, height: 240, fps: Rational::from_int(25), output: "o.mkv".into() }
    }

    #[test]
    fn requests_are_checked_before_anything_runs() {
        assert!(validate(&req(Mode::Amplify { factor: 3.0 })).is_ok());
        assert!(validate(&req(Mode::Amplify { factor: 99.0 })).is_err());
        assert!(validate(&req(Mode::Amplify { factor: f64::NAN })).is_err());
        assert!(validate(&req(Mode::Drift { x: 4, y: -4 })).is_ok());
        assert!(validate(&req(Mode::Drift { x: 900, y: 0 })).is_err());
        let empty = Source { path: "b.mp4".into(), start: Rational::ZERO, duration: Rational::ZERO };
        assert!(validate(&req(Mode::Transfer { donor: empty })).is_err());
        let mut odd = req(Mode::Amplify { factor: 1.0 });
        odd.width = 321;
        assert!(validate(&odd).is_err());
    }

    #[test]
    fn scripts_clamp_to_the_range_the_stream_holds() {
        for js in [script(AMPLIFY_JS), script(DRIFT_JS)] {
            assert!(js.starts_with("const MAX = 1000;"));
            assert!(js.contains("export function glitch_frame"));
            // FFglitch arrays are indexable but not iterable
            assert!(!js.contains("for (const") && !js.contains(" of "));
        }
    }

    #[test]
    fn vector_effects_fill_defaults_and_refuse_bad_numbers() {
        let none = serde_json::Map::new();
        let r = resolve_fx("noise", &none).unwrap();
        assert_eq!((r["fx"].as_str(), r["amount"].as_f64(), r["seed"].as_f64()), (Some("noise"), Some(8.0), Some(1.0)));
        let mut p = serde_json::Map::new();
        p.insert("amount".into(), 500.into());
        assert!(resolve_fx("noise", &p).unwrap_err().to_string().contains("must be from 1 to 64"));
        p.clear();
        p.insert("wobble".into(), 1.into());
        assert!(resolve_fx("noise", &p).unwrap_err().to_string().contains("no setting called 'wobble'"));
        assert!(resolve_fx("sparkle", &none).is_err());
        p.clear();
        p.insert("amount".into(), "lots".into());
        assert!(resolve_fx("noise", &p).is_err());
        for def in FX {
            assert!(resolve_fx(def.id, &none).is_ok(), "{} runs with its defaults", def.id);
            assert!(def.params.iter().all(|q| q.min <= q.default && q.default <= q.max), "{}", def.id);
            assert!(script(FX_JS).contains(&format!("\"{}\"", def.id)), "the script handles {}", def.id);
        }
        let js = script(FX_JS);
        assert!(!js.contains("for (const") && !js.contains(" of "), "FFglitch arrays are not iterable");
    }

    #[test]
    fn modes_survive_json() {
        let m = Mode::Transfer { donor: Source { path: "d.mp4".into(), start: Rational::new(1, 2), duration: Rational::from_int(3) } };
        let back: Mode = serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(back, m);
    }

    #[test]
    fn tools_are_found_in_a_folder() {
        let d = std::env::temp_dir().join(format!("ffworks-gt-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        let exe = |n: &str| if cfg!(windows) { format!("{n}.exe") } else { n.to_string() };
        std::fs::write(d.join(exe("ffedit")), b"").unwrap();
        std::fs::write(d.join(exe("ffgac")), b"").unwrap();
        let t = GlitchTools::discover(Some(&d)).unwrap();
        assert_eq!(t.ffedit, d.join(exe("ffedit")));
        let _ = std::fs::remove_dir_all(&d);
    }
}
