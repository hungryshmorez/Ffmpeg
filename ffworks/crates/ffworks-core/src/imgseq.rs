//! Image sequences (`shot_0001.png`, `shot_0002.png`, ...): detected from any one frame, imported as ONE media item whose
//! path is FFmpeg's numbered pattern (`shot_%04d.png`). Length = number of consecutive frames / chosen frame rate.

use crate::error::{Error, Result};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq)]
pub struct Sequence {
    /// Absolute pattern, e.g. `/footage/shot_%04d.png`.
    pub pattern: String,
    pub first: u64,
    pub count: u64,
}

/// True when `path` is a numbered pattern such as `shot_%04d.png`.
pub fn is_pattern(path: &str) -> bool {
    pattern_parts(path).is_some()
}

/// (prefix, digits, suffix) of a `%0Nd` pattern.
fn pattern_parts(path: &str) -> Option<(&str, usize, &str)> {
    let at = path.find("%0")?;
    let rest = &path[at + 2..];
    let d = rest.find('d')?;
    let digits: usize = rest[..d].parse().ok()?;
    (digits >= 1 && digits <= 9).then(|| (&path[..at], digits, &rest[d + 1..]))
}

fn frame_path(pattern: &str, n: u64) -> Option<PathBuf> {
    let (pre, digits, suf) = pattern_parts(pattern)?;
    Some(PathBuf::from(format!("{pre}{n:0digits$}{suf}")))
}

/// Path of the first existing frame of `pattern` (what "does the media exist" should look at), if any.
pub fn first_frame(pattern: &str) -> Option<PathBuf> {
    let first = first_index(pattern)?;
    frame_path(pattern, first)
}

/// Lowest frame number present for `pattern` (scans the folder), or None.
pub fn first_index(pattern: &str) -> Option<u64> {
    let (pre, digits, suf) = pattern_parts(pattern)?;
    let dir = Path::new(pre).parent()?;
    let stem = Path::new(pre).file_name()?.to_string_lossy().into_owned();
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let mid = name.strip_prefix(&stem)?.strip_suffix(suf)?;
            (mid.len() == digits && mid.bytes().all(|b| b.is_ascii_digit())).then(|| mid.parse::<u64>().ok()).flatten()
        })
        .min()
}

/// Detect the sequence `file` belongs to: its last run of digits becomes the frame number. Needs at least two consecutive frames.
pub fn detect(file: &Path) -> Result<Sequence> {
    let abs = std::fs::canonicalize(file).map_err(|e| Error::io(file, e))?;
    let name = abs.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let (stem, ext) = name.rsplit_once('.').ok_or_else(|| Error::validation("an image sequence frame needs a file extension"))?;
    let end = stem.len();
    let start = stem.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    if start == end {
        return Err(Error::validation(format!("'{name}' has no frame number at the end of its name (expected shot_0001.png)")));
    }
    let digits = end - start;
    if digits > 9 {
        return Err(Error::validation("frame numbers longer than 9 digits are not supported"));
    }
    let dir = abs.parent().ok_or_else(|| Error::validation("no folder"))?;
    let pattern = format!("{}{}%0{digits}d.{ext}", dir.join("").to_string_lossy(), &stem[..start]);
    let first = first_index(&pattern).ok_or_else(|| Error::validation("no frames found"))?;
    let mut count = 0;
    while frame_path(&pattern, first + count).is_some_and(|p| p.exists()) {
        count += 1;
    }
    if count < 2 {
        return Err(Error::validation(format!("only {count} frame matches {name}'s numbering; a sequence needs at least 2 consecutive frames")));
    }
    Ok(Sequence { pattern, first, count })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pattern_recognition() {
        assert!(is_pattern("/a/shot_%04d.png") && is_pattern("x%01d.jpg"));
        assert!(!is_pattern("/a/shot_0001.png") && !is_pattern("/a/%d.png") && !is_pattern("/a/%0xd.png"));
    }

    #[test]
    fn detects_the_run_from_any_frame_and_counts_only_consecutive_frames() {
        let dir = tempfile::tempdir().unwrap();
        for n in [7u32, 8, 9, 10, 12] {
            std::fs::write(dir.path().join(format!("fx_{n:03}.png")), b"x").unwrap();
        }
        std::fs::write(dir.path().join("other_001.png"), b"x").unwrap();
        let s = detect(&dir.path().join("fx_009.png")).unwrap();
        assert_eq!((s.first, s.count), (7, 4), "frame 12 is after a gap");
        assert!(s.pattern.ends_with("fx_%03d.png"));
        assert_eq!(first_frame(&s.pattern).unwrap().file_name().unwrap(), "fx_007.png");
        assert!(detect(&dir.path().join("other_001.png")).is_err(), "single frame");
        std::fs::write(dir.path().join("plain.png"), b"x").unwrap();
        assert!(detect(&dir.path().join("plain.png")).is_err(), "no number");
    }
}
