//! Low-level, invertible state transitions. Every [`Command`](crate::commands::Command) compiles to a
//! list of `Patch`es; applying a patch returns its inverse, which is what powers undo/redo,
//! transactions and automation recording with predictable state transitions (spec §111).

use crate::error::{Error, Result};
use crate::project::{Clip, Id, MediaAsset, Project, ProjectSettings, Track};
use crate::transitions::Transition;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Patch {
    /// Insert the clip into `track`, or replace/move it if a clip with the same id already exists anywhere.
    PutClip { seq: Id, track: Id, clip: Clip },
    RemoveClip { seq: Id, clip: Id },
    /// Insert or replace (by id) a transition on `track`.
    PutTransition { seq: Id, track: Id, transition: Transition },
    RemoveTransition { seq: Id, track: Id, id: Id },
    /// Insert a whole track (with its clips) at `index`.
    InsertTrack { seq: Id, index: usize, track: Track },
    RemoveTrack { seq: Id, track: Id },
    SetTrackProps { seq: Id, track: Id, name: String, muted: bool, locked: bool, gain_db: f64 },
    InsertMedia { index: usize, asset: MediaAsset },
    RemoveMedia { media: Id },
    /// Replace an asset in place (same id), e.g. when relinking.
    ReplaceMedia { asset: MediaAsset },
    SetSettings { settings: ProjectSettings },
    SetName { name: String },
}

fn find_clip_pos(p: &Project, seq: &str, clip: &str) -> Result<Option<(usize, usize)>> {
    let s = p.sequence(seq)?;
    for (ti, t) in s.tracks.iter().enumerate() {
        if let Some(ci) = t.clips.iter().position(|c| c.id == clip) {
            return Ok(Some((ti, ci)));
        }
    }
    Ok(None)
}

pub fn apply(p: &mut Project, patch: &Patch) -> Result<Patch> {
    match patch {
        Patch::PutClip { seq, track, clip } => {
            let existing = find_clip_pos(p, seq, &clip.id)?;
            let inverse = match existing {
                Some((ti, ci)) => {
                    let s = p.sequence_mut(seq)?;
                    let old = s.tracks[ti].clips.remove(ci);
                    Patch::PutClip { seq: seq.clone(), track: s.tracks[ti].id.clone(), clip: old }
                }
                None => Patch::RemoveClip { seq: seq.clone(), clip: clip.id.clone() },
            };
            let s = p.sequence_mut(seq)?;
            let t = s.tracks.iter_mut().find(|t| &t.id == track).ok_or_else(|| Error::NotFound(format!("track {track}")))?;
            let at = t.clips.partition_point(|c| c.start <= clip.start);
            t.clips.insert(at, clip.clone());
            Ok(inverse)
        }
        Patch::RemoveClip { seq, clip } => {
            let (ti, ci) = find_clip_pos(p, seq, clip)?.ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
            let s = p.sequence_mut(seq)?;
            let track_id = s.tracks[ti].id.clone();
            let old = s.tracks[ti].clips.remove(ci);
            Ok(Patch::PutClip { seq: seq.clone(), track: track_id, clip: old })
        }
        Patch::PutTransition { seq, track, transition } => {
            let s = p.sequence_mut(seq)?;
            let t = s.tracks.iter_mut().find(|t| &t.id == track).ok_or_else(|| Error::NotFound(format!("track {track}")))?;
            match t.transitions.iter().position(|x| x.id == transition.id) {
                Some(i) => {
                    let old = std::mem::replace(&mut t.transitions[i], transition.clone());
                    Ok(Patch::PutTransition { seq: seq.clone(), track: track.clone(), transition: old })
                }
                None => {
                    t.transitions.push(transition.clone());
                    Ok(Patch::RemoveTransition { seq: seq.clone(), track: track.clone(), id: transition.id.clone() })
                }
            }
        }
        Patch::RemoveTransition { seq, track, id } => {
            let s = p.sequence_mut(seq)?;
            let t = s.tracks.iter_mut().find(|t| &t.id == track).ok_or_else(|| Error::NotFound(format!("track {track}")))?;
            let i = t.transitions.iter().position(|x| &x.id == id).ok_or_else(|| Error::NotFound(format!("transition {id}")))?;
            let old = t.transitions.remove(i);
            Ok(Patch::PutTransition { seq: seq.clone(), track: track.clone(), transition: old })
        }
        Patch::InsertTrack { seq, index, track } => {
            let s = p.sequence_mut(seq)?;
            let at = (*index).min(s.tracks.len());
            s.tracks.insert(at, track.clone());
            Ok(Patch::RemoveTrack { seq: seq.clone(), track: track.id.clone() })
        }
        Patch::RemoveTrack { seq, track } => {
            let s = p.sequence_mut(seq)?;
            let idx = s.tracks.iter().position(|t| &t.id == track).ok_or_else(|| Error::NotFound(format!("track {track}")))?;
            let old = s.tracks.remove(idx);
            Ok(Patch::InsertTrack { seq: seq.clone(), index: idx, track: old })
        }
        Patch::SetTrackProps { seq, track, name, muted, locked, gain_db } => {
            let s = p.sequence_mut(seq)?;
            let t = s.tracks.iter_mut().find(|t| &t.id == track).ok_or_else(|| Error::NotFound(format!("track {track}")))?;
            let inv = Patch::SetTrackProps { seq: seq.clone(), track: track.clone(), name: t.name.clone(), muted: t.muted, locked: t.locked, gain_db: t.gain_db };
            t.name = name.clone();
            t.muted = *muted;
            t.locked = *locked;
            t.gain_db = *gain_db;
            Ok(inv)
        }
        Patch::InsertMedia { index, asset } => {
            let at = (*index).min(p.media.len());
            p.media.insert(at, asset.clone());
            Ok(Patch::RemoveMedia { media: asset.id.clone() })
        }
        Patch::RemoveMedia { media } => {
            let idx = p.media.iter().position(|m| &m.id == media).ok_or_else(|| Error::NotFound(format!("media {media}")))?;
            let old = p.media.remove(idx);
            Ok(Patch::InsertMedia { index: idx, asset: old })
        }
        Patch::ReplaceMedia { asset } => {
            let slot = p.media.iter_mut().find(|m| m.id == asset.id).ok_or_else(|| Error::NotFound(format!("media {}", asset.id)))?;
            let old = std::mem::replace(slot, asset.clone());
            Ok(Patch::ReplaceMedia { asset: old })
        }
        Patch::SetSettings { settings } => {
            let old = std::mem::replace(&mut p.settings, settings.clone());
            Ok(Patch::SetSettings { settings: old })
        }
        Patch::SetName { name } => {
            let old = std::mem::replace(&mut p.name, name.clone());
            Ok(Patch::SetName { name: old })
        }
    }
}
