//! `Engine` owns the open project, the undo/redo history and the tool configuration.
//! It has no GUI dependency, so the same engine drives the desktop app, tests and a future headless CLI (spec §154).

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

#[derive(Clone, Debug)]
struct Entry {
    label: String,
    forward: Vec<Patch>,
    /// Inverse patches in the order they must be applied to undo.
    inverse: Vec<Patch>,
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
}

impl Engine {
    pub fn new(name: &str, settings: ProjectSettings, tools: Tools) -> Engine {
        Engine { project: Project::new(name, settings), tools, path: None, undo: vec![], redo: vec![], saved_at: Some(0), recording: None }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
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
        if let Err(e) = self.project.validate() {
            self.rollback(&inv);
            return Err(e);
        }
        inv.reverse();
        self.undo.push(Entry { label: cmd.label(), forward: fwd, inverse: inv });
        self.redo.clear();
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

    /// `inv` is in application order; undo it newest-first.
    fn rollback(&mut self, inv: &[Patch]) {
        for p in inv.iter().rev() {
            // Inverse patches were produced from valid states, so failure here would be an engine bug.
            apply(&mut self.project, p).expect("rollback patch must apply");
        }
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
        for p in &e.inverse {
            apply(&mut self.project, p)?;
        }
        self.redo.push(e);
        Ok(())
    }

    pub fn redo(&mut self) -> Result<()> {
        let e = self.redo.pop().ok_or(Error::NothingTo("redo"))?;
        for p in &e.forward {
            apply(&mut self.project, p)?;
        }
        self.undo.push(e);
        Ok(())
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

    /// Media whose source file no longer exists (spec §41 relinking input).
    pub fn offline_media(&self) -> Vec<String> {
        self.project.media.iter().filter(|m| !Path::new(&m.path).exists()).map(|m| m.id.clone()).collect()
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
        Ok(Engine { project, tools, path: Some(path.to_path_buf()), undo: vec![], redo: vec![], saved_at: Some(0), recording: None })
    }
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
        info,
    })
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
