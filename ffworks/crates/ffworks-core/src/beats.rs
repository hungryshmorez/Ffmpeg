//! Beat/onset detection, ported from the browser app's `beat-detection.js` (spectral flux → adaptive-threshold
//! peak picking → median inter-onset BPM). Audio is decoded by FFmpeg (mono, 44.1 kHz, f32) instead of Web Audio.
//! Behavioural notes carried over: the first/last `AVG_WINDOW` frames (~0.19 s) are never reported as peaks, and BPM is
//! folded into 60–200. Deliberate difference: a minimum-strength floor (see `MIN_STRENGTH`) fixes phantom beats in silence.

use crate::error::{Error, Result};
use crate::process::{suppress_console_window, Tools};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

const SR: u32 = 44_100;
const FRAME: usize = 1024;
const HOP: usize = 512;
const AVG_WINDOW: usize = 16;
const LOCAL_WIN: usize = 3;
const MIN_PEAK_DISTANCE: f64 = 0.18;
const THRESHOLD_MUL: f32 = 1.35;
/// Peaks weaker than this fraction of the strongest onset are ignored. The original JS had no floor, so flat/silent
/// regions (where every frame ties as a "local maximum") produced phantom beats.
const MIN_STRENGTH: f32 = 0.05;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BeatAnalysis {
    /// Onset times in seconds from the start of the media.
    pub beats: Vec<f64>,
    /// 0.0 when it cannot be estimated.
    pub bpm: f64,
    pub duration: f64,
}

/// In-place radix-2 FFT (`re.len()` must be a power of two).
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut size = 2;
    while size <= n {
        let half = size / 2;
        let ang = -2.0 * std::f64::consts::PI / size as f64;
        let (w_re_step, w_im_step) = (ang.cos() as f32, ang.sin() as f32);
        let mut off = 0;
        while off < n {
            let (mut w_re, mut w_im) = (1.0f32, 0.0f32);
            for k in 0..half {
                let (a_re, a_im) = (re[off + k], im[off + k]);
                let (b_re, b_im) = (re[off + k + half] * w_re - im[off + k + half] * w_im, re[off + k + half] * w_im + im[off + k + half] * w_re);
                re[off + k] = a_re + b_re;
                im[off + k] = a_im + b_im;
                re[off + k + half] = a_re - b_re;
                im[off + k + half] = a_im - b_im;
                let nw_re = w_re * w_re_step - w_im * w_im_step;
                w_im = w_re * w_im_step + w_im * w_re_step;
                w_re = nw_re;
            }
            off += size;
        }
        size <<= 1;
    }
}

/// Onset times (seconds) from mono samples at `SR`.
pub fn onsets(samples: &[f32]) -> Vec<f64> {
    let n = samples.len();
    if n < FRAME {
        return vec![];
    }
    let frames = (n - FRAME) / HOP + 1;
    let win: Vec<f32> = (0..FRAME).map(|i| 0.5 * (1.0 - (2.0 * std::f64::consts::PI * i as f64 / (FRAME - 1) as f64).cos() as f32)).collect();
    let (mut re, mut im) = (vec![0f32; FRAME], vec![0f32; FRAME]);
    let mut prev = vec![0f32; FRAME / 2 + 1];
    let mut flux = vec![0f32; frames];
    for (f, fl) in flux.iter_mut().enumerate() {
        let start = f * HOP;
        for i in 0..FRAME {
            re[i] = samples.get(start + i).copied().unwrap_or(0.0) * win[i];
            im[i] = 0.0;
        }
        fft(&mut re, &mut im);
        let mut sum = 0f32;
        for k in 1..=FRAME / 2 {
            let mag = (re[k] * re[k] + im[k] * im[k]).sqrt();
            let d = mag - prev[k];
            if d > 0.0 {
                sum += d;
            }
            prev[k] = mag;
        }
        *fl = sum;
    }
    let max = flux.iter().cloned().fold(0f32, f32::max);
    if max <= 1e-6 {
        return vec![];
    }
    flux.iter_mut().for_each(|x| *x /= max);
    let min_frames = ((MIN_PEAK_DISTANCE * SR as f64 / HOP as f64).round() as i64).max(1);
    let mut last: i64 = -min_frames - 1;
    let mut out = vec![];
    for i in AVG_WINDOW..flux.len().saturating_sub(AVG_WINDOW) {
        let is_max = (1..=LOCAL_WIN).all(|d| flux[i + d] <= flux[i] && flux[i - d] <= flux[i]);
        if !is_max {
            continue;
        }
        let avg: f32 = flux[i - AVG_WINDOW..=i + AVG_WINDOW].iter().sum::<f32>() / (2 * AVG_WINDOW + 1) as f32;
        if flux[i] < MIN_STRENGTH || flux[i] < avg * THRESHOLD_MUL || (i as i64) - last < min_frames {
            continue;
        }
        last = i as i64;
        out.push((i * HOP) as f64 / SR as f64);
    }
    out
}

