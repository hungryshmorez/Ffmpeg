//! Render graph IR: the sequence flattened into resolved, renderer-independent segments.
//! Both preview and final export compile from this one structure so they share edit semantics (spec §156).

use crate::error::Result;
use crate::project::{Project, TrackKind};
use crate::time::{Fps, Rational};

#[derive(Clone, Debug, PartialEq)]
pub struct InputRef {
    pub media_id: String,
    pub path: String,
    pub has_video: bool,
    pub has_audio: bool,
    /// Source frame rate (for sub-frame trim boundary placement).
    pub src_fps: Option<Fps>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VideoSegment {
    pub input: usize,
    /// 0 = bottom layer. Later segments are composited over earlier ones.
    pub layer: usize,
    pub start: Rational,
    pub source_in: Rational,
    pub duration: Rational,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AudioSegment {
    pub input: usize,
    pub start: Rational,
    pub source_in: Rational,
    pub duration: Rational,
    /// Clip gain + track gain.
    pub gain_db: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RenderGraph {
    pub width: u32,
    pub height: u32,
    pub fps: Fps,
    pub sample_rate: u32,
    pub duration: Rational,
    pub inputs: Vec<InputRef>,
    pub video: Vec<VideoSegment>,
    pub audio: Vec<AudioSegment>,
    /// True when the timeline contains any audio clips (even muted). Muted audio renders as silence
    /// so the output keeps an audio stream.
    pub has_audio: bool,
}

pub fn build(project: &Project) -> Result<RenderGraph> {
    let seq = project.active()?;
    let mut g = RenderGraph {
        width: project.settings.width,
        height: project.settings.height,
        fps: project.settings.fps,
        sample_rate: project.settings.sample_rate,
        duration: seq.duration(),
        inputs: vec![],
        video: vec![],
        audio: vec![],
        has_audio: false,
    };
    let input_index = |g: &mut RenderGraph, media_id: &str| -> Result<usize> {
        if let Some(i) = g.inputs.iter().position(|i| i.media_id == media_id) {
            return Ok(i);
        }
        let m = project.media(media_id)?;
        g.inputs.push(InputRef {
            media_id: m.id.clone(),
            path: m.path.clone(),
            has_video: m.info.has_video(),
            has_audio: m.info.has_audio(),
            src_fps: m.info.video.first().and_then(|v| v.fps),
        });
        Ok(g.inputs.len() - 1)
    };
    let mut layer = 0;
    for t in &seq.tracks {
        match t.kind {
            TrackKind::Video => {
                // For video tracks `muted` means hidden.
                if !t.muted {
                    for c in &t.clips {
                        let input = input_index(&mut g, &c.media)?;
                        g.video.push(VideoSegment { input, layer, start: c.start, source_in: c.source_in, duration: c.duration });
                    }
                }
                layer += 1;
            }
            TrackKind::Audio => {
                for c in &t.clips {
                    g.has_audio = true;
                    if t.muted {
                        continue;
                    }
                    let input = input_index(&mut g, &c.media)?;
                    g.audio.push(AudioSegment { input, start: c.start, source_in: c.source_in, duration: c.duration, gain_db: c.gain_db + t.gain_db });
                }
            }
        }
    }
    Ok(g)
}
