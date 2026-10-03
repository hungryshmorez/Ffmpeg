//! Scene/shot cut detection (spec §35), built on the `scenesdetect` crate (a Rust port of PySceneDetect's content detector,
//! MIT/Apache-2.0). FFmpeg decodes a low-resolution BGR stream; the crate decides where the cuts are.

use crate::error::{Error, Result};
use crate::jobs::CancelToken;
use crate::process::{suppress_console_window, Tools};
use scenesdetect::content::{Detector, Options};
use scenesdetect::frame::{RgbFrame, Timebase, Timestamp};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::num::NonZeroI32;
use std::path::Path;
use std::process::{Command, Stdio};

const W: u32 = 160;
const H: u32 = 90;
/// Analysis frame rate. PySceneDetect looks at every frame; 12 fps keeps analysis fast and still catches hard cuts to within ~0.08 s.
const FPS: i32 = 12;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SceneAnalysis {
    /// Cut times in seconds (the start of every scene after the first).
    pub cuts: Vec<f64>,
    /// `(start, end)` of every scene in seconds; together they cover the media.
    pub scenes: Vec<(f64, f64)>,
    pub threshold: f64,
}

/// Turn cut times into contiguous scenes covering `[0, duration]`.
pub fn scenes_from_cuts(cuts: &[f64], duration: f64) -> Vec<(f64, f64)> {
    let mut starts = vec![0.0];
    starts.extend(cuts.iter().copied().filter(|c| *c > 0.0 && *c < duration));
    starts.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    let mut out = vec![];
    for (i, s) in starts.iter().enumerate() {
        let e = starts.get(i + 1).copied().unwrap_or(duration);
        if e > *s {
            out.push((*s, e));
        }
    }
    out
}

/// Run the content detector over a stream of equally spaced BGR frames. Returns cut times in seconds.
pub fn detect_cuts(frames: &mut dyn Iterator<Item = Vec<u8>>, w: u32, h: u32, fps: i32, threshold: f64) -> Vec<f64> {
    let tb = Timebase::new(1, NonZeroI32::new(fps).expect("fps != 0"));
    let mut det = Detector::new(Options::new().with_threshold(threshold));
    let mut cuts = vec![];
    for (i, data) in frames.enumerate() {
        let f = RgbFrame::new(&data, w, h, w * 3, Timestamp::new(i as i64, tb));
        if let Some(ts) = det.process_bgr(f) {
            let t = ts.pts() as f64 / fps as f64;
            // the detector reports an initial cut at the first frame; that is the start of scene 1, not a cut
            if t > 0.0 {
                cuts.push(t);
            }
        }
    }
    cuts
}

/// Detect scenes in `media`. `threshold` is PySceneDetect's content score (default 27; lower = more sensitive). Cached per key+threshold.
pub fn detect(tools: &Tools, media: &Path, duration: f64, cache_dir: &Path, key: &str, threshold: f64) -> Result<SceneAnalysis> {
    detect_with(tools, media, duration, cache_dir, key, threshold, &CancelToken::new())
}

/// [`detect`] that stops (with [`Error::Canceled`]) when `cancel` is raised.
pub fn detect_with(tools: &Tools, media: &Path, duration: f64, cache_dir: &Path, key: &str, threshold: f64, cancel: &CancelToken) -> Result<SceneAnalysis> {
    std::fs::create_dir_all(cache_dir).map_err(|e| Error::io(cache_dir, e))?;
    let cache_file = cache_dir.join(format!("{key}.scenes_{threshold}.json"));
    if let Some(a) = std::fs::read_to_string(&cache_file).ok().and_then(|t| serde_json::from_str::<SceneAnalysis>(&t).ok()) {
        return Ok(a);
    }
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-i"]).arg(media).args(["-an", "-vf", &format!("fps={FPS},scale={W}:{H}:flags=bilinear"), "-pix_fmt", "bgr24", "-f", "rawvideo", "-"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null());
    suppress_console_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| Error::ToolUnavailable { tool: tools.ffmpeg.display().to_string(), reason: e.to_string() })?;
    let mut out = child.stdout.take().expect("piped");
    let size = (W * H * 3) as usize;
    let mut frames = std::iter::from_fn(|| {
        if cancel.is_canceled() {
            return None;
        }
        let mut buf = vec![0u8; size];
        out.read_exact(&mut buf).ok().map(|_| buf)
    });
    let cuts = detect_cuts(&mut frames, W, H, FPS, threshold);
    if cancel.is_canceled() {
        let _ = child.kill();
        let _ = child.wait();
        return Err(Error::Canceled);
    }
    let status = child.wait().map_err(|e| Error::io(media, e))?;
    if !status.success() {
        return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: status.code(), hint: "video decode failed during scene detection (does the file have a video stream?)".into() });
    }
    let a = SceneAnalysis { scenes: scenes_from_cuts(&cuts, duration), cuts, threshold };
    let _ = std::fs::write(&cache_file, serde_json::to_vec(&a)?);
    Ok(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scenes_cover_the_media() {
        let s = scenes_from_cuts(&[2.0, 5.0], 8.0);
        assert_eq!(s, vec![(0.0, 2.0), (2.0, 5.0), (5.0, 8.0)]);
        assert_eq!(scenes_from_cuts(&[], 3.0), vec![(0.0, 3.0)]);
        // cuts at/after the end or at 0 are ignored
        assert_eq!(scenes_from_cuts(&[0.0, 9.0], 3.0), vec![(0.0, 3.0)]);
    }

    #[test]
    fn synthetic_hard_cuts_are_found() {
        // 12 fps: 3 s dark grey, 3 s bright colour pattern, 3 s mid-grey
        let mk = |v: u8, n: usize, alt: bool| -> Vec<Vec<u8>> {
            (0..n).map(|_| (0..(W * H) as usize).flat_map(|p| if alt && p % 2 == 0 { [255 - v, v, 200] } else { [v, v, v] }).collect()).collect()
        };
        let mut frames: Vec<Vec<u8>> = mk(30, 36, false);
        frames.extend(mk(220, 36, true));
        frames.extend(mk(110, 36, false));
        let cuts = detect_cuts(&mut frames.into_iter(), W, H, 12, 27.0);
        assert_eq!(cuts.len(), 2, "{cuts:?}");
        assert!((cuts[0] - 3.0).abs() < 0.2 && (cuts[1] - 6.0).abs() < 0.2, "{cuts:?}");
    }

    #[test]
    fn static_video_has_no_cuts() {
        let frames: Vec<Vec<u8>> = (0..60).map(|_| vec![90u8; (W * H * 3) as usize]).collect();
        assert!(detect_cuts(&mut frames.into_iter(), W, H, 12, 27.0).is_empty());
    }
}