/// BPM from the median inter-onset interval, folded into 60–200. 0.0 if there is too little data.
pub fn estimate_bpm(beats: &[f64]) -> f64 {
    let mut iv: Vec<f64> = beats.windows(2).map(|w| w[1] - w[0]).filter(|d| *d > 0.2 && *d < 2.0).collect();
    if beats.len() < 4 || iv.len() < 3 {
        return 0.0;
    }
    iv.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut bpm = 60.0 / iv[iv.len() / 2];
    while bpm < 60.0 {
        bpm *= 2.0;
    }
    while bpm > 200.0 {
        bpm /= 2.0;
    }
    (bpm * 10.0).round() / 10.0
}

/// Decode `media`'s first audio stream and detect beats; cached by `key` in `cache_dir`.
pub fn detect(tools: &Tools, media: &Path, cache_dir: &Path, key: &str) -> Result<BeatAnalysis> {
    std::fs::create_dir_all(cache_dir).map_err(|e| Error::io(cache_dir, e))?;
    let cache_file = cache_dir.join(format!("{key}.beats.json"));
    if let Some(a) = std::fs::read_to_string(&cache_file).ok().and_then(|t| serde_json::from_str::<BeatAnalysis>(&t).ok()) {
        return Ok(a);
    }
    let a = analyse(tools, media)?;
    let _ = std::fs::write(&cache_file, serde_json::to_vec(&a)?);
    Ok(a)
}

/// Decode the first audio stream of `media` and find its beats (no cache).
pub fn analyse(tools: &Tools, media: &Path) -> Result<BeatAnalysis> {
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-i"]).arg(media).args(["-map", "0:a:0", "-ac", "1", "-ar", &SR.to_string(), "-f", "f32le", "-"]);
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
    let beats = onsets(&samples);
    Ok(BeatAnalysis { bpm: estimate_bpm(&beats), beats, duration: samples.len() as f64 / SR as f64 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fft_finds_a_pure_tone_bin() {
        let n = 1024;
        let mut re: Vec<f32> = (0..n).map(|i| (2.0 * std::f32::consts::PI * 64.0 * i as f32 / n as f32).sin()).collect();
        let mut im = vec![0.0; n];
        fft(&mut re, &mut im);
        let mags: Vec<f32> = (0..n / 2).map(|k| (re[k] * re[k] + im[k] * im[k]).sqrt()).collect();
        let peak = mags.iter().enumerate().max_by(|a, b| a.1.partial_cmp(b.1).unwrap()).unwrap().0;
        assert_eq!(peak, 64);
    }

    #[test]
    fn bpm_folds_and_needs_data() {
        assert_eq!(estimate_bpm(&[0.0, 0.5]), 0.0);
        let beats: Vec<f64> = (0..10).map(|i| i as f64 * 0.5).collect();
        assert_eq!(estimate_bpm(&beats), 120.0);
        let slow: Vec<f64> = (0..10).map(|i| i as f64 * 1.5).collect(); // 40 bpm folds to 80
        assert_eq!(estimate_bpm(&slow), 80.0);
    }

    #[test]
    fn silence_has_no_beats() {
        assert!(onsets(&vec![0.0; SR as usize * 3]).is_empty());
        assert!(onsets(&[0.0; 10]).is_empty());
    }

    #[test]
    fn synthetic_clicks_are_found_at_the_right_times() {
        // 120 bpm clicks, 6 s: noise bursts every 0.5 s
        let mut s = vec![0f32; SR as usize * 6];
        for k in 1..12 {
            let at = (k as f64 * 0.5 * SR as f64) as usize;
            for i in 0..600 {
                s[at + i] = ((i as f32 * 0.9).sin()) * (1.0 - i as f32 / 600.0);
            }
        }
        let beats = onsets(&s);
        assert!(beats.len() >= 9, "{beats:?}");
        for b in &beats {
            let nearest = (b / 0.5).round() * 0.5;
            assert!((b - nearest).abs() < 0.04, "beat {b} not near a click");
        }
        assert!((estimate_bpm(&beats) - 120.0).abs() < 1.0);
    }
}
