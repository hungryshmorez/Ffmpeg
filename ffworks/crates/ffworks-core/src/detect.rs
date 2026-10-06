//! Silence, black-frame and frozen-frame detection (spec §35) using FFmpeg's own `silencedetect`, `blackdetect` and
//! `freezedetect` filters. Results are `(start, end)` ranges in seconds of the source media.

use crate::error::{Error, Result};
use crate::jobs::CancelToken;
use crate::process::{run_cancellable, Tools};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Silence,
    Black,
    Freeze,
    /// Sharp attacks in the sound (drum hits, claps, clicks). Reported as short ranges that start at the hit.
    Transients,
}

/// Length of the range reported for one transient hit, seconds.
pub const HIT_LEN: f64 = 0.05;

/// Run one detector over `media`. `threshold` is dB for silence (e.g. -35), picture-black ratio for black (0.1) and dB noise
/// for freeze (-60), and for transients the sensitivity factor (1 to 10; a hit weaker than (f - 1) / (f + 1) of the strongest one is
/// ignored, so lower finds more and softer hits); `min_len` is the shortest range reported, in seconds (for transients, the shortest gap between two hits).
pub fn detect(tools: &Tools, media: &Path, duration: f64, kind: Kind, threshold: f64, min_len: f64) -> Result<Vec<(f64, f64)>> {
    detect_with(tools, media, duration, kind, threshold, min_len, &CancelToken::new())
}

/// [`detect`] that stops (with [`Error::Canceled`]) when `cancel` is raised.
pub fn detect_with(tools: &Tools, media: &Path, duration: f64, kind: Kind, threshold: f64, min_len: f64, cancel: &CancelToken) -> Result<Vec<(f64, f64)>> {
    if !(min_len > 0.0 && min_len.is_finite()) {
        return Err(Error::validation("minimum length must be above zero"));
    }
    if kind == Kind::Transients {
        if !(1.0..=10.0).contains(&threshold) {
            return Err(Error::validation("transient sensitivity is a factor from 1 to 10"));
        }
        let samples = crate::beats::decode_mono(tools, media, cancel)?;
        return Ok(crate::beats::onsets_with(&samples, min_len, (((threshold - 1.0) / (threshold + 1.0)) as f32).max(0.05)).into_iter().map(|t| (t, (t + HIT_LEN).min(duration.max(t + HIT_LEN)))).collect());
    }
    let (maps, filter): (&[&str], String) = match kind {
        Kind::Silence => (&["-vn"], format!("silencedetect=noise={threshold}dB:d={min_len}")),
        Kind::Black => (&["-an"], format!("blackdetect=d={min_len}:pic_th=0.98:pix_th={threshold}")),
        Kind::Freeze => (&["-an"], format!("freezedetect=n={threshold}dB:d={min_len}")),
        Kind::Transients => unreachable!("handled above"),
    };
    let flag = if kind == Kind::Silence { "-af" } else { "-vf" };
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-i"]).arg(media).args(maps).args([flag, &filter, "-f", "null", "-"]);
    let out = run_cancellable(&mut cmd, cancel)?;
    let text = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        let hint = text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
        return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: out.status.code(), hint });
    }
    Ok(parse(&text, kind, duration))
}

fn number_after(line: &str, key: &str) -> Option<f64> {
    let rest = line.split(key).nth(1)?;
    let t: String = rest.trim_start().chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-' || *c == 'e').collect();
    t.parse().ok()
}

/// Turn FFmpeg's log into ranges. An open range at the end of the media is closed at `duration`.
pub fn parse(log: &str, kind: Kind, duration: f64) -> Vec<(f64, f64)> {
    let (start_key, end_key) = match kind {
        Kind::Silence => ("silence_start:", "silence_end:"),
        Kind::Black => ("black_start:", "black_end:"),
        Kind::Freeze => ("freeze_start:", "freeze_end:"),
        Kind::Transients => return vec![],
    };
    let mut out = vec![];
    let mut open: Option<f64> = None;
    for line in log.lines() {
        if let Some(s) = number_after(line, start_key) {
            open = Some(s.max(0.0));
        }
        if let Some(e) = number_after(line, end_key) {
            // blackdetect prints start and end on the same line
            let s = open.take().or_else(|| number_after(line, start_key)).unwrap_or(0.0);
            if e > s {
                out.push((s, e));
            }
        }
    }
    if let Some(s) = open {
        if duration > s {
            out.push((s, duration));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_silence_ranges_and_closes_an_open_one() {
        let log = "[silencedetect @ 0x1] silence_start: 1.5\n[silencedetect @ 0x1] silence_end: 3.25 | silence_duration: 1.75\n[silencedetect @ 0x1] silence_start: 8";
        assert_eq!(parse(log, Kind::Silence, 10.0), vec![(1.5, 3.25), (8.0, 10.0)]);
    }

    #[test]
    fn parses_black_and_freeze_lines() {
        let b = "[blackdetect @ 0x1] black_start:0 black_end:2.04 black_duration:2.04";
        assert_eq!(parse(b, Kind::Black, 5.0), vec![(0.0, 2.04)]);
        let f = "lavfi.freezedetect.freeze_start: 1\nlavfi.freezedetect.freeze_duration: 2\nlavfi.freezedetect.freeze_end: 3";
        assert_eq!(parse(f, Kind::Freeze, 5.0), vec![(1.0, 3.0)]);
    }
}
