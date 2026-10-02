//! Audio-reactive parameters: measure how loud a stretch of audio is over time (FFmpeg `astats`, RMS per window) and turn
//! that into a keyframe curve, so any animatable parameter can pulse with the sound. The curve is ordinary keyframes,
//! so it previews, renders, saves and undoes like hand-set ones and can be edited afterwards.

use crate::error::{Error, Result};
use crate::keyframes::{Interp, Keyframe};
use crate::process::Tools;
use crate::time::{Fps, Rational};
use std::path::Path;

/// Measurements per second.
pub const RATE: f64 = 20.0;
/// Most keys one curve may have (each key adds a nested `if()` to the FFmpeg expression).
pub const MAX_KEYS: usize = 200;
/// Level used for silence (FFmpeg reports `-inf`).
const SILENT_DB: f64 = -120.0;

/// Frequency bands a curve can follow: (id, label, FFmpeg filter that keeps only that band).
pub const BANDS: &[(&str, &str, &str)] = &[
    ("all", "Whole signal", ""),
    ("bass", "Bass (below 150 Hz)", "lowpass=f=150:p=2,lowpass=f=150:p=2,"),
    ("mid", "Mids (300 Hz - 3 kHz)", "highpass=f=300:p=2,lowpass=f=3000:p=2,"),
    ("treble", "Treble (above 5 kHz)", "highpass=f=5000:p=2,highpass=f=5000:p=2,"),
];

/// RMS level in dB of the first audio stream of `path`, optionally only in `band` (see [`BANDS`]), for each 1/[`RATE`] s
/// window of `[from, from + dur)` (media time).
pub fn envelope(tools: &Tools, path: &Path, from: f64, dur: f64, band: &str) -> Result<Vec<f64>> {
    let pre = BANDS.iter().find(|b| b.0 == band).map(|b| b.2).ok_or_else(|| Error::validation(format!("unknown band '{band}' (all, bass, mid, treble)")))?;
    if !dur.is_finite() || !from.is_finite() || dur <= 0.0 || from < 0.0 {
        return Err(Error::validation("nothing to measure"));
    }
    let n = (48000.0 / RATE).round() as u32;
    let af = format!("aresample=48000,{pre}asetnsamples=n={n}:p=0,astats=metadata=1:reset=1:measure_overall=RMS_level:measure_perchannel=none,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-");
    let (ss, t) = (format!("{from:.6}"), format!("{dur:.6}"));
    // run_capture puts the input last, but the filter options must follow it, so the argv is built here
    let mut cmd = std::process::Command::new(&tools.ffmpeg);
    cmd.args(["-nostdin", "-v", "error", "-ss", &ss, "-t", &t, "-i"]).arg(path).args(["-vn", "-map", "0:a:0", "-af", &af, "-f", "null", "-"]);
    crate::process::suppress_console_window(&mut cmd);
    let o = cmd.stdin(std::process::Stdio::null()).output().map_err(|e| Error::ToolUnavailable { tool: tools.ffmpeg.display().to_string(), reason: e.to_string() })?;
    if !o.status.success() {
        return Err(Error::ToolFailed { tool: tools.ffmpeg.display().to_string(), code: o.status.code(), hint: crate::process::explain_failure(&String::from_utf8_lossy(&o.stderr)) });
    }
    let levels = parse(&String::from_utf8_lossy(&o.stdout));
    if levels.is_empty() {
        return Err(Error::validation("no audio was measured (does the source have sound in that range?)"));
    }
    Ok(levels)
}

fn parse(text: &str) -> Vec<f64> {
    text.lines()
        .filter_map(|l| l.strip_prefix("lavfi.astats.Overall.RMS_level="))
        .map(|v| v.trim().parse::<f64>().ok().filter(|x| x.is_finite()).unwrap_or(SILENT_DB).max(SILENT_DB))
        .collect()
}

/// How a loudness curve becomes parameter values.
#[derive(Clone, Copy, Debug)]
pub struct Mapping {
    /// Value when quiet / when loud.
    pub low: f64,
    pub high: f64,
    /// Smoothing time in seconds (0 = follow every window).
    pub smooth: f64,
}

