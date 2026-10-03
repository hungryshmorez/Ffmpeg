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

/// Shapes an LFO can have: (id, label).
pub const LFO_SHAPES: &[(&str, &str)] = &[("sine", "Sine"), ("triangle", "Triangle"), ("saw", "Saw (rises, then drops)"), ("square", "Square"), ("random", "Random (smooth)")];

/// Fastest LFO: each half cycle needs at least two frames.
fn max_lfo_rate(fps: Fps) -> f64 {
    fps.as_f64() / 4.0
}

/// splitmix64 hash to 0..1, so a random LFO is the same on every machine.
fn unit_hash(seed: u64, k: i64) -> f64 {
    let mut z = seed.wrapping_add((k as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)).wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64
}

/// Keyframes for a low-frequency oscillator over a clip of `clip_dur` seconds: `shape` at `rate` Hz between `low` and
/// `high`, starting `phase` (0..1) of a cycle in (0 starts at `low`, 0.5 at `high` for sine/triangle/square). Sine uses
/// eased segments between its peaks (two keys per cycle, within 2% of a true sine), square holds, saw rises and drops,
/// random glides between a new random value each cycle (`seed`). Errors when the curve would need more than [`MAX_KEYS`] keys.
#[allow(clippy::too_many_arguments)]
pub fn lfo_keys(shape: &str, rate: f64, low: f64, high: f64, phase: f64, seed: u64, fps: Fps, clip_dur: f64) -> Result<Vec<Keyframe>> {
    if !LFO_SHAPES.iter().any(|(id, _)| *id == shape) {
        return Err(Error::validation(format!("unknown LFO shape '{shape}' (sine, triangle, saw, square, random)")));
    }
    let top = max_lfo_rate(fps);
    if !rate.is_finite() || rate <= 0.0 || rate > top {
        return Err(Error::validation(format!("LFO rate must be above 0 and at most {top} Hz at this frame rate")));
    }
    if !(0.0..1.0).contains(&phase) {
        return Err(Error::validation("LFO phase must be 0 up to (not including) 1 of a cycle"));
    }
    if !low.is_finite() || !high.is_finite() || !clip_dur.is_finite() || clip_dur <= 0.0 {
        return Err(Error::validation("LFO needs finite values and a clip with some length"));
    }
    let fpsf = fps.as_f64();
    let frame = 1.0 / fpsf;
    let snap = |t: f64| (t * fpsf).round() / fpsf;
    let val = |u: f64| low + (high - low) * u;
    // 0..1 position in the wave at cycle position c (any real number)
    let wave = |c: f64| -> f64 {
        let (k, f) = (c.floor(), c - c.floor());
        match shape {
            "sine" => 0.5 - 0.5 * (std::f64::consts::TAU * f).cos(),
            "triangle" => 1.0 - (2.0 * f - 1.0).abs(),
            "saw" => f,
            "square" => f64::from(f >= 0.5),
            _ => {
                // random: glide from this cycle's value to the next one's
                let (a, b) = (unit_hash(seed, k as i64), unit_hash(seed, k as i64 + 1));
                a + (b - a) * 0.5 * (1.0 - (std::f64::consts::PI * f).cos())
            }
        }
    };
    let (step, interp) = match shape {
        "sine" => (0.5, Interp::EaseInOut),
        "triangle" => (0.5, Interp::Linear),
        "square" => (0.5, Interp::Hold),
        "saw" => (1.0, Interp::Linear),
        _ => (1.0, Interp::EaseInOut),
    };
    let estimate = (clip_dur * rate / step).ceil() as usize + 3;
    if estimate * if shape == "saw" { 2 } else { 1 } > MAX_KEYS {
        return Err(Error::validation(format!("{rate} Hz over {clip_dur:.1} s needs about {estimate} keyframes; the limit is {MAX_KEYS}. Lower the rate or split the clip")));
    }
    let mut pts: Vec<(f64, f64, Interp)> = vec![(0.0, val(wave(phase)), interp)];
    // keys at every `step` of the cycle that falls inside the clip
    let mut j = (phase / step).floor() as i64 + 1;
    loop {
        let c = j as f64 * step;
        let t = snap((c - phase) / rate);
        if t > clip_dur + 1e-9 {
            break;
        }
        if shape == "saw" {
            // rise to just short of the top, hold it, then the next cycle's key drops back to the bottom
            let top_t = snap(t - frame);
            if top_t > pts.last().map(|p| p.0).unwrap_or(0.0) {
                pts.push((top_t, val(wave(c - frame * rate)), Interp::Hold));
            }
            pts.push((t, val(wave(c)), interp));
        } else {
            pts.push((t, val(wave(c)), interp));
        }
        j += 1;
    }
    if pts.last().is_some_and(|p| p.0 < snap(clip_dur) - 1e-9) {
        pts.push((snap(clip_dur), val(wave(clip_dur * rate + phase)), Interp::Linear));
    }
    pts.dedup_by(|b, a| b.0 <= a.0 + 1e-9);
    Ok(pts.into_iter().map(|(t, v, interp)| Keyframe { t: Rational::new((t * fpsf).round() as i64 * fps.den(), fps.num()), v: (v * 1e4).round() / 1e4, interp }).collect())
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
    fn a_sine_lfo_follows_a_sine_with_two_keys_per_cycle() {
        // 40 fps puts every half cycle on a whole frame, so only the shape of the curve is measured
        let k = lfo_keys("sine", 1.0, 0.0, 1.0, 0.0, 0, Rational::from_int(40), 4.0).unwrap();
        let at = |t: f64| crate::keyframes::eval(&k, t).unwrap();
        assert_eq!(at(0.0), 0.0);
        for t in [0.1, 0.25, 0.4, 0.5, 0.75, 1.0, 1.3, 2.5, 3.2] {
            let want = 0.5 - 0.5 * (std::f64::consts::TAU * t).cos();
            assert!((at(t) - want).abs() < 0.03, "t={t}: {} vs {want}", at(t));
        }
        assert!(k.len() <= 12, "{}", k.len());
        assert!(k.windows(2).all(|w| w[0].t < w[1].t));
    }

    #[test]
    fn phase_range_and_direction_are_honoured() {
        let k = lfo_keys("sine", 1.0, 2.0, 6.0, 0.5, 0, Rational::from_int(40), 2.0).unwrap();
        assert!((crate::keyframes::eval(&k, 0.0).unwrap() - 6.0).abs() < 1e-3, "phase 0.5 starts at the top");
        assert!((crate::keyframes::eval(&k, 0.5).unwrap() - 2.0).abs() < 0.05, "and reaches the bottom half a cycle later");
        let t = lfo_keys("triangle", 2.0, 0.0, 10.0, 0.0, 0, Rational::from_int(40), 2.0).unwrap();
        let tv = |x: f64| crate::keyframes::eval(&t, x).unwrap();
        assert!((tv(0.125) - 5.0).abs() < 0.2 && (tv(0.25) - 10.0).abs() < 1e-6 && (tv(0.5) - 0.0).abs() < 1e-6, "{} {} {}", tv(0.125), tv(0.25), tv(0.5));
    }

    #[test]
    fn square_holds_saw_rises_then_drops_and_random_is_seeded() {
        let sq = lfo_keys("square", 1.0, 1.0, 3.0, 0.0, 0, fps(), 4.0).unwrap();
        let sv = |x: f64| crate::keyframes::eval(&sq, x).unwrap();
        assert_eq!((sv(0.25), sv(0.75), sv(1.25), sv(1.75)), (1.0, 3.0, 1.0, 3.0));
        let sw = lfo_keys("saw", 1.0, 0.0, 1.0, 0.0, 0, fps(), 3.0).unwrap();
        let wv = |x: f64| crate::keyframes::eval(&sw, x).unwrap();
        assert!((wv(0.5) - 0.5).abs() < 0.05 && wv(0.96) > 0.9 && wv(1.04) < 0.15, "{} {} {}", wv(0.5), wv(0.96), wv(1.04));
        let r1 = lfo_keys("random", 1.0, 0.0, 10.0, 0.0, 7, fps(), 6.0).unwrap();
        assert_eq!(r1, lfo_keys("random", 1.0, 0.0, 10.0, 0.0, 7, fps(), 6.0).unwrap());
        assert_ne!(r1, lfo_keys("random", 1.0, 0.0, 10.0, 0.0, 8, fps(), 6.0).unwrap());
        assert!(r1.iter().all(|k| (0.0..=10.0).contains(&k.v)));
    }

    #[test]
    fn impossible_lfos_are_refused_with_the_reason() {
        let bad = |shape: &str, rate: f64, phase: f64, dur: f64| lfo_keys(shape, rate, 0.0, 1.0, phase, 0, fps(), dur).unwrap_err().to_string();
        assert!(bad("wobble", 1.0, 0.0, 2.0).contains("unknown LFO shape"));
        assert!(bad("sine", 0.0, 0.0, 2.0).contains("rate"));
        assert!(bad("sine", 30.0, 0.0, 2.0).contains("at most"));
        assert!(bad("sine", 1.0, 1.0, 2.0).contains("phase"));
        assert!(bad("sine", 5.0, 0.0, 60.0).contains("keyframes"));
        assert!(bad("sine", 1.0, 0.0, 0.0).contains("length"));
    }

    #[test]
    fn constant_sound_gives_a_flat_low_curve() {
        let k = keys(&[-20.0; 30], 0.0, Mapping { low: 3.0, high: 9.0, smooth: 0.0 }, fps(), 1.5);
        assert!(k.iter().all(|x| x.v == 3.0) && k.len() == 2, "{k:?}");
    }
}
