//! Corruption lab: real bitstream damage, with stock FFmpeg only. The clip's source range is encoded with an old codec,
//! the *compressed packets* are damaged (random bytes flipped, whole packets dropped; FFmpeg's `noise` bitstream filter), and
//! the damaged stream is decoded again and stored losslessly (FFV1). Because the damage happens before decoding, errors behave
//! the way real corruption does: they smear along the prediction chain until the next keyframe, tear blocks, or freeze.
//! Like the mosh lab it makes a **new file**; the original clip is never touched.
//!
//! Pipeline: `ffmpeg` (encode MPEG-4 / MJPEG / MPEG-2, keyframes every N frames) → `ffmpeg -c copy -bsf:v noise` →
//! `ffmpeg -err_detect ignore_err` (decode, retime to the project rate, FFV1).
//!
//! Which bytes are damaged is repeatable (the same encoded clip and settings give a byte-identical damaged stream, see
//! [`damage`]), but FFmpeg's decoders conceal broken data in ways that are not exactly repeatable from one run to the next
//! (checked on 6.1 and a current build), so two runs can differ in small details of the finished picture. The result is a file
//! that is imported and kept, so a run only has to be good once.

use crate::error::{Error, Result};
use crate::jobs::CancelToken;
use crate::moshlab::Source;
use crate::process::{explain_failure, run_cancellable, Tools};
use crate::time::{Fps, Rational};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Codecs that tolerate (and show) damage differently.
pub const CODECS: &[(&str, &str)] = &[("mpeg4", "MPEG-4 (blocky smears)"), ("mjpeg", "MJPEG (colour and scanline tears, no smearing)"), ("mpeg2video", "MPEG-2 (long macroblock smears)")];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    /// One of [`CODECS`].
    pub codec: String,
    /// Bit damage, 1 (rare flips) to 10 (the stream is shredded); None for none.
    pub bits: Option<u32>,
    /// Drop every N-th packet (2 to 100) after the first; None for none. The picture freezes where packets are missing.
    pub drop_every: Option<u32>,
    /// Frames between full pictures: errors smear until the next one. 1 heals at once; large values smear for a long time.
    pub keyframe_every: u32,
}

#[derive(Clone, Debug)]
pub struct Request {
    pub source: Source,
    pub settings: Settings,
    pub width: u32,
    pub height: u32,
    pub fps: Fps,
    /// The finished FFV1 file (`.mkv`).
    pub output: PathBuf,
}

/// Bytes between damaged bytes for a bit-damage level (1 is rare, 10 is constant).
pub fn bit_period(level: u32) -> u64 {
    400u64 << (10 - level.clamp(1, 10))
}

/// Check the request without running anything.
pub fn validate(req: &Request) -> Result<()> {
    if req.source.duration <= Rational::ZERO || req.source.start < Rational::ZERO {
        return Err(Error::validation("the part of the clip to corrupt is empty"));
    }
    if req.width < 16 || req.height < 16 || !req.width.is_multiple_of(2) || !req.height.is_multiple_of(2) {
        return Err(Error::validation("the project picture size must be even and at least 16 pixels"));
    }
    let s = &req.settings;
    if !CODECS.iter().any(|(id, _)| *id == s.codec) {
        return Err(Error::validation(format!("unknown codec '{}' (mpeg4, mjpeg or mpeg2video)", s.codec)));
    }
    if s.bits.is_none() && s.drop_every.is_none() {
        return Err(Error::validation("choose something to break: bit damage, dropped packets, or both"));
    }
    if s.bits.is_some_and(|b| !(1..=10).contains(&b)) {
        return Err(Error::validation("bit damage is a level from 1 to 10"));
    }
    if s.drop_every.is_some_and(|d| !(2..=100).contains(&d)) {
        return Err(Error::validation("dropping one packet in N needs N from 2 to 100"));
    }
    if !(1..=600).contains(&s.keyframe_every) {
        return Err(Error::validation("keyframes every 1 to 600 frames"));
    }
    Ok(())
}

/// Removes the working folder however the run ends.
struct Work(PathBuf);
impl Drop for Work {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn stage(tools: &Tools, args: &[String], what: &str, cancel: &CancelToken) -> Result<()> {
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-y"]).args(args);
    let out = run_cancellable(&mut cmd, cancel)?;
    if !out.status.success() {
        return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: out.status.code(), hint: format!("{what}: {}", explain_failure(&String::from_utf8_lossy(&out.stderr))) });
    }
    Ok(())
}

