//! Transitions between two adjacent clips on one video track (spec §67).
//!
//! A transition of duration `d` is centred on the cut: it blends the last `d/2` of the outgoing clip's *extended*
//! media with the first `d/2` of the incoming clip's, so the timeline length is unchanged. This needs "handles"
//! (`d/2` of unused source media after A's out point and before B's in point); validation reports when they are missing.

use crate::error::{Error, Result};
use crate::project::{Clip, Id, Project, Track, TrackKind};
use crate::time::{Fps, Rational};
use serde::{Deserialize, Serialize};

/// (id, display name) of FFmpeg `xfade` transitions known at build time (FFmpeg 6.1/7.x: 57). The app asks the installed FFmpeg for the
/// list it really supports (`Capabilities::xfade_transitions`); this is the fallback and the source of display names.
pub const KINDS: &[(&str, &str)] = &[
    ("fade", "Fade"),
    ("wipeleft", "Wipe left"),
    ("wiperight", "Wipe right"),
    ("wipeup", "Wipe up"),
    ("wipedown", "Wipe down"),
    ("slideleft", "Slide left"),
    ("slideright", "Slide right"),
    ("slideup", "Slide up"),
    ("slidedown", "Slide down"),
    ("circlecrop", "Circle crop"),
    ("rectcrop", "Rect crop"),
    ("distance", "Distance"),
    ("fadeblack", "Fadeblack"),
    ("fadewhite", "Fadewhite"),
    ("radial", "Radial"),
    ("smoothleft", "Smoothleft"),
    ("smoothright", "Smoothright"),
    ("smoothup", "Smoothup"),
    ("smoothdown", "Smoothdown"),
    ("circleopen", "Circleopen"),
    ("circleclose", "Circleclose"),
    ("vertopen", "Vert open"),
    ("vertclose", "Vert close"),
    ("horzopen", "Horz open"),
    ("horzclose", "Horz close"),
    ("dissolve", "Dissolve"),
    ("pixelize", "Pixelize"),
    ("diagtl", "Diag tl"),
    ("diagtr", "Diag tr"),
    ("diagbl", "Diag bl"),
    ("diagbr", "Diag br"),
    ("hlslice", "Hl slice"),
    ("hrslice", "Hr slice"),
    ("vuslice", "Vu slice"),
    ("vdslice", "Vd slice"),
    ("hblur", "Hblur"),
    ("fadegrays", "Fadegrays"),
    ("wipetl", "Wipe tl"),
    ("wipetr", "Wipe tr"),
    ("wipebl", "Wipe bl"),
    ("wipebr", "Wipe br"),
    ("squeezeh", "Squeeze h"),
    ("squeezev", "Squeeze v"),
    ("zoomin", "Zoom in"),
    ("fadefast", "Fast fade"),
    ("fadeslow", "Slow fade"),
    ("hlwind", "Hl wind"),
    ("hrwind", "Hr wind"),
    ("vuwind", "Vu wind"),
    ("vdwind", "Vd wind"),
    ("coverleft", "Cover left"),
    ("coverright", "Cover right"),
    ("coverup", "Cover up"),
    ("coverdown", "Cover down"),
    ("revealleft", "Reveal left"),
    ("revealright", "Reveal right"),
    ("revealup", "Reveal up"),
    ("revealdown", "Reveal down"),
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

/// Accept any plain lowercase xfade name (newer FFmpegs add transitions); the name goes into a filter graph, so nothing else is allowed.
/// Whether the *installed* FFmpeg supports it is checked when the render is compiled.
pub fn check_kind(kind: &str) -> Result<()> {
    if !kind.is_empty() && kind != "custom" && kind.len() <= 24 && kind.chars().all(|c| c.is_ascii_lowercase()) {
        Ok(())
    } else {
        Err(Error::validation(format!("unknown transition '{kind}'")))
    }
}

/// Audio clips linked to `c` (none when it is unlinked).
fn linked_audio<'a>(p: &'a Project, c: &Clip) -> Vec<&'a Clip> {
    let Some(link) = &c.link else { return vec![] };
    p.sequences.iter().flat_map(|s| s.tracks.iter()).flat_map(|t| t.clips.iter()).filter(|x| x.kind == TrackKind::Audio && x.link.as_ref() == Some(link)).collect()
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
        for c in [a, b] {
            if p.media(&c.media)?.is_generated() {
                return Err(Error::validation(format!("'{}' is a generated clip (title/solid colour); transitions are not supported on those yet — fade its opacity instead", c.name)));
            }
            if !c.is_plain_timing() {
                return Err(Error::validation(format!("'{}' has speed, reverse or freeze applied; transitions need normal playback (remove the transition or reset the clip's timing)", c.name)));
            }
            for ac in linked_audio(p, c) {
                if !ac.effects.is_empty() || ac.pan != 0.0 || ac.fade_in != Rational::ZERO || ac.fade_out != Rational::ZERO || !ac.keyframes.is_empty() || !ac.is_plain_timing() {
                    return Err(Error::validation(format!("the audio of '{}' has effects, pan, fades, keyframes or retiming; transitions cannot be combined with those yet", c.name)));
                }
            }
            if c.effects.iter().any(|e| e.enabled && e.graph.is_some()) {
                return Err(Error::validation(format!("'{}' has a custom filter graph; transitions cannot be combined with those yet", c.name)));
            }
            if !c.transform.is_identity() || c.blend != "normal" || !c.keyframes.is_empty() {
                return Err(Error::validation(format!("'{}' has a transform, blend mode or keyframes; transitions cannot be combined with those yet", c.name)));
            }
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
    fn kind_names_are_validated_for_safe_use_in_a_filter_graph() {
        assert!(check_kind("fade").is_ok());
        assert!(check_kind("zoomin").is_ok());
        for bad in ["", "custom", "fade;movie=x", "Fade", "a b", "x:y", "waytoolongtransitionname_here"] {
            assert!(check_kind(bad).is_err(), "{bad}");
        }
        assert!(KINDS.len() >= 50 && KINDS.iter().all(|(k, _)| check_kind(k).is_ok()));
    }
}
