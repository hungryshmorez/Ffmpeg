//! Compound clips: several clips (and their audio) folded into one clip that stays editable.
//!
//! A compound clip is an ordinary clip whose media is a *nested* asset (`Generator::Nested`) pointing at another sequence of
//! the project (`Sequence::compound`). Because it is ordinary media, trimming, speed, effects, transforms, blend modes,
//! transitions and a linked audio clip all work on it unchanged. What is special happens at render time: [`prepare`] renders
//! the inner sequence once through the normal compiler into a lossless cache file (FFV1 + FLAC, named after a hash of
//! everything it depends on), and the outer render reads that file like any other source. Editing inside the compound changes
//! the hash, so the next preview or export renders it again; unchanged compounds are reused.
//!
//! Limits, by design: the inner picture is opaque (it is composited on black, like any export) and is rendered at project
//! resolution and frame rate; the compound's length only ever grows by itself (see [`grown`]); `FitCompound` shortens it.

use crate::commands::SNAPSHOT_PREFIX;
use crate::error::{Error, Result};
use crate::ffmpeg::{compile, ExportSettings, FfmpegJob, RenderOptions};
use crate::ffprobe::{AudioStream, ColorInfo, MediaInfo, VideoStream};
use crate::generators::Generator;
use crate::jobs::{CancelToken, JobState};
use crate::patch::Patch;
use crate::process::{Capabilities, Tools};
use crate::project::{new_id, Clip, Id, MediaAsset, Project, ProjectSettings, Sequence, Track, TrackKind};
use crate::render_graph::{build_for, RenderGraph};
use crate::time::Rational;
use crate::transitions::Transition;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

/// Compounds inside compounds may go this deep (a cycle is refused by validation; this bounds honest nesting).
pub const MAX_DEPTH: usize = 8;

/// Bump when the way a compound is rendered changes, so old cache files are not reused.
const RENDER_VERSION: u32 = 1;

/// One planned render of a compound's inner sequence.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NestStage {
    /// Fingerprint of everything the file depends on.
    pub key: String,
    /// The lossless file this stage writes (and the outer render reads).
    pub output: PathBuf,
    /// Name of the compound, for progress and errors.
    pub name: String,
    /// Renders the inner sequence; carries its own pixel-sort stages and nested compounds.
    pub job: Box<FfmpegJob>,
}

/// The sequence a compound media asset stands for.
pub fn sequence_of(m: &MediaAsset) -> Option<&str> {
    match &m.generator {
        Some(Generator::Nested { sequence }) => Some(sequence),
        _ => None,
    }
}

/// The media asset standing for `seq`, sized for the project.
pub fn compound_asset(seq: &Sequence, settings: &ProjectSettings) -> MediaAsset {
    let has = |kind| seq.tracks.iter().any(|t| t.kind == kind && !t.clips.is_empty());
    MediaAsset {
        id: format!("gen_nest_{}", seq.id),
        name: seq.name.clone(),
        path: format!("generated:compound:{}", seq.id),
        fingerprint: None,
        generator: Some(Generator::Nested { sequence: seq.id.clone() }),
        color_override: None,
        info: MediaInfo {
            container: "compound".into(),
            duration: seq.duration(),
            video: if has(TrackKind::Video) { vec![VideoStream { index: 0, codec: "compound".into(), width: settings.width, height: settings.height, fps: Some(settings.fps), bit_rate: None, color: ColorInfo::default() }] } else { vec![] },
            audio: if has(TrackKind::Audio) { vec![AudioStream { index: 1, codec: "compound".into(), sample_rate: settings.sample_rate, channels: 2, channel_layout: Some("stereo".into()), bit_rate: None }] } else { vec![] },
            ..Default::default()
        },
    }
}

