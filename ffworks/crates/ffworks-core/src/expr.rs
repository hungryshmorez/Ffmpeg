//! Expressions and parameter links: a formula in the clip's time (and optionally another parameter's value) that is
//! evaluated once per frame and stored as ordinary keyframes, so it previews, renders, saves and undoes like hand-set
//! ones and can be edited afterwards. It is a one-off calculation, not a live binding: change the source or the clip's
//! length and apply it again.
//!
//! Variables: `t` seconds into the clip, `n` frame number, `d` clip length in seconds, `p` progress 0..1 (t/d), `fps`, and
//! `v` the value of the source parameter at that moment (the parameter's own current value when no source is given).
//! Functions: everything [fasteval](https://crates.io/crates/fasteval) offers (sin cos tan abs min max floor ceil round
//! sqrt log exp int sign pi e(), `if`, `%`, `^`, comparisons) plus `noise(x)`, smooth deterministic noise between 0 and 1.

use crate::error::{Error, Result};
use crate::keyframes::{Interp, Keyframe};
use crate::reactive::{thin, unit_hash, MAX_KEYS};
use crate::time::{Fps, Rational};
use fasteval::{Compiler, Evaler, Parser, Slab};

/// Longest formula accepted (characters).
pub const MAX_LEN: usize = 500;

/// What a formula is evaluated against.
pub struct Inputs<'a> {
    pub fps: Fps,
    /// Clip length in seconds.
    pub dur: f64,
    /// Value of the source parameter at clip-relative time `t`.
    pub source: &'a dyn Fn(f64) -> f64,
    /// Allowed values of the target parameter.
    pub range: (f64, f64),
    /// Clamp results into `range` instead of refusing them.
    pub clamp: bool,
}

/// Smooth noise in 0..1: value noise on integer positions, eased between them.
fn noise(x: f64) -> f64 {
    let (k, f) = (x.floor(), x - x.floor());
    let (a, b) = (unit_hash(7, k as i64), unit_hash(7, k as i64 + 1));
    a + (b - a) * 0.5 * (1.0 - (std::f64::consts::PI * f).cos())
}

/// Value of a clip parameter (a clip-level one or `fx:<effect id>:<param>`) at clip-relative time `t`: its keyframes when it is
/// animated, else its static value.
pub fn clip_value(c: &crate::project::Clip, param: &str, t: f64) -> Result<f64> {
    if let Some(k) = c.keyframes.get(param).filter(|k| !k.is_empty()) {
        return crate::keyframes::eval(k, t).ok_or_else(|| Error::validation(format!("{param} has no keyframes")));
    }
    if let Some(rest) = param.strip_prefix("fx:") {
        let (fx_id, p) = rest.split_once(':').ok_or_else(|| Error::validation(format!("bad parameter id '{param}'")))?;
        let inst = c.effects.iter().find(|e| e.id == fx_id).ok_or_else(|| Error::NotFound(format!("effect {fx_id}")))?;
        let def = crate::effects::find(&inst.effect)?;
        let pd = def.params.iter().find(|x| x.id == p).ok_or_else(|| Error::validation(format!("effect '{}' has no parameter '{p}'", def.id)))?;
        return Ok(inst.params.get(p).copied().unwrap_or(pd.default));
    }
    c.static_param(param).ok_or_else(|| Error::validation(format!("unknown parameter '{param}'")))
}

