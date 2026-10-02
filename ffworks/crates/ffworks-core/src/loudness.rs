//! Loudness analysis (spec §165) using the `ebur128` crate (MIT; Rust port of libebur128, EBU R128 / ITU-R BS.1770):
//! integrated loudness, loudness range and true peak.

use crate::error::{Error, Result};
use crate::process::{suppress_console_window, Tools};
use ebur128::{EbuR128, Mode};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

const SR: u32 = 48_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Loudness {
    /// Integrated loudness in LUFS (None for silence).
    pub integrated_lufs: Option<f64>,
    /// Loudness range in LU.
    pub range_lu: f64,
    /// Highest true peak across channels, dBTP (None for silence).
    pub true_peak_dbtp: Option<f64>,
}

fn finite(v: f64) -> Option<f64> {
    v.is_finite().then_some(v)
}

/// Measure interleaved stereo f32 samples at 48 kHz.
pub fn measure_samples(samples: &[f32]) -> Result<Loudness> {
    let mut m = EbuR128::new(2, SR, Mode::I | Mode::LRA | Mode::TRUE_PEAK).map_err(|e| Error::validation(format!("loudness meter: {e}")))?;
    m.add_frames_f32(samples).map_err(|e| Error::validation(format!("loudness meter: {e}")))?;
    let peak = (0..2).filter_map(|c| m.true_peak(c).ok()).fold(0.0f64, f64::max);
    Ok(Loudness {
        integrated_lufs: m.loudness_global().ok().and_then(finite),
        range_lu: m.loudness_range().ok().and_then(finite).unwrap_or(0.0),
        true_peak_dbtp: (peak > 0.0).then(|| 20.0 * peak.log10()),
    })
}

/// Decode `media`'s first audio stream (stereo, 48 kHz) through FFmpeg and measure it. Cached per key.
pub fn analyze(tools: &Tools, media: &Path, cache_dir: &Path, key: &str) -> Result<Loudness> {
    std::fs::create_dir_all(cache_dir).map_err(|e| Error::io(cache_dir, e))?;
    let cache_file = cache_dir.join(format!("{key}.loudness.json"));
    if let Some(l) = std::fs::read_to_string(&cache_file).ok().and_then(|t| serde_json::from_str::<Loudness>(&t).ok()) {
        return Ok(l);
    }
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-i"]).arg(media).args(["-map", "0:a:0", "-ac", "2", "-ar", &SR.to_string(), "-f", "f32le", "-"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null());
    suppress_console_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| Error::ToolUnavailable { tool: tools.ffmpeg.display().to_string(), reason: e.to_string() })?;
    let mut bytes = vec![];
    child.stdout.take().expect("piped").read_to_end(&mut bytes).map_err(|e| Error::io(media, e))?;
    let status = child.wait().map_err(|e| Error::io(media, e))?;
    if !status.success() {
        return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: status.code(), hint: "audio decode failed (does the file have an audio stream?)".into() });
    }
    let samples: Vec<f32> = bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let l = measure_samples(&samples)?;
    let _ = std::fs::write(&cache_file, serde_json::to_vec(&l)?);
    Ok(l)
}

/// Gain (dB) that would bring `measured` to `target_lufs`; None when silent.
pub fn gain_to_target(measured: &Loudness, target_lufs: f64) -> Option<f64> {
    measured.integrated_lufs.map(|l| target_lufs - l)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(amp: f32, secs: usize) -> Vec<f32> {
        (0..SR as usize * secs).flat_map(|i| { let v = amp * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / SR as f32).sin(); [v, v] }).collect()
    }

    #[test]
    fn full_scale_stereo_sine_matches_the_reference_value() {
        // ITU-R BS.1770 reference: a 0 dBFS 1 kHz sine on both channels measures 0.0 LUFS (a single channel: -3.01 LUFS).
        let l = measure_samples(&sine(1.0, 5)).unwrap();
        let lufs = l.integrated_lufs.unwrap();
        assert!(lufs.abs() < 0.1, "{lufs}");
        assert!(l.true_peak_dbtp.unwrap().abs() < 0.3);
    }

    #[test]
    fn halving_the_amplitude_lowers_loudness_by_six_db() {
        let a = measure_samples(&sine(1.0, 5)).unwrap().integrated_lufs.unwrap();
        let b = measure_samples(&sine(0.5, 5)).unwrap().integrated_lufs.unwrap();
        assert!((a - b - 6.02).abs() < 0.1, "{a} {b}");
    }

    #[test]
    fn silence_has_no_loudness_and_gain_is_none() {
        let l = measure_samples(&vec![0.0; SR as usize * 4]).unwrap();
        assert_eq!(l.integrated_lufs, None);
        assert_eq!(gain_to_target(&l, -14.0), None);
    }

    #[test]
    fn gain_to_target_is_the_difference() {
        let l = Loudness { integrated_lufs: Some(-20.0), range_lu: 3.0, true_peak_dbtp: Some(-3.0) };
        assert_eq!(gain_to_target(&l, -14.0), Some(6.0));
    }
}
