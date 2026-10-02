//! Proxies: small, universally playable H.264 copies of video media for the source monitor. They fix files the webview cannot
//! decode (ProRes, HEVC on some systems, odd pixel formats) and make scrubbing of heavy footage responsive. They are a *cache*,
//! never part of the project file: the name is derived from the media's content fingerprint, so relinking or editing a source
//! naturally invalidates its proxy. Exports and processed previews always read the original media.

use crate::error::{Error, Result};
use crate::ffmpeg::FfmpegJob;
use crate::process::Capabilities;
use crate::project::MediaAsset;
use crate::time::Rational;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Proxy height in pixels (never upscales).
pub const PROXY_HEIGHT: u32 = 540;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    pub media_id: String,
    /// Can this media have a proxy at all (real video file: not audio-only, a still, or generated)?
    pub eligible: bool,
    pub ready: bool,
    pub path: Option<String>,
    pub bytes: Option<u64>,
}

pub fn eligible(m: &MediaAsset) -> bool {
    m.info.has_video() && !m.info.still && !m.is_generated()
}

/// Where the proxy of `m` lives: `<cache>/proxies/<fingerprint>_<height>p.mp4`.
pub fn proxy_path(cache_dir: &Path, m: &MediaAsset) -> PathBuf {
    let key: String = m.fingerprint.clone().unwrap_or_else(|| m.id.clone()).chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    cache_dir.join("proxies").join(format!("{key}_{PROXY_HEIGHT}p.mp4"))
}

pub fn status(cache_dir: &Path, m: &MediaAsset) -> ProxyStatus {
    let p = proxy_path(cache_dir, m);
    let meta = std::fs::metadata(&p).ok().filter(|x| x.len() > 0);
    ProxyStatus { media_id: m.id.clone(), eligible: eligible(m), ready: meta.is_some() && eligible(m), path: meta.as_ref().map(|_| p.to_string_lossy().into_owned()), bytes: meta.map(|x| x.len()) }
}

/// The FFmpeg job that writes the proxy (to be run through the queue / `run_job`, which writes `*.ffworks-partial` and renames).
pub fn build_job(m: &MediaAsset, out: &Path, caps: Option<&Capabilities>) -> Result<FfmpegJob> {
    if !eligible(m) {
        return Err(Error::validation(format!("'{}' cannot have a proxy (only video files can)", m.name)));
    }
    if let Some(c) = caps {
        if !c.has_encoder("libx264") {
            return Err(Error::validation("this FFmpeg build has no libx264 encoder, so proxies cannot be made (the bundled FFmpeg has it; check Diagnostics → FFmpeg location)"));
        }
    }
    std::fs::create_dir_all(out.parent().unwrap_or(Path::new("."))).map_err(|e| Error::io(out, e))?;
    let v = &m.info.video[0];
    // nominal frame rate keeps variable-frame-rate sources steady; never upscale
    let fps = v.fps.map(|f| format!("fps={}/{},", f.num(), f.den())).unwrap_or_default();
    let mut graph = format!("[0:v:0]{fps}scale=-2:'min({PROXY_HEIGHT},ih)':flags=bicubic,format=yuv420p[v]");
    let mut post: Vec<String> = ["-map", "[v]"].map(String::from).into();
    if m.info.has_audio() {
        graph.push_str(";[0:a:0]aresample=48000,aformat=channel_layouts=stereo[a]");
        post.extend(["-map", "[a]"].map(String::from));
    }
    // short GOP: every 12th frame is a keyframe, so seeking/scrubbing is quick
    post.extend(["-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-g", "12", "-keyint_min", "12", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-movflags", "+faststart"].map(String::from));
    if m.info.has_audio() {
        post.extend(["-c:a", "aac", "-b:a", "128k"].map(String::from));
    }
    post.push(out.to_string_lossy().into_owned());
    let pre = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-i"].iter().map(|s| s.to_string()).chain([m.path.clone()]).collect();
    Ok(FfmpegJob { program: PathBuf::from("ffmpeg"), pre, filter_graph: graph, post, total_duration: m.info.duration.max(Rational::new(1, 100)), output: out.to_path_buf(), force_file: false })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffprobe::{ColorInfo, MediaInfo, VideoStream};

    fn asset(still: bool) -> MediaAsset {
        MediaAsset {
            id: "med_1".into(),
            name: "a.mov".into(),
            path: "/x/a.mov".into(),
            fingerprint: Some("abc/def+1".into()),
            generator: None,
            info: MediaInfo { video: vec![VideoStream { index: 0, codec: "prores".into(), width: 1920, height: 1080, fps: Some(Rational::new(30000, 1001)), bit_rate: None, color: ColorInfo::default() }], still, ..Default::default() },
        }
    }

    #[test]
    fn path_comes_from_the_fingerprint_and_is_filename_safe() {
        let p = proxy_path(Path::new("/c"), &asset(false));
        assert_eq!(p, PathBuf::from("/c/proxies/abc_def_1_540p.mp4"));
        let mut b = asset(false);
        b.fingerprint = None;
        assert!(proxy_path(Path::new("/c"), &b).to_string_lossy().contains("med_1_540p"));
    }

    #[test]
    fn only_real_video_is_eligible() {
        assert!(eligible(&asset(false)));
        assert!(!eligible(&asset(true)), "stills have no proxy");
        let mut audio = asset(false);
        audio.info.video.clear();
        assert!(!eligible(&audio));
        assert!(build_job(&audio, Path::new("/tmp/o.mp4"), None).is_err());
    }
}
