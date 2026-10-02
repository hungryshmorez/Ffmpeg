//! Free-space check before an export (spec cross-cutting): a render that runs out of disk half way wastes the user's time
//! and leaves a partial file, so the estimate is checked first and the shortfall is reported in plain numbers.

use crate::error::{Error, Result};
use std::path::Path;

/// Rough output size in bytes for `seconds` of `preset`. Deliberately generous (a refusal should mean "really too small").
pub fn estimate_bytes(preset: &str, seconds: f64) -> u64 {
    // megabytes per minute of 1080p-ish material
    let mb_per_min: f64 = match preset {
        "prores_mov" => 900.0,
        "dnxhr_mov" => 700.0,
        "ffv1_mkv" => 500.0,
        "png_sequence" => 800.0,
        "wav" => 11.0,
        "flac" => 6.0,
        "mp3" => 1.5,
        "gif" => 150.0,
        "quick_copy" => 120.0,
        _ => 60.0,
    };
    ((seconds.max(0.0) / 60.0) * mb_per_min * 1_048_576.0) as u64
}

/// Free bytes on the volume holding `path` (or its nearest existing parent).
pub fn free_bytes(path: &Path) -> Result<u64> {
    let mut p = path;
    while !p.exists() {
        match p.parent() {
            Some(q) if !q.as_os_str().is_empty() => p = q,
            _ => {
                p = Path::new(".");
                break;
            }
        }
    }
    fs4::available_space(p).map_err(|e| Error::io(p, e))
}

/// Refuse when the output volume has less than the estimate plus a 100 MB margin.
pub fn check(output: &Path, preset: &str, seconds: f64) -> Result<()> {
    check_with(free_bytes(output)?, estimate_bytes(preset, seconds), output)
}

fn check_with(free: u64, need: u64, output: &Path) -> Result<()> {
    const MARGIN: u64 = 100 * 1_048_576;
    if free < need + MARGIN {
        let mb = |b: u64| b / 1_048_576;
        return Err(Error::validation(format!("not enough disk space for {}: about {} MB needed (plus a margin), {} MB free. Choose another folder or free some space", output.display(), mb(need), mb(free))));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimates_scale_with_length_and_preset() {
        assert!(estimate_bytes("prores_mov", 60.0) > 10 * estimate_bytes("h264_mp4", 60.0) / 2);
        assert_eq!(estimate_bytes("h264_mp4", 0.0), 0);
        assert!(estimate_bytes("h264_mp4", 120.0) == 2 * estimate_bytes("h264_mp4", 60.0));
    }

    #[test]
    fn a_shortfall_is_reported_with_numbers_and_enough_space_passes() {
        let out = Path::new("/x/y.mp4");
        let e = check_with(50 * 1_048_576, 500 * 1_048_576, out).unwrap_err().to_string();
        assert!(e.contains("500 MB needed") && e.contains("50 MB free"), "{e}");
        assert!(check_with(10_000 * 1_048_576, 500 * 1_048_576, out).is_ok());
    }

    #[test]
    fn real_free_space_is_readable_for_a_folder_that_does_not_exist_yet() {
        let d = tempfile::tempdir().unwrap();
        assert!(free_bytes(&d.path().join("a/b/c/out.mp4")).unwrap() > 0);
        assert!(check(&d.path().join("o.mp4"), "mp3", 5.0).is_ok());
    }
}
