//! Workflows from the browser app (FFmpeg Studio) that FFWORKS carries over as ready-made recipes. Each one is data (the original
//! name, description and filter chain), applied through the ordinary commands so it is undoable, saved and rendered like anything else.
//! `docs/WORKFLOW_PARITY.md` says which of the browser app's workflows are covered and how.

use std::sync::OnceLock;

const AUDIO_MASTERING: &str = include_str!("../assets/workflows/audio_mastering.tsv");

/// One audio workflow: an FFmpeg audio filter chain (`@SR@` = the project's sample rate) to put on an audio clip.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct AudioWorkflow {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub chain: &'static str,
}

/// The browser app's "audio mastering" workflows (mastering, lo-fi, slowed/reverb "slushwave" and similar looks).
pub fn audio_workflows() -> &'static [AudioWorkflow] {
    static T: OnceLock<Vec<AudioWorkflow>> = OnceLock::new();
    T.get_or_init(|| {
        AUDIO_MASTERING
            .lines()
            .filter_map(|l| {
                let mut p = l.split('\t');
                Some(AudioWorkflow { id: p.next()?, name: p.next()?, description: p.next()?, chain: p.next()? })
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
        assert_eq!(audio_workflows().len(), 19);
        let mut ids: Vec<_> = audio_workflows().iter().map(|w| w.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 19, "unique ids");
        for w in audio_workflows() {
            crate::effects::check_audio_chain(w.chain).unwrap_or_else(|e| panic!("{}: {e}", w.id));
        }
    }
}
