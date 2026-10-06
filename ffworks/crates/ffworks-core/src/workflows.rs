//! Workflows from the browser app (FFmpeg Studio) that FFWORKS carries over as ready-made recipes. Each one is data (the original
//! name, description and filter chain), applied through the ordinary commands so it is undoable, saved and rendered like anything else.
//! `docs/WORKFLOW_PARITY.md` says which of the browser app's workflows are covered and how.

use std::sync::OnceLock;

const AUDIO: &str = include_str!("../assets/workflows/audio_workflows.tsv");

/// One audio workflow: an FFmpeg audio filter chain (`@SR@` = the project's sample rate) to put on an audio clip, and/or a clip speed.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct AudioWorkflow {
    pub id: &'static str,
    pub name: &'static str,
    /// The browser app's category (`audio`, `audio-mastering`, `audio-repair-utility`).
    pub category: &'static str,
    pub description: &'static str,
    /// New clip speed (1 = unchanged); the clip gets shorter or longer, its linked picture follows.
    pub speed: Option<f64>,
    /// May be empty when the workflow is only a speed change.
    pub chain: &'static str,
}

/// The browser app's audio workflows: mastering and lo-fi looks, tone and effects, pitch and speed, channel tricks (`scripts/workflows/build_audio.py`).
pub fn audio_workflows() -> &'static [AudioWorkflow] {
    static T: OnceLock<Vec<AudioWorkflow>> = OnceLock::new();
    T.get_or_init(|| {
        AUDIO
            .lines()
            .filter_map(|l| {
                let mut p = l.split('\t');
                let (id, name, category, description, speed, chain) = (p.next()?, p.next()?, p.next()?, p.next()?, p.next()?, p.next().unwrap_or(""));
                Some(AudioWorkflow { id, name, category, description, speed: speed.parse().ok(), chain })
            })
            .collect()
    })
}

pub fn audio_workflow(id: &str) -> Option<&'static AudioWorkflow> {
    audio_workflows().iter().find(|w| w.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_audio_workflow_is_a_valid_chain() {
        assert_eq!(audio_workflows().len(), 44);
        let mut ids: Vec<_> = audio_workflows().iter().map(|w| w.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 44, "unique ids");
        for w in audio_workflows() {
            assert!(!w.chain.is_empty() || w.speed.is_some(), "{} does nothing", w.id);
            if !w.chain.is_empty() {
                crate::effects::check_audio_chain(w.chain).unwrap_or_else(|e| panic!("{}: {e}", w.id));
            }
        }
    }
}
