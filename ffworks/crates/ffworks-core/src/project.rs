//! Authoritative, serialisable project model (spec §5). One model backs the UI, scripts,
//! macros and the renderer. Only persistent state lives here; transient UI state does not.

use crate::error::{Error, Result};
use crate::effects::EffectInstance;
use crate::ffprobe::MediaInfo;
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
    /// Length on the timeline (speed is 1.0 until retiming exists).
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
}

fn one() -> f64 {
    1.0
}

impl Clip {
    pub fn end(&self) -> Rational {
        self.start + self.duration
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Sequence {
    pub id: Id,
    pub name: String,
    pub tracks: Vec<Track>,
}

impl Sequence {
    pub fn new(name: &str) -> Sequence {
        Sequence {
            id: new_id("seq"),
            name: name.into(),
            tracks: vec![
                Track { id: new_id("trk"), name: "V1".into(), kind: TrackKind::Video, muted: false, locked: false, gain_db: 0.0, clips: vec![], transitions: vec![] },
                Track { id: new_id("trk"), name: "A1".into(), kind: TrackKind::Audio, muted: false, locked: false, gain_db: 0.0, clips: vec![], transitions: vec![] },
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
                    if c.source_in + c.duration > m.info.duration + Rational::new(1, 1000) {
                        return Err(Error::validation(format!("clip '{}' extends past the end of '{}'", c.name, m.name)));
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
