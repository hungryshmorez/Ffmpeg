//! Audio auto-sync: how much later one recording is than another, found by FFT cross-correlation of their first minutes
//! (`rustfft`, MIT/Apache-2.0). Used to line up a camera clip with separately recorded sound, or two cameras.

use crate::error::{Error, Result};
use crate::process::{suppress_console_window, Tools};
use rustfft::{num_complex::Complex, FftPlanner};
use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

const SR: u32 = 8000;
/// Longest stretch analysed per file; sync clap/slate sounds nearly always sit near the start.
const MAX_SECONDS: u32 = 120;

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
pub struct SyncResult {
    /// Seconds by which `other` is *later* than `reference` (the same sound appears this much further into `other`).
    pub lag_seconds: f64,
    /// 0..1: height of the correlation peak relative to the signal energy. Below ~0.1 the match is not trustworthy.
    pub confidence: f64,
}

/// Cross-correlate two mono signals at `rate` Hz. Positive lag: `b` is delayed relative to `a`.
pub fn correlate(a: &[f32], b: &[f32], rate: u32) -> Result<SyncResult> {
    if a.len() < rate as usize / 2 || b.len() < rate as usize / 2 {
        return Err(Error::validation("audio too short to synchronise (need at least half a second)"));
    }
    let n = (a.len() + b.len()).next_power_of_two();
    let mut planner = FftPlanner::<f32>::new();
    let fwd = planner.plan_fft_forward(n);
    let inv = planner.plan_fft_inverse(n);
    let prep = |x: &[f32]| -> Vec<Complex<f32>> {
        let mean = x.iter().sum::<f32>() / x.len() as f32;
        let mut v: Vec<Complex<f32>> = x.iter().map(|s| Complex::new(s - mean, 0.0)).collect();
        v.resize(n, Complex::new(0.0, 0.0));
        v
    };
    let (mut fa, mut fb) = (prep(a), prep(b));
    let (ea, eb): (f64, f64) = (fa.iter().map(|c| (c.re as f64).powi(2)).sum(), fb.iter().map(|c| (c.re as f64).powi(2)).sum());
    if ea < 1e-9 || eb < 1e-9 {
        return Err(Error::validation("one of the recordings is silent, so there is nothing to match"));
    }
    fwd.process(&mut fa);
    fwd.process(&mut fb);
    let mut prod: Vec<Complex<f32>> = fa.iter().zip(&fb).map(|(x, y)| x.conj() * y).collect();
    inv.process(&mut prod);
    // prod[k] = Σ a[i] b[i+k] (circular, scaled by n)
    let (mut best, mut best_k) = (f32::MIN, 0usize);
    for (k, c) in prod.iter().enumerate() {
        let lag_ok = k < b.len() || k > n - a.len();
        if lag_ok && c.re > best {
            best = c.re;
            best_k = k;
        }
    }
    let lag = if best_k < n / 2 { best_k as i64 } else { best_k as i64 - n as i64 };
    let norm = (ea * eb).sqrt() * n as f64;
    Ok(SyncResult { lag_seconds: lag as f64 / rate as f64, confidence: (best as f64 / norm).clamp(0.0, 1.0) })
}

/// Decode the first audio stream of `path` to mono f32 at 8 kHz (first two minutes).
pub fn decode(tools: &Tools, path: &Path) -> Result<Vec<f32>> {
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-i"]).arg(path).args(["-map", "0:a:0", "-t", &MAX_SECONDS.to_string(), "-ac", "1", "-ar", &SR.to_string(), "-f", "f32le", "-"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null());
    suppress_console_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| Error::ToolUnavailable { tool: tools.ffmpeg.display().to_string(), reason: e.to_string() })?;
    let mut bytes = vec![];
    child.stdout.take().expect("piped").read_to_end(&mut bytes).map_err(|e| Error::io(path, e))?;
    let st = child.wait().map_err(|e| Error::io(path, e))?;
    if !st.success() {
        return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: st.code(), hint: format!("could not read audio from {} (does it have an audio stream?)", path.display()) });
    }
    Ok(bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

/// How much later `other` is than `reference` (both media files).
pub fn measure(tools: &Tools, reference: &Path, other: &Path) -> Result<SyncResult> {
    correlate(&decode(tools, reference)?, &decode(tools, other)?, SR)
}

/// Timeline start (seconds) that makes `clip` line up with `reference`, given that the clip's media is `lag` seconds later
/// than the reference media. Both clips must play at normal speed. An event at reference media time `t` sits on the
/// timeline at `ref_start + t - ref_in`; in the clip's media the same event is at `t + lag`.
pub fn aligned_start(ref_start: f64, ref_in: f64, clip_in: f64, lag: f64) -> f64 {
    ref_start - ref_in + clip_in - lag
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aligned_start_puts_the_same_event_at_the_same_timeline_time() {
        // reference clip starts at 10 s showing media from 2 s; the other media is 1.5 s late; its clip shows media from 4 s
        let start = aligned_start(10.0, 2.0, 4.0, 1.5);
        // event at reference media 5 s -> timeline 13 s; in the other media at 6.5 s -> start + (6.5 - 4)
        assert!((start + (6.5 - 4.0) - 13.0).abs() < 1e-9);
    }

    fn noise(n: usize, seed: u64) -> Vec<f32> {
        let mut x = seed;
        (0..n).map(|_| { x ^= x << 13; x ^= x >> 7; x ^= x << 17; (x % 2000) as f32 / 1000.0 - 1.0 }).collect()
    }

    #[test]
    fn finds_positive_and_negative_lags_exactly() {
        let a = noise(16000, 7);
        let mut b = vec![0.0f32; 1200];
        b.extend(a.iter().map(|s| s * 0.4));
        let r = correlate(&a, &b, 8000).unwrap();
        assert!((r.lag_seconds - 0.15).abs() < 1e-6, "{r:?}");
        assert!(r.confidence > 0.3);
        let r = correlate(&b, &a, 8000).unwrap();
        assert!((r.lag_seconds + 0.15).abs() < 1e-6, "{r:?}");
    }

    #[test]
    fn unrelated_noise_has_low_confidence_and_silence_or_short_input_is_refused() {
        let r = correlate(&noise(16000, 1), &noise(16000, 99), 8000).unwrap();
        assert!(r.confidence < 0.1, "{r:?}");
        assert!(correlate(&vec![0.0; 16000], &noise(16000, 1), 8000).is_err());
        assert!(correlate(&noise(100, 1), &noise(16000, 1), 8000).is_err());
    }
}
