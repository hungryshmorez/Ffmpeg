//! Authoritative, serialisable project model (spec §5). One model backs the UI, scripts,
//! macros and the renderer. Only persistent state lives here; transient UI state does not.

use crate::clipprops::Transform;
use crate::error::{Error, Result};
use crate::effects::EffectInstance;
use crate::keyframes::Keyframe;
use std::collections::BTreeMap;
use crate::ffprobe::MediaInfo;
use crate::generators::Generator;
use crate::titles::Title;
use crate::time::{Fps, Rational};
use crate::transitions::Transition;
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

pub type Id = String;

pub fn new_id(prefix: &str) -> Id {
    format!("{prefix}_{}", &uuid::Uuid::new_v4().simple().to_string()[..12])
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ProjectSettings {
    pub width: u32,
    pub height: u32,
    pub fps: Fps,
    pub sample_rate: u32,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        ProjectSettings { width: 1920, height: 1080, fps: Rational::from_int(30), sample_rate: 48000 }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct MediaAsset {
    pub id: Id,
    pub name: String,
    /// Absolute path of the untouched source file. Sources are never modified (spec §6).
    pub path: String,
    pub info: MediaInfo,
    /// Cheap content fingerprint (size + head/tail hash) used for relinking and cache keys.
    pub fingerprint: Option<String>,
    /// Generated media (solid colour, title canvas) has no file: `path` is a label and nothing is ever read from disk.
    #[serde(default)]
    pub generator: Option<Generator>,
}

impl MediaAsset {
    pub fn is_generated(&self) -> bool {
        self.generator.is_some()
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum TrackKind {
    Video,
    Audio,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Track {
    pub id: Id,
    pub name: String,
    pub kind: TrackKind,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub locked: bool,
    /// Track gain in dB (audio tracks).
    #[serde(default)]
    pub gain_db: f64,
    /// Balance -1 (left) .. +1 (right) (audio tracks).
    #[serde(default)]
    pub pan: f64,
    /// When any audio track is soloed, only soloed tracks are heard.
    #[serde(default)]
    pub solo: bool,
    /// Clips sorted by `start`, non-overlapping.
    #[serde(default)]
    pub clips: Vec<Clip>,
    /// Transitions on adjacent clip pairs (video tracks).
    #[serde(default)]
    pub transitions: Vec<Transition>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Clip {
    pub id: Id,
    pub media: Id,
    pub name: String,
    pub kind: TrackKind,
    /// Position on the timeline.
    pub start: Rational,
    /// Offset into the source media where this clip begins.
    pub source_in: Rational,
    /// Length on the timeline. The source span consumed is `duration × speed` (see [`Clip::source_span`]).
    pub duration: Rational,
    /// Clips sharing a link id move/trim/split/delete together (e.g. a video clip and its audio).
    #[serde(default)]
    pub link: Option<Id>,
    #[serde(default)]
    pub gain_db: f64,
    /// Video clips: 0..1 compositing opacity.
    #[serde(default = "one")]
    pub opacity: f64,
    /// Ordered effect stack (video clips).
    #[serde(default)]
    pub effects: Vec<EffectInstance>,
    /// Playback speed (1 = normal). Linked clips share it. Ignored while `freeze` is set.
    #[serde(default = "one_rational")]
    pub speed: Rational,
    /// Play the source range backwards. Video reverse buffers the whole clip in memory at render time.
    #[serde(default)]
    pub reverse: bool,
    /// Hold the single source frame at this time for the whole clip (video clips).
    #[serde(default)]
    pub freeze: Option<Rational>,
    #[serde(default)]
    pub transform: Transform,
    /// Audio clips: balance -1 (left) .. +1 (right); unity on the louder side.
    #[serde(default)]
    pub pan: f64,
    /// Audio clips: linear fade-in / fade-out lengths in seconds.
    #[serde(default)]
    pub fade_in: Rational,
    #[serde(default)]
    pub fade_out: Rational,
    /// Title text/styling; only on clips whose media is the transparent title canvas.
    #[serde(default)]
    pub title: Option<Title>,
    /// FFmpeg `blend` mode name, "normal" for plain compositing.
    #[serde(default = "normal_blend")]
    pub blend: String,
    /// Animated parameters, keyed by parameter id (see `clipprops::param_range`). Times are clip-relative.
    #[serde(default)]
    pub keyframes: BTreeMap<String, Vec<Keyframe>>,
}

fn one() -> f64 {
    1.0
}
fn one_rational() -> Rational {
    Rational::from_int(1)
}
fn normal_blend() -> String {
    "normal".into()
}

impl Clip {
    /// A plain clip: speed 1, no effects, identity transform.
    #[allow(clippy::too_many_arguments)]
    pub fn new(id: Id, media: Id, name: String, kind: TrackKind, start: Rational, source_in: Rational, duration: Rational, link: Option<Id>) -> Clip {
        Clip { id, media, name, kind, start, source_in, duration, link, gain_db: 0.0, opacity: 1.0, effects: vec![], speed: one_rational(), reverse: false, freeze: None, transform: Transform::default(), pan: 0.0, fade_in: Rational::ZERO, fade_out: Rational::ZERO, title: None, blend: normal_blend(), keyframes: BTreeMap::new() }
    }

    pub fn end(&self) -> Rational {
        self.start + self.duration
    }

    /// Length of source media this clip consumes (0 for a frozen frame).
    pub fn source_span(&self) -> Rational {
        if self.freeze.is_some() { Rational::ZERO } else { self.duration.mul(self.speed) }
    }

    /// Shrink fades so they fit the clip (fade-out first), e.g. after a trim or speed change.
    pub fn clamp_fades(&mut self) {
        self.fade_out = self.fade_out.min(self.duration);
        self.fade_in = self.fade_in.min(self.duration - self.fade_out);
    }

    /// True when the clip plays the source unchanged in time (required for transitions).
    pub fn is_plain_timing(&self) -> bool {
        self.speed == one_rational() && !self.reverse && self.freeze.is_none()
    }
}

/// A named point on the sequence timeline (chapter, note, to-do). Kept sorted by time.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Marker {
    pub id: Id,
    pub time: Rational,
    pub name: String,
    /// `#RRGGBB`.
    pub color: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Sequence {
    pub id: Id,
    pub name: String,
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub markers: Vec<Marker>,
}

impl Sequence {
    pub fn new(name: &str) -> Sequence {
        Sequence {
            id: new_id("seq"),
            name: name.into(),
            markers: vec![],
            tracks: vec![
                Track { id: new_id("trk"), name: "V1".into(), kind: TrackKind::Video, muted: false, locked: false, gain_db: 0.0, pan: 0.0, solo: false, clips: vec![], transitions: vec![] },
                Track { id: new_id("trk"), name: "A1".into(), kind: TrackKind::Audio, muted: false, locked: false, gain_db: 0.0, pan: 0.0, solo: false, clips: vec![], transitions: vec![] },
            ],
        }
    }

    pub fn duration(&self) -> Rational {
        self.tracks.iter().flat_map(|t| t.clips.iter()).map(Clip::end).fold(Rational::ZERO, Rational::max)
    }

    pub fn find_clip(&self, id: &str) -> Option<(&Track, &Clip)> {
        self.tracks.iter().find_map(|t| t.clips.iter().find(|c| c.id == id).map(|c| (t, c)))
    }

    pub fn track(&self, id: &str) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == id)
    }

    /// All clips that share a link id with `clip_id` (including itself).
    pub fn linked_group(&self, clip_id: &str) -> Vec<Id> {
        match self.find_clip(clip_id) {
            None => vec![],
            Some((_, c)) => match &c.link {
                None => vec![c.id.clone()],
                Some(l) => self.tracks.iter().flat_map(|t| t.clips.iter()).filter(|x| x.link.as_ref() == Some(l)).map(|x| x.id.clone()).collect(),
            },
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Project {
    pub schema_version: u32,
    pub name: String,
    pub settings: ProjectSettings,
    pub media: Vec<MediaAsset>,
    pub sequences: Vec<Sequence>,
    pub active_sequence: Id,
}

impl Project {
    pub fn new(name: &str, settings: ProjectSettings) -> Project {
        let seq = Sequence::new("Main");
        Project {
            schema_version: SCHEMA_VERSION,
            name: name.into(),
            settings,
            media: vec![],
            active_sequence: seq.id.clone(),
            sequences: vec![seq],
        }
    }

    pub fn sequence(&self, id: &str) -> Result<&Sequence> {
        self.sequences.iter().find(|s| s.id == id).ok_or_else(|| Error::NotFound(format!("sequence {id}")))
    }
    pub fn sequence_mut(&mut self, id: &str) -> Result<&mut Sequence> {
        self.sequences.iter_mut().find(|s| s.id == id).ok_or_else(|| Error::NotFound(format!("sequence {id}")))
    }
    pub fn active(&self) -> Result<&Sequence> {
        self.sequence(&self.active_sequence)
    }
    pub fn media(&self, id: &str) -> Result<&MediaAsset> {
        self.media.iter().find(|m| m.id == id).ok_or_else(|| Error::NotFound(format!("media {id}")))
    }

    /// Structural validation (spec §113): dangling references, overlaps, bad ranges, kind mismatches.
    pub fn validate(&self) -> Result<()> {
        self.sequence(&self.active_sequence)?;
        for seq in &self.sequences {
            for m in &seq.markers {
                if m.time < Rational::ZERO || m.name.chars().count() > 100 || m.note.chars().count() > 2000 {
                    return Err(Error::validation(format!("marker '{}' is invalid (negative time, name over 100 or note over 2000 characters)", m.name)));
                }
                crate::titles::check_hex(&m.color, 6)?;
            }
            for t in &seq.tracks {
                let mut prev_end: Option<Rational> = None;
                for c in &t.clips {
                    let m = self.media(&c.media).map_err(|_| Error::validation(format!("clip '{}' references missing media {}", c.name, c.media)))?;
                    if c.kind != t.kind {
                        return Err(Error::validation(format!("clip '{}' ({:?}) is on {:?} track '{}'", c.name, c.kind, t.kind, t.name)));
                    }
                    if c.duration <= Rational::ZERO {
                        return Err(Error::validation(format!("clip '{}' has non-positive duration", c.name)));
                    }
                    if c.start < Rational::ZERO || c.source_in < Rational::ZERO {
                        return Err(Error::validation(format!("clip '{}' has a negative time", c.name)));
                    }
                    if c.speed <= Rational::ZERO {
                        return Err(Error::validation(format!("clip '{}' has a non-positive speed", c.name)));
                    }
                    if c.source_in + c.source_span() > m.info.duration + Rational::new(1, 1000) {
                        return Err(Error::validation(format!("clip '{}' extends past the end of '{}'", c.name, m.name)));
                    }
                    if let Some(f) = c.freeze {
                        if c.kind != TrackKind::Video || f < Rational::ZERO || f >= m.info.duration {
                            return Err(Error::validation(format!("clip '{}' has an invalid freeze frame", c.name)));
                        }
                    }
                    crate::clipprops::check_blend(&c.blend)?;
                    if let Some(t) = &c.title {
                        t.validate()?;
                        if !m.is_generated() || c.kind != TrackKind::Video {
                            return Err(Error::validation(format!("clip '{}' has title text but is not a generated video clip", c.name)));
                        }
                    }
                    if c.fade_in < Rational::ZERO || c.fade_out < Rational::ZERO || c.fade_in + c.fade_out > c.duration {
                        return Err(Error::validation(format!("clip '{}': fades must be non-negative and fit inside the clip", c.name)));
                    }
                    if !(-1.0..=1.0).contains(&c.pan) {
                        return Err(Error::validation(format!("clip '{}': pan must be between -1 and 1", c.name)));
                    }
                    for (param, kfs) in &c.keyframes {
                        crate::keyframes::validate(param, kfs)?;
                        for k in kfs {
                            crate::clipprops::check_value(c, param, k.v, true)?;
                        }
                    }
                    if let Some(pe) = prev_end {
                        if c.start < pe {
                            return Err(Error::validation(format!("clip '{}' overlaps the previous clip on track '{}'", c.name, t.name)));
                        }
                    }
                    prev_end = Some(c.end());
                }
                crate::transitions::validate_track(self, t)?;
            }
        }
        Ok(())
    }
}
