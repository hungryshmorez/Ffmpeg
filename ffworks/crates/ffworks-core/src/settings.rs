//! Persistent application settings (not part of any project). Resolution order for tools:
//! saved setting > `FFWORKS_FFMPEG`/`FFWORKS_FFPROBE` > `PATH`. Binaries are never downloaded (spec §95).

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
        let blank = |s: &Option<String>| s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(PathBuf::from);
        Tools::discover(blank(&self.ffmpeg_path).as_deref(), blank(&self.ffprobe_path).as_deref())
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
    fn rejects_non_ffmpeg_and_missing() {
        let t = Tools { ffmpeg: "definitely-not-here".into(), ffprobe: "definitely-not-here".into() };
        assert!(validate_tools(&t).is_err());
        // `ls --version` runs but is not FFmpeg
        let t = Tools { ffmpeg: "ls".into(), ffprobe: "ls".into() };
        assert!(validate_tools(&t).is_err());
    }
}
