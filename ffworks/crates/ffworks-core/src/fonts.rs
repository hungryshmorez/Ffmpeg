//! Fonts for titles. Two fonts ship inside the binary (DejaVu Sans, regular and bold; free licence in `assets/fonts`) and are
//! written to a temp directory on first use so FFmpeg's `drawtext` gets a plain file path; installed fonts are discovered by
//! scanning the OS font folders. A title stores the *name*; rendering resolves it to a file and refuses (with a message) if it
//! is not installed on this computer, rather than silently substituting another font.

use crate::error::{Error, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

const REGULAR: &[u8] = include_bytes!("../assets/fonts/DejaVuSans.ttf");
const BOLD: &[u8] = include_bytes!("../assets/fonts/DejaVuSans-Bold.ttf");

pub const DEFAULT_FONT: &str = "DejaVu Sans";
pub const DEFAULT_FONT_BOLD: &str = "DejaVu Sans Bold";

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct FontEntry {
    pub name: String,
    pub path: PathBuf,
    pub bundled: bool,
}

/// Write the bundled fonts (once per content hash) and return their paths.
fn bundled() -> Result<Vec<FontEntry>> {
    let dir = std::env::temp_dir().join(format!("ffworks-fonts-{:x}", REGULAR.len() ^ (BOLD.len() << 7)));
    std::fs::create_dir_all(&dir).map_err(|e| Error::io(&dir, e))?;
    let mut out = vec![];
    for (name, file, bytes) in [(DEFAULT_FONT, "DejaVuSans.ttf", REGULAR), (DEFAULT_FONT_BOLD, "DejaVuSans-Bold.ttf", BOLD)] {
        let p = dir.join(file);
        if std::fs::metadata(&p).map(|m| m.len() as usize).ok() != Some(bytes.len()) {
            let tmp = dir.join(format!("{file}.{}.tmp", std::process::id()));
            std::fs::write(&tmp, bytes).map_err(|e| Error::io(&tmp, e))?;
            std::fs::rename(&tmp, &p).map_err(|e| Error::io(&p, e))?;
        }
        out.push(FontEntry { name: name.into(), path: p, bundled: true });
    }
    Ok(out)
}

fn system_dirs() -> Vec<PathBuf> {
    let mut v = vec![];
    if cfg!(windows) {
        if let Some(w) = std::env::var_os("WINDIR") {
            v.push(PathBuf::from(w).join("Fonts"));
        }
        if let Some(l) = std::env::var_os("LOCALAPPDATA") {
            v.push(PathBuf::from(l).join("Microsoft/Windows/Fonts"));
        }
    } else if cfg!(target_os = "macos") {
        v.extend(["/Library/Fonts", "/System/Library/Fonts"].map(PathBuf::from));
    } else {
        v.extend(["/usr/share/fonts", "/usr/local/share/fonts"].map(PathBuf::from));
    }
    v
}

fn scan(dir: &Path, depth: u32, budget: &mut usize, out: &mut Vec<FontEntry>) {
    if depth > 3 || *budget == 0 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            scan(&p, depth + 1, budget, out);
        } else if p.extension().is_some_and(|x| ["ttf", "otf"].contains(&x.to_string_lossy().to_lowercase().as_str())) {
            *budget = budget.saturating_sub(1);
            if let Some(stem) = p.file_stem() {
                out.push(FontEntry { name: stem.to_string_lossy().into_owned(), path: p, bundled: false });
            }
        }
    }
}

/// Bundled fonts first, then installed fonts (name = file name without extension), sorted and de-duplicated by name.
pub fn list() -> Vec<FontEntry> {
    let mut out = bundled().unwrap_or_default();
    let mut sys = vec![];
    let mut budget = 5000;
    for d in system_dirs() {
        scan(&d, 0, &mut budget, &mut sys);
    }
    sys.sort_by_key(|f| f.name.to_lowercase());
    for f in sys {
        if !out.iter().any(|o| o.name.eq_ignore_ascii_case(&f.name)) {
            out.push(f);
        }
    }
    out
}

/// The file for font `name`, or an error naming the font so the user can pick another.
pub fn resolve(name: &str) -> Result<PathBuf> {
    let all = list();
    all.into_iter()
        .find(|f| f.name.eq_ignore_ascii_case(name))
        .map(|f| f.path)
        .ok_or_else(|| Error::validation(format!("the font '{name}' is not installed on this computer; choose another font for this title")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_fonts_are_written_and_resolvable() {
        let p = resolve(DEFAULT_FONT).unwrap();
        assert!(p.exists() && std::fs::metadata(&p).unwrap().len() > 100_000);
        assert!(resolve(DEFAULT_FONT_BOLD).unwrap().exists());
        assert!(resolve("dejavu sans").is_ok(), "names are case-insensitive");
        assert!(resolve("No Such Font 123").unwrap_err().to_string().contains("not installed"));
        let l = list();
        assert!(l[0].bundled && l[1].bundled);
    }
}
