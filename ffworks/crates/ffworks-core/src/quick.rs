//! Quick export without re-encoding (`-c copy`): only for a timeline that is one untouched stretch of one media file
//! (plus its linked audio). Anything else needs the normal renderer, and the refusal says why. Because nothing is
//! re-encoded the cut starts at the keyframe at or before the in point, like every stream-copy trim.

use crate::error::{Error, Result};
use crate::ffmpeg::{FfmpegJob, RenderOptions};
use crate::project::{Clip, Project, TrackKind};
use crate::time::Rational;
use std::path::PathBuf;

/// Preset id handled here instead of by the filter-graph compiler.
pub const PRESET: &str = "quick_copy";

fn untouched(c: &Clip) -> Result<()> {
    let bad = if !c.effects.is_empty() {
        "has effects"
    } else if c.speed != Rational::from_int(1) || c.reverse || c.freeze.is_some() {
        "is retimed"
    } else if !c.transform.is_identity() || c.opacity != 1.0 || c.blend != "normal" || c.keyframes.values().any(|k| !k.is_empty()) {
        "is transformed or animated"
    } else if c.gain_db != 0.0 || c.pan != 0.0 || c.fade_in != Rational::ZERO || c.fade_out != Rational::ZERO {
        "has audio edits"
    } else {
        return Ok(());
    };
    Err(Error::validation(format!("quick export needs untouched clips, but '{}' {bad}; use a normal export preset", c.name)))
}

pub fn compile(project: &Project, opts: &RenderOptions) -> Result<FfmpegJob> {
    let seq = project.active()?;
    let clips: Vec<&Clip> = seq.tracks.iter().flat_map(|t| t.clips.iter()).collect();
    if clips.is_empty() {
        return Err(Error::validation("the timeline is empty"));
    }
    let video: Vec<&&Clip> = clips.iter().filter(|c| c.kind == TrackKind::Video).collect();
    let audio: Vec<&&Clip> = clips.iter().filter(|c| c.kind == TrackKind::Audio).collect();
    let main = *video.first().or(audio.first()).expect("non-empty");
    if video.len() > 1 || audio.len() > 1 || seq.tracks.iter().any(|t| !t.transitions.is_empty()) {
        return Err(Error::validation("quick export works for a single clip (with its audio); this timeline has several. Use a normal export preset"));
    }
    for c in &clips {
        untouched(c)?;
        if c.media != main.media || c.source_in != main.source_in || c.duration != main.duration || c.start != main.start {
            return Err(Error::validation("quick export needs the audio to match the video clip exactly; use a normal export preset"));
        }
    }
    let asset = project.media(&main.media)?;
    if asset.is_generated() {
        return Err(Error::validation("quick export cannot copy a generated clip (solid colour or title)"));
    }
    if opts.output.to_string_lossy() == asset.path {
        return Err(Error::validation("output path equals source media; sources are never overwritten"));
    }
    let (start, dur) = match opts.range {
        Some((a, b)) if b > a && a >= Rational::ZERO => (main.source_in + a, (b - a).min(main.duration - a)),
        Some(_) => return Err(Error::validation("render range is empty or negative")),
        None => (main.source_in, main.duration),
    };
    let s = |t: Rational| format!("{:.6}", t.as_f64());
    let mut pre: Vec<String> = ["-y", "-hide_banner", "-nostdin", "-ss"].map(String::from).into();
    pre.push(s(start));
    pre.extend(["-t".to_string(), s(dur), "-i".to_string(), asset.path.clone()]);
    let mut post: Vec<String> = vec![];
    if !video.is_empty() {
        post.extend(["-map", "0:v:0"].map(String::from));
    }
    if !audio.is_empty() {
        post.extend(["-map", "0:a:0"].map(String::from));
    }
    post.extend(["-c", "copy", "-avoid_negative_ts", "make_zero"].map(String::from));
    post.push(opts.output.to_string_lossy().into_owned());
    Ok(FfmpegJob { program: PathBuf::from("ffmpeg"), pre, filter_graph: String::new(), post, total_duration: dur, output: opts.output.clone(), force_file: false, stages: vec![] })
}
