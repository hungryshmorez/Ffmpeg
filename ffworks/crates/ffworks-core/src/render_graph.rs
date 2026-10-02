//! Render graph IR: the sequence flattened into resolved, renderer-independent segments.
//! Both preview and final export compile from this one structure so they share edit semantics (spec §156).

use crate::clipprops::Transform;
use crate::error::Result;
use crate::keyframes::Keyframe;
use crate::project::{Clip, Project, TrackKind};
use std::collections::{BTreeMap, HashMap};
use crate::time::{Fps, Rational};

#[derive(Clone, Debug, PartialEq)]
pub struct InputRef {
    /// Identifies the use (clip / link group / transition side), so every use gets its own `-i`. Sharing one input between
    /// branches via split/asplit starved branches consumed at very different times (silent crossfades), so it is avoided.
    pub key: String,
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
    pub opacity: f64,
    /// Serialised FFmpeg filters of the enabled effects, in stack order.
    pub filters: Vec<String>,
    /// Filter names those effects need (capability check).
    pub requires: Vec<String>,
    /// Playback speed (source span = duration × speed). 1 for transitioned clips.
    pub speed: Rational,
    pub reverse: bool,
    /// Source time of the single frame held for the whole segment.
    pub freeze: Option<Rational>,
    pub transform: Transform,
    /// FFmpeg blend mode; "normal" = plain overlay.
    pub blend: String,
    /// Animated clip parameters (`opacity`, `x`, `y`, `scale`, `rotation`) with their keyframes.
    pub keyframes: BTreeMap<String, Vec<Keyframe>>,
    /// An effect on this segment writes transparency (e.g. crop).
    pub alpha_fx: bool,
}

