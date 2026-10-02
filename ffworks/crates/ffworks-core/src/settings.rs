//! Persistent application settings (not part of any project). Resolution order for tools:
//! saved setting > `FFWORKS_FFMPEG`/`FFWORKS_FFPROBE` > bundled copy shipped with the installer > `PATH`.
//! Binaries are never downloaded at runtime (spec §95); the Windows installer bundles a pinned build fetched and checksum-verified in CI.

use crate::error::{Error, Result};
use crate::process::Tools;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    pub ffmpeg_path: Option<String>,
    pub ffprobe_path: Option<String>,
}

impl Settings {
    pub fn load(file: &Path) -> Settings {
        std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn save(&self, file: &Path) -> Result<()> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| Error::io(dir, e))?;
        }
        let tmp = file.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?).map_err(|e| Error::io(&tmp, e))?;
        std::fs::rename(&tmp, file).map_err(|e| Error::io(file, e))
    }

    pub fn tools(&self) -> Tools {
        self.tools_with_bundled(None)
    }

    /// Like [`tools`](Self::tools), but falls back to FFmpeg/FFprobe shipped inside `bundled_dir` (when present)
    /// before looking at `PATH`.
    pub fn tools_with_bundled(&self, bundled_dir: Option<&Path>) -> Tools {
        let exe = |n: &str| if cfg!(windows) { format!("{n}.exe") } else { n.to_string() };
        let bundled = |n: &str| bundled_dir.map(|d| d.join(exe(n))).filter(|p| p.is_file());
        let blank = |s: &Option<String>| s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(PathBuf::from);
        let pick = |setting: &Option<String>, env: &str, name: &str| -> PathBuf {
            blank(setting).or_else(|| std::env::var_os(env).map(PathBuf::from)).or_else(|| bundled(name)).unwrap_or_else(|| PathBuf::from(name))
        };
        Tools { ffmpeg: pick(&self.ffmpeg_path, "FFWORKS_FFMPEG", "ffmpeg"), ffprobe: pick(&self.ffprobe_path, "FFWORKS_FFPROBE", "ffprobe") }
    }
}

/// Run `-version` on both tools; returns their version lines or the first failure. Used before accepting new settings.
pub fn validate_tools(tools: &Tools) -> Result<(String, String)> {
    let first = |p: &Path, flag: &str| -> Result<String> {
        let out = tools.run_capture(p, &[flag], None)?;
        out.lines().next().map(str::to_string).filter(|l| !l.is_empty()).ok_or_else(|| Error::validation(format!("{} printed no version", p.display())))
    };
    let ff = first(&tools.ffmpeg, "-version")?;
    let pr = first(&tools.ffprobe, "-version")?;
    if !ff.to_lowercase().contains("ffmpeg") {
        return Err(Error::validation(format!("{} does not look like FFmpeg ({ff})", tools.ffmpeg.display())));
    }
    if !pr.to_lowercase().contains("ffprobe") {
        return Err(Error::validation(format!("{} does not look like FFprobe ({pr})", tools.ffprobe.display())));
    }
    Ok((ff, pr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_blank_means_unset() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("s/settings.json");
        assert_eq!(Settings::load(&f), Settings::default());
        let s = Settings { ffmpeg_path: Some("  ".into()), ffprobe_path: Some("/x/ffprobe".into()) };
        s.save(&f).unwrap();
        assert_eq!(Settings::load(&f), s);
        let t = s.tools();
        assert_eq!(t.ffprobe, PathBuf::from("/x/ffprobe"));
        assert_ne!(t.ffmpeg, PathBuf::from("  "));
    }

    #[test]
    fn bundled_copy_is_used_after_settings_and_env_but_before_path() {
        let d = tempfile::tempdir().unwrap();
        let name = |n: &str| if cfg!(windows) { format!("{n}.exe") } else { n.to_string() };
        std::fs::write(d.path().join(name("ffmpeg")), b"x").unwrap();
        std::fs::write(d.path().join(name("ffprobe")), b"x").unwrap();
        // SAFETY of env use in tests: these variables are only read by this crate's discovery code.
        if std::env::var_os("FFWORKS_FFMPEG").is_none() && std::env::var_os("FFWORKS_FFPROBE").is_none() {
            let t = Settings::default().tools_with_bundled(Some(d.path()));
            assert_eq!(t.ffmpeg, d.path().join(name("ffmpeg")));
            assert_eq!(t.ffprobe, d.path().join(name("ffprobe")));
            // an explicit saved path beats the bundled copy
            let t = Settings { ffmpeg_path: Some("/custom/ffmpeg".into()), ffprobe_path: None }.tools_with_bundled(Some(d.path()));
            assert_eq!(t.ffmpeg, PathBuf::from("/custom/ffmpeg"));
            assert_eq!(t.ffprobe, d.path().join(name("ffprobe")));
            // nothing bundled -> plain PATH names
            let empty = tempfile::tempdir().unwrap();
            assert_eq!(Settings::default().tools_with_bundled(Some(empty.path())).ffmpeg, PathBuf::from("ffmpeg"));
        }
    }

    #[test]
    fn rejects_non_ffmpeg_and_missing() {
        let t = Tools { ffmpeg: "definitely-not-here".into(), ffprobe: "definitely-not-here".into() };
        assert!(validate_tools(&t).is_err());
        // `ls --version` runs but is not FFmpeg
        let t = Tools { ffmpeg: "ls".into(), ffprobe: "ls".into() };
        assert!(validate_tools(&t).is_err());
    }
}