/// Keyframes (clip-relative times, starting at `offset` s) for `levels` measured every 1/[`RATE`] s. Levels are normalised
/// between the quiet floor (10th percentile) and the loudest window, smoothed, mapped to `low..high`, snapped to frames
/// and thinned to at most [`MAX_KEYS`] keys that stay within 1% of the full curve.
pub fn keys(levels: &[f64], offset: f64, map: Mapping, fps: Fps, clip_dur: f64) -> Vec<Keyframe> {
    if levels.is_empty() {
        return vec![];
    }
    let mut sorted = levels.to_vec();
    sorted.sort_by(f64::total_cmp);
    let floor = sorted[sorted.len() / 10];
    let ceil = *sorted.last().expect("non-empty");
    let span = ceil - floor;
    let alpha = if map.smooth > 0.0 { 1.0 - (-1.0 / (RATE * map.smooth)).exp() } else { 1.0 };
    let mut acc = None::<f64>;
    let fpsf = fps.as_f64();
    let mut pts: Vec<(f64, f64)> = vec![];
    for (i, db) in levels.iter().enumerate() {
        let n = if span < 1.0 { 0.0 } else { ((db - floor) / span).clamp(0.0, 1.0) };
        let s = match acc {
            Some(a) => a + alpha * (n - a),
            None => n,
        };
        acc = Some(s);
        // a window describes its middle; snap to a frame, keep inside the clip, first one wins on collisions
        let t = ((offset + (i as f64 + 0.5) / RATE) * fpsf).round() / fpsf;
        if t < 0.0 || t > clip_dur + 1e-9 || pts.last().is_some_and(|(pt, _)| *pt >= t) {
            continue;
        }
        pts.push((t, map.low + (map.high - map.low) * s));
    }
    let tol0 = (map.high - map.low).abs() * 0.01;
    let mut tol = tol0;
    let mut kept = thin(&pts, tol);
    while kept.len() > MAX_KEYS {
        tol += tol0.max(1e-6);
        kept = thin(&pts, tol);
    }
    kept.into_iter()
        .map(|(t, v)| Keyframe { t: Rational::new((t * fpsf).round() as i64 * fps.den(), fps.num()), v: (v * 1e4).round() / 1e4, interp: Interp::Linear })
        .collect()
}

/// Most keys a beat pulse curve may have (two per beat).
pub const MAX_PULSE_KEYS: usize = 300;

/// Keyframes that jump to `high` on each beat (clip-relative seconds) and ease back to `low` over `decay` seconds (or
/// until shortly before the next beat), holding `low` in between. Errors when the clip has more beats than fit.
pub fn pulse_keys(beats: &[f64], low: f64, high: f64, decay: f64, fps: Fps, clip_dur: f64) -> Result<Vec<Keyframe>> {
    let fpsf = fps.as_f64();
    let frame = 1.0 / fpsf;
    let snap = |t: f64| (t * fpsf).round() / fpsf;
    let mut bs: Vec<f64> = beats.iter().copied().filter(|t| *t >= 0.0 && *t <= clip_dur).map(snap).collect();
    bs.dedup();
    if bs.is_empty() {
        return Err(Error::validation("no beats were found under this clip"));
    }
    let mut pts: Vec<(f64, f64, Interp)> = vec![];
    if bs[0] > 0.0 {
        pts.push((0.0, low, Interp::Hold));
    }
    for (i, &t) in bs.iter().enumerate() {
        let next = bs.get(i + 1).copied().unwrap_or(f64::INFINITY);
        // the pulse needs at least one frame to fall; a beat on the very next frame just restarts it
        let end = snap((t + decay.max(frame)).min(next - frame).min(clip_dur));
        if end > t {
            pts.push((t, high, Interp::EaseOut));
            pts.push((end, low, Interp::Hold));
        } else {
            pts.push((t, high, Interp::Hold));
        }
    }
    if pts.len() > MAX_PULSE_KEYS {
        return Err(Error::validation(format!("{} beats under this clip is too many for one curve (at most {}); split the clip first", bs.len(), MAX_PULSE_KEYS / 2)));
    }
    Ok(pts.into_iter().map(|(t, v, interp)| Keyframe { t: Rational::new((t * fpsf).round() as i64 * fps.den(), fps.num()), v, interp }).collect())
}

