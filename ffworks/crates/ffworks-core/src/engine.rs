//! `Engine` owns the open project, the undo/redo history and the tool configuration.
//! It has no GUI dependency, so the same engine drives the desktop app, tests and a future headless CLI (spec §154).

use crate::project::TrackKind;
use crate::time::Rational;
use crate::commands::{plan, Command};
use crate::error::{Error, Result};
use crate::ffprobe::probe;
use crate::migrate::migrate;
use crate::patch::{apply, Patch};
use crate::process::Tools;
use crate::project::{new_id, MediaAsset, Project, ProjectSettings};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// (relinked media ids, unresolved media id + candidates)
pub type RelinkOutcome = (Vec<String>, Vec<(String, Vec<crate::relink::Candidate>)>);

#[derive(Clone, Debug)]
struct Entry {
    label: String,
    forward: Vec<Patch>,
    /// Inverse patches in the order they must be applied to undo.
    inverse: Vec<Patch>,
}

/// An open group of commands (see [`Engine::begin_group`]).
pub struct Group {
    base: usize,
    redo: Vec<Entry>,
}

pub struct Engine {
    pub project: Project,
    pub tools: Tools,
    path: Option<PathBuf>,
    undo: Vec<Entry>,
    redo: Vec<Entry>,
    /// Number of undo entries at the last save; `None` once that state is unreachable.
    saved_at: Option<usize>,
    recording: Option<Vec<Command>>,
    /// Bumped on every state change; autosave skips when unchanged.
    revision: u64,
    autosaved_rev: Option<u64>,
}

