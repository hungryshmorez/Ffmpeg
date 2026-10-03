//! The typed command bus (spec §111). UI actions, scripts, macros, the automation recorder and
//! undo all go through [`Command`]. A command is *planned* against the current project into
//! [`Patch`]es without mutating anything; the engine then applies the patches and records them.

use crate::error::{Error, Result};
use crate::patch::Patch;
use crate::project::{new_id, Clip, Id, Marker, MediaAsset, Project, ProjectSettings, Track, TrackKind};
use crate::time::{snap_to_frame, Rational};
use crate::transitions::{self, Transition};
use crate::clipprops;
use crate::generators;
use crate::titles::Title;
use crate::effects::{self, EffectInstance};
use crate::keyframes::{self, Interp, Keyframe};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Edge {
    Start,
    End,
}

/// Sequences whose name starts with this are snapshots, not timelines to edit.
pub const SNAPSHOT_PREFIX: &str = "Snapshot: ";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    RenameProject { name: String },
    SetProjectSettings { settings: ProjectSettings },
    ImportMedia { asset: MediaAsset },
    RemoveMedia { media: Id },
    /// Point an existing media entry at a new file (already probed). Clips keep their references.
    RelinkMedia { asset: MediaAsset },
    AddTrack { kind: TrackKind, name: Option<String> },
    RemoveTrack { track: Id },
    SetTrack { track: Id, name: Option<String>, muted: Option<bool>, locked: Option<bool>, gain_db: Option<f64>, pan: Option<f64>, solo: Option<bool> },
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
    /// Add an effect (defaults overridden by `params`) at `index` (end if omitted). Video clips only.
    AddEffect { clip: Id, effect: String, #[serde(default)] params: BTreeMap<String, f64>, index: Option<usize> },
    RemoveEffect { clip: Id, effect_id: Id },
    SetEffectParam { clip: Id, effect_id: Id, param: String, value: f64 },
    SetEffectEnabled { clip: Id, effect_id: Id, enabled: bool },
    /// Replace the node graph of a `graph` effect.
    SetEffectGraph { clip: Id, effect_id: Id, graph: crate::filtergraph::FilterGraph },
    MoveEffect { clip: Id, effect_id: Id, index: usize },
    SetClipOpacity { clip: Id, opacity: f64 },
    /// Set a static clip parameter (`x`, `y`, `scale`, `rotation`, `opacity`) or `fx:<effect id>:<param>`. Refused while the parameter is animated.
    SetClipParam { clip: Id, param: String, value: f64 },
    SetClipBlend { clip: Id, blend: String },
    /// Linear fade-in / fade-out lengths (seconds, snapped to frames) for an audio clip. `None` leaves a side unchanged.
    SetClipFades { clip: Id, fade_in: Option<Rational>, fade_out: Option<Rational> },
    /// Insert or update the keyframe of `param` at clip-relative `time` (snapped to the frame grid). `interp` keeps the existing curve shape when omitted.
    SetKeyframe { clip: Id, param: String, time: Rational, value: f64, #[serde(default)] interp: Option<Interp> },
    /// Replace every keyframe of `param` with `keys` (clip-relative times, snapped to frames). An empty list removes the
    /// animation and keeps the parameter's current static value.
    SetKeyframes { clip: Id, param: String, keys: Vec<Keyframe> },
    /// Make `param` follow the loudness of `source` (an audio clip; default: the clip itself if it is audio, else its linked
    /// audio): quiet → `low`, loud → `high`, smoothed over `smooth` seconds, optionally only one frequency `band` (all, bass,
    /// mid, treble). Measured with FFmpeg, stored as keyframes. One undo step.
    AnimateFromAudio { clip: Id, param: String, #[serde(default)] source: Option<Id>, low: f64, high: f64, #[serde(default)] smooth: f64, #[serde(default)] band: Option<String> },
    /// Make `param` jump to `high` on every beat of `source` (same default as above) and fall back to `low` over `decay`
    /// seconds. Beats come from FFWORKS's onset detector. Stored as keyframes. One undo step.
    AnimateFromBeats { clip: Id, param: String, #[serde(default)] source: Option<Id>, low: f64, high: f64, decay: f64 },
    /// Keyframes from a Standard MIDI File on disk: `source` is `cc:N`, `velocity`, `gate`, `pitch` or `bend`; `channel` is 1-16.
    AnimateFromMidi { clip: Id, param: String, path: String, source: String, #[serde(default)] channel: Option<u8>, #[serde(default)] track: Option<usize>, low: f64, high: f64, #[serde(default)] decay: f64, #[serde(default)] offset: f64 },
    /// Make `param` oscillate: `shape` (sine, triangle, saw, square, random) at `rate` Hz between `low` and `high`, starting
    /// `phase` of a cycle in; `seed` only matters for random. Stored as keyframes (at most 200). One undo step.
    AnimateFromLfo { clip: Id, param: String, shape: String, rate: f64, low: f64, high: f64, #[serde(default)] phase: f64, #[serde(default)] seed: u64 },
    /// Make `param` follow a formula evaluated once per frame (see `expr`): variables `t`, `n`, `d`, `p`, `fps`, and `v` = the value of
    /// `source` (another parameter of the same clip; default: `param` itself). Stored as keyframes (a link, not a live binding).
    /// Results outside the parameter's range are refused unless `clamp`. One undo step.
    AnimateFromExpression { clip: Id, param: String, expr: String, #[serde(default)] source: Option<String>, #[serde(default)] clamp: bool },
    RemoveKeyframe { clip: Id, param: String, time: Rational },
    /// Remove all keyframes of `param`; the static value becomes the first key's value.
    ClearKeyframes { clip: Id, param: String },
    /// Change speed (1 = normal) for the clip and its linked clips; the timeline duration follows (source span stays the same).
    SetClipSpeed { clip: Id, speed: Rational },
    SetClipReverse { clip: Id, reverse: bool },
    /// Hold the source frame at `at` for the whole video clip; `None` returns to normal playback.
    SetClipFreeze { clip: Id, at: Option<Rational> },
    /// Blend two adjacent clips on a video track (`kind` is an xfade name; see `transitions::KINDS`).
    AddTransition { clip_a: Id, clip_b: Id, kind: String, duration: Rational },
    RemoveTransition { transition: Id },
    SetTransition { transition: Id, kind: Option<String>, duration: Option<Rational> },
    /// A title (text drawn on a transparent generated canvas) on a video track. Position/scale/opacity/blend/keyframes are the clip's own.
    AddTitle { track: Id, start: Rational, duration: Rational, text: String },
    /// Replace a title clip's text and styling.
    SetTitle { clip: Id, title: Title },
    /// An adjustment layer on a video track: effects added to this clip apply to everything beneath it (lower tracks) for its
    /// length, and its opacity sets how strongly. No transform, blend, speed or transitions; no pixel sort.
    AddAdjustment { track: Id, start: Rational, duration: Rational },
    /// A solid-colour clip (`#RRGGBB` or `#RRGGBBAA`) on a video track.
    AddSolid { track: Id, start: Rational, duration: Rational, color: String },
    /// Change the colour of a solid-colour clip.
    SetSolidColor { clip: Id, color: String },
    /// A marker at `time` (snapped to the frame grid).
    AddMarker { time: Rational, name: String, color: Option<String>, note: Option<String> },
    SetMarker { marker: Id, time: Option<Rational>, name: Option<String>, color: Option<String>, note: Option<String> },
    RemoveMarker { marker: Id },
    /// Save the active sequence (tracks, clips, markers) as a named snapshot; the project keeps it alongside the live timeline.
    TakeSnapshot { name: String },
    /// Put the active sequence back to how a snapshot was. The state it replaces can be recovered with undo (or a snapshot taken first).
    RestoreSnapshot { snapshot: Id },
    DeleteSnapshot { snapshot: Id },
    /// Add one FFmpeg filter (with `options`) to a video clip as a custom-graph effect: `in -> filter -> out`. One undo step.
    AddFilterEffect { clip: Id, filter: String, #[serde(default)] options: Vec<(String, String)> },
    /// Put subtitle cues (`start`, `end`, text) on a new video track named `track` as title clips, `offset` seconds later than the
    /// file says. One undo step.
    ImportCues { track: String, offset: Rational, cues: Vec<(Rational, Rational, String)> },
    /// Cut the given timeline time ranges out of `clip` and everything linked to it, closing each gap (ripple on those
    /// tracks only). Used for "remove silences". Ranges are clamped to the clip, merged when they overlap, and one undo step.
    RemoveRanges { clip: Id, ranges: Vec<(Rational, Rational)> },
    /// Fold the clips (and everything linked to them) into one compound clip that stays editable: its contents become a
    /// sequence of their own (open it to edit). The compound replaces them where the topmost selected video clip was. One undo step.
    NestClips { clips: Vec<Id>, #[serde(default)] name: Option<String> },
    /// Replace a compound clip by the clips it holds, on new tracks. Refused while the clip has settings of its own (speed,
    /// effects, transform, blend, opacity, volume, fades, keyframes) or a transition.
    UnnestClip { clip: Id },
    /// Make a compound's length equal to what its sequence holds now (it grows by itself but never shrinks).
    FitCompound { media: Id },
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
            Command::RelinkMedia { asset } => format!("Relink {}", asset.name),
            Command::AddTrack { .. } => "Add track".into(),
            Command::RemoveTrack { .. } => "Remove track".into(),
            Command::SetTrack { .. } => "Track properties".into(),
            Command::PlaceClip { .. } => "Place clip".into(),
            Command::MoveClip { .. } => "Move clip".into(),
            Command::TrimClip { .. } => "Trim clip".into(),
            Command::SplitClip { .. } => "Split clip".into(),
            Command::DeleteClip { ripple, .. } => if *ripple { "Ripple delete".into() } else { "Delete clip".into() },
            Command::SetClipGain { .. } => "Clip volume".into(),
            Command::AddEffect { effect, .. } => format!("Add effect {effect}"),
            Command::RemoveEffect { .. } => "Remove effect".into(),
            Command::SetEffectParam { .. } => "Effect parameter".into(),
            Command::SetEffectEnabled { .. } => "Toggle effect".into(),
            Command::SetEffectGraph { .. } => "Edit filter graph".into(),
            Command::MoveEffect { .. } => "Reorder effect".into(),
            Command::SetClipOpacity { .. } => "Clip opacity".into(),
            Command::SetClipParam { param, .. } => format!("Set {param}"),
            Command::SetClipBlend { blend, .. } => format!("Blend mode {blend}"),
            Command::SetClipFades { .. } => "Fades".into(),
            Command::AddMarker { .. } => "Add marker".into(),
            Command::SetMarker { .. } => "Edit marker".into(),
            Command::RemoveMarker { .. } => "Remove marker".into(),
            Command::AddTitle { .. } => "Add title".into(),
            Command::SetTitle { .. } => "Edit title".into(),
            Command::AddSolid { .. } => "Add solid colour".into(),
            Command::SetSolidColor { .. } => "Solid colour".into(),
            Command::SetKeyframe { param, .. } => format!("Keyframe {param}"),
            Command::SetKeyframes { param, keys, .. } => format!("Set {} keyframes on {param}", keys.len()),
            Command::AnimateFromAudio { param, .. } => format!("Animate {param} from audio"),
            Command::AnimateFromBeats { param, .. } => format!("Pulse {param} on beats"),
            Command::AnimateFromMidi { param, .. } => format!("Follow MIDI with {param}"),
            Command::AnimateFromLfo { param, shape, .. } => format!("{shape} LFO on {param}"),
            Command::AnimateFromExpression { param, .. } => format!("Formula on {param}"),
            Command::RemoveKeyframe { param, .. } => format!("Remove keyframe {param}"),
            Command::ClearKeyframes { param, .. } => format!("Clear keyframes {param}"),
            Command::SetClipSpeed { .. } => "Clip speed".into(),
            Command::SetClipReverse { .. } => "Reverse clip".into(),
            Command::SetClipFreeze { .. } => "Freeze frame".into(),
            Command::AddTransition { kind, .. } => format!("Add {kind} transition"),
            Command::RemoveTransition { .. } => "Remove transition".into(),
            Command::SetTransition { .. } => "Edit transition".into(),
            Command::TakeSnapshot { name } => format!("Snapshot '{name}'"),
            Command::RestoreSnapshot { .. } => "Restore snapshot".into(),
            Command::DeleteSnapshot { .. } => "Delete snapshot".into(),
            Command::AddFilterEffect { filter, .. } => format!("Add filter {filter}"),
            Command::ImportCues { cues, .. } => format!("Import {} subtitles", cues.len()),
            Command::RemoveRanges { ranges, .. } => format!("Cut out {} ranges", ranges.len()),
            Command::AddAdjustment { .. } => "Add adjustment layer".into(),
            Command::NestClips { .. } => "Make compound clip".into(),
            Command::UnnestClip { .. } => "Take compound clip apart".into(),
            Command::FitCompound { .. } => "Fit compound length".into(),
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
        Command::Batch { .. } | Command::RemoveRanges { .. } | Command::ImportCues { .. } | Command::AddFilterEffect { .. } | Command::AnimateFromAudio { .. } | Command::AnimateFromBeats { .. } | Command::AnimateFromMidi { .. } | Command::AnimateFromLfo { .. } | Command::AnimateFromExpression { .. } => Err(Error::validation("batch is handled by the engine")),
        Command::NestClips { clips, name } => crate::nest::plan_nest(p, clips, name.as_deref()),
        Command::UnnestClip { clip } => crate::nest::plan_unnest(p, clip),
        Command::FitCompound { media } => crate::nest::plan_fit(p, media),
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
        Command::RelinkMedia { asset } => {
            let old = p.media(&asset.id)?;
            if old.info.has_video() && !asset.info.has_video() || old.info.has_audio() && !asset.info.has_audio() {
                return Err(Error::validation(format!("'{}' lacks a video/audio stream that '{}' had", asset.name, old.name)));
            }
            Ok(vec![Patch::ReplaceMedia { asset: asset.clone() }])
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
                track: Track { id: new_id("trk"), name: name.clone().unwrap_or(default), kind: *kind, muted: false, locked: false, gain_db: 0.0, pan: 0.0, solo: false, clips: vec![], transitions: vec![] },
            }])
        }
        Command::RemoveTrack { track } => {
            let t = seq.track(track).ok_or_else(|| Error::NotFound(format!("track {track}")))?;
            if !t.clips.is_empty() {
                return Err(Error::validation(format!("track '{}' still contains clips", t.name)));
            }
            Ok(vec![Patch::RemoveTrack { seq: sid, track: track.clone() }])
        }
        Command::SetTrack { track, name, muted, locked, gain_db, pan, solo } => {
            let t = seq.track(track).ok_or_else(|| Error::NotFound(format!("track {track}")))?;
            if let Some(p) = pan {
                if !(-1.0..=1.0).contains(p) {
                    return Err(Error::validation("pan must be between -1 and 1"));
                }
            }
            if let Some(g) = gain_db {
                if !g.is_finite() || !(-96.0..=24.0).contains(g) {
                    return Err(Error::validation(format!("track gain {g} dB is outside -96..+24 dB")));
                }
            }
            Ok(vec![Patch::SetTrackProps {
                seq: sid,
                track: track.clone(),
                name: name.clone().unwrap_or_else(|| t.name.clone()),
                muted: muted.unwrap_or(t.muted),
                locked: locked.unwrap_or(t.locked),
                gain_db: gain_db.unwrap_or(t.gain_db),
                pan: pan.unwrap_or(t.pan),
                solo: solo.unwrap_or(t.solo),
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
            // a still image has no length of its own: default to 5 s
            let dur = duration.unwrap_or(if m.info.still { Rational::from_int(5) } else { m.info.duration - s_in });
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
                clip: Clip::new(new_id("clp"), media.clone(), m.name.clone(), t.kind, start, s_in, dur, link.clone()),
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
                    clip: Clip::new(new_id("clp"), media.clone(), m.name.clone(), TrackKind::Audio, start, s_in, dur, link),
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
                // The source moves with the *timeline* edge unless the clip plays backwards (then the opposite end of the source).
                let src_delta = if gc.freeze.is_some() { Rational::ZERO } else { delta.mul(gc.speed) };
                match edge {
                    Edge::Start => {
                        c.start = gc.start + delta;
                        if !gc.reverse {
                            c.source_in = gc.source_in + src_delta;
                        }
                        c.duration = gc.duration - delta;
                        // keyframes are clip-relative: keep them on the same picture
                        for kfs in c.keyframes.values_mut() {
                            for k in kfs.iter_mut() {
                                k.t = k.t - delta;
                            }
                        }
                    }
                    Edge::End => {
                        c.duration = gc.duration + delta;
                        if gc.reverse {
                            c.source_in = gc.source_in - src_delta;
                        }
                    }
                }
                c.clamp_fades();
                let m = p.media(&c.media)?;
                if c.duration < Rational::from_int(1).div(fps) {
                    return Err(Error::validation("trim would leave less than one frame; delete the clip instead"));
                }
                if c.source_in < Rational::ZERO {
                    return Err(Error::validation(format!("cannot extend '{}' before the start of its source media", c.name)));
                }
                if c.source_in + c.source_span() > m.info.duration + Rational::new(1, 1000) {
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
                right.duration = gc.end() - at;
                right.link = right_link.clone();
                // source ranges (a reversed clip plays its source end first, so the left piece takes the later source)
                let cut = at - gc.start;
                // the fade-in belongs to the left piece, the fade-out to the right one
                left.fade_out = Rational::ZERO;
                right.fade_in = Rational::ZERO;
                left.clamp_fades();
                right.clamp_fades();
                if gc.freeze.is_none() {
                    if gc.reverse {
                        left.source_in = gc.source_in + (gc.duration - cut).mul(gc.speed);
                    } else {
                        right.source_in = gc.source_in + cut.mul(gc.speed);
                    }
                }
                for (param, kfs) in &gc.keyframes {
                    left.keyframes.insert(param.clone(), keyframes::window(kfs, Rational::ZERO, cut, Rational::ZERO));
                    right.keyframes.insert(param.clone(), keyframes::window(kfs, cut, gc.duration, cut));
                }
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
                for tr in gt.transitions.iter().filter(|x| &x.clip_a == gid || &x.clip_b == gid) {
                    out.push(Patch::RemoveTransition { seq: sid.clone(), track: gt.id.clone(), id: tr.id.clone() });
                }
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
        Command::AddEffect { .. } | Command::RemoveEffect { .. } | Command::SetEffectParam { .. } | Command::SetEffectEnabled { .. } | Command::SetEffectGraph { .. } | Command::MoveEffect { .. } | Command::SetClipOpacity { .. } | Command::SetClipParam { .. } | Command::SetClipBlend { .. } | Command::SetClipFades { .. } | Command::SetKeyframe { .. } | Command::SetKeyframes { .. } | Command::RemoveKeyframe { .. } | Command::ClearKeyframes { .. } => {
            let clip_id = match cmd {
                Command::AddEffect { clip, .. } | Command::RemoveEffect { clip, .. } | Command::SetEffectParam { clip, .. } | Command::SetEffectEnabled { clip, .. } | Command::SetEffectGraph { clip, .. } | Command::MoveEffect { clip, .. } | Command::SetClipOpacity { clip, .. } | Command::SetClipParam { clip, .. } | Command::SetClipBlend { clip, .. } | Command::SetClipFades { clip, .. } | Command::SetKeyframe { clip, .. } | Command::SetKeyframes { clip, .. } | Command::RemoveKeyframe { clip, .. } | Command::ClearKeyframes { clip, .. } => clip,
                _ => unreachable!(),
            };
            let (t, c) = seq.find_clip(clip_id).ok_or_else(|| Error::NotFound(format!("clip {clip_id}")))?;
            ensure_unlocked(t)?;
            if c.kind != TrackKind::Video && matches!(cmd, Command::SetClipOpacity { .. } | Command::SetClipBlend { .. }) {
                return Err(Error::validation("opacity and blend mode apply to video clips; select the video clip"));
            }
            if c.kind != TrackKind::Audio && matches!(cmd, Command::SetClipFades { .. }) {
                return Err(Error::validation("fades apply to audio clips; select the audio clip"));
            }
            if c.adjustment {
                adjustment_refuses(cmd)?;
            }
            let mut c2 = c.clone();
            let find_fx = |c: &Clip, id: &str| c.effects.iter().position(|e| e.id == id).ok_or_else(|| Error::NotFound(format!("effect {id}")));
            let animated = |c: &Clip, param: &str| c.keyframes.get(param).is_some_and(|k| !k.is_empty());
            match cmd {
                Command::AddEffect { effect, params, index, .. } => {
                    let want = if c2.kind == TrackKind::Video { "video" } else { "audio" };
                    let def = effects::find(effect)?;
                    if def.kind != want {
                        return Err(Error::validation(format!("'{}' is an {} effect and cannot be added to a {want} clip", def.name, def.kind)));
                    }
                    let inst = EffectInstance::new(new_id("fx"), effect, params)?;
                    let at = index.unwrap_or(c2.effects.len()).min(c2.effects.len());
                    c2.effects.insert(at, inst);
                }
                Command::RemoveEffect { effect_id, .. } => {
                    let i = find_fx(&c2, effect_id)?;
                    c2.effects.remove(i);
                    // its keyframes go with it
                    let prefix = format!("fx:{effect_id}:");
                    c2.keyframes.retain(|k, _| !k.starts_with(&prefix));
                }
                Command::SetEffectParam { effect_id, param, value, .. } => {
                    let i = find_fx(&c2, effect_id)?;
                    effects::check_param(&effects::find(&c2.effects[i].effect)?, param, *value)?;
                    if animated(&c2, &format!("fx:{effect_id}:{param}")) {
                        return Err(Error::validation("this parameter is animated; edit its keyframes instead"));
                    }
                    c2.effects[i].params.insert(param.clone(), *value);
                }
                Command::SetEffectEnabled { effect_id, enabled, .. } => {
                    let i = find_fx(&c2, effect_id)?;
                    c2.effects[i].enabled = *enabled;
                }
                Command::SetEffectGraph { effect_id, graph, .. } => {
                    let i = find_fx(&c2, effect_id)?;
                    if c2.effects[i].effect != effects::GRAPH_EFFECT {
                        return Err(Error::validation("only a custom filter graph effect has a graph"));
                    }
                    graph.validate()?;
                    c2.effects[i].graph = Some(graph.clone());
                }
                Command::MoveEffect { effect_id, index, .. } => {
                    let i = find_fx(&c2, effect_id)?;
                    let e = c2.effects.remove(i);
                    c2.effects.insert((*index).min(c2.effects.len()), e);
                }
                Command::SetClipOpacity { opacity, .. } => {
                    if !(0.0..=1.0).contains(opacity) {
                        return Err(Error::validation(format!("opacity {opacity} must be between 0 and 1")));
                    }
                    if animated(&c2, "opacity") {
                        return Err(Error::validation("opacity is animated; edit its keyframes instead"));
                    }
                    c2.opacity = *opacity;
                }
                Command::SetClipParam { param, value, .. } => {
                    clipprops::check_value(&c2, param, *value, false)?;
                    if animated(&c2, param) {
                        return Err(Error::validation(format!("'{param}' is animated; edit its keyframes instead")));
                    }
                    match param.strip_prefix("fx:").and_then(|r| r.split_once(':')) {
                        Some((fx, name)) => {
                            let i = find_fx(&c2, fx)?;
                            c2.effects[i].params.insert(name.to_string(), *value);
                        }
                        None => c2.set_static_param(param, *value),
                    }
                }
                Command::SetClipBlend { blend, .. } => {
                    clipprops::check_blend(blend)?;
                    c2.blend = blend.clone();
                }
                Command::SetClipFades { fade_in, fade_out, .. } => {
                    let snap = |r: Rational| snap_to_frame(r, fps);
                    if let Some(f) = fade_in {
                        c2.fade_in = snap(*f);
                    }
                    if let Some(f) = fade_out {
                        c2.fade_out = snap(*f);
                    }
                    if c2.fade_in < Rational::ZERO || c2.fade_out < Rational::ZERO || c2.fade_in + c2.fade_out > c2.duration {
                        return Err(Error::validation("fades must be non-negative and together no longer than the clip"));
                    }
                }
                Command::SetKeyframe { param, time, value, interp, .. } => {
                    clipprops::check_value(&c2, param, *value, true)?;
                    let tt = snap_to_frame(*time, fps);
                    if tt < Rational::ZERO || tt > c2.duration {
                        return Err(Error::validation(format!("keyframe time {}s is outside the clip (0..{}s)", tt.as_f64(), c2.duration.as_f64())));
                    }
                    let list = c2.keyframes.entry(param.clone()).or_default();
                    let keep = list.iter().find(|k| k.t == tt).map(|k| k.interp).unwrap_or_default();
                    keyframes::upsert(list, Keyframe { t: tt, v: *value, interp: interp.unwrap_or(keep) });
                }
                Command::SetKeyframes { param, keys, .. } => {
                    if keys.len() > 2000 {
                        return Err(Error::validation("too many keyframes (2000 at most)"));
                    }
                    let mut list: Vec<Keyframe> = vec![];
                    for k in keys {
                        clipprops::check_value(&c2, param, k.v, true)?;
                        let tt = snap_to_frame(k.t, fps);
                        if tt < Rational::ZERO || tt > c2.duration {
                            return Err(Error::validation(format!("keyframe time {}s is outside the clip (0..{}s)", tt.as_f64(), c2.duration.as_f64())));
                        }
                        keyframes::upsert(&mut list, Keyframe { t: tt, ..*k });
                    }
                    if !list.is_empty() {
                        c2.keyframes.insert(param.clone(), list);
                    } else if let Some(first) = c2.keyframes.remove(param).and_then(|old| old.first().copied()) {
                        set_param_value(&mut c2, param, first.v)?;
                    }
                }
                Command::RemoveKeyframe { param, time, .. } => {
                    let tt = snap_to_frame(*time, fps);
                    let list = c2.keyframes.get_mut(param).ok_or_else(|| Error::validation(format!("'{param}' has no keyframes")))?;
                    let i = list.iter().position(|k| k.t == tt).ok_or_else(|| Error::validation(format!("no keyframe at {}s", tt.as_f64())))?;
                    let removed = list.remove(i);
                    if list.is_empty() {
                        c2.keyframes.remove(param);
                        set_param_value(&mut c2, param, removed.v)?;
                    }
                }
                Command::ClearKeyframes { param, .. } => {
                    let list = c2.keyframes.remove(param).ok_or_else(|| Error::validation(format!("'{param}' has no keyframes")))?;
                    if let Some(first) = list.first() {
                        set_param_value(&mut c2, param, first.v)?;
                    }
                }
                _ => unreachable!(),
            }
            Ok(vec![Patch::PutClip { seq: sid, track: t.id.clone(), clip: c2 }])
        }
        Command::TakeSnapshot { name } => {
            let n = name.trim();
            if n.is_empty() || n.chars().count() > 60 {
                return Err(Error::validation("snapshot names must be 1-60 characters"));
            }
            let mut copy = seq.clone();
            copy.id = new_id("snap");
            copy.compound = false;
            copy.name = format!("{SNAPSHOT_PREFIX}{n}");
            Ok(vec![Patch::InsertSequence { index: p.sequences.len(), sequence: copy }])
        }
        Command::RestoreSnapshot { snapshot } => {
            let snap = p.sequences.iter().find(|s| &s.id == snapshot && s.name.starts_with(SNAPSHOT_PREFIX)).ok_or_else(|| Error::NotFound(format!("snapshot {snapshot}")))?;
            Ok(vec![Patch::SetSequenceContent { seq: sid, tracks: snap.tracks.clone(), markers: snap.markers.clone() }])
        }
        Command::DeleteSnapshot { snapshot } => {
            if !p.sequences.iter().any(|s| &s.id == snapshot && s.name.starts_with(SNAPSHOT_PREFIX)) {
                return Err(Error::NotFound(format!("snapshot {snapshot}")));
            }
            Ok(vec![Patch::RemoveSequence { id: snapshot.clone() }])
        }
        Command::AddMarker { time, name, color, note } => {
            let m = Marker { id: new_id("mrk"), time: snap_to_frame(*time, fps), name: name.clone(), color: color.clone().unwrap_or_else(|| "#ffb020".into()), note: note.clone().unwrap_or_default() };
            check_marker(&m)?;
            Ok(vec![Patch::PutMarker { seq: sid, marker: m }])
        }
        Command::SetMarker { marker, time, name, color, note } => {
            let mut m = seq.markers.iter().find(|m| &m.id == marker).cloned().ok_or_else(|| Error::NotFound(format!("marker {marker}")))?;
            if let Some(t) = time {
                m.time = snap_to_frame(*t, fps);
            }
            if let Some(n) = name {
                m.name = n.clone();
            }
            if let Some(c) = color {
                m.color = c.clone();
            }
            if let Some(n) = note {
                m.note = n.clone();
            }
            check_marker(&m)?;
            Ok(vec![Patch::PutMarker { seq: sid, marker: m }])
        }
        Command::RemoveMarker { marker } => {
            seq.markers.iter().find(|m| &m.id == marker).ok_or_else(|| Error::NotFound(format!("marker {marker}")))?;
            Ok(vec![Patch::RemoveMarker { seq: sid, id: marker.clone() }])
        }
        Command::AddTitle { track, start, duration, text } => {
            let t = seq.track(track).ok_or_else(|| Error::NotFound(format!("track {track}")))?;
            ensure_unlocked(t)?;
            if t.kind != TrackKind::Video {
                return Err(Error::validation("titles go on a video track"));
            }
            let (start, dur) = (snap_to_frame(*start, fps), snap_to_frame(*duration, fps));
            if start < Rational::ZERO || dur < Rational::from_int(1).div(fps) {
                return Err(Error::validation("a title needs a start >= 0 and at least one frame of duration"));
            }
            let title = Title::new(text);
            title.validate()?;
            check_free(t, start, start + dur, &[])?;
            let asset = generators::solid_asset(generators::TRANSPARENT, &p.settings)?;
            let mut out = vec![];
            if !p.media.iter().any(|m| m.id == asset.id) {
                out.push(Patch::InsertMedia { index: p.media.len(), asset: asset.clone() });
            }
            let mut clip = Clip::new(new_id("clp"), asset.id, title_name(text), TrackKind::Video, start, Rational::ZERO, dur, None);
            clip.title = Some(title);
            out.push(Patch::PutClip { seq: sid, track: t.id.clone(), clip });
            Ok(out)
        }
        Command::SetTitle { clip, title } => {
            let (t, c) = seq.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
            ensure_unlocked(t)?;
            if c.title.is_none() {
                return Err(Error::validation("this clip is not a title"));
            }
            title.validate()?;
            let mut c2 = c.clone();
            c2.name = title_name(&title.text);
            c2.title = Some(title.clone());
            Ok(vec![Patch::PutClip { seq: sid, track: t.id.clone(), clip: c2 }])
        }
        Command::AddSolid { track, start, duration, color } => {
            let t = seq.track(track).ok_or_else(|| Error::NotFound(format!("track {track}")))?;
            ensure_unlocked(t)?;
            if t.kind != TrackKind::Video {
                return Err(Error::validation("solid colours go on a video track"));
            }
            let (start, dur) = (snap_to_frame(*start, fps), snap_to_frame(*duration, fps));
            if start < Rational::ZERO || dur < Rational::from_int(1).div(fps) {
                return Err(Error::validation("a solid needs a start >= 0 and at least one frame of duration"));
            }
            check_free(t, start, start + dur, &[])?;
            let asset = generators::solid_asset(color, &p.settings)?;
            let mut out = vec![];
            if !p.media.iter().any(|m| m.id == asset.id) {
                out.push(Patch::InsertMedia { index: p.media.len(), asset: asset.clone() });
            }
            out.push(Patch::PutClip { seq: sid, track: t.id.clone(), clip: Clip::new(new_id("clp"), asset.id.clone(), asset.name.clone(), TrackKind::Video, start, Rational::ZERO, dur, None) });
            Ok(out)
        }
        Command::AddAdjustment { track, start, duration } => {
            let t = seq.track(track).ok_or_else(|| Error::NotFound(format!("track {track}")))?;
            ensure_unlocked(t)?;
            if t.kind != TrackKind::Video {
                return Err(Error::validation("adjustment layers go on a video track"));
            }
            let (start, dur) = (snap_to_frame(*start, fps), snap_to_frame(*duration, fps));
            if start < Rational::ZERO || dur < Rational::from_int(1).div(fps) {
                return Err(Error::validation("an adjustment layer needs a start >= 0 and at least one frame of duration"));
            }
            check_free(t, start, start + dur, &[])?;
            let asset = generators::solid_asset(generators::TRANSPARENT, &p.settings)?;
            let mut out = vec![];
            if !p.media.iter().any(|m| m.id == asset.id) {
                out.push(Patch::InsertMedia { index: p.media.len(), asset: asset.clone() });
            }
            let mut clip = Clip::new(new_id("clp"), asset.id, "Adjustment layer".into(), TrackKind::Video, start, Rational::ZERO, dur, None);
            clip.adjustment = true;
            out.push(Patch::PutClip { seq: sid, track: t.id.clone(), clip });
            Ok(out)
        }
        Command::SetSolidColor { clip, color } => {
            let (t, c) = seq.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
            ensure_unlocked(t)?;
            let current = p.media(&c.media)?;
            if c.title.is_some() || !matches!(current.generator, Some(generators::Generator::Solid { .. })) {
                return Err(Error::validation("this clip is not a solid colour"));
            }
            let asset = generators::solid_asset(color, &p.settings)?;
            let mut out = vec![];
            if !p.media.iter().any(|m| m.id == asset.id) {
                out.push(Patch::InsertMedia { index: p.media.len(), asset: asset.clone() });
            }
            let mut c2 = c.clone();
            c2.media = asset.id.clone();
            c2.name = asset.name.clone();
            out.push(Patch::PutClip { seq: sid, track: t.id.clone(), clip: c2 });
            Ok(out)
        }
        Command::SetClipSpeed { clip, speed } => {
            if seq.find_clip(clip).is_some_and(|(_, c)| c.adjustment) {
                return Err(Error::validation("an adjustment layer has no footage to retime"));
            }
            if *speed < Rational::new(1, 10) || *speed > Rational::from_int(10) {
                return Err(Error::validation("speed must be between 10% and 1000%"));
            }
            let group = seq.linked_group(clip);
            if group.is_empty() {
                return Err(Error::NotFound(format!("clip {clip}")));
            }
            // one timeline duration for the whole group, floored to frames so the source range can't overrun
            let (_, anchor) = seq.find_clip(clip).expect("checked");
            if anchor.freeze.is_some() {
                return Err(Error::validation("a frozen clip has no speed; unfreeze it first"));
            }
            let new_dur = Rational::new(anchor.source_span().div(*speed).floor_units(fps).max(1), 1).div(fps);
            let mut out = vec![];
            for gid in &group {
                let (gt, gc) = seq.find_clip(gid).expect("member");
                ensure_unlocked(gt)?;
                let mut c = gc.clone();
                c.speed = *speed;
                c.duration = new_dur;
                c.clamp_fades();
                let m = p.media(&c.media)?;
                if c.source_in + c.source_span() > m.info.duration + Rational::new(1, 1000) {
                    return Err(Error::validation(format!("'{}' does not have enough source media for that speed", c.name)));
                }
                check_free(gt, c.start, c.end(), &group)?;
                out.push(Patch::PutClip { seq: sid.clone(), track: gt.id.clone(), clip: c });
            }
            Ok(out)
        }
        Command::SetClipReverse { clip, reverse } => {
            if seq.find_clip(clip).is_some_and(|(_, c)| c.adjustment) {
                return Err(Error::validation("an adjustment layer has no footage to reverse"));
            }
            let group = seq.linked_group(clip);
            if group.is_empty() {
                return Err(Error::NotFound(format!("clip {clip}")));
            }
            let mut out = vec![];
            for gid in &group {
                let (gt, gc) = seq.find_clip(gid).expect("member");
                ensure_unlocked(gt)?;
                let mut c = gc.clone();
                c.reverse = *reverse;
                out.push(Patch::PutClip { seq: sid.clone(), track: gt.id.clone(), clip: c });
            }
            Ok(out)
        }
        Command::SetClipFreeze { clip, at } => {
            let (t, c) = seq.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
            ensure_unlocked(t)?;
            if c.kind != TrackKind::Video {
                return Err(Error::validation("only video clips can be frozen"));
            }
            if c.adjustment {
                return Err(Error::validation("an adjustment layer has no footage to freeze"));
            }
            let mut c2 = c.clone();
            let mut out = vec![];
            match at {
                Some(a) => {
                    if *a < Rational::ZERO || *a >= p.media(&c.media)?.info.duration {
                        return Err(Error::validation("freeze time is outside the source media"));
                    }
                    c2.freeze = Some(*a);
                    // A held picture has no matching sound: detach the linked audio so the frame can be lengthened on its own.
                    if c.link.is_some() {
                        for gid in seq.linked_group(clip).into_iter().filter(|g| g != clip) {
                            let (gt, gc) = seq.find_clip(&gid).expect("member");
                            ensure_unlocked(gt)?;
                            let mut other = gc.clone();
                            other.link = None;
                            out.push(Patch::PutClip { seq: sid.clone(), track: gt.id.clone(), clip: other });
                        }
                        c2.link = None;
                    }
                }
                None => c2.freeze = None,
            }
            out.push(Patch::PutClip { seq: sid, track: t.id.clone(), clip: c2 });
            Ok(out)
        }
        Command::AddTransition { clip_a, clip_b, kind, duration } => {
            transitions::check_kind(kind)?;
            let (ta, ca) = seq.find_clip(clip_a).ok_or_else(|| Error::NotFound(format!("clip {clip_a}")))?;
            let (tb, cb) = seq.find_clip(clip_b).ok_or_else(|| Error::NotFound(format!("clip {clip_b}")))?;
            if ca.adjustment || cb.adjustment {
                return Err(Error::validation("transitions are between footage clips, not adjustment layers"));
            }
            if ta.id != tb.id {
                return Err(Error::validation("both clips of a transition must be on the same track"));
            }
            ensure_unlocked(ta)?;
            // duplicates, adjacency, opacity and media handles are checked by project validation right after applying
            Ok(vec![Patch::PutTransition { seq: sid, track: ta.id.clone(), transition: Transition { id: new_id("trn"), clip_a: clip_a.clone(), clip_b: clip_b.clone(), kind: kind.clone(), duration: transitions::snap_duration(*duration, fps) } }])
        }
        Command::RemoveTransition { transition } => {
            let t = seq.tracks.iter().find(|t| t.transitions.iter().any(|x| &x.id == transition)).ok_or_else(|| Error::NotFound(format!("transition {transition}")))?;
            ensure_unlocked(t)?;
            Ok(vec![Patch::RemoveTransition { seq: sid, track: t.id.clone(), id: transition.clone() }])
        }
        Command::SetTransition { transition, kind, duration } => {
            let t = seq.tracks.iter().find(|t| t.transitions.iter().any(|x| &x.id == transition)).ok_or_else(|| Error::NotFound(format!("transition {transition}")))?;
            ensure_unlocked(t)?;
            let mut x = t.transitions.iter().find(|x| &x.id == transition).expect("found").clone();
            if let Some(k) = kind {
                transitions::check_kind(k)?;
                x.kind = k.clone();
            }
            if let Some(d) = duration {
                x.duration = transitions::snap_duration(*d, fps);
            }
            Ok(vec![Patch::PutTransition { seq: sid, track: t.id.clone(), transition: x }])
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
            if tc.keyframes.contains_key("gain_db") {
                return Err(Error::validation("volume is animated; edit its keyframes instead"));
            }
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

/// Store `value` as the static value of a clip or effect parameter (used when its keyframes are removed).
fn set_param_value(c: &mut Clip, param: &str, value: f64) -> Result<()> {
    match param.strip_prefix("fx:").and_then(|r| r.split_once(':')) {
        Some((fx, name)) => {
            let i = c.effects.iter().position(|e| e.id == fx).ok_or_else(|| Error::NotFound(format!("effect {fx}")))?;
            c.effects[i].params.insert(name.to_string(), value);
        }
        None => c.set_static_param(param, value),
    }
    Ok(())
}

fn check_marker(m: &Marker) -> Result<()> {
    if m.time < Rational::ZERO {
        return Err(Error::validation("a marker cannot be placed before 00:00:00"));
    }
    if m.name.chars().count() > 100 || m.note.chars().count() > 2000 {
        return Err(Error::validation("marker name is limited to 100 characters and its note to 2000"));
    }
    crate::titles::check_hex(&m.color, 6)
}

/// Clip name for a title: its first line, shortened.
fn title_name(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    let short: String = line.chars().take(40).collect();
    if short.is_empty() { "Title".into() } else { short }
}

/// What an adjustment layer cannot take (it has no footage of its own): picture placement, blend mode, and effects that
/// need the layer's own footage.
fn adjustment_refuses(cmd: &Command) -> Result<()> {
    const PLACEMENT: [&str; 4] = ["x", "y", "scale", "rotation"];
    let bad_param = |p: &str| PLACEMENT.contains(&p);
    match cmd {
        Command::SetClipBlend { .. } => Err(Error::validation("an adjustment layer has no blend mode; its opacity sets how strongly it applies")),
        Command::SetClipParam { param, .. } | Command::SetKeyframe { param, .. } | Command::SetKeyframes { param, .. } if bad_param(param) => Err(Error::validation("an adjustment layer has no position, scale or rotation")),
        Command::AddEffect { effect, .. } if effect == "pixel_sort" => Err(Error::validation("pixel sort needs footage of its own; put it on a clip, not on an adjustment layer")),
        _ => Ok(()),
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