/// Keyframes (clip-relative, at most [`MAX_KEYS`]) for `expr` over the clip.
pub fn keys(expr: &str, inp: &Inputs) -> Result<Vec<Keyframe>> {
    let expr = expr.trim();
    if expr.is_empty() || expr.chars().count() > MAX_LEN {
        return Err(Error::validation(format!("an expression needs 1 to {MAX_LEN} characters")));
    }
    if !inp.dur.is_finite() || inp.dur <= 0.0 {
        return Err(Error::validation("the clip has no length to animate over"));
    }
    let bad = |e: fasteval::Error| Error::validation(format!("expression '{expr}': {e}"));
    let parser = Parser::new();
    let mut slab = Slab::new();
    let compiled = parser.parse(expr, &mut slab.ps).map_err(bad)?.from(&slab.ps).compile(&slab.ps, &mut slab.cs);

    let fpsf = inp.fps.as_f64();
    let frames = ((inp.dur * fpsf).round() as i64).max(1);
    // a sample at every frame up to the key limit, then spread evenly
    let step = ((frames as f64) / (MAX_KEYS as f64 - 1.0)).ceil().max(1.0) as i64;
    let mut at: Vec<i64> = (0..frames).step_by(step as usize).collect();
    at.push(frames);
    at.dedup();
    let (lo, hi) = inp.range;
    let mut pts: Vec<(f64, f64)> = Vec::with_capacity(at.len());
    for n in at {
        let t = n as f64 / fpsf;
        let mut ns = |name: &str, args: Vec<f64>| -> Option<f64> {
            match (name, args.as_slice()) {
                ("t", []) => Some(t),
                ("n", []) => Some(n as f64),
                ("d", []) => Some(inp.dur),
                ("p", []) => Some(t / inp.dur),
                ("fps", []) => Some(fpsf),
                ("v", []) => Some((inp.source)(t)),
                ("noise", [x]) => Some(noise(*x)),
                _ => None,
            }
        };
        let mut v = compiled.eval(&slab, &mut ns).map_err(bad)?;
        if !v.is_finite() {
            return Err(Error::validation(format!("expression '{expr}' gives no number at t = {t:.2} s (division by zero or a value out of reach)")));
        }
        if inp.clamp {
            v = v.clamp(lo, hi);
        } else if v < lo || v > hi {
            return Err(Error::validation(format!("expression '{expr}' gives {v:.3} at t = {t:.2} s, outside the allowed {lo}..{hi}; change the formula or ask for the result to be clamped")));
        }
        pts.push((t, v));
    }
    // the fewest keys whose straight lines stay within 0.2% of the range
    let tol = ((hi - lo).abs() * 0.002).max(1e-9);
    Ok(thin(&pts, tol).into_iter().map(|(t, v)| Keyframe { t: Rational::new((t * fpsf).round() as i64 * inp.fps.den(), inp.fps.num()), v: (v * 1e4).round() / 1e4, interp: Interp::Linear }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(expr: &str, dur: f64, source: &dyn Fn(f64) -> f64, range: (f64, f64), clamp: bool) -> Result<Vec<Keyframe>> {
        keys(expr, &Inputs { fps: Rational::from_int(25), dur, source, range, clamp })
    }
    fn at(k: &[Keyframe], t: f64) -> f64 {
        crate::keyframes::eval(k, t).unwrap()
    }
    const ZERO: &dyn Fn(f64) -> f64 = &|_| 0.0;

    #[test]
    fn a_ramp_in_time_becomes_two_keys() {
        let k = run("p", 4.0, ZERO, (0.0, 1.0), false).unwrap();
        assert_eq!(k.len(), 2, "a straight line needs only its ends: {k:?}");
        assert!((at(&k, 2.0) - 0.5).abs() < 0.01 && (at(&k, 4.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn a_sine_follows_the_formula_within_tolerance() {
        let k = run("0.5 + 0.5 * sin(2 * pi() * t)", 4.0, ZERO, (0.0, 1.0), false).unwrap();
        assert!(k.len() <= MAX_KEYS);
        for t in [0.1, 0.25, 0.6, 1.3, 2.9] {
            let want = 0.5 + 0.5 * (std::f64::consts::TAU * t).sin();
            assert!((at(&k, t) - want).abs() < 0.03, "t={t}: {} vs {want}", at(&k, t));
        }
    }

    #[test]
    fn the_source_value_is_available_as_v() {
        // link: follow the source at half strength, offset
        let src = |t: f64| t / 10.0;
        let k = run("v * 0.5 + 0.25", 10.0, &src, (0.0, 1.0), false).unwrap();
        assert!((at(&k, 0.0) - 0.25).abs() < 1e-3 && (at(&k, 10.0) - 0.75).abs() < 1e-3);
    }

    #[test]
    fn frame_number_length_and_progress_are_known() {
        let k = run("n / (d * fps)", 2.0, ZERO, (0.0, 1.0), false).unwrap();
        assert!((at(&k, 1.0) - 0.5).abs() < 0.02);
    }

    #[test]
    fn noise_is_deterministic_and_stays_in_range() {
        let a = run("noise(t * 3)", 4.0, ZERO, (0.0, 1.0), false).unwrap();
        let b = run("noise(t * 3)", 4.0, ZERO, (0.0, 1.0), false).unwrap();
        assert_eq!(a, b);
        assert!(a.iter().all(|k| (0.0..=1.0).contains(&k.v)) && a.len() > 4);
    }

    #[test]
    fn mistakes_are_explained() {
        let e = |s: &str, r: (f64, f64)| run(s, 4.0, ZERO, r, false).unwrap_err().to_string();
        assert!(e("sin(", (0.0, 1.0)).contains("expression"), "syntax");
        assert!(e("wobble", (0.0, 1.0)).contains("expression"), "unknown name");
        assert!(e("t * 2", (0.0, 1.0)).contains("outside the allowed 0..1"), "range");
        assert!(e("1 / (t - 1)", (-1e9, 1e9)).contains("no number"), "division by zero");
        assert!(e("", (0.0, 1.0)).contains("1 to"), "empty");
        assert!(e(&"1+".repeat(300), (0.0, 1.0)).contains("1 to"), "too long");
    }

    #[test]
    fn clamping_keeps_out_of_range_results_inside() {
        let k = run("t * 2", 4.0, ZERO, (0.0, 1.0), true).unwrap();
        assert!(k.iter().all(|k| (0.0..=1.0).contains(&k.v)));
        assert!((at(&k, 4.0) - 1.0).abs() < 1e-6 && (at(&k, 0.25) - 0.5).abs() < 0.02);
    }

    #[test]
    fn long_clips_stay_under_the_key_limit() {
        let k = run("sin(t * 5)", 120.0, ZERO, (-1.0, 1.0), false).unwrap();
        assert!(k.len() <= MAX_KEYS, "{}", k.len());
    }
}
