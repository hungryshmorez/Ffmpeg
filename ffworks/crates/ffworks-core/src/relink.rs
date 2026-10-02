//! Media relinking (spec §41): find the new location of missing sources by content fingerprint, size and name.
//! Search is bounded (depth and file count) and only *reads* candidates.

use crate::engine::fingerprint;
use crate::project::MediaAsset;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Candidate {
    pub path: PathBuf,
    /// Content fingerprint equals the original's: safe to relink automatically (works even if the file was renamed).
    pub exact: bool,
    pub reason: String,
}

const MAX_DEPTH: usize = 8;
const MAX_FILES: usize = 100_000;

fn walk(dir: &Path, depth: usize, budget: &mut usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH || *budget == 0 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue; // avoid cycles
        }
        if ft.is_dir() {
            walk(&e.path(), depth + 1, budget, out);
        } else if ft.is_file() {
            if *budget == 0 {
                return;
            }
            *budget -= 1;
            out.push(e.path());
        }
    }
}

/// Candidates for each missing asset across `dirs`, best first. Exact (fingerprint) matches first, then same-name files
/// whose content differs (reported, never auto-applied).
pub fn find_candidates(missing: &[&MediaAsset], dirs: &[PathBuf]) -> Vec<(String, Vec<Candidate>)> {
    let mut files = vec![];
    let mut budget = MAX_FILES;
    for d in dirs {
        walk(d, 0, &mut budget, &mut files);
    }
    let sized: Vec<(PathBuf, u64)> = files.into_iter().filter_map(|p| std::fs::metadata(&p).ok().map(|m| (p, m.len()))).collect();
    missing
        .iter()
        .map(|a| {
            let want_size = a.info.size_bytes;
            let orig_name = Path::new(&a.path).file_name().map(|n| n.to_string_lossy().to_lowercase());
            let mut found: Vec<Candidate> = vec![];
            for (p, size) in &sized {
                let same_name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()) == orig_name;
                let same_size = want_size == Some(*size);
                // only hash plausible files: same size, and the original had a fingerprint
                if same_size {
                    if let (Some(fp), Ok(got)) = (&a.fingerprint, fingerprint(p)) {
                        if &got == fp {
                            found.push(Candidate { path: p.clone(), exact: true, reason: if same_name { "identical content".into() } else { "identical content (renamed)".into() } });
                            continue;
                        }
                    }
                }
                if same_name {
                    found.push(Candidate { path: p.clone(), exact: false, reason: if same_size { "same name and size, content differs".into() } else { "same name, different size".into() } });
                }
            }
            found.sort_by_key(|c| !c.exact);
            (a.id.clone(), found)
        })
        .collect()
}
