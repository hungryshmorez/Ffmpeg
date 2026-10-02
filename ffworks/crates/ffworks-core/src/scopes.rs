//! Video scopes (waveform, vectorscope, histogram) of one source frame and an audio spectrogram of a whole file, drawn by
//! FFmpeg's own filters into a PNG in the cache folder.

use crate::error::{Error, Result};
use crate::process::{suppress_console_window, Tools};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Waveform,
    Vectorscope,
    Histogram,
    Spectrogram,
}

impl Scope {
    fn name(self) -> &'static str {
        match self {
            Scope::Waveform => "waveform",
            Scope::Vectorscope => "vectorscope",
            Scope::Histogram => "histogram",
            Scope::Spectrogram => "spectrogram",
        }
    }
}

/// Draw `scope` for `media` (at `time` seconds for the video scopes; the whole file for the spectrogram). Cached by key, time and scope.
pub fn render(tools: &Tools, media: &Path, time: f64, scope: Scope, cache_dir: &Path, key: &str) -> Result<PathBuf> {
    if !time.is_finite() || time < 0.0 {
        return Err(Error::validation("scope time must be zero or more"));
    }
    std::fs::create_dir_all(cache_dir).map_err(|e| Error::io(cache_dir, e))?;
    let t_ms = (time * 1000.0).round() as u64;
    let out = cache_dir.join(format!("{key}.{}.{}.png", scope.name(), if scope == Scope::Spectrogram { 0 } else { t_ms }));
    if out.exists() {
        return Ok(out);
    }
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-y"]);
    match scope {
        Scope::Spectrogram => {
            cmd.arg("-i").arg(media).args(["-lavfi", "[0:a:0]showspectrumpic=s=800x320:legend=0:color=intensity[v]", "-map", "[v]", "-frames:v", "1"]);
        }
        other => {
            let draw = match other {
                Scope::Waveform => "waveform=mode=column:intensity=0.08:display=overlay:components=7:graticule=0",
                Scope::Vectorscope => "vectorscope=mode=color3:intensity=0.05:graticule=0",
                _ => "histogram=display_mode=overlay:levels_mode=linear",
            };
            cmd.args(["-ss", &format!("{time:.3}"), "-i"]).arg(media).args(["-map", "0:v:0", "-frames:v", "1", "-vf", &format!("scale=640:-2,format=yuv444p,{draw},format=rgb24")]);
        }
    }
    let partial = out.with_extension("partial.png");
    cmd.arg(&partial).stdout(Stdio::null()).stderr(Stdio::piped()).stdin(Stdio::null());
    suppress_console_window(&mut cmd);
    let o = cmd.output().map_err(|e| Error::ToolUnavailable { tool: tools.ffmpeg.display().to_string(), reason: e.to_string() })?;
    if !o.status.success() || !partial.exists() {
        let _ = std::fs::remove_file(&partial);
        let msg = String::from_utf8_lossy(&o.stderr).lines().last().unwrap_or("").to_string();
        return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: o.status.code(), hint: format!("could not draw the {}: {msg}", scope.name()) });
    }
    std::fs::rename(&partial, &out).map_err(|e| Error::io(&out, e))?;
    Ok(out)
}