/// Ramer–Douglas–Peucker: the fewest points whose straight lines stay within `tol` of every point.
fn thin(pts: &[(f64, f64)], tol: f64) -> Vec<(f64, f64)> {
    if pts.len() <= 2 {
        return pts.to_vec();
    }
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    keep[pts.len() - 1] = true;
    let mut stack = vec![(0usize, pts.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        let (ta, va) = pts[a];
        let (tb, vb) = pts[b];
        let mut worst = (0.0, 0usize);
        for (i, &(t, v)) in pts.iter().enumerate().take(b).skip(a + 1) {
            let line = va + (vb - va) * (t - ta) / (tb - ta);
            let d = (v - line).abs();
            if d > worst.0 {
                worst = (d, i);
            }
        }
        if worst.0 > tol {
            keep[worst.1] = true;
            stack.push((a, worst.1));
            stack.push((worst.1, b));
        }
    }
    pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fps() -> Fps {
        Rational::from_int(25)
    }

    #[test]
    fn parse_reads_levels_and_treats_inf_as_silence() {
        let t = "frame:0 pts:0\nlavfi.astats.Overall.RMS_level=-20.5\nframe:1\nlavfi.astats.Overall.RMS_level=-inf\n";
        assert_eq!(parse(t), vec![-20.5, SILENT_DB]);
    }

    #[test]
    fn loud_and_quiet_map_to_high_and_low() {
        // 1 s quiet, 1 s loud
        let lv: Vec<f64> = (0..40).map(|i| if i < 20 { -40.0 } else { -10.0 }).collect();
        let k = keys(&lv, 0.0, Mapping { low: 1.0, high: 2.0, smooth: 0.0 }, fps(), 2.0);
        let at = |t: f64| crate::keyframes::eval(&k, t).unwrap();
        assert!((at(0.5) - 1.0).abs() < 1e-6, "{}", at(0.5));
        assert!((at(1.5) - 2.0).abs() < 1e-6, "{}", at(1.5));
        assert!(k.len() <= 6, "a step needs few keys after thinning: {}", k.len());
        assert!(k.windows(2).all(|w| w[0].t < w[1].t));
    }

    #[test]
    fn smoothing_slows_the_rise() {
        let lv: Vec<f64> = (0..40).map(|i| if i < 20 { -40.0 } else { -10.0 }).collect();
        let k = keys(&lv, 0.0, Mapping { low: 0.0, high: 1.0, smooth: 0.3 }, fps(), 2.0);
        let v = crate::keyframes::eval(&k, 1.1).unwrap();
        assert!(v > 0.1 && v < 0.7, "{v}");
    }

    #[test]
    fn a_long_noisy_curve_is_capped() {
        let lv: Vec<f64> = (0..20 * 120).map(|i| -30.0 + 20.0 * ((i * 7919 % 101) as f64 / 101.0)).collect();
        let k = keys(&lv, 0.0, Mapping { low: 0.0, high: 100.0, smooth: 0.0 }, fps(), 120.0);
        assert!(k.len() <= MAX_KEYS && k.len() > 20, "{}", k.len());
    }

    #[test]
    fn pulses_jump_on_beats_and_fall_back() {
        // beats on frame boundaries at 25 fps; 1.40 and 1.44 are one frame apart
        let k = pulse_keys(&[0.4, 1.4, 1.44, 3.0], 0.0, 1.0, 0.3, fps(), 4.0).unwrap();
        let at = |t: f64| crate::keyframes::eval(&k, t).unwrap();
        assert_eq!(at(0.2), 0.0);
        assert_eq!(at(0.4), 1.0);
        assert!(at(0.55) > 0.0 && at(0.55) < 1.0);
        assert_eq!(at(1.0), 0.0);
        assert_eq!(at(1.44), 1.0, "a beat one frame after another restarts the pulse");
        assert_eq!(at(3.0), 1.0);
        assert_eq!(at(3.5), 0.0);
        assert!(k.windows(2).all(|w| w[0].t < w[1].t));
        assert!(pulse_keys(&[], 0.0, 1.0, 0.3, fps(), 4.0).is_err());
        let many: Vec<f64> = (0..400).map(|i| i as f64 * 0.25).collect();
        assert!(pulse_keys(&many, 0.0, 1.0, 0.1, fps(), 100.0).is_err());
    }

    #[test]
    fn constant_sound_gives_a_flat_low_curve() {
        let k = keys(&[-20.0; 30], 0.0, Mapping { low: 3.0, high: 9.0, smooth: 0.0 }, fps(), 1.5);
        assert!(k.iter().all(|x| x.v == 3.0) && k.len() == 2, "{k:?}");
    }
}
