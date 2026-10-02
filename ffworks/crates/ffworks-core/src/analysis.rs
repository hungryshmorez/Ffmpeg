//! Background media analysis: thumbnails and waveform peaks, cached by source fingerprint (spec §11, §121).

use crate::error::{Error, Result};
use crate::process::{suppress_console_window, Tools};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Waveform {
    /// Peaks per second of media.
    pub bins_per_sec: u32,
    /// Normalised 0..1 peak amplitude per bin.
    pub peaks: Vec<f32>,
}

pub const WAVEFORM_BINS_PER_SEC: u32 = 100;

/// Decode audio to mono 8 kHz s16le through FFmpeg's stdout and reduce to peak bins.
pub fn waveform(tools: &Tools, media: &Path, cache_dir: &Path, key: &str) -> Result<Waveform> {
    std::fs::create_dir_all(cache_dir).map_err(|e| Error::io(cache_dir, e))?;
    let cache_file = cache_dir.join(format!("{key}.waveform.json"));
    if let Ok(text) = std::fs::read_to_string(&cache_file) {
        if let Ok(w) = serde_json::from_str::<Waveform>(&text) {
            return Ok(w);
        }
    }
    const RATE: u32 = 8000;
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-i"]).arg(media).args(["-map", "0:a:0", "-ac", "1", "-ar", &RATE.to_string(), "-f", "s16le", "-"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null());
    suppress_console_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| Error::ToolUnavailable { tool: tools.ffmpeg.display().to_string(), reason: e.to_string() })?;
    let mut out = child.stdout.take().expect("piped");
    let per_bin = (RATE / WAVEFORM_BINS_PER_SEC) as usize;
    let mut peaks = vec![];
    let (mut cur, mut count) = (0i32, 0usize);
    let mut buf = vec![0u8; 64 * 1024];
    let mut carry: Option<u8> = None;
    loop {
        let n = out.read(&mut buf).map_err(|e| Error::io(media, e))?;
        if n == 0 {
            break;
        }
        let mut bytes: Vec<u8> = Vec::with_capacity(n + 1);
        if let Some(c) = carry.take() {
            bytes.push(c);
        }
        bytes.extend_from_slice(&buf[..n]);
        let even = bytes.len() & !1;
        if bytes.len() != even {
            carry = Some(bytes[even]);
        }
        for pair in bytes[..even].chunks_exact(2) {
            let s = i16::from_le_bytes([pair[0], pair[1]]) as i32;
            cur = cur.max(s.abs());
            count += 1;
            if count == per_bin {
                peaks.push(cur as f32 / 32768.0);
                cur = 0;
                count = 0;
            }
        }
    }
    if count > 0 {
        peaks.push(cur as f32 / 32768.0);
    }
    let status = child.wait().map_err(|e| Error::io(media, e))?;
    if !status.success() {
        return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: status.code(), hint: "audio decode failed while building the waveform".into() });
    }
    let w = Waveform { bins_per_sec: WAVEFORM_BINS_PER_SEC, peaks };
    let _ = std::fs::write(&cache_file, serde_json::to_string(&w)?);
    Ok(w)
}

/// Filmstrip: one JPEG every `interval_secs`, scaled to `height` px tall. Returns file paths in time order.
pub fn thumbnails(tools: &Tools, media: &Path, cache_dir: &Path, key: &str, interval_secs: u32, height: u32) -> Result<Vec<PathBuf>> {
    let dir = cache_dir.join(format!("{key}.thumbs_{interval_secs}s_{height}"));
    let existing = |d: &Path| -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = std::fs::read_dir(d).map(|r| r.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "jpg")).collect()).unwrap_or_default();
        v.sort();
        v
    };
    let have = existing(&dir);
    if !have.is_empty() {
        return Ok(have);
    }
    std::fs::create_dir_all(&dir).map_err(|e| Error::io(&dir, e))?;
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-y", "-i"]).arg(media).args(["-an", "-vf", &format!("fps=1/{interval_secs},scale=-2:{height}"), "-q:v", "5"]).arg(dir.join("t%05d.jpg"));
    cmd.stdout(Stdio::null()).stderr(Stdio::piped()).stdin(Stdio::null());
    suppress_console_window(&mut cmd);
    let out = cmd.output().map_err(|e| Error::ToolUnavailable { tool: tools.ffmpeg.display().to_string(), reason: e.to_string() })?;
    if !out.status.success() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: out.status.code(), hint: crate::process::explain_failure(&String::from_utf8_lossy(&out.stderr)) });
    }
    let mut frames = existing(&dir);
    if frames.is_empty() {
        // Clips shorter than one interval produce no frame with fps=1/N; grab the first frame instead.
        let mut cmd = Command::new(&tools.ffmpeg);
        cmd.args(["-v", "error", "-nostdin", "-y", "-i"]).arg(media).args(["-an", "-frames:v", "1", "-vf", &format!("scale=-2:{height}"), "-q:v", "5"]).arg(dir.join("t00001.jpg"));
        cmd.stdout(Stdio::null()).stderr(Stdio::null()).stdin(Stdio::null());
        suppress_console_window(&mut cmd);
        let _ = cmd.status();
        frames = existing(&dir);
    }
    Ok(frames)
}
