//! Demo mode: a throwaway timeline built from one of the user's clips, cut into short segments with a random
//! transition between each pair and (optionally) a random effect stack on each segment. It is rendered to a preview and
//! looped, then replaced by a new random one, so many looks can be seen quickly. The user's project is never changed.

use crate::commands::Command;
use crate::engine::Engine;
use crate::error::{Error, Result};
use crate::process::Tools;
use crate::project::{Project, TrackKind};
use crate::random::{effect_stack, Rng};
use crate::time::Rational;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct DemoOptions {
    /// Source to cut up; the first real video clip's media when not given.
    pub media: Option<String>,
    /// Number of segments (and so segments-1 transitions).
    pub segments: usize,
    pub segment_secs: f64,
    pub transition_secs: f64,
    /// Transition names to pick from; `None` = hard cuts.
    pub transitions: Option<Vec<String>>,
    /// `(stack size, effect ids to pick from or None for all)`; `None` = no effects.
    pub effects: Option<(usize, Option<Vec<String>>)>,
    pub seed: u64,
}

/// What one segment got, so the user can see (and star) what they are looking at.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DemoStep {
    pub index: usize,
    /// Seconds from the start of the demo where the segment begins.
    pub start: f64,
    /// Transition into this segment (None for the first or when it could not be added).
    pub transition: Option<String>,
    pub effects: Vec<String>,
    /// The same effects with their random parameter values, so a look can be kept.
    #[serde(default)]
    pub fx: Vec<crate::settings::PresetEffect>,
}

fn secs(x: f64) -> Rational {
    Rational::new((x * 1000.0).round() as i64, 1000)
}

/// Build the demo project. Returns it with the steps; fails when there is no usable video or nothing random is asked for.
pub fn build(project: &Project, tools: &Tools, o: &DemoOptions) -> Result<(Project, Vec<DemoStep>)> {
    if o.transitions.is_none() && o.effects.is_none() {
        return Err(Error::validation("choose transitions, effects or both for the demo"));
    }
    if !(2..=12).contains(&o.segments) || !(1.0..=10.0).contains(&o.segment_secs) || !(0.2..=o.segment_secs.min(3.0)).contains(&o.transition_secs) {
        return Err(Error::validation("demo needs 2-12 segments of 1-10 s with transitions of 0.2-3 s that fit"));
    }
    let seq = project.active()?;
    let media_id = match &o.media {
        Some(m) => m.clone(),
        None => seq
            .tracks
            .iter()
            .filter(|t| t.kind == TrackKind::Video)
            .flat_map(|t| t.clips.iter())
            .map(|c| c.media.clone())
            .find(|m| project.media.iter().any(|a| a.id == *m && !a.is_generated()))
            .or_else(|| project.media.iter().find(|a| !a.is_generated() && !a.info.video.is_empty()).map(|a| a.id.clone()))
            .ok_or_else(|| Error::validation("add a video clip to the project first; the demo cuts one up"))?,
    };
    let asset = project.media.iter().find(|a| a.id == media_id).ok_or_else(|| Error::NotFound(format!("media {media_id}")))?;
    if asset.info.video.is_empty() || asset.is_generated() || asset.info.still {
        return Err(Error::validation("the demo needs a real video file (not a still picture)"));
    }
    let dur = asset.info.duration.as_f64();
    let h = o.transition_secs / 2.0;
    // every segment needs spare footage of half a transition on both sides
    let room = dur - o.segment_secs - 2.0 * h;
    if room < 0.0 {
        return Err(Error::validation(format!("the clip is only {dur:.1} s; the demo needs at least {:.1} s of footage", o.segment_secs + o.transition_secs)));
    }

    let mut eng = Engine::new("demo", project.settings.clone(), tools.clone());
    eng.project.media.push(asset.clone());
    let track = eng.project.active()?.tracks.iter().find(|t| t.kind == TrackKind::Video).ok_or_else(|| Error::validation("no video track"))?.id.clone();
    let mut rng = Rng::new(o.seed);
    let mut clips = vec![];
    for i in 0..o.segments {
        // walk through the source, wrapping back to the start when it runs out
        let from = h + if room > 0.0 { (i as f64 * o.segment_secs) % (room + f64::EPSILON) } else { 0.0 };
        eng.dispatch(Command::PlaceClip { media: media_id.clone(), track: track.clone(), start: secs(i as f64 * o.segment_secs), source_in: Some(secs(from)), duration: Some(secs(o.segment_secs)), with_audio: false, audio_track: None })?;
        clips.push(eng.project.active()?.tracks.iter().find(|t| t.id == track).unwrap().clips.last().unwrap().id.clone());
    }
    let mut steps: Vec<DemoStep> = (0..o.segments).map(|i| DemoStep { index: i, start: i as f64 * o.segment_secs, transition: None, effects: vec![], fx: vec![] }).collect();
    if let Some((count, pool)) = &o.effects {
        for (i, id) in clips.iter().enumerate() {
            let clip = eng.project.active()?.find_clip(id).unwrap().1.clone();
            let cmds = effect_stack(&clip, *count, o.seed.wrapping_add(i as u64 * 7919), pool.as_deref())?;
            steps[i].effects = cmds.iter().filter_map(|c| if let Command::AddEffect { effect, .. } = c { Some(effect.clone()) } else { None }).collect();
            steps[i].fx = cmds.iter().filter_map(|c| if let Command::AddEffect { effect, params, .. } = c { Some(crate::settings::PresetEffect { effect: effect.clone(), params: params.clone() }) } else { None }).collect();
            eng.dispatch(Command::Batch { label: "demo effects".into(), commands: cmds })?;
        }
    }
    if let Some(kinds) = o.transitions.as_ref().filter(|k| !k.is_empty()) {
        for i in 1..o.segments {
            let kind = kinds[rng.below(kinds.len())].clone();
            // a cut that cannot take it (should not happen with the spare footage above) stays a hard cut
            if eng.dispatch(Command::AddTransition { clip_a: clips[i - 1].clone(), clip_b: clips[i].clone(), kind: kind.clone(), duration: secs(o.transition_secs) }).is_ok() {
                steps[i].transition = Some(kind);
            }
        }
    } else if o.transitions.is_some() {
        return Err(Error::validation("none of the chosen transitions are available in this FFmpeg"));
    }
    Ok((eng.project, steps))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needs_something_random_and_sane_numbers() {
        let p = Project::new("p", crate::project::ProjectSettings { width: 320, height: 240, fps: Rational::from_int(25), sample_rate: 48000 });
        let t = Tools { ffmpeg: "ffmpeg".into(), ffprobe: "ffprobe".into() };
        let base = DemoOptions { media: None, segments: 4, segment_secs: 2.0, transition_secs: 0.5, transitions: Some(vec!["fade".into()]), effects: None, seed: 1 };
        assert!(build(&p, &t, &DemoOptions { transitions: None, effects: None, ..base.clone() }).unwrap_err().to_string().contains("choose"));
        assert!(build(&p, &t, &DemoOptions { segments: 1, ..base.clone() }).is_err());
        assert!(build(&p, &t, &DemoOptions { transition_secs: 5.0, ..base.clone() }).is_err());
        assert!(build(&p, &t, &base).unwrap_err().to_string().contains("video clip"), "an empty project has nothing to cut up");
    }
}
