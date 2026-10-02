//! The typed command bus (spec §111). UI actions, scripts, macros, the automation recorder and
//! undo all go through [`Command`]. A command is *planned* against the current project into
//! [`Patch`]es without mutating anything; the engine then applies the patches and records them.

use crate::error::{Error, Result};
use crate::patch::Patch;
use crate::project::{new_id, Clip, Id, MediaAsset, Project, ProjectSettings, Track, TrackKind};
use crate::time::{snap_to_frame, Rational};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Edge {
    Start,
    End,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    RenameProject { name: String },
    SetProjectSettings { settings: ProjectSettings },
    ImportMedia { asset: MediaAsset },
    RemoveMedia { media: Id },
    AddTrack { kind: TrackKind, name: Option<String> },
    RemoveTrack { track: Id },
    SetTrack { track: Id, name: Option<String>, muted: Option<bool>, locked: Option<bool>, gain_db: Option<f64> },
    /// Place media on a track. For video media with audio, a linked audio clip is placed too
    /// (on `audio_track` or the first audio track with room) unless `with_audio` is false.
    PlaceClip {
        media: Id,
        track: Id,
        start: Rational,
        source_in: Option<Rational>,
        duration: Option<Rational>,
        #[serde(default = "yes")]
        with_audio: bool,
        audio_track: Option<Id>,
    },
    MoveClip { clip: Id, start: Rational, track: Option<Id> },
    TrimClip { clip: Id, edge: Edge, to: Rational },
    SplitClip { clip: Id, at: Rational },
    DeleteClip { clip: Id, ripple: bool },
    /// Absolute or relative (`relative: true`) gain change in dB (spec §140).
    SetClipGain { clip: Id, gain_db: f64, relative: bool },
    /// Several commands applied as one undo step (spec §112).
    Batch { label: String, commands: Vec<Command> },
}

fn yes() -> bool {
    true
}

impl Command {
    /// Short label for history and recorded scripts.
    pub fn label(&self) -> String {
        match self {
            Command::RenameProject { .. } => "Rename project".into(),
            Command::SetProjectSettings { .. } => "Project settings".into(),
            Command::ImportMedia { asset } => format!("Import {}", asset.name),
            Command::RemoveMedia { .. } => "Remove media".into(),
            Command::AddTrack { .. } => "Add track".into(),
            Command::RemoveTrack { .. } => "Remove track".into(),
            Command::SetTrack { .. } => "Track properties".into(),
            Command::PlaceClip { .. } => "Place clip".into(),
            Command::MoveClip { .. } => "Move clip".into(),
            Command::TrimClip { .. } => "Trim clip".into(),
            Command::SplitClip { .. } => "Split clip".into(),
            Command::DeleteClip { ripple, .. } => if *ripple { "Ripple delete".into() } else { "Delete clip".into() },
            Command::SetClipGain { .. } => "Clip volume".into(),
            Command::Batch { label, .. } => label.clone(),
        }
    }
}