impl VideoSegment {
    pub fn animated(&self, param: &str) -> bool {
        self.keyframes.get(param).is_some_and(|k| !k.is_empty())
    }
    /// Source media consumed.
    pub fn source_span(&self) -> Rational {
        if self.freeze.is_some() { Rational::ZERO } else { self.duration.mul(self.speed) }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AudioSegment {
    pub input: usize,
    pub start: Rational,
    pub source_in: Rational,
    pub duration: Rational,
    /// Clip gain + track gain.
    pub gain_db: f64,
    pub speed: Rational,
    pub reverse: bool,
}

/// One side of a video transition: a source range with the clip's effects applied.
#[derive(Clone, Debug, PartialEq)]
pub struct TransitionPart {
    pub input: usize,
    pub source_in: Rational,
    pub filters: Vec<String>,
    pub requires: Vec<String>,
}

/// `a` and `b` each contribute `duration` of media; xfade blends them over `[start, start + duration)`.
#[derive(Clone, Debug, PartialEq)]
pub struct VideoTransition {
    pub layer: usize,
    pub start: Rational,
    pub duration: Rational,
    pub kind: String,
    pub a: TransitionPart,
    pub b: TransitionPart,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AudioPart {
    pub input: usize,
    pub source_in: Rational,
    pub gain_db: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AudioTransition {
    pub start: Rational,
    pub duration: Rational,
    pub a: AudioPart,
    pub b: AudioPart,
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
    pub video_transitions: Vec<VideoTransition>,
    pub audio_transitions: Vec<AudioTransition>,
    /// True when the timeline contains any audio clips (even muted). Muted audio renders as silence
    /// so the output keeps an audio stream.
    pub has_audio: bool,
}

/// (filters, required FFmpeg filter names, whether any writes transparency)
fn effect_filters(c: &Clip) -> Result<(Vec<String>, Vec<String>, bool)> {
    let (mut filters, mut requires, mut alpha) = (vec![], vec![], false);
    for fx in &c.effects {
        if let Some(f) = crate::effects::to_filter(fx, &c.keyframes)? {
            filters.push(f);
            let def = crate::effects::find(&fx.effect)?;
            requires.extend(def.requires.iter().map(|r| r.to_string()));
            alpha |= def.alpha;
        }
    }
    Ok((filters, requires, alpha))
}

/// The clip-level animated parameters (not effect parameters) of a clip.
fn clip_keyframes(c: &Clip) -> BTreeMap<String, Vec<Keyframe>> {
    c.keyframes.iter().filter(|(k, v)| !k.starts_with("fx:") && !v.is_empty()).map(|(k, v)| (k.clone(), v.clone())).collect()
}

/// Input key for the main segment of a clip: linked video/audio clips share one input (each stream is consumed once).
fn main_key(c: &Clip) -> String {
    match &c.link {
        Some(l) => format!("lnk:{l}"),
        None => format!("clp:{}", c.id),
    }
}

/// (front, back) media consumed from a clip by the transitions that touch it.
type Trims = HashMap<String, (Rational, Rational)>;

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
        video_transitions: vec![],
        audio_transitions: vec![],
        has_audio: false,
    };
    let input_index = |g: &mut RenderGraph, media_id: &str, key: &str| -> Result<usize> {
        if let Some(i) = g.inputs.iter().position(|i| i.key == key) {
            return Ok(i);
        }
        let m = project.media(media_id)?;
        g.inputs.push(InputRef {
            key: key.to_string(),
            media_id: m.id.clone(),
            path: m.path.clone(),
            has_video: m.info.has_video(),
            has_audio: m.info.has_audio(),
            src_fps: m.info.video.first().and_then(|v| v.fps),
        });
        Ok(g.inputs.len() - 1)
    };

    // Pass 1: transitions. They shorten the clips they touch (each gives up `half` at the joined edge) and
    // become their own overlapped segments.
    let mut trims: Trims = HashMap::new();
    let mut layer = 0;
    for t in &seq.tracks {
        if t.kind != TrackKind::Video {
            continue;
        }
        if !t.muted {
            for tr in &t.transitions {
                let a = t.clips.iter().find(|c| c.id == tr.clip_a).expect("validated");
                let b = t.clips.iter().find(|c| c.id == tr.clip_b).expect("validated");
                let half = tr.half();
                trims.entry(a.id.clone()).or_default().1 = trims.get(&a.id).map(|x| x.1).unwrap_or(Rational::ZERO) + half;
                trims.entry(b.id.clone()).or_default().0 = trims.get(&b.id).map(|x| x.0).unwrap_or(Rational::ZERO) + half;
                let (fa, ra, _) = effect_filters(a)?;
                let (fb, rb, _) = effect_filters(b)?;
                let (ia, ib) = (input_index(&mut g, &a.media, &format!("tr:{}:a", tr.id))?, input_index(&mut g, &b.media, &format!("tr:{}:b", tr.id))?);
                g.video_transitions.push(VideoTransition {
                    layer,
                    start: a.end() - half,
                    duration: tr.duration,
                    kind: tr.kind.clone(),
                    a: TransitionPart { input: ia, source_in: a.source_in + a.duration - half, filters: fa, requires: ra },
                    b: TransitionPart { input: ib, source_in: b.source_in - half, filters: fb, requires: rb },
                });
                // linked audio crossfades too, when both audio partners touch on the same unmuted audio track
                let partner = |c: &Clip| seq.linked_group(&c.id).into_iter().filter_map(|id| seq.find_clip(&id)).find(|(_, x)| x.kind == TrackKind::Audio);
                if let (Some((ta, aa)), Some((tb, ab))) = (partner(a), partner(b)) {
                    if ta.id == tb.id && !ta.muted && aa.end() == ab.start {
                        trims.entry(aa.id.clone()).or_default().1 = trims.get(&aa.id).map(|x| x.1).unwrap_or(Rational::ZERO) + half;
                        trims.entry(ab.id.clone()).or_default().0 = trims.get(&ab.id).map(|x| x.0).unwrap_or(Rational::ZERO) + half;
                        let (ia, ib) = (input_index(&mut g, &aa.media, &format!("tr:{}:a", tr.id))?, input_index(&mut g, &ab.media, &format!("tr:{}:b", tr.id))?);
                        g.audio_transitions.push(AudioTransition {
                            start: aa.end() - half,
                            duration: tr.duration,
                            a: AudioPart { input: ia, source_in: aa.source_in + aa.duration - half, gain_db: aa.gain_db + ta.gain_db },
                            b: AudioPart { input: ib, source_in: ab.source_in - half, gain_db: ab.gain_db + tb.gain_db },
                        });
                    }
                }
            }
        }
        layer += 1;
    }

    // Pass 2: ordinary segments, trimmed by whatever the transitions consumed.
    let trimmed = |c: &Clip| -> Option<(Rational, Rational, Rational)> {
        let (front, back) = trims.get(&c.id).copied().unwrap_or_default();
        let dur = c.duration - front - back;
        (dur > Rational::ZERO).then_some((c.start + front, c.source_in + front.mul(c.speed), dur))
    };
    let mut layer = 0;
    for t in &seq.tracks {
        match t.kind {
            TrackKind::Video => {
                // For video tracks `muted` means hidden.
                if !t.muted {
                    for c in &t.clips {
                        let Some((start, source_in, duration)) = trimmed(c) else { continue };
                        let input = input_index(&mut g, &c.media, &main_key(c))?;
                        let (filters, requires, alpha_fx) = effect_filters(c)?;
                        g.video.push(VideoSegment {
                            input,
                            layer,
                            start,
                            source_in,
                            duration,
                            opacity: c.opacity,
                            filters,
                            requires,
                            speed: c.speed,
                            reverse: c.reverse,
                            freeze: c.freeze,
                            transform: c.transform,
                            blend: c.blend.clone(),
                            keyframes: clip_keyframes(c),
                            alpha_fx,
                        });
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
                    let Some((start, source_in, duration)) = trimmed(c) else { continue };
                    let input = input_index(&mut g, &c.media, &main_key(c))?;
                    g.audio.push(AudioSegment { input, start, source_in, duration, gain_db: c.gain_db + t.gain_db, speed: c.speed, reverse: c.reverse });
                }
            }
        }
    }
    Ok(g)
}
