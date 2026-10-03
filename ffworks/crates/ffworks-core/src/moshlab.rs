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
    let seq = eng.project.active()?;
    let (_, c) = seq.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
    if c.kind != crate::project::TrackKind::Video {
        return Err(Error::validation("only video clips can be moshed"));
    }
    let m = eng.project.media(&c.media)?;
    if c.title.is_some() || m.is_generated() || m.info.still || crate::imgseq::is_pattern(&m.path) {
        return Err(Error::validation("titles, solid colours, stills and image sequences have no motion to mosh"));
    }
    if c.speed != Rational::from_int(1) || c.reverse || c.freeze.is_some() {
        return Err(Error::validation("the mosh lab works on the clip at normal speed: reset speed, reverse and freeze first"));
    }
    Ok(Source { path: PathBuf::from(&m.path), start: c.source_in, duration: c.duration })
}

/// Import the finished file and put it on a new video track at the same place and length as `clip`. Returns the new media id.
/// Three undo steps (import, new track, placement); the original clip is left as it was.
pub fn place(eng: &mut crate::engine::Engine, clip: &str, output: &Path) -> Result<String> {
    use crate::commands::Command;
    let (start, duration) = {
        let (_, c) = eng.project.active()?.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
        (c.start, c.duration)
    };
    let media = eng.import_media(output)?;
    eng.dispatch(Command::AddTrack { kind: crate::project::TrackKind::Video, name: Some("Datamosh".into()) })?;
    let track = eng.project.active()?.tracks.iter().rev().find(|t| t.kind == crate::project::TrackKind::Video && t.name == "Datamosh").map(|t| t.id.clone()).ok_or_else(|| Error::validation("the new track was not created"))?;
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