/// Plan a non-batch command into patches. Pure: never mutates `p`.
pub fn plan(p: &Project, cmd: &Command) -> Result<Vec<Patch>> {
    let seq = p.active()?;
    let sid = seq.id.clone();
    let fps = p.settings.fps;
    match cmd {
        Command::Batch { .. } => Err(Error::validation("batch is handled by the engine")),
        Command::RenameProject { name } => {
            if name.trim().is_empty() {
                return Err(Error::validation("project name cannot be empty"));
            }
            Ok(vec![Patch::SetName { name: name.clone() }])
        }
        Command::SetProjectSettings { settings } => {
            if settings.width == 0 || settings.height == 0 || settings.width % 2 != 0 || settings.height % 2 != 0 {
                return Err(Error::validation("project resolution must be non-zero and even (required by yuv420p encoders)"));
            }
            if settings.fps <= Rational::ZERO || settings.sample_rate == 0 {
                return Err(Error::validation("frame rate and sample rate must be positive"));
            }
            Ok(vec![Patch::SetSettings { settings: settings.clone() }])
        }
        Command::ImportMedia { asset } => {
            if p.media.iter().any(|m| m.id == asset.id) {
                return Err(Error::validation(format!("media id {} already exists", asset.id)));
            }
            Ok(vec![Patch::InsertMedia { index: p.media.len(), asset: asset.clone() }])
        }
        Command::RemoveMedia { media } => {
            p.media(media)?;
            if p.sequences.iter().flat_map(|s| &s.tracks).flat_map(|t| &t.clips).any(|c| &c.media == media) {
                return Err(Error::validation("media is used by clips on a timeline; remove those clips first"));
            }
            Ok(vec![Patch::RemoveMedia { media: media.clone() }])
        }
        Command::AddTrack { kind, name } => {
            let n = seq.tracks.iter().filter(|t| t.kind == *kind).count() + 1;
            let default = format!("{}{}", if *kind == TrackKind::Video { "V" } else { "A" }, n);
            // Video tracks stack upward: new video tracks go on top; audio tracks go at the bottom.
            let index = match kind {
                TrackKind::Video => seq.tracks.iter().rposition(|t| t.kind == TrackKind::Video).map(|i| i + 1).unwrap_or(0),
                TrackKind::Audio => seq.tracks.len(),
            };
            Ok(vec![Patch::InsertTrack {
                seq: sid,
                index,
                track: Track { id: new_id("trk"), name: name.clone().unwrap_or(default), kind: *kind, muted: false, locked: false, gain_db: 0.0, clips: vec![] },
            }])
        }
        Command::RemoveTrack { track } => {
            let t = seq.track(track).ok_or_else(|| Error::NotFound(format!("track {track}")))?;
            if !t.clips.is_empty() {
                return Err(Error::validation(format!("track '{}' still contains clips", t.name)));
            }
            Ok(vec![Patch::RemoveTrack { seq: sid, track: track.clone() }])
        }
        Command::SetTrack { track, name, muted, locked, gain_db } => {
            let t = seq.track(track).ok_or_else(|| Error::NotFound(format!("track {track}")))?;
            Ok(vec![Patch::SetTrackProps {
                seq: sid,
                track: track.clone(),
                name: name.clone().unwrap_or_else(|| t.name.clone()),
                muted: muted.unwrap_or(t.muted),
                locked: locked.unwrap_or(t.locked),
                gain_db: gain_db.unwrap_or(t.gain_db),
            }])
        }
        Command::PlaceClip { media, track, start, source_in, duration, with_audio, audio_track } => {
            let m = p.media(media)?;
            let t = seq.track(track).ok_or_else(|| Error::NotFound(format!("track {track}")))?;
            ensure_unlocked(t)?;
            let start = snap_to_frame(*start, fps);
            if start < Rational::ZERO {
                return Err(Error::validation("clips cannot start before 00:00:00"));
            }
            let s_in = source_in.unwrap_or(Rational::ZERO);
            let dur = duration.unwrap_or(m.info.duration - s_in);
            if s_in < Rational::ZERO || dur <= Rational::ZERO || s_in + dur > m.info.duration + Rational::new(1, 1000) {
                return Err(Error::validation(format!("source range {s_in}+{dur}s is outside '{}' ({}s)", m.name, m.info.duration.as_f64())));
            }
            let has_v = m.info.has_video();
            let has_a = m.info.has_audio();
            match t.kind {
                TrackKind::Video if !has_v => return Err(Error::validation(format!("'{}' has no video stream; place it on an audio track", m.name))),
                TrackKind::Audio if !has_a => return Err(Error::validation(format!("'{}' has no audio stream", m.name))),
                _ => {}
            }
            let link = if t.kind == TrackKind::Video && has_a && *with_audio { Some(new_id("lnk")) } else { None };
            check_free(t, start, start + dur, &[])?;
            let mut out = vec![Patch::PutClip {
                seq: sid.clone(),
                track: t.id.clone(),
                clip: Clip { id: new_id("clp"), media: media.clone(), name: m.name.clone(), kind: t.kind, start, source_in: s_in, duration: dur, link: link.clone(), gain_db: 0.0 },
            }];
            if link.is_some() {
                let at = match audio_track {
                    Some(id) => seq.track(id).ok_or_else(|| Error::NotFound(format!("track {id}")))?,
                    None => seq
                        .tracks
                        .iter()
                        .find(|t| t.kind == TrackKind::Audio && !t.locked && check_free(t, start, start + dur, &[]).is_ok())
                        .ok_or_else(|| Error::validation("no free audio track for the linked audio; add an audio track"))?,
                };
                if at.kind != TrackKind::Audio {
                    return Err(Error::validation(format!("track '{}' is not an audio track", at.name)));
                }
                ensure_unlocked(at)?;
                check_free(at, start, start + dur, &[])?;
                out.push(Patch::PutClip {
                    seq: sid,
                    track: at.id.clone(),
                    clip: Clip { id: new_id("clp"), media: media.clone(), name: m.name.clone(), kind: TrackKind::Audio, start, source_in: s_in, duration: dur, link, gain_db: 0.0 },
                });
            }
            Ok(out)
        }
        Command::MoveClip { clip, start, track } => {
            let (src_track, c) = seq.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
            ensure_unlocked(src_track)?;
            let new_start = snap_to_frame(*start, fps);
            if new_start < Rational::ZERO {
                return Err(Error::validation("clips cannot start before 00:00:00"));
            }
            let delta = new_start - c.start;
            let group = seq.linked_group(clip);
            let mut out = vec![];
            for gid in &group {
                let (gt, gc) = seq.find_clip(gid).expect("group member exists");
                ensure_unlocked(gt)?;
                let dest = if gid == clip {
                    match track {
                        Some(tid) => {
                            let d = seq.track(tid).ok_or_else(|| Error::NotFound(format!("track {tid}")))?;
                            if d.kind != gc.kind {
                                return Err(Error::validation(format!("cannot move a {:?} clip onto {:?} track '{}'", gc.kind, d.kind, d.name)));
                            }
                            ensure_unlocked(d)?;
                            d
                        }
                        None => gt,
                    }
                } else {
                    gt
                };
                let ns = gc.start + delta;
                if ns < Rational::ZERO {
                    return Err(Error::validation("move would push a linked clip before 00:00:00"));
                }
                check_free(dest, ns, ns + gc.duration, &group)?;
                let mut moved = gc.clone();
                moved.start = ns;
                out.push(Patch::PutClip { seq: sid.clone(), track: dest.id.clone(), clip: moved });
            }
            Ok(out)
        }
        Command::TrimClip { clip, edge, to } => {
            let to = snap_to_frame(*to, fps);
            let group = seq.linked_group(clip);
            if group.is_empty() {
                return Err(Error::NotFound(format!("clip {clip}")));
            }
            let (_, anchor) = seq.find_clip(clip).expect("checked");
            // Edge delta is derived from the clicked clip and applied equally to linked clips.
            let delta = match edge {
                Edge::Start => to - anchor.start,
                Edge::End => to - anchor.end(),
            };
            let mut out = vec![];
            for gid in &group {
                let (gt, gc) = seq.find_clip(gid).expect("member");
                ensure_unlocked(gt)?;
                let mut c = gc.clone();
                match edge {
                    Edge::Start => {
                        c.start = gc.start + delta;
                        c.source_in = gc.source_in + delta;
                        c.duration = gc.duration - delta;
                    }
                    Edge::End => c.duration = gc.duration + delta,
                }
                let m = p.media(&c.media)?;
                if c.duration < Rational::from_int(1).div(fps) {
                    return Err(Error::validation("trim would leave less than one frame; delete the clip instead"));
                }
                if c.source_in < Rational::ZERO {
                    return Err(Error::validation(format!("cannot extend '{}' before the start of its source media", c.name)));
                }
                if c.source_in + c.duration > m.info.duration + Rational::new(1, 1000) {
                    return Err(Error::validation(format!("cannot extend '{}' past the end of its source media", c.name)));
                }
                if c.start < Rational::ZERO {
                    return Err(Error::validation("trim would move the clip before 00:00:00"));
                }
                check_free(gt, c.start, c.end(), &group)?;
                out.push(Patch::PutClip { seq: sid.clone(), track: gt.id.clone(), clip: c });
            }
            Ok(out)
        }
        Command::SplitClip { clip, at } => {
            let at = snap_to_frame(*at, fps);
            let group = seq.linked_group(clip);
            if group.is_empty() {
                return Err(Error::NotFound(format!("clip {clip}")));
            }
            let one_frame = Rational::from_int(1).div(fps);
            let has_link = group.len() > 1;
            let right_link = if has_link { Some(new_id("lnk")) } else { None };
            let mut out = vec![];
            for gid in &group {
                let (gt, gc) = seq.find_clip(gid).expect("member");
                ensure_unlocked(gt)?;
                if at < gc.start + one_frame || at > gc.end() - one_frame {
                    return Err(Error::validation(format!("split point must be inside '{}' and at least one frame from either edge", gc.name)));
                }
                let mut left = gc.clone();
                left.duration = at - gc.start;
                let mut right = gc.clone();
                right.id = new_id("clp");
                right.start = at;
                right.source_in = gc.source_in + (at - gc.start);
                right.duration = gc.end() - at;
                right.link = right_link.clone();
                out.push(Patch::PutClip { seq: sid.clone(), track: gt.id.clone(), clip: left });
                out.push(Patch::PutClip { seq: sid.clone(), track: gt.id.clone(), clip: right });
            }
            Ok(out)
        }
        Command::DeleteClip { clip, ripple } => {
            let group = seq.linked_group(clip);
            if group.is_empty() {
                return Err(Error::NotFound(format!("clip {clip}")));
            }
            let mut out = vec![];
            for gid in &group {
                let (gt, gc) = seq.find_clip(gid).expect("member");
                ensure_unlocked(gt)?;
                out.push(Patch::RemoveClip { seq: sid.clone(), clip: gid.clone() });
                if *ripple {
                    for later in gt.clips.iter().filter(|c| c.start >= gc.end() && !group.contains(&c.id)) {
                        let mut shifted = later.clone();
                        shifted.start = later.start - gc.duration;
                        out.push(Patch::PutClip { seq: sid.clone(), track: gt.id.clone(), clip: shifted });
                    }
                }
            }
            Ok(out)
        }
        Command::SetClipGain { clip, gain_db, relative } => {
            let (_, c) = seq.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
            // Volume belongs to the audio clip; targeting a video clip means its linked audio.
            let target = if c.kind == TrackKind::Audio {
                c.id.clone()
            } else {
                seq.linked_group(clip).into_iter().find(|id| seq.find_clip(id).map(|(_, x)| x.kind == TrackKind::Audio).unwrap_or(false)).ok_or_else(|| Error::validation("this clip has no audio to adjust"))?
            };
            let (tt, tc) = seq.find_clip(&target).expect("exists");
            ensure_unlocked(tt)?;
            let new_gain = if *relative { tc.gain_db + gain_db } else { *gain_db };
            if !(-96.0..=24.0).contains(&new_gain) {
                return Err(Error::validation(format!("gain {new_gain:.1} dB is outside -96..+24 dB")));
            }
            let mut c2 = tc.clone();
            c2.gain_db = new_gain;
            Ok(vec![Patch::PutClip { seq: sid, track: tt.id.clone(), clip: c2 }])
        }
    }
}

fn ensure_unlocked(t: &Track) -> Result<()> {
    if t.locked {
        Err(Error::validation(format!("track '{}' is locked", t.name)))
    } else {
        Ok(())
    }
}

/// Fail if `[start,end)` collides with a clip on `t` (ignoring clips whose id is in `ignore`).
fn check_free(t: &Track, start: Rational, end: Rational, ignore: &[Id]) -> Result<()> {
    for c in &t.clips {
        if ignore.contains(&c.id) {
            continue;
        }
        if c.start < end && start < c.end() {
            return Err(Error::validation(format!("range overlaps clip '{}' on track '{}'", c.name, t.name)));
        }
    }
    Ok(())
}
