//! Seeded randomisation of effects and transitions ("random effect" / "random transition" buttons, stacking).
//! The same seed always gives the same picks, so a result can be reproduced or shared.

use crate::commands::Command;
use crate::effects;
use crate::error::{Error, Result};
use crate::patch::apply;
use crate::project::{Clip, Project};
use crate::time::Rational;
use std::collections::BTreeMap;

/// SplitMix64: tiny, deterministic, good enough for picking effects.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in [0, 1).
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
}

/// A seed from the clock, for when the user did not ask for a specific one. Callers return it so the result is reproducible.
pub fn fresh_seed() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1)
}

/// Picks `count` items from `candidates` without repeats until they run out, then refills.
fn pick_many<'a>(rng: &mut Rng, candidates: &'a [String], count: usize) -> Vec<&'a String> {
    let mut bag: Vec<&String> = vec![];
    let mut out = vec![];
    for _ in 0..count {
        if bag.is_empty() {
            bag = candidates.iter().collect();
        }
        out.push(bag.remove(rng.below(bag.len())));
    }
    out
}

/// A moderate random value for a parameter: moves away from the default by up to 40% of the range (towards the
/// inside when the default sits on an end of the range), then snaps to the parameter's step.
fn random_value(rng: &mut Rng, d: &effects::ParamDef) -> f64 {
    let span = d.max - d.min;
    let reach = rng.unit() * 0.4 * span;
    let raw = if d.default <= d.min {
        d.min + reach
    } else if d.default >= d.max {
        d.max - reach
    } else if rng.unit() < 0.5 {
        d.default - reach.min(d.default - d.min)
    } else {
        d.default + reach.min(d.max - d.default)
    };
    let snapped = if d.step > 0.0 { (raw / d.step).round() * d.step } else { raw };
    (snapped.clamp(d.min, d.max) * 1e6).round() / 1e6
}

/// `AddEffect` commands for `count` random effects suited to the clip's kind. `pool` restricts the choice to those effect
/// ids (e.g. the user's favourites); effects that do not apply to this clip are ignored, and it is an error if none do.
pub fn effect_stack(clip: &Clip, count: usize, seed: u64, pool: Option<&[String]>) -> Result<Vec<Command>> {
    if count == 0 || count > 20 {
        return Err(Error::validation("stack 1 to 20 effects"));
    }
    let want = if clip.kind == crate::project::TrackKind::Video { "video" } else { "audio" };
    let defs: Vec<effects::EffectDef> = effects::registry().into_iter().filter(|d| d.kind == want && d.id != effects::GRAPH_EFFECT && pool.is_none_or(|p| p.iter().any(|x| x == d.id))).collect();
    if defs.is_empty() {
        return Err(Error::validation(format!("none of the chosen effects can be used on a {want} clip")));
    }
    let ids: Vec<String> = defs.iter().map(|d| d.id.to_string()).collect();
    let mut rng = Rng::new(seed);
    Ok(pick_many(&mut rng, &ids, count)
        .into_iter()
        .map(|id| {
            let def = defs.iter().find(|d| d.id == id.as_str()).unwrap();
            let params: BTreeMap<String, f64> = def.params.iter().map(|d| (d.id.to_string(), random_value(&mut rng, d))).collect();
            Command::AddEffect { clip: clip.id.clone(), effect: id.clone(), params, index: None }
        })
        .collect())
}

/// Result of [`transition_stack`]: commands that are known to apply, plus why other cuts were skipped.
pub struct TransitionPlan {
    pub commands: Vec<Command>,
    pub skipped: Vec<String>,
}

/// Random transitions on up to `count` consecutive cuts starting at the cut after `clip`. Each candidate is trial-applied to a
/// copy of the project, so cuts that cannot take a transition (no media handles, retimed clips, ...) are skipped with the reason
/// instead of failing the lot. `kinds` are the transition names to choose from (already filtered by what FFmpeg supports).
pub fn transition_stack(project: &Project, clip: &str, count: usize, seed: u64, kinds: &[String], duration: Rational) -> Result<TransitionPlan> {
    if count == 0 || count > 20 {
        return Err(Error::validation("stack 1 to 20 transitions"));
    }
    if kinds.is_empty() {
        return Err(Error::validation("none of the chosen transitions are available in this FFmpeg"));
    }
    let (track, cur) = project.active()?.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
    let (track_id, mut cur_id) = (track.id.clone(), cur.id.clone());
    let mut rng = Rng::new(seed);
    let mut work = project.clone();
    let mut plan = TransitionPlan { commands: vec![], skipped: vec![] };
    loop {
        if plan.commands.len() >= count {
            break;
        }
        let seq = work.active()?;
        let t = seq.tracks.iter().find(|t| t.id == track_id).ok_or_else(|| Error::NotFound("track".into()))?;
        let a = t.clips.iter().find(|c| c.id == cur_id).ok_or_else(|| Error::NotFound("clip".into()))?;
        let end = a.start + a.duration;
        let Some(b) = t.clips.iter().find(|c| c.start == end && c.id != a.id) else { break };
        let (a_id, b_id, b_name) = (a.id.clone(), b.id.clone(), b.name.clone());
        let kind = kinds[rng.below(kinds.len())].clone();
        let cmd = Command::AddTransition { clip_a: a_id.clone(), clip_b: b_id.clone(), kind, duration };
        let mut trial = work.clone();
        let outcome = crate::commands::plan(&trial, &cmd).and_then(|patches| {
            for p in &patches {
                apply(&mut trial, p)?;
            }
            trial.validate()
        });
        match outcome {
            Ok(()) => {
                work = trial;
                plan.commands.push(cmd);
            }
            Err(e) => plan.skipped.push(format!("cut before “{b_name}”: {e}")),
        }
        cur_id = b_id;
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_sequence_different_seed_differs() {
        let (mut a, mut b, mut c) = (Rng::new(7), Rng::new(7), Rng::new(8));
        let sa: Vec<u64> = (0..5).map(|_| a.next_u64()).collect();
        assert_eq!(sa, (0..5).map(|_| b.next_u64()).collect::<Vec<_>>());
        assert_ne!(sa, (0..5).map(|_| c.next_u64()).collect::<Vec<_>>());
        let mut r = Rng::new(1);
        assert!((0..1000).map(|_| r.unit()).all(|u| (0.0..1.0).contains(&u)));
    }

    #[test]
    fn pick_many_does_not_repeat_until_exhausted() {
        let pool: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        let mut r = Rng::new(3);
        let mut got: Vec<&String> = pick_many(&mut r, &pool, 3);
        got.sort();
        assert_eq!(got, vec!["a", "b", "c"]);
        assert_eq!(pick_many(&mut r, &pool, 7).len(), 7);
    }

    #[test]
    fn random_values_stay_inside_every_parameter_range() {
        let mut r = Rng::new(99);
        for def in effects::registry() {
            for p in &def.params {
                for _ in 0..200 {
                    let v = random_value(&mut r, p);
                    assert!(v >= p.min && v <= p.max, "{} {} = {v}", def.id, p.id);
                }
            }
        }
    }
}