/// Patches that bring each compound's media up to what its inner sequence holds now: a longer length, or a stream it did not
/// have. They never shorten it (clips already placed would then run past the end); `FitCompound` does that on request.
pub fn grown(p: &Project) -> Vec<Patch> {
    let mut out = vec![];
    for seq in p.sequences.iter().filter(|s| s.compound) {
        let Some(m) = p.media.iter().find(|m| sequence_of(m) == Some(seq.id.as_str())) else { continue };
        let fresh = compound_asset(seq, &p.settings);
        let mut next = m.clone();
        next.info.duration = m.info.duration.max(fresh.info.duration);
        if next.info.video.is_empty() {
            next.info.video = fresh.info.video;
        }
        if next.info.audio.is_empty() {
            next.info.audio = fresh.info.audio;
        }
        if next != *m {
            out.push(Patch::ReplaceMedia { asset: next });
        }
    }
    out
}

/// True when following compound references from `from` leads back to `from` (a compound inside itself).
pub fn is_cyclic(p: &Project, from: &str) -> bool {
    fn reaches(p: &Project, at: &str, target: &str, seen: &mut BTreeSet<String>) -> bool {
        if !seen.insert(at.to_string()) {
            return false;
        }
        let Ok(seq) = p.sequence(at) else { return false };
        seq.tracks.iter().flat_map(|t| &t.clips).filter_map(|c| p.media.iter().find(|m| m.id == c.media)).filter_map(sequence_of).any(|next| next == target || reaches(p, next, target, seen))
    }
    reaches(p, from, from, &mut BTreeSet::new())
}

/// Every clip of every sequence that uses `media`.
fn uses(p: &Project, media: &str) -> usize {
    p.sequences.iter().flat_map(|s| &s.tracks).flat_map(|t| &t.clips).filter(|c| c.media == media).count()
}

// ---- editing ----------------------------------------------------------------------------------

