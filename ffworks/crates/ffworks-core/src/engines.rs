//! Registered FFmpeg builds ("engines"). Windows users often install several (gyan full / essentials, BtbN GPL / LGPL,
//! a build with NVENC...), and features differ between them, so FFWORKS can know about all of them, show what each one
//! really supports, pick the active one, and let a single export use another.

use crate::process::{Capabilities, Tools};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct EngineEntry {
    pub id: String,
    pub name: String,
    pub ffmpeg_path: String,
    /// Defaults to `ffprobe` next to the ffmpeg binary.
    #[serde(default)]
    pub ffprobe_path: Option<String>,
}

impl EngineEntry {
    pub fn tools(&self) -> Tools {
        let ffmpeg = PathBuf::from(&self.ffmpeg_path);
        let ffprobe = self.ffprobe_path.as_deref().filter(|p| !p.trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| sibling_ffprobe(&ffmpeg));
        Tools { ffmpeg, ffprobe }
    }
}

/// `ffprobe` (or `ffprobe.exe`) in the same folder as `ffmpeg`.
pub fn sibling_ffprobe(ffmpeg: &Path) -> PathBuf {
    let name = if ffmpeg.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) { "ffprobe.exe" } else { "ffprobe" };
    ffmpeg.with_file_name(name)
}

/// What an engine actually is and can do, read by running it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct EngineInfo {
    pub id: String,
    pub name: String,
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub ok: bool,
    pub error: Option<String>,
    pub version: String,
    /// `GPL`, `LGPL` or `nonfree` from the build configuration.
    pub license: String,
    pub filters: usize,
    pub encoders: usize,
    pub xfade_custom: bool,
    pub hwaccels: Vec<String>,
    /// Notable encoders present: libx264, libx265, libvpx-vp9, libsvtav1, h264_nvenc, hevc_nvenc, h264_qsv, h264_amf ...
    pub notable: Vec<String>,
}

const NOTABLE: &[&str] = &["libx264", "libx265", "libvpx-vp9", "libsvtav1", "libaom-av1", "h264_nvenc", "hevc_nvenc", "av1_nvenc", "h264_qsv", "h264_amf", "prores_ks", "libfdk_aac"];

pub fn license_from_config(version_output: &str) -> &'static str {
    if version_output.contains("--enable-nonfree") {
        "nonfree"
    } else if version_output.contains("--enable-gpl") {
        "GPL"
    } else {
        "LGPL"
    }
}

/// Run the engine's ffmpeg/ffprobe and describe it. Never panics: a broken entry comes back with `ok: false` and the reason.
pub fn probe_engine(e: &EngineEntry) -> EngineInfo {
    let tools = e.tools();
    let mut info = EngineInfo {
        id: e.id.clone(),
        name: e.name.clone(),
        ffmpeg_path: tools.ffmpeg.display().to_string(),
        ffprobe_path: tools.ffprobe.display().to_string(),
        ok: false,
        error: None,
        version: String::new(),
        license: String::new(),
        filters: 0,
        encoders: 0,
        xfade_custom: false,
        hwaccels: vec![],
        notable: vec![],
    };
    if let Err(err) = crate::settings::validate_tools(&tools) {
        info.error = Some(err.to_string());
        return info;
    }
    match tools.run_capture(&tools.ffmpeg, &["-hide_banner", "-version"], None) {
        Ok(v) => info.license = license_from_config(&v).to_string(),
        Err(err) => {
            info.error = Some(err.to_string());
            return info;
        }
    }
    match Capabilities::discover(&tools) {
        Ok(c) => {
            info.ok = true;
            info.version = c.version.clone();
            info.filters = c.filters.len();
            info.encoders = c.encoders.len();
            info.xfade_custom = c.xfade_custom;
            info.notable = NOTABLE.iter().filter(|n| c.has_encoder(n)).map(|n| n.to_string()).collect();
            info.hwaccels = c.hwaccels;
        }
        Err(err) => info.error = Some(err.to_string()),
    }
    info
}

/// An ffmpeg found by [`scan`], with the ffprobe beside it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Found {
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    /// Folder-based suggestion for a name (the folder above `bin`, or the folder itself).
    pub suggested_name: String,
}

/// Look for `ffmpeg`/`ffmpeg.exe` with an `ffprobe` beside it under `root` (at most `max_depth` folders deep, at most
/// 20 000 entries looked at, links not followed). Lets the user point at the folder holding all their installs.
pub fn scan(root: &Path, max_depth: usize) -> Vec<Found> {
    let mut found = vec![];
    let mut budget = 20_000usize;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            if budget == 0 {
                return found;
            }
            budget -= 1;
            let Ok(ft) = entry.file_type() else { continue };
            let path = entry.path();
            if ft.is_dir() {
                if depth < max_depth {
                    stack.push((path, depth + 1));
                }
            } else if ft.is_file() || ft.is_symlink() {
                let stem_ok = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n == "ffmpeg" || n.eq_ignore_ascii_case("ffmpeg.exe"));
                let probe = sibling_ffprobe(&path);
                if stem_ok && probe.is_file() {
                    let folder = path.parent().unwrap_or(&dir);
                    let named = if folder.file_name().is_some_and(|n| n.eq_ignore_ascii_case("bin")) { folder.parent() } else { Some(folder) };
                    let suggested_name = named.and_then(|p| p.file_name()).and_then(|n| n.to_str()).unwrap_or("ffmpeg").to_string();
                    found.push(Found { ffmpeg_path: path.display().to_string(), ffprobe_path: probe.display().to_string(), suggested_name });
                }
            }
        }
    }
    found.sort_by(|a, b| a.ffmpeg_path.cmp(&b.ffmpeg_path));
    found
}

/// A fresh id for a registered engine.
pub fn new_id() -> String {
    format!("eng-{:x}", crate::random::fresh_seed() & 0xffff_ffff)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn license_from_the_build_configuration() {
        assert_eq!(license_from_config("configuration: --enable-gpl --enable-libx264"), "GPL");
        assert_eq!(license_from_config("configuration: --enable-gpl --enable-nonfree --enable-libfdk-aac"), "nonfree");
        assert_eq!(license_from_config("configuration: --disable-autodetect"), "LGPL");
    }

    #[test]
    fn ffprobe_is_looked_for_beside_ffmpeg() {
        assert_eq!(sibling_ffprobe(Path::new("/x/bin/ffmpeg")), PathBuf::from("/x/bin/ffprobe"));
        assert_eq!(sibling_ffprobe(Path::new("C:/ff/bin/ffmpeg.exe")), PathBuf::from("C:/ff/bin/ffprobe.exe"));
        let e = EngineEntry { id: "a".into(), name: "A".into(), ffmpeg_path: "/x/ffmpeg".into(), ffprobe_path: Some(" ".into()) };
        assert_eq!(e.tools().ffprobe, PathBuf::from("/x/ffprobe"), "blank ffprobe path means the sibling");
    }
}
