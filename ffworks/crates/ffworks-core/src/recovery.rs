//! Autosave and crash recovery (spec §47, §101). The engine periodically writes the *unsaved* project to a
//! rotating set of autosave files (`current`, `.1`, `.2`). They are removed on explicit save, new/open, or when
//! the user knowingly discards. Any autosave present at startup therefore means abnormal termination.
//! The saved project file itself is never touched by autosave.

use crate::engine::Engine;
use crate::error::{Error, Result};
use crate::migrate::migrate;
use crate::process::Tools;
use crate::project::Project;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const KEEP: usize = 3;
const BASE: &str = "recovery.autosave.json";

#[derive(Serialize, Deserialize)]
struct Envelope {
    saved_unix: u64,
    original_path: Option<String>,
    project: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct RecoveryInfo {
    pub saved_unix: u64,
    pub original_path: Option<String>,
    pub name: String,
    pub clips: usize,
    pub file: PathBuf,
}

fn slot(dir: &Path, i: usize) -> PathBuf {
    if i == 0 { dir.join(BASE) } else { dir.join(format!("{BASE}.{i}")) }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Write an autosave, rotating older copies. Atomic: temp file + rename.
pub fn write(dir: &Path, project: &Project, original_path: Option<&Path>) -> Result<()> {
    std::fs::create_dir_all(dir).map_err(|e| Error::io(dir, e))?;
    for i in (0..KEEP - 1).rev() {
        let (from, to) = (slot(dir, i), slot(dir, i + 1));
        if from.exists() {
            let _ = std::fs::rename(&from, &to);
        }
    }
    let env = Envelope { saved_unix: now(), original_path: original_path.map(|p| p.to_string_lossy().into_owned()), project: serde_json::to_value(project)? };
    let tmp = dir.join(format!("{BASE}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec(&env)?).map_err(|e| Error::io(&tmp, e))?;
    let cur = slot(dir, 0);
    std::fs::rename(&tmp, &cur).map_err(|e| Error::io(&cur, e))
}

/// Remove all autosave files (after a save, new/open, or an explicit discard).
pub fn clear(dir: &Path) {
    for i in 0..KEEP {
        let _ = std::fs::remove_file(slot(dir, i));
    }
    let _ = std::fs::remove_file(dir.join(format!("{BASE}.tmp")));
}

fn read_slot(file: &Path) -> Result<(Envelope, Project)> {
    let text = std::fs::read_to_string(file).map_err(|e| Error::io(file, e))?;
    let env: Envelope = serde_json::from_str(&text)?;
    let project: Project = serde_json::from_value(migrate(env.project.clone())?)?;
    Ok((env, project))
}

/// Newest *valid* autosave. A truncated/corrupt latest file (crash mid-write) falls back to the previous rotation.
pub fn find(dir: &Path) -> Option<RecoveryInfo> {
    (0..KEEP).map(|i| slot(dir, i)).filter(|f| f.exists()).find_map(|file| {
        let (env, project) = read_slot(&file).ok()?;
        let clips = project.sequences.iter().flat_map(|s| &s.tracks).map(|t| t.clips.len()).sum();
        Some(RecoveryInfo { saved_unix: env.saved_unix, original_path: env.original_path, name: project.name, clips, file })
    })
}

/// Load a recovery into a fresh engine. It comes back *dirty* and bound to the original path, so the user must save explicitly.
pub fn load(info: &RecoveryInfo, tools: Tools) -> Result<Engine> {
    let (env, project) = read_slot(&info.file)?;
    project.validate()?;
    Ok(Engine::from_recovered(project, env.original_path.map(PathBuf::from), tools))
}