/// Fold `clips` (and everything linked to them) of the active sequence into a compound clip.
pub fn plan_nest(p: &Project, clips: &[Id], name: Option<&str>) -> Result<Vec<Patch>> {
    let seq = p.active()?;
    if seq.name.starts_with(SNAPSHOT_PREFIX) {
        return Err(Error::validation("a snapshot cannot be edited"));
    }
    if clips.is_empty() {
        return Err(Error::validation("select the clips to put in a compound clip"));
    }
    let mut chosen: Vec<Id> = vec![];
    for c in clips {
        for id in seq.linked_group(c) {
            if !chosen.contains(&id) {
                chosen.push(id);
            }
        }
        if seq.find_clip(c).is_none() {
            return Err(Error::NotFound(format!("clip {c}")));
        }
    }
    let picked = |id: &str| chosen.iter().any(|c| c == id);

    // every transition must lie wholly inside or wholly outside the selection
    for t in &seq.tracks {
        for tr in &t.transitions {
            if picked(&tr.clip_a) != picked(&tr.clip_b) {
                return Err(Error::validation(format!("a transition on '{}' joins a selected clip to one that is not selected; select both or remove the transition", t.name)));
            }
        }
        if t.clips.iter().any(|c| picked(&c.id)) && t.locked {
            return Err(Error::validation(format!("track '{}' is locked", t.name)));
        }
    }
    let selected: Vec<(&Track, &Clip)> = seq.tracks.iter().flat_map(|t| t.clips.iter().filter(|c| picked(&c.id)).map(move |c| (t, c))).collect();
    let t0 = selected.iter().map(|(_, c)| c.start).fold(selected[0].1.start, Rational::min);
    let t1 = selected.iter().map(|(_, c)| c.end()).fold(Rational::ZERO, Rational::max);

    // where the compound goes: the highest selected video track (so it is composited where the top clip was) and the first
    // selected audio track
    let dest_video = seq.tracks.iter().rev().find(|t| t.kind == TrackKind::Video && t.clips.iter().any(|c| picked(&c.id)));
    let dest_audio = seq.tracks.iter().find(|t| t.kind == TrackKind::Audio && t.clips.iter().any(|c| picked(&c.id)));
    for dest in [dest_video, dest_audio].into_iter().flatten() {
        if let Some(c) = dest.clips.iter().find(|c| !picked(&c.id) && c.start < t1 && c.end() > t0) {
            return Err(Error::validation(format!("the compound clip would overlap '{}' on track '{}'; select it too or move it away first", c.name, dest.name)));
        }
    }

    // the inner sequence: the same tracks and clips, moved to start at zero, with new ids
    let mut link_map: HashMap<Id, Id> = HashMap::new();
    let mut clip_map: HashMap<Id, Id> = HashMap::new();
    let mut inner_tracks: Vec<Track> = vec![];
    for t in seq.tracks.iter().filter(|t| t.clips.iter().any(|c| picked(&c.id))) {
        let own: Vec<Clip> = t
            .clips
            .iter()
            .filter(|c| picked(&c.id))
            .map(|c| {
                let mut c = c.clone();
                let new = new_id("clp");
                clip_map.insert(c.id.clone(), new.clone());
                c.id = new;
                c.start = c.start - t0;
                c.link = c.link.as_ref().map(|l| link_map.entry(l.clone()).or_insert_with(|| new_id("lnk")).clone());
                c
            })
            .collect();
        // the destination track applies its own level to the compound, so the inner track only adds the difference
        let (gain_db, pan) = match (t.kind, dest_audio) {
            (TrackKind::Audio, Some(d)) if d.id == t.id => (0.0, 0.0),
            (TrackKind::Audio, Some(d)) => (t.gain_db - d.gain_db, t.pan),
            _ => (t.gain_db, t.pan),
        };
        let transitions: Vec<Transition> = t
            .transitions
            .iter()
            .filter(|tr| picked(&tr.clip_a))
            .map(|tr| Transition { id: new_id("trn"), clip_a: clip_map[&tr.clip_a].clone(), clip_b: clip_map[&tr.clip_b].clone(), ..tr.clone() })
            .collect();
        inner_tracks.push(Track { id: new_id("trk"), name: t.name.clone(), kind: t.kind, muted: t.muted, locked: false, gain_db, pan, solo: false, clips: own, transitions });
    }
    let n = (1..).find(|n| !p.sequences.iter().any(|s| s.name == format!("Compound {n}"))).expect("unbounded");
    let label = name.map(str::trim).filter(|n| !n.is_empty()).map(str::to_string).unwrap_or_else(|| format!("Compound {n}"));
    if label.chars().count() > 80 {
        return Err(Error::validation("a compound clip's name can have at most 80 characters"));
    }
    let inner = Sequence { id: new_id("seq"), name: label.clone(), tracks: inner_tracks, markers: vec![], compound: true };
    let asset = compound_asset(&inner, &p.settings);
    let (has_v, has_a) = (asset.info.has_video(), asset.info.has_audio());
    let (media, dur) = (asset.id.clone(), asset.info.duration);

    let mut out = vec![];
    for t in &seq.tracks {
        for tr in t.transitions.iter().filter(|tr| picked(&tr.clip_a)) {
            out.push(Patch::RemoveTransition { seq: seq.id.clone(), track: t.id.clone(), id: tr.id.clone() });
        }
    }
    for (_, c) in &selected {
        out.push(Patch::RemoveClip { seq: seq.id.clone(), clip: c.id.clone() });
    }
    out.push(Patch::InsertSequence { index: p.sequences.len(), sequence: inner });
    out.push(Patch::InsertMedia { index: p.media.len(), asset });
    let link = (has_v && has_a).then(|| new_id("lnk"));
    if has_v {
        let t = dest_video.ok_or_else(|| Error::validation("internal: no video track for the compound"))?;
        out.push(Patch::PutClip { seq: seq.id.clone(), track: t.id.clone(), clip: Clip::new(new_id("clp"), media.clone(), label.clone(), TrackKind::Video, t0, Rational::ZERO, dur, link.clone()) });
    }
    if has_a {
        let t = dest_audio.ok_or_else(|| Error::validation("internal: no audio track for the compound"))?;
        out.push(Patch::PutClip { seq: seq.id.clone(), track: t.id.clone(), clip: Clip::new(new_id("clp"), media, label, TrackKind::Audio, t0, Rational::ZERO, dur, link) });
    }
    Ok(out)
}

