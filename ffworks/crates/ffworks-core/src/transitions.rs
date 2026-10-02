//! Transitions between two adjacent clips on one video track (spec §67).
//!
//! A transition of duration `d` is centred on the cut: it blends the last `d/2` of the outgoing clip's *extended*
//! media with the first `d/2` of the incoming clip's, so the timeline length is unchanged. This needs "handles"
//! (`d/2` of unused source media after A's out point and before B's in point); validation reports when they are missing.

use crate::error::{Error, Result};
use crate::project::{Clip, Id, Project, Track, TrackKind};
use crate::time::{Fps, Rational};
use serde::{Deserialize, Serialize};

/// (id, display name) of supported FFmpeg `xfade` transitions.
pub const KINDS: &[(&str, &str)] = &[
    ("fade", "Cross dissolve"),
    ("fadeblack", "Dip to black"),
    ("fadewhite", "Dip to white"),
    ("wipeleft", "Wipe left"),
    ("wiperight", "Wipe right"),
    ("slideleft", "Slide left"),
    ("slideright", "Slide right"),
    ("circleopen", "Circle open"),
    ("radial", "Radial"),
    ("pixelize", "Pixelize"),
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Transition {
    pub id: Id,
    pub clip_a: Id,
    pub clip_b: Id,
    pub kind: String,
    pub duration: Rational,
}

impl Transition {
    pub fn half(&self) -> Rational {
        self.duration.div(Rational::from_int(2))
    }
}

/// Snap a requested duration to an even number of frames (>= 2) so that `duration / 2` is itself on the frame grid.
pub fn snap_duration(d: Rational, fps: Fps) -> Rational {
    let frames = d.round_units(fps);
    let even = ((frames + 1) / 2 * 2).max(2);
    Rational::new(even, 1).div(fps)
}

pub fn check_kind(kind: &str) -> Result<()> {
    if KINDS.iter().any(|(k, _)| *k == kind) {
        Ok(())
    } else {
        Err(Error::validation(format!("unknown transition '{kind}'")))
    }
}

/// Validate every transition on `track` against its clips and media handles.
pub fn validate_track(p: &Project, track: &Track) -> Result<()> {
    if track.transitions.is_empty() {
        return Ok(());
    }
    if track.kind != TrackKind::Video {
        return Err(Error::validation(format!("track '{}': transitions are only supported on video tracks", track.name)));
    }
    let mut used: Vec<(Id, Rational)> = vec![];
    let mut seen: Vec<(&Id, &Id)> = vec![];
    for t in &track.transitions {
        check_kind(&t.kind)?;
        if seen.contains(&(&t.clip_a, &t.clip_b)) {
            return Err(Error::validation("a cut can only have one transition"));
        }
        seen.push((&t.clip_a, &t.clip_b));
        let find = |id: &str| -> Result<&Clip> { track.clips.iter().find(|c| c.id == id).ok_or_else(|| Error::validation(format!("transition on '{}' refers to a clip that is no longer on the track", track.name))) };
        let (a, b) = (find(&t.clip_a)?, find(&t.clip_b)?);
        let half = t.half();
        if a.end() != b.start {
            return Err(Error::validation(format!("transition between '{}' and '{}' needs the clips to touch; remove the transition before moving or trimming them", a.name, b.name)));
        }
        if a.opacity < 1.0 || b.opacity < 1.0 {
            return Err(Error::validation("clips with a transition must have opacity 100%"));
        }
        let (ma, _mb) = (p.media(&a.media)?, p.media(&b.media)?);
        let eps = Rational::new(1, 1000);
        if a.source_in + a.duration + half > ma.info.duration + eps {
            return Err(Error::validation(format!("'{}' has no media left after its out point for a {}s transition (needs {}s of handle)", a.name, t.duration.as_f64(), half.as_f64())));
        }
        if b.source_in - half < Rational::ZERO - eps {
            return Err(Error::validation(format!("'{}' has no media before its in point for a {}s transition (needs {}s of handle)", b.name, t.duration.as_f64(), half.as_f64())));
        }
        for (id, c) in [(&a.id, a), (&b.id, b)] {
            let cur = used.iter().position(|(i, _)| i == id).map(|i| used[i].1).unwrap_or(Rational::ZERO) + half;
            if cur >= c.duration {
                return Err(Error::validation(format!("transitions consume all of '{}'; shorten them or lengthen the clip", c.name)));
            }
            match used.iter_mut().find(|(i, _)| i == id) {
                Some(u) => u.1 = cur,
                None => used.push((id.clone(), cur)),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_snaps_to_even_frames() {
        let fps = Rational::from_int(30);
        assert_eq!(snap_duration(Rational::new(1, 2), fps), Rational::new(8, 15)); // 15 frames is odd -> 16 frames
        assert_eq!(snap_duration(Rational::new(1, 3), fps), Rational::new(1, 3)); // 10 frames stays
        assert_eq!(snap_duration(Rational::new(1, 1000), fps), Rational::new(1, 15)); // minimum 2 frames
    }

    #[test]
    fn kinds_are_known() {
        assert!(check_kind("fade").is_ok());
        assert!(check_kind("nope").is_err());
    }
}
