//! Audio auto-sync: how much later one recording is than another, found by FFT cross-correlation of their first minutes
//! (`rustfft`, MIT/Apache-2.0). Used to line up a camera clip with separately recorded sound, or two cameras.

use crate::error::{Error, Result};
use crate::jobs::CancelToken;
use crate::process::{run_cancellable, Tools};
use rustfft::{num_complex::Complex, FftPlanner};
use serde::Serialize;
use std::path::Path;
use std::process::Command;

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
    decode_with(tools, path, &CancelToken::new())
}

/// [`decode`] that stops (with [`Error::Canceled`]) when `cancel` is raised.
pub fn decode_with(tools: &Tools, path: &Path, cancel: &CancelToken) -> Result<Vec<f32>> {
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-i"]).arg(path).args(["-map", "0:a:0", "-t", &MAX_SECONDS.to_string(), "-ac", "1", "-ar", &SR.to_string(), "-f", "f32le", "-"]);
    let out = run_cancellable(&mut cmd, cancel)?;
    if !out.status.success() {
        return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: out.status.code(), hint: format!("could not read audio from {} (does it have an audio stream?)", path.display()) });
    }
    Ok(out.stdout.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

/// How much later `other` is than `reference` (both media files).
pub fn measure(tools: &Tools, reference: &Path, other: &Path) -> Result<SyncResult> {
    measure_with(tools, reference, other, &CancelToken::new())
}

/// [`measure`] that stops (with [`Error::Canceled`]) when `cancel` is raised.
pub fn measure_with(tools: &Tools, reference: &Path, other: &Path, cancel: &CancelToken) -> Result<SyncResult> {
    correlate(&decode_with(tools, reference, cancel)?, &decode_with(tools, other, cancel)?, SR)
}

/// How the lag between two recordings changes along them: separate recorders' clocks run at slightly different speeds, so a
/// recording that lines up at the start can be tens of milliseconds off after an hour.
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
pub struct DriftResult {
    /// Lag in the first 30 s (seconds `other` is later than `reference`), as [`SyncResult::lag_seconds`].
    pub lag_start: f64,
    /// Lag measured in the window `at` seconds into the reference.
    pub lag_later: f64,
    /// Where the second window starts, in reference time.
    pub at: f64,
    /// Lag gained per second of reference (positive: events in `other` get further apart than in `reference`).
    pub drift: f64,
    /// Speed to give `other` so it stays in step: `1 + drift`.
    pub speed: f64,
    /// The weaker of the two measurements' confidences.
    pub confidence: f64,
}

/// Seconds of audio compared in the later window.
const DRIFT_WINDOW: f64 = 30.0;
/// How far from where the first lag predicts the later window of `other` may be (drift or a wrong first guess).
const DRIFT_SLACK: f64 = 3.0;
/// The reference must be at least this long (seconds) for a drift to mean anything.
pub const MIN_DRIFT_SPAN: f64 = 60.0;

/// `len` seconds of `path`'s first audio stream from `start`, mono f32 at 8 kHz.
fn decode_window(tools: &Tools, path: &Path, start: f64, len: f64, cancel: &CancelToken) -> Result<Vec<f32>> {
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-ss", &format!("{start:.6}"), "-i"]).arg(path).args(["-map", "0:a:0", "-t", &format!("{len:.6}"), "-ac", "1", "-ar", &SR.to_string(), "-f", "f32le", "-"]);
    let out = run_cancellable(&mut cmd, cancel)?;
    if !out.status.success() {
        return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: out.status.code(), hint: format!("could not read audio from {} (does it have an audio stream?)", path.display()) });
    }
    Ok(out.stdout.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

/// Measure the drift between two recordings: the lag in the first 30 s, and again in a 30 s window near the end
/// of the shorter stretch both cover (`span` seconds of reference time, at least [`MIN_DRIFT_SPAN`]).
pub fn measure_drift(tools: &Tools, reference: &Path, other: &Path, span: f64, cancel: &CancelToken) -> Result<DriftResult> {
    if !span.is_finite() || span < MIN_DRIFT_SPAN {
        return Err(Error::validation(format!("drift needs at least {MIN_DRIFT_SPAN} seconds of overlapping sound; these cover {span:.0} s")));
    }
    // both lags come from windows of the same length, so where in its window a lag is "measured" cancels out of the difference;
    // the first window of `other` is longer so a start offset of up to a minute is still found
    let first = correlate(&decode_window(tools, reference, 0.0, DRIFT_WINDOW, cancel)?, &decode_window(tools, other, 0.0, 3.0 * DRIFT_WINDOW, cancel)?, SR)?;
    let at = (span - DRIFT_WINDOW).max(MIN_DRIFT_SPAN / 2.0);
    let a = decode_window(tools, reference, at, DRIFT_WINDOW, cancel)?;
    let from = (at + first.lag_seconds - DRIFT_SLACK).max(0.0);
    let b = decode_window(tools, other, from, DRIFT_WINDOW + 2.0 * DRIFT_SLACK, cancel)?;
    let later = correlate(&a, &b, SR)?;
    let lag_later = (from - at) + later.lag_seconds;
    let drift = (lag_later - first.lag_seconds) / at;
    Ok(DriftResult { lag_start: first.lag_seconds, lag_later, at, drift, speed: 1.0 + drift, confidence: first.confidence.min(later.confidence) })
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
    fn drift_is_the_lag_gained_per_second_and_the_speed_follows() {
        let d = DriftResult { lag_start: 1.0, lag_later: 1.05, at: 100.0, drift: 0.0005, speed: 1.0005, confidence: 0.5 };
        assert!((d.drift - (d.lag_later - d.lag_start) / d.at).abs() < 1e-12);
        assert_eq!(d.speed, 1.0 + d.drift);
    }

    #[test]
    fn unrelated_noise_has_low_confidence_and_silence_or_short_input_is_refused() {
        let r = correlate(&noise(16000, 1), &noise(16000, 99), 8000).unwrap();
        assert!(r.confidence < 0.1, "{r:?}");
        assert!(correlate(&vec![0.0; 16000], &noise(16000, 1), 8000).is_err());
        assert!(correlate(&noise(100, 1), &noise(16000, 1), 8000).is_err());
    }
}