impl Engine {
    pub fn new(name: &str, settings: ProjectSettings, tools: Tools) -> Engine {
        Engine { project: Project::new(name, settings), tools, path: None, undo: vec![], redo: vec![], saved_at: Some(0), recording: None, revision: 0, autosaved_rev: None }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Engine restored from an autosave: unsaved by definition (`saved_at` is unreachable).
    pub fn from_recovered(project: Project, path: Option<PathBuf>, tools: Tools) -> Engine {
        Engine { project, tools, path, undo: vec![], redo: vec![], saved_at: None, recording: None, revision: 1, autosaved_rev: None }
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Write an autosave if there are unsaved changes since the last one. Returns whether a file was written.
    pub fn autosave(&mut self, dir: &Path) -> Result<bool> {
        if !self.is_dirty() || self.autosaved_rev == Some(self.revision) {
            return Ok(false);
        }
        crate::recovery::write(dir, &self.project, self.path.as_deref())?;
        self.autosaved_rev = Some(self.revision);
        Ok(true)
    }

    pub fn is_dirty(&self) -> bool {
        self.saved_at != Some(self.undo.len())
    }

    // ---- command bus -------------------------------------------------------------------------

    /// Apply a command as one undo step. On any error the project is left exactly as it was.
    pub fn dispatch(&mut self, cmd: Command) -> Result<()> {
        let (mut fwd, mut inv) = (vec![], vec![]);
        if let Err(e) = self.run(&cmd, &mut fwd, &mut inv) {
            self.rollback(&inv);
            return Err(e);
        }
        // a compound's media follows its contents (grows with them), as part of the same step
        for patch in crate::nest::grown(&self.project) {
            let undo_patch = apply(&mut self.project, &patch)?;
            fwd.push(patch);
            inv.push(undo_patch);
        }
        if let Err(e) = self.project.validate() {
            self.rollback(&inv);
            return Err(e);
        }
        inv.reverse();
        self.undo.push(Entry { label: cmd.label(), forward: fwd, inverse: inv });
        self.redo.clear();
        self.revision += 1;
        if self.saved_at.is_some_and(|s| s >= self.undo.len()) {
            self.saved_at = None;
        }
        if let Some(rec) = &mut self.recording {
            rec.push(cmd);
        }
        Ok(())
    }

    /// Plan against the *current* (possibly already-modified) project and apply, appending to the logs.
    fn run(&mut self, cmd: &Command, fwd: &mut Vec<Patch>, inv: &mut Vec<Patch>) -> Result<()> {
        match cmd {
            Command::Batch { commands, .. } => {
                for c in commands {
                    self.run(c, fwd, inv)?;
                }
                Ok(())
            }
            Command::AddFilterEffect { clip, filter, options } => {
                use crate::filtergraph::{FilterGraph, GEdge, GNode, IN, OUT};
                self.run(&Command::AddEffect { clip: clip.clone(), effect: crate::effects::GRAPH_EFFECT.into(), params: Default::default(), index: None }, fwd, inv)?;
                let fx = self.project.active()?.find_clip(clip).and_then(|(_, c)| c.effects.last().map(|e| e.id.clone())).ok_or_else(|| Error::validation("internal: effect not added"))?;
                let node = GNode { id: "n1".into(), filter: filter.clone(), options: options.clone(), x: 200.0, y: 0.0 };
                let graph = FilterGraph {
                    nodes: vec![GNode { id: IN.into(), ..Default::default() }, node, GNode { id: OUT.into(), x: 400.0, ..Default::default() }],
                    edges: vec![GEdge { from: IN.into(), from_pad: 0, to: "n1".into(), to_pad: 0 }, GEdge { from: "n1".into(), from_pad: 0, to: OUT.into(), to_pad: 0 }],
                };
                self.run(&Command::SetEffectGraph { clip: clip.clone(), effect_id: fx, graph }, fwd, inv)
            }
            Command::ImportCues { track, offset, cues } => {
                if cues.is_empty() {
                    return Err(Error::validation("no subtitle cues to import"));
                }
                self.run(&Command::AddTrack { kind: TrackKind::Video, name: Some(track.clone()) }, fwd, inv)?;
                let tid = self.project.active()?.tracks.iter().rfind(|t| t.kind == TrackKind::Video).expect("just added").id.clone();
                for (a, b, text) in cues {
                    let start = *a + *offset;
                    if start < Rational::ZERO {
                        continue;
                    }
                    self.run(&Command::AddTitle { track: tid.clone(), start, duration: *b - *a, text: text.clone() }, fwd, inv)?;
                }
                Ok(())
            }
            Command::RemoveRanges { clip, ranges } => self.remove_ranges(clip, ranges, fwd, inv),
            Command::AnimateFromBeats { clip, param, source, low, high, decay } => {
                let keys = self.beat_keys(clip, param, source.as_deref(), *low, *high, *decay)?;
                self.run(&Command::SetKeyframes { clip: clip.clone(), param: param.clone(), keys }, fwd, inv)
            }
            Command::AnimateFromLfo { clip, param, shape, rate, low, high, phase, seed } => {
                let dur = {
                    let (_, c) = self.project.active()?.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
                    // both ends must be values the parameter allows, and it must be animatable
                    crate::clipprops::check_value(c, param, *low, true)?;
                    crate::clipprops::check_value(c, param, *high, true)?;
                    c.duration.as_f64()
                };
                let keys = crate::reactive::lfo_keys(shape, *rate, *low, *high, *phase, *seed, self.project.settings.fps, dur)?;
                self.run(&Command::SetKeyframes { clip: clip.clone(), param: param.clone(), keys }, fwd, inv)
            }
            Command::AnimateFromExpression { clip, param, expr, source, clamp } => {
                let keys = {
                    let (_, c) = self.project.active()?.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
                    let (_, lo, hi) = crate::clipprops::param_range(c, param, true)?;
                    let src = source.as_deref().unwrap_or(param);
                    crate::clipprops::param_range(c, src, false)?;
                    // a source that cannot be read (a typo'd effect id) fails here, not halfway through the formula
                    crate::expr::clip_value(c, src, 0.0)?;
                    let read = |t: f64| crate::expr::clip_value(c, src, t).unwrap_or(0.0);
                    crate::expr::keys(expr, &crate::expr::Inputs { fps: self.project.settings.fps, dur: c.duration.as_f64(), source: &read, range: (lo, hi), clamp: *clamp })?
                };
                self.run(&Command::SetKeyframes { clip: clip.clone(), param: param.clone(), keys }, fwd, inv)
            }
            Command::AnimateFromMidi { clip, param, path, source, channel, track, low, high, decay, offset } => {
                let (start, dur) = {
                    let (_, c) = self.project.active()?.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
                    crate::clipprops::check_value(c, param, *low, true)?;
                    crate::clipprops::check_value(c, param, *high, true)?;
                    (c.start.as_f64(), c.duration.as_f64())
                };
                let size = std::fs::metadata(path).map_err(|e| Error::io(path, e))?.len();
                if size > crate::midi::MAX_FILE_BYTES {
                    return Err(Error::validation(format!("{path} is too large for a MIDI file ({size} bytes)")));
                }
                let file = crate::midi::parse(&std::fs::read(path).map_err(|e| Error::io(path, e))?)?;
                let opts = crate::midi::Options { source: crate::midi::Source::parse(source)?, channel: *channel, track: *track, low: *low, high: *high, decay: *decay, offset: *offset };
                let keys = crate::midi::keys(&file, &opts, self.project.settings.fps, start, dur)?;
                self.run(&Command::SetKeyframes { clip: clip.clone(), param: param.clone(), keys }, fwd, inv)
            }
            Command::AnimateFromAudio { clip, param, source, low, high, smooth, band } => {
                let keys = self.audio_keys(clip, param, source.as_deref(), *low, *high, *smooth, band.as_deref().unwrap_or("all"))?;
                self.run(&Command::SetKeyframes { clip: clip.clone(), param: param.clone(), keys }, fwd, inv)
            }
            other => {
                for patch in plan(&self.project, other)? {
                    let undo_patch = apply(&mut self.project, &patch)?;
                    fwd.push(patch);
                    inv.push(undo_patch);
                }
                Ok(())
            }
        }
    }

    /// The audio a parameter of `clip` should react to: the media file, the media time where the overlap starts, the
    /// overlap's offset into `clip` and its length (seconds). Also checks `param` can be animated to `low` and `high`.
    fn reaction_source(&self, clip: &str, param: &str, source: Option<&str>, low: f64, high: f64) -> Result<(PathBuf, f64, f64, f64)> {
        let seq = self.project.active()?;
        let (_, c) = seq.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
        // check the parameter can be animated and both values are allowed before running FFmpeg
        crate::clipprops::check_value(c, param, low, true)?;
        crate::clipprops::check_value(c, param, high, true)?;
        let src_id = match source {
            Some(s) => s.to_string(),
            None if c.kind == TrackKind::Audio => c.id.clone(),
            None => seq
                .tracks
                .iter()
                .filter(|t| t.kind == TrackKind::Audio)
                .flat_map(|t| t.clips.iter())
                .find(|a| a.link.is_some() && a.link == c.link)
                .map(|a| a.id.clone())
                .ok_or_else(|| Error::validation("this clip has no linked audio; pick an audio clip to follow"))?,
        };
        let (st, s) = seq.find_clip(&src_id).ok_or_else(|| Error::NotFound(format!("clip {src_id}")))?;
        if st.kind != TrackKind::Audio {
            return Err(Error::validation("the clip to follow must be an audio clip"));
        }
        if s.speed != Rational::from_int(1) || s.reverse || s.freeze.is_some() {
            return Err(Error::validation("following a retimed audio clip is not supported (speed must be 100%, not reversed or frozen)"));
        }
        let media = self.project.media.iter().find(|m| m.id == s.media).ok_or_else(|| Error::NotFound(format!("media {}", s.media)))?;
        if media.generator.is_some() {
            return Err(Error::validation("that clip has no audio file to measure"));
        }
        let from = c.start.max(s.start);
        let to = c.end().min(s.end());
        if from >= to {
            return Err(Error::validation("the audio clip does not overlap this clip on the timeline"));
        }
        let media_from = s.source_in + (from - s.start);
        Ok((PathBuf::from(&media.path), media_from.as_f64(), (from - c.start).as_f64(), (to - from).as_f64()))
    }

    /// Keyframes making `param` of `clip` follow the loudness of an audio clip over the part of the timeline both cover.
    #[allow(clippy::too_many_arguments)]
    fn audio_keys(&self, clip: &str, param: &str, source: Option<&str>, low: f64, high: f64, smooth: f64, band: &str) -> Result<Vec<crate::keyframes::Keyframe>> {
        if !(0.0..=10.0).contains(&smooth) {
            return Err(Error::validation("smoothing must be 0-10 seconds"));
        }
        if !crate::reactive::BANDS.iter().any(|b| b.0 == band) {
            return Err(Error::validation(format!("unknown band '{band}' (all, bass, mid, treble)")));
        }
        let (path, media_from, offset, len) = self.reaction_source(clip, param, source, low, high)?;
        let levels = crate::reactive::envelope(&self.tools, &path, media_from, len, band)?;
        let dur = self.project.active()?.find_clip(clip).map(|(_, c)| c.duration.as_f64()).unwrap_or(0.0);
        Ok(crate::reactive::keys(&levels, offset, crate::reactive::Mapping { low, high, smooth }, self.project.settings.fps, dur))
    }

    /// Keyframes pulsing `param` of `clip` on the beats of an audio clip.
    fn beat_keys(&self, clip: &str, param: &str, source: Option<&str>, low: f64, high: f64, decay: f64) -> Result<Vec<crate::keyframes::Keyframe>> {
        if !(0.0..=10.0).contains(&decay) {
            return Err(Error::validation("decay must be 0-10 seconds"));
        }
        let (path, media_from, offset, len) = self.reaction_source(clip, param, source, low, high)?;
        let beats = crate::beats::analyse(&self.tools, &path)?.beats;
        // media time → clip time, keeping only beats inside the overlap
        let rel: Vec<f64> = beats.iter().filter(|b| **b >= media_from && **b < media_from + len).map(|b| b - media_from + offset).collect();
        let dur = self.project.active()?.find_clip(clip).map(|(_, c)| c.duration.as_f64()).unwrap_or(0.0);
        crate::reactive::pulse_keys(&rel, low, high, decay, self.project.settings.fps, dur)
    }

    /// Cut `ranges` (timeline time) out of `clip`'s linked group, latest range first so earlier ones keep their positions.
    fn remove_ranges(&mut self, clip: &str, ranges: &[(Rational, Rational)], fwd: &mut Vec<Patch>, inv: &mut Vec<Patch>) -> Result<()> {
        let fps = self.project.settings.fps;
        let frame = Rational::from_int(1).div(fps);
        let (cs, ce) = {
            let (_, c) = self.project.active()?.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
            (c.start, c.end())
        };
        // clamp to the clip, snap to frames, drop empties, sort and merge overlaps
        let mut rs: Vec<(Rational, Rational)> = ranges
            .iter()
            .map(|(a, b)| (crate::time::snap_to_frame(*a, fps).max(cs), crate::time::snap_to_frame(*b, fps).min(ce)))
            .filter(|(a, b)| a < b)
            .collect();
        rs.sort_by_key(|x| x.0);
        let mut merged: Vec<(Rational, Rational)> = vec![];
        for r in rs {
            match merged.last_mut() {
                Some(l) if r.0 <= l.1 => l.1 = l.1.max(r.1),
                _ => merged.push(r),
            }
        }
        if merged.is_empty() {
            return Err(Error::validation("nothing to cut: no range overlaps the clip"));
        }
        for (mut a, mut b) in merged.into_iter().rev() {
            // the clip's current extent (earlier cuts do not move it; later ones were already removed)
            let (start, end) = {
                let (_, c) = self.project.active()?.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
                (c.start, c.end())
            };
            if b > end - frame { b = end; }
            if a < start + frame { a = start; }
            if a >= b { continue; }
            if b < end {
                self.run(&Command::SplitClip { clip: clip.to_string(), at: b }, fwd, inv)?;
            }
            let victim = if a > start {
                self.run(&Command::SplitClip { clip: clip.to_string(), at: a }, fwd, inv)?;
                let (t, _) = self.project.active()?.find_clip(clip).expect("left piece keeps its id");
                t.clips.iter().find(|c| c.start == a && c.id != clip).map(|c| c.id.clone()).ok_or_else(|| Error::validation("internal: cut piece not found"))?
            } else {
                clip.to_string()
            };
            self.run(&Command::DeleteClip { clip: victim, ripple: true }, fwd, inv)?;
        }
        Ok(())
    }

    /// `inv` is in application order; undo it newest-first.
    fn rollback(&mut self, inv: &[Patch]) {
        for p in inv.iter().rev() {
            // Inverse patches were produced from valid states, so failure here would be an engine bug.
            apply(&mut self.project, p).expect("rollback patch must apply");
        }
    }

    /// Start a group: everything dispatched until [`end_group`](Self::end_group) becomes ONE undo step, and
    /// [`abort_group`](Self::abort_group) takes all of it back. Groups do not nest.
    pub fn begin_group(&mut self) -> Group {
        Group { base: self.undo.len(), redo: std::mem::take(&mut self.redo) }
    }

    /// Merge what ran since `group` began into one undo step named `label` (nothing happened: no step).
    pub fn end_group(&mut self, group: Group, label: &str) {
        let tail: Vec<Entry> = self.undo.drain(group.base.min(self.undo.len())..).collect();
        if tail.is_empty() {
            self.redo = group.redo;
            return;
        }
        let forward = tail.iter().flat_map(|e| e.forward.clone()).collect();
        let inverse = tail.iter().rev().flat_map(|e| e.inverse.clone()).collect();
        self.undo.push(Entry { label: label.into(), forward, inverse });
        if self.saved_at.is_some_and(|s| s > group.base) {
            self.saved_at = None;
        }
    }

    /// Undo everything since `group` began, leaving the history as it was.
    pub fn abort_group(&mut self, group: Group) {
        while self.undo.len() > group.base {
            if self.undo().is_err() {
                break;
            }
        }
        self.redo = group.redo;
    }

    pub fn undo_label(&self) -> Option<&str> {
        self.undo.last().map(|e| e.label.as_str())
    }
    pub fn redo_label(&self) -> Option<&str> {
        self.redo.last().map(|e| e.label.as_str())
    }
    pub fn history(&self) -> Vec<String> {
        self.undo.iter().map(|e| e.label.clone()).collect()
    }

    pub fn undo(&mut self) -> Result<()> {
        let e = self.undo.pop().ok_or(Error::NothingTo("undo"))?;
        self.leave_removed_sequence(&e.inverse);
        for p in &e.inverse {
            apply(&mut self.project, p)?;
        }
        self.redo.push(e);
        self.fix_active();
        self.revision += 1;
        Ok(())
    }

    pub fn redo(&mut self) -> Result<()> {
        let e = self.redo.pop().ok_or(Error::NothingTo("redo"))?;
        self.leave_removed_sequence(&e.forward);
        for p in &e.forward {
            apply(&mut self.project, p)?;
        }
        self.undo.push(e);
        self.fix_active();
        self.revision += 1;
        Ok(())
    }

    /// Show another sequence (a compound clip's contents, or the main timeline). Not an undo step: it only changes which
    /// timeline commands act on.
    pub fn set_active_sequence(&mut self, id: &str) -> Result<()> {
        let s = self.project.sequence(id)?;
        if s.name.starts_with(crate::commands::SNAPSHOT_PREFIX) {
            return Err(Error::validation("a snapshot cannot be opened for editing; restore it instead"));
        }
        if self.project.active_sequence != id {
            self.project.active_sequence = id.to_string();
            self.revision += 1;
        }
        Ok(())
    }

    /// A sequence being shown cannot be removed: step back to the main timeline before patches that remove it are applied.
    fn leave_removed_sequence(&mut self, patches: &[Patch]) {
        let shown = self.project.active_sequence.clone();
        if patches.iter().any(|p| matches!(p, Patch::RemoveSequence { id } if *id == shown)) {
            if let Some(s) = self.project.sequences.iter().find(|s| s.id != shown && !s.compound && !s.name.starts_with(crate::commands::SNAPSHOT_PREFIX)) {
                self.project.active_sequence = s.id.clone();
            }
        }
    }

    /// After undo/redo the sequence being shown may be gone (undoing the step that made a compound): go back to the main one.
    fn fix_active(&mut self) {
        if self.project.sequence(&self.project.active_sequence).is_err() {
            if let Some(s) = self.project.sequences.iter().find(|s| !s.compound && !s.name.starts_with(crate::commands::SNAPSHOT_PREFIX)) {
                self.project.active_sequence = s.id.clone();
            }
        }
    }

    // ---- automation recorder (spec §56) ------------------------------------------------------

    pub fn start_recording(&mut self) {
        self.recording = Some(vec![]);
    }
    /// Stop and return the commands that ran while recording, as a replayable script.
    pub fn stop_recording(&mut self) -> Vec<Command> {
        self.recording.take().unwrap_or_default()
    }

    // ---- media -------------------------------------------------------------------------------

    /// Probe a file and add it to the media library. The file itself is never modified.
    pub fn import_media(&mut self, path: &Path) -> Result<String> {
        let asset = prepare_asset(&self.tools, path)?;
        self.import_asset(asset)
    }

    /// Add an already-probed asset (so callers can run FFprobe without holding the engine lock).
    /// Re-importing the same path returns the existing asset id.
    pub fn import_asset(&mut self, asset: MediaAsset) -> Result<String> {
        if let Some(existing) = self.project.media.iter().find(|m| m.path == asset.path) {
            return Ok(existing.id.clone());
        }
        let id = asset.id.clone();
        self.dispatch(Command::ImportMedia { asset })?;
        Ok(id)
    }

    /// Relink `media_id` to `new_path` (probed; the id and all clip references are kept). Undoable.
    pub fn relink_media(&mut self, media_id: &str, new_path: &Path) -> Result<()> {
        let mut asset = prepare_asset(&self.tools, new_path)?;
        asset.id = media_id.to_string();
        self.dispatch(Command::RelinkMedia { asset })
    }

    /// Search `dirs` for every offline media item and relink all *exact* (fingerprint) matches as ONE undo step.
    /// Returns (relinked media ids, still-unresolved candidates per media id).
    pub fn relink_search(&mut self, dirs: &[PathBuf]) -> Result<RelinkOutcome> {
        let offline = self.offline_media();
        let missing: Vec<&MediaAsset> = self.project.media.iter().filter(|m| offline.contains(&m.id)).collect();
        let found = crate::relink::find_candidates(&missing, dirs);
        let mut cmds = vec![];
        let mut done = vec![];
        let mut rest = vec![];
        for (id, cands) in found {
            match cands.iter().find(|c| c.exact) {
                Some(c) => {
                    let mut asset = prepare_asset(&self.tools, &c.path)?;
                    asset.id = id.clone();
                    cmds.push(Command::RelinkMedia { asset });
                    done.push(id);
                }
                None => rest.push((id, cands)),
            }
        }
        if !cmds.is_empty() {
            self.dispatch(Command::Batch { label: format!("Relink {} media", cmds.len()), commands: cmds })?;
        }
        Ok((done, rest))
    }

    /// Media whose source file no longer exists (spec §41 relinking input).
    pub fn offline_media(&self) -> Vec<String> {
        self.project.media.iter().filter(|m| !m.is_generated() && !media_exists(&m.path)).map(|m| m.id.clone()).collect()
    }

    // ---- persistence -------------------------------------------------------------------------

    /// Save atomically (write temp file, then rename) so a crash never leaves a half-written project.
    pub fn save(&mut self, path: &Path) -> Result<()> {
        let json = serde_json::to_string_pretty(&self.project)?;
        let tmp = path.with_extension("ffworks.tmp");
        fs::write(&tmp, json).map_err(|e| Error::io(&tmp, e))?;
        fs::rename(&tmp, path).map_err(|e| Error::io(path, e))?;
        self.path = Some(path.to_path_buf());
        self.saved_at = Some(self.undo.len());
        Ok(())
    }

    pub fn load(path: &Path, tools: Tools) -> Result<Engine> {
        let text = fs::read_to_string(path).map_err(|e| Error::io(path, e))?;
        let doc: serde_json::Value = serde_json::from_str(&text)?;
        let doc = migrate(doc)?;
        let project: Project = serde_json::from_value(doc)?;
        project.validate()?;
        Ok(Engine { project, tools, path: Some(path.to_path_buf()), undo: vec![], redo: vec![], saved_at: Some(0), recording: None, revision: 0, autosaved_rev: None })
    }
}

/// Whether a media path (a file, or an image-sequence pattern) is present.
fn media_exists(path: &str) -> bool {
    if crate::imgseq::is_pattern(path) {
        crate::imgseq::first_frame(path).is_some_and(|p| p.exists())
    } else {
        Path::new(path).exists()
    }
}

/// Import an image sequence (any one frame of it) as one media item at `fps` frames per second.
pub fn prepare_sequence_asset(tools: &Tools, frame: &Path, fps: crate::time::Fps) -> Result<MediaAsset> {
    let seq = crate::imgseq::detect(frame)?;
    let first = crate::imgseq::first_frame(&seq.pattern).ok_or_else(|| Error::validation("no frames found"))?;
    let mut info = probe(tools, &first)?;
    if info.video.len() != 1 {
        return Err(Error::validation("the frames must be pictures"));
    }
    info.still = false;
    info.container = "image2".into();
    info.video[0].fps = Some(fps);
    info.duration = Rational::new(seq.count as i64 * fps.den(), fps.num());
    let stem = Path::new(&seq.pattern).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(MediaAsset { id: new_id("med"), name: format!("{stem} ({} frames)", seq.count), path: seq.pattern, fingerprint: None, generator: None, color_override: None, info })
}

/// Probe `path` and build a media asset without touching any project state.
pub fn prepare_asset(tools: &Tools, path: &Path) -> Result<MediaAsset> {
    let abs = fs::canonicalize(path).map_err(|e| Error::io(path, e))?;
    let abs = strip_verbatim(&abs);
    let info = probe(tools, &abs)?;
    if !info.has_video() && !info.has_audio() {
        return Err(Error::validation(format!("'{}' contains no video or audio streams", abs.display())));
    }
    Ok(MediaAsset {
        id: new_id("med"),
        name: abs.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "media".into()),
        path: abs.to_string_lossy().into_owned(),
        fingerprint: fingerprint(&abs).ok(),
        generator: None,
        color_override: None,
        info,
    })
}

/// The absolute form of `path` as text, without the `\\?\` prefix Windows' `canonicalize` adds. The file must exist.
pub fn absolute_path(path: &Path) -> Result<String> {
    let abs = fs::canonicalize(path).map_err(|e| Error::io(path, e))?;
    Ok(strip_verbatim(&abs).to_string_lossy().into_owned())
}

/// Remove the `\\?\` prefix `canonicalize` adds on Windows so paths stay readable and portable.
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p.to_path_buf(),
    }
}

/// size + SHA-256 of the first and last MiB. Cheap enough to run on enormous files.
pub fn fingerprint(path: &Path) -> Result<String> {
    const WINDOW: u64 = 1 << 20;
    let mut f = fs::File::open(path).map_err(|e| Error::io(path, e))?;
    let size = f.metadata().map_err(|e| Error::io(path, e))?.len();
    let mut h = Sha256::new();
    h.update(size.to_le_bytes());
    let mut buf = vec![0u8; WINDOW.min(size) as usize];
    f.read_exact(&mut buf).map_err(|e| Error::io(path, e))?;
    h.update(&buf);
    if size > WINDOW {
        let tail = WINDOW.min(size - WINDOW) as usize;
        f.seek(SeekFrom::End(-(tail as i64))).map_err(|e| Error::io(path, e))?;
        let mut t = vec![0u8; tail];
        f.read_exact(&mut t).map_err(|e| Error::io(path, e))?;
        h.update(&t);
    }
    Ok(format!("{size}-{:x}", h.finalize())[..48].to_string())
}