fn path_arg(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// The `noise` bitstream filter's argument for these settings.
fn noise_filter(s: &Settings) -> String {
    let mut parts = vec![];
    if let Some(level) = s.bits {
        parts.push(format!("amount={}", bit_period(level)));
    }
    if let Some(n) = s.drop_every {
        // every N-th packet, never the first (a stream must start with a picture the others can lean on); the commas inside
        // the expression are escaped because a comma separates bitstream filters
        parts.push(format!(r"drop=gt(n\,0)*not(mod(n\,{n}))"));
    }
    format!("noise={}", parts.join(":"))
}

/// Damage the compressed packets of `input` (written to `output`, same container, no re-encoding). Deterministic: the same input
/// and settings always give the same bytes.
pub fn damage(tools: &Tools, input: &Path, output: &Path, settings: &Settings, cancel: &CancelToken) -> Result<()> {
    stage(tools, &["-i".into(), path_arg(input), "-c".into(), "copy".into(), "-bsf:v".into(), noise_filter(settings), path_arg(output)], "damaging the stream", cancel)
}

/// Run the lab. `on_progress` gets 0..=1 (by stage). Writes `req.output` atomically; nothing is left behind on failure or cancel.
pub fn run(tools: &Tools, req: &Request, cancel: &CancelToken, on_progress: &mut dyn FnMut(f64)) -> Result<()> {
    validate(req)?;
    if let Some(dir) = req.output.parent() {
        std::fs::create_dir_all(dir).map_err(|e| Error::io(dir, e))?;
    }
    let work = Work(std::env::temp_dir().join(format!("ffworks-corrupt-{}", uuid::Uuid::new_v4().simple())));
    std::fs::create_dir_all(&work.0).map_err(|e| Error::io(&work.0, e))?;
    let (w, h) = (req.width, req.height);
    let fps = format!("{}/{}", req.fps.num(), req.fps.den());
    let pix = if req.settings.codec == "mjpeg" { "yuvj420p" } else { "yuv420p" };
    let fit = format!("fps={fps},scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format={pix}");
    on_progress(0.0);

    let base = work.0.join("base.avi");
    stage(
        tools,
        &["-threads".into(), "1".into(), "-ss".into(), crate::ffmpeg::secs(req.source.start), "-t".into(), crate::ffmpeg::secs(req.source.duration), "-i".into(), path_arg(&req.source.path), "-an".into(), "-vf".into(), fit, "-threads".into(), "1".into(), "-c:v".into(), req.settings.codec.clone(), "-qscale:v".into(), "3".into(), "-g".into(), req.settings.keyframe_every.to_string(), "-bf".into(), "0".into(), path_arg(&base)],
        "reading the clip",
        cancel,
    )?;
    on_progress(0.4);

    let broken = work.0.join("broken.avi");
    damage(tools, &base, &broken, &req.settings, cancel)?;
    on_progress(0.6);

    let stem = req.output.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "corrupt".into());
    let partial = req.output.with_file_name(format!("{stem}.{}.partial.mkv", uuid::Uuid::new_v4().simple()));
    // damaged packets may leave frames missing or repeated: retime to the project rate so the clip keeps its length
    // (and a stream that lost its last packets is padded with its final picture)
    let retime = format!("fps={fps}:start_time=0,tpad=stop_mode=clone:stop_duration=2,format=yuv420p");
    let r = stage(
        tools,
        &["-threads".into(), "1".into(), "-err_detect".into(), "ignore_err".into(), "-i".into(), path_arg(&broken), "-an".into(), "-vf".into(), retime, "-t".into(), crate::ffmpeg::secs(req.source.duration), "-c:v".into(), "ffv1".into(), "-level".into(), "3".into(), "-g".into(), "1".into(), path_arg(&partial)],
        "storing the result",
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

    fn req(settings: Settings) -> Request {
        Request { source: Source { path: "a.mp4".into(), start: Rational::ZERO, duration: Rational::from_int(2) }, settings, width: 320, height: 240, fps: Rational::from_int(25), output: "o.mkv".into() }
    }
    fn base() -> Settings {
        Settings { codec: "mpeg4".into(), bits: Some(5), drop_every: None, keyframe_every: 30 }
    }

    #[test]
    fn requests_are_checked_before_anything_runs() {
        assert!(validate(&req(base())).is_ok());
        assert!(validate(&req(Settings { bits: None, ..base() })).is_err(), "nothing to break");
        assert!(validate(&req(Settings { bits: Some(11), ..base() })).is_err());
        assert!(validate(&req(Settings { bits: None, drop_every: Some(1), ..base() })).is_err());
        assert!(validate(&req(Settings { bits: None, drop_every: Some(8), ..base() })).is_ok());
        assert!(validate(&req(Settings { codec: "h264".into(), ..base() })).is_err());
        assert!(validate(&req(Settings { keyframe_every: 0, ..base() })).is_err());
        let mut odd = req(base());
        odd.width = 321;
        assert!(validate(&odd).is_err());
    }

    #[test]
    fn levels_map_to_shorter_and_shorter_gaps_between_damaged_bytes() {
        assert_eq!(bit_period(10), 400);
        assert_eq!(bit_period(9), 800);
        assert_eq!(bit_period(1), 204_800);
        assert_eq!(bit_period(0), bit_period(1));
        assert_eq!(noise_filter(&Settings { bits: Some(10), drop_every: Some(7), ..base() }), r"noise=amount=400:drop=gt(n\,0)*not(mod(n\,7))");
        assert_eq!(noise_filter(&Settings { bits: None, drop_every: Some(7), ..base() }), r"noise=drop=gt(n\,0)*not(mod(n\,7))");
    }
}