/// Replace a compound clip by the clips it holds, on new tracks of the active sequence.
pub fn plan_unnest(p: &Project, clip: &str) -> Result<Vec<Patch>> {
    let seq = p.active()?;
    let (_, anchor) = seq.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
    let media = p.media(&anchor.media)?;
    let inner_id = sequence_of(media).ok_or_else(|| Error::validation(format!("'{}' is not a compound clip", anchor.name)))?;
    let inner = p.sequence(inner_id)?;
    let group = seq.linked_group(clip);
    for gid in &group {
        let (t, c) = seq.find_clip(gid).expect("member");
        if t.locked {
            return Err(Error::validation(format!("track '{}' is locked", t.name)));
        }
        if t.transitions.iter().any(|tr| &tr.clip_a == gid || &tr.clip_b == gid) {
            return Err(Error::validation(format!("'{}' has a transition; remove it before taking the compound apart", c.name)));
        }
        let changed = !c.is_plain_timing()
            || !c.effects.is_empty()
            || !c.transform.is_identity()
            || c.blend != "normal"
            || !c.keyframes.is_empty()
            || c.opacity != 1.0
            || c.gain_db != 0.0
            || c.pan != 0.0
            || c.fade_in != Rational::ZERO
            || c.fade_out != Rational::ZERO;
        if changed {
            return Err(Error::validation(format!("'{}' has speed, effects, a transform, blend, opacity, volume, pan, fades or keyframes of its own, which cannot be folded into its contents; reset them first", c.name)));
        }
    }
    let lo = anchor.source_in;
    let hi = anchor.source_in + anchor.duration;
    let offset = anchor.start - anchor.source_in;

    let mut link_map: HashMap<Id, Vec<Id>> = HashMap::new();
    let mut tracks: Vec<Track> = vec![];
    for it in &inner.tracks {
        let mut kept: Vec<Clip> = vec![];
        let mut clip_map: HashMap<Id, Id> = HashMap::new();
        let mut trimmed: BTreeSet<Id> = BTreeSet::new();
        for c in &it.clips {
            let (a, b) = (c.start.max(lo), c.end().min(hi));
            if b <= a {
                continue;
            }
            let (front, back) = (a - c.start, c.end() - b);
            let mut n = c.clone();
            n.id = new_id("clp");
            clip_map.insert(c.id.clone(), n.id.clone());
            n.start = a + offset;
            n.duration = b - a;
            if front != Rational::ZERO || back != Rational::ZERO {
                trimmed.insert(c.id.clone());
                if c.freeze.is_none() {
                    if !c.reverse {
                        n.source_in = c.source_in + front.mul(c.speed);
                    } else {
                        n.source_in = c.source_in + back.mul(c.speed);
                    }
                }
                for kfs in n.keyframes.values_mut() {
                    for k in kfs.iter_mut() {
                        k.t = k.t - front;
                    }
                }
                n.clamp_fades();
            }
            if let Some(l) = &c.link {
                link_map.entry(l.clone()).or_default().push(n.id.clone());
            }
            kept.push(n);
        }
        if kept.is_empty() {
            continue;
        }
        let transitions = it
            .transitions
            .iter()
            .filter(|tr| clip_map.contains_key(&tr.clip_a) && clip_map.contains_key(&tr.clip_b) && !trimmed.contains(&tr.clip_a) && !trimmed.contains(&tr.clip_b))
            .map(|tr| Transition { id: new_id("trn"), clip_a: clip_map[&tr.clip_a].clone(), clip_b: clip_map[&tr.clip_b].clone(), ..tr.clone() })
            .collect();
        tracks.push(Track { id: new_id("trk"), name: format!("{} ({})", it.name, inner.name), kind: it.kind, muted: it.muted, locked: false, gain_db: it.gain_db, pan: it.pan, solo: false, clips: kept, transitions });
    }
    // links survive only between clips that are both still there
    let fresh: HashMap<Id, Id> = link_map.iter().filter(|(_, m)| m.len() > 1).map(|(l, _)| (l.clone(), new_id("lnk"))).collect();
    let by_clip: HashMap<Id, Id> = link_map.iter().filter_map(|(l, ms)| fresh.get(l).map(|f| ms.iter().map(move |m| (m.clone(), f.clone())))).flatten().collect();
    for t in &mut tracks {
        for c in &mut t.clips {
            c.link = by_clip.get(&c.id).cloned();
        }
    }
    if tracks.is_empty() {
        return Err(Error::validation("nothing of the compound's contents lies inside this clip's range"));
    }

    let mut out = vec![];
    for gid in &group {
        out.push(Patch::RemoveClip { seq: seq.id.clone(), clip: gid.clone() });
    }
    let mut video_at = seq.tracks.iter().rposition(|t| t.kind == TrackKind::Video).map(|i| i + 1).unwrap_or(0);
    let mut audio_at = seq.tracks.len();
    for t in tracks {
        let index = if t.kind == TrackKind::Video {
            video_at += 1;
            audio_at += 1;
            video_at - 1
        } else {
            audio_at += 1;
            audio_at - 1
        };
        out.push(Patch::InsertTrack { seq: seq.id.clone(), index, track: t });
    }
    // the compound itself goes when nothing else uses it
    if uses(p, &media.id) == group.len() {
        out.push(Patch::RemoveMedia { media: media.id.clone() });
        out.push(Patch::RemoveSequence { id: inner.id.clone() });
    }
    Ok(out)
}

