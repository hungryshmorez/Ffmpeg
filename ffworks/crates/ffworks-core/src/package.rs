//! Project packaging: copy a project and every media file it uses into one folder so it can be moved to another machine
//! or archived. The live project is never changed; the packaged copy points at the copies inside the folder.

use crate::error::{Error, Result};
use crate::project::Project;
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq)]
pub struct Packaged {
    pub project_file: PathBuf,
    pub files_copied: usize,
    pub bytes: u64,
}

fn unique_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = name.rsplit_once('.').map(|(a, b)| (a.to_string(), format!(".{b}"))).unwrap_or((name.to_string(), String::new()));
    (2..).map(|n| format!("{stem}_{n}{ext}")).find(|c| !dir.join(c).exists()).expect("endless range")
}

/// Write `<dir>/<name>.ffworks` and `<dir>/media/*` for `project`. Missing media is an error naming the files (nothing is half-copied
/// silently): the caller can relink first.
pub fn package(project: &Project, dir: &Path, project_file_name: &str) -> Result<Packaged> {
    let mut copy = project.clone();
    let media_dir = dir.join("media");
    std::fs::create_dir_all(&media_dir).map_err(|e| Error::io(&media_dir, e))?;
    let missing: Vec<String> = project.media.iter().filter(|m| !m.is_generated()).filter(|m| !media_present(&m.path)).map(|m| m.name.clone()).collect();
    if !missing.is_empty() {
        return Err(Error::validation(format!("cannot package: these media files are missing (relink them first): {}", missing.join(", "))));
    }
    let lut_files = || project.sequences.iter().flat_map(|q| q.tracks.iter()).flat_map(|t| t.clips.iter()).flat_map(|c| c.effects.iter()).filter_map(|e| e.file.clone());
    let missing_luts: Vec<String> = lut_files().filter(|f| !Path::new(f).is_file()).collect();
    if !missing_luts.is_empty() {
        return Err(Error::validation(format!("cannot package: these lookup table files are missing: {}", missing_luts.join(", "))));
    }
    let (mut files, mut bytes) = (0usize, 0u64);
    for m in copy.media.iter_mut().filter(|m| !m.is_generated()) {
        if crate::imgseq::is_pattern(&m.path) {
            // a numbered sequence goes into its own sub-folder, all frames
            let sub = media_dir.join(unique_name(&media_dir, &m.id));
            std::fs::create_dir_all(&sub).map_err(|e| Error::io(&sub, e))?;
            let pat = Path::new(&m.path);
            let src_dir = pat.parent().unwrap_or(Path::new("."));
            let stem_pat = pat.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let pre: String = stem_pat.split("%0").next().unwrap_or("").to_string();
            let suf: String = stem_pat.rsplit('d').next().unwrap_or("").to_string();
            for e in std::fs::read_dir(src_dir).map_err(|e| Error::io(src_dir, e))?.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if let Some(mid) = n.strip_prefix(&pre).and_then(|r| r.strip_suffix(&suf)) {
                    if !mid.is_empty() && mid.bytes().all(|b| b.is_ascii_digit()) {
                        let to = sub.join(&n);
                        bytes += std::fs::copy(e.path(), &to).map_err(|er| Error::io(&to, er))?;
                        files += 1;
                    }
                }
            }
            m.path = sub.join(&stem_pat).to_string_lossy().into_owned();
        } else {
            let from = PathBuf::from(&m.path);
            let name = unique_name(&media_dir, from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "media".into()).as_str());
            let to = media_dir.join(&name);
            bytes += std::fs::copy(&from, &to).map_err(|e| Error::io(&to, e))?;
            files += 1;
            m.path = to.to_string_lossy().into_owned();
        }
    }
    // lookup tables go beside the media, and the packaged project points at the copies
    let lut_dir = dir.join("luts");
    let mut copied: std::collections::HashMap<String, String> = Default::default();
    for fx in copy.sequences.iter_mut().flat_map(|q| q.tracks.iter_mut()).flat_map(|t| t.clips.iter_mut()).flat_map(|c| c.effects.iter_mut()) {
        let Some(from) = fx.file.clone() else { continue };
        if let Some(done) = copied.get(&from) {
            fx.file = Some(done.clone());
            continue;
        }
        std::fs::create_dir_all(&lut_dir).map_err(|e| Error::io(&lut_dir, e))?;
        let name = unique_name(&lut_dir, Path::new(&from).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "lut.cube".into()).as_str());
        let to = lut_dir.join(&name);
        bytes += std::fs::copy(&from, &to).map_err(|e| Error::io(&to, e))?;
        files += 1;
        let to = to.to_string_lossy().into_owned();
        copied.insert(from, to.clone());
        fx.file = Some(to);
    }
    let file = dir.join(format!("{project_file_name}.{}", crate::brand::PROJECT_EXTENSION));
    let json = serde_json::to_string_pretty(&copy)?;
    std::fs::write(&file, json).map_err(|e| Error::io(&file, e))?;
    Ok(Packaged { project_file: file, files_copied: files, bytes })
}

fn media_present(path: &str) -> bool {
    if crate::imgseq::is_pattern(path) {
        crate::imgseq::first_frame(path).is_some_and(|p| p.exists())
    } else {
        Path::new(path).exists()
    }
}