/// Make a compound's length equal to what its sequence holds now (it never shrinks by itself).
pub fn plan_fit(p: &Project, media: &str) -> Result<Vec<Patch>> {
    let m = p.media(media)?;
    let seq = p.sequence(sequence_of(m).ok_or_else(|| Error::validation(format!("'{}' is not a compound clip", m.name)))?)?;
    let len = seq.duration();
    if len <= Rational::ZERO {
        return Err(Error::validation("the compound is empty"));
    }
    let eps = Rational::new(1, 1000);
    for s in &p.sequences {
        for c in s.tracks.iter().flat_map(|t| &t.clips).filter(|c| c.media == m.id) {
            if c.source_in + c.source_span() > len + eps {
                return Err(Error::validation(format!("'{}' in '{}' uses the compound beyond {:.2} s; trim that clip first", c.name, s.name, len.as_f64())));
            }
        }
    }
    let mut asset = m.clone();
    asset.info.duration = len;
    Ok(vec![Patch::ReplaceMedia { asset }])
}

// ---- rendering --------------------------------------------------------------------------------

/// Plan the render of every compound the graph reads and point those inputs at the files. Stages come back inner first;
/// `jobs::run_job` runs them before anything else. Call before `bake::prepare` (its mini-renders copy the input).
pub fn prepare(project: &Project, g: &mut RenderGraph, cache: &Path, caps: Option<&Capabilities>) -> Result<Vec<NestStage>> {
    prepare_at(project, g, cache, caps, 0)
}

fn prepare_at(project: &Project, g: &mut RenderGraph, cache: &Path, caps: Option<&Capabilities>, depth: usize) -> Result<Vec<NestStage>> {
    let mut stages: Vec<NestStage> = vec![];
    for i in 0..g.inputs.len() {
        let Some(seq_id) = g.inputs[i].nested.clone() else { continue };
        if !g.inputs[i].path.is_empty() {
            continue;
        }
        if depth >= MAX_DEPTH {
            return Err(Error::validation(format!("compound clips are nested more than {MAX_DEPTH} deep")));
        }
        let media = project.media(&g.inputs[i].media_id)?;
        let name = project.sequence(&seq_id)?.name.clone();
        let mut inner = build_for(project, &seq_id)?;
        // the clip may be longer than its contents, and keeps its sound even when the contents have none left
        inner.duration = inner.duration.max(media.info.duration);
        inner.has_audio = media.info.has_audio();
        let mut nests = prepare_at(project, &mut inner, cache, caps, depth + 1)?;
        let baked = crate::bake::prepare(&mut inner, None, cache, true)?;
        let mut settings = ExportSettings::find("ffv1_mkv")?;
        settings.extra.extend(["-g".into(), "1".into()]);
        if !media.info.has_video() {
            settings.video_codec = None;
        }
        if !media.info.has_audio() {
            settings.audio_codec = None;
        }
        let pending = cache.join("nest-pending.mkv");
        let mut job = compile(&inner, &RenderOptions { output: pending, settings, range: None, scale_div: 1 }, caps)?;
        job.stages = baked;
        let key = fingerprint(&job);
        let output = cache.join(format!("nest-{key}.mkv"));
        if let Some(last) = job.post.last_mut() {
            *last = output.to_string_lossy().into_owned();
        }
        job.output = output.clone();
        job.nests = nests.clone();

        let input = &mut g.inputs[i];
        input.path = output.to_string_lossy().into_owned();
        input.has_video = media.info.has_video();
        input.has_audio = media.info.has_audio();
        input.src_fps = Some(g.fps);
        input.still = false;
        input.generated = None;
        input.alpha = false;
        // inner stages first, once each
        for n in nests.drain(..) {
            if !stages.iter().any(|s| s.output == n.output) {
                stages.push(n);
            }
        }
        if !stages.iter().any(|s| s.output == output) {
            stages.push(NestStage { key, output, name, job: Box::new(job) });
        }
    }
    Ok(stages)
}

/// Hash of everything a compound's file depends on: how it is rendered, and the size and age of every source file it reads.
fn fingerprint(job: &FfmpegJob) -> String {
    let mut h = Sha256::new();
    h.update(RENDER_VERSION.to_le_bytes());
    h.update(job.argv(None).join("\u{1f}").as_bytes());
    h.update(job.filter_graph.as_bytes());
    // the files named after `-i` are the sources; baked and nested files carry their own hash in the name
    let mut it = job.pre.iter();
    while let Some(a) = it.next() {
        if a == "-i" {
            if let Some(path) = it.next() {
                if let Ok(m) = std::fs::metadata(path) {
                    h.update(m.len().to_le_bytes());
                    if let Ok(t) = m.modified().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).map_err(std::io::Error::other)) {
                        h.update(t.as_nanos().to_le_bytes());
                    }
                }
            }
        }
    }
    format!("{:x}", h.finalize())[..24].to_string()
}

/// Render one compound unless its file is already there. `on_progress` gets 0..=1.
pub fn run_stage(tools: &Tools, stage: &NestStage, cancel: &CancelToken, temp_dir: &Path, on_progress: &mut dyn FnMut(f64)) -> Result<()> {
    if stage.output.exists() {
        crate::bake::touch(&stage.output);
        on_progress(1.0);
        return Ok(());
    }
    if let Some(dir) = stage.output.parent() {
        std::fs::create_dir_all(dir).map_err(|e| Error::io(dir, e))?;
        crate::bake::prune(dir, crate::bake::CACHE_LIMIT_BYTES);
    }
    // Rendered to a name of its own and renamed afterwards: two renders of the same compound (a preview and an export, or two
    // projects) must not share one partial file.
    let mut job = (*stage.job).clone();
    let unique = stage.output.with_file_name(format!("nest-{}.{}.render.mkv", stage.key, uuid::Uuid::new_v4().simple()));
    if let Some(last) = job.post.last_mut() {
        *last = unique.to_string_lossy().into_owned();
    }
    job.output = unique.clone();
    let result = crate::jobs::run_job(tools, &job, &format!("nest_{}", stage.key), "compound clip", cancel, temp_dir, &mut |s| {
        if let JobState::Rendering { fraction: Some(f), .. } = s {
            on_progress(f);
        }
    });
    let outcome = result.map(|_| ()).and_then(|()| {
        if stage.output.exists() {
            // another render of the same compound finished first; theirs is identical
            let _ = std::fs::remove_file(&unique);
            Ok(())
        } else {
            std::fs::rename(&unique, &stage.output).map_err(|e| Error::io(&stage.output, e))
        }
    });
    if outcome.is_err() {
        let _ = std::fs::remove_file(&unique);
    }
    outcome.map_err(|e| match e {
        Error::Canceled => e,
        other => Error::validation(format!("rendering the compound clip '{}' failed: {other}", stage.name)),
    })
}
