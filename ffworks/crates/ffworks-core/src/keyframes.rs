//! Keyframes (spec §62 ff.): animated parameters with interpolation, evaluated both here (UI display, tests,
//! scripts) and inside FFmpeg through an expression generated from the same data, so preview/export match.
//!
//! Times are clip-relative timeline seconds (after speed changes), so retiming a clip never moves its keyframes.

use crate::error::{Error, Result};
use crate::time::Rational;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Interp {
    #[default]
    Linear,
    /// Keep this key's value until the next key (step).
    Hold,
    EaseIn,
    EaseOut,
    EaseInOut,
}

pub const INTERPS: &[(Interp, &str)] = &[(Interp::Linear, "Linear"), (Interp::Hold, "Hold"), (Interp::EaseIn, "Ease in"), (Interp::EaseOut, "Ease out"), (Interp::EaseInOut, "Ease in/out")];

/// One key. `interp` describes the curve from this key to the next one.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Keyframe {
    pub t: Rational,
    pub v: f64,
    #[serde(default)]
    pub interp: Interp,
}

fn shape(i: Interp, p: f64) -> f64 {
    match i {
        Interp::Linear => p,
        Interp::Hold => 0.0,
        Interp::EaseIn => p * p,
        Interp::EaseOut => p * (2.0 - p),
        Interp::EaseInOut => p * p * (3.0 - 2.0 * p),
    }
}

/// Value of the curve at clip-relative time `t` (seconds). Before the first key the first value holds; after the last, the last.
/// `kfs` must be sorted by time (the planner guarantees that).
pub fn eval(kfs: &[Keyframe], t: f64) -> Option<f64> {
    let first = kfs.first()?;
    if t <= first.t.as_f64() {
        return Some(first.v);
    }
    for w in kfs.windows(2) {
        let (a, b) = (w[0], w[1]);
        let (ta, tb) = (a.t.as_f64(), b.t.as_f64());
        if t < tb {
            return Some(a.v + (b.v - a.v) * shape(a.interp, (t - ta) / (tb - ta)));
        }
    }
    kfs.last().map(|k| k.v)
}

/// Insert or replace the key at exactly `t`, keeping the list sorted.
pub fn upsert(kfs: &mut Vec<Keyframe>, key: Keyframe) {
    match kfs.iter().position(|k| k.t == key.t) {
        Some(i) => kfs[i] = key,
        None => {
            let at = kfs.partition_point(|k| k.t < key.t);
            kfs.insert(at, key);
        }
    }
}

fn num(x: f64) -> String {
    let s = format!("{x:.9}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    let s = if s.is_empty() || s == "-" || s == "-0" { "0" } else { s };
    if s.starts_with('-') { format!("({s})") } else { s.to_string() }
}

/// FFmpeg expression for the curve in the time variable `var` (e.g. `t`, or `(in-1)*1001/30000` for frame counters).
/// Contains commas, so callers must wrap it in single quotes inside a filter graph. Never contains quotes itself.
pub fn to_expr(kfs: &[Keyframe], var: &str) -> String {
    let Some(first) = kfs.first() else { return "0".into() };
    if kfs.len() == 1 {
        return num(first.v);
    }
    let mut segs: Vec<(f64, String)> = vec![]; // (end time, expression for the segment)
    for w in kfs.windows(2) {
        let (a, b) = (w[0], w[1]);
        let (ta, tb) = (a.t.as_f64(), b.t.as_f64());
        let dv = b.v - a.v;
        let p = format!("(({var}-{})/{})", num(ta), num(tb - ta));
        let e = match a.interp {
            Interp::Hold => num(a.v),
            _ if dv == 0.0 => num(a.v),
            Interp::Linear => format!("({}+{}*{p})", num(a.v), num(dv)),
            Interp::EaseIn => format!("({}+{}*{p}*{p})", num(a.v), num(dv)),
            Interp::EaseOut => format!("({}+{}*{p}*(2-{p}))", num(a.v), num(dv)),
            Interp::EaseInOut => format!("({}+{}*{p}*{p}*(3-2*{p}))", num(a.v), num(dv)),
        };
        segs.push((tb, e));
    }
    let mut out = num(kfs.last().expect("non-empty").v);
    for (end, e) in segs.into_iter().rev() {
        out = format!("if(lt({var},{}),{e},{out})", num(end));
    }
    format!("if(lt({var},{}),{},{out})", num(first.t.as_f64()), num(first.v))
}

/// Keys needed to reproduce the curve exactly on `[lo, hi]`, shifted by `shift` seconds: keys inside the window plus the
/// nearest key on each side (so interpolation at the window edges is unchanged). Used when a clip is split.
pub fn window(kfs: &[Keyframe], lo: Rational, hi: Rational, shift: Rational) -> Vec<Keyframe> {
    let before = kfs.iter().rposition(|k| k.t <= lo);
    let after = kfs.iter().position(|k| k.t >= hi);
    let from = before.unwrap_or(0);
    let to = after.unwrap_or(kfs.len().saturating_sub(1));
    kfs.iter().enumerate().filter(|(i, _)| *i >= from && *i <= to).map(|(_, k)| Keyframe { t: k.t - shift, ..*k }).collect()
}

/// Check a key list: finite values, sorted, unique times.
pub fn validate(param: &str, kfs: &[Keyframe]) -> Result<()> {
    for k in kfs {
        if !k.v.is_finite() {
            return Err(Error::validation(format!("keyframe value for '{param}' is not a number")));
        }
    }
    if kfs.windows(2).any(|w| w[0].t >= w[1].t) {
        return Err(Error::validation(format!("keyframes for '{param}' must have strictly increasing times")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(t: i64, v: f64, i: Interp) -> Keyframe {
        Keyframe { t: Rational::from_int(t), v, interp: i }
    }

    #[test]
    fn evaluates_each_interpolation() {
        let lin = [k(0, 0.0, Interp::Linear), k(2, 10.0, Interp::Linear)];
        assert_eq!(eval(&lin, -1.0), Some(0.0));
        assert_eq!(eval(&lin, 1.0), Some(5.0));
        assert_eq!(eval(&lin, 5.0), Some(10.0));
        let hold = [k(0, 1.0, Interp::Hold), k(2, 9.0, Interp::Linear)];
        assert_eq!(eval(&hold, 1.99), Some(1.0));
        assert_eq!(eval(&hold, 2.0), Some(9.0));
        let ei = [k(0, 0.0, Interp::EaseIn), k(2, 8.0, Interp::Linear)];
        assert_eq!(eval(&ei, 1.0), Some(2.0)); // p=.5 -> p^2=.25
        let eo = [k(0, 0.0, Interp::EaseOut), k(2, 8.0, Interp::Linear)];
        assert_eq!(eval(&eo, 1.0), Some(6.0)); // .5*(2-.5)=.75
        let eio = [k(0, 0.0, Interp::EaseInOut), k(2, 8.0, Interp::Linear)];
        assert_eq!(eval(&eio, 1.0), Some(4.0));
        assert_eq!(eval(&[], 1.0), None);
        assert_eq!(eval(&[k(3, 7.0, Interp::Linear)], 0.0), Some(7.0));
    }

    #[test]
    fn upsert_keeps_order_and_replaces() {
        let mut v = vec![];
        upsert(&mut v, k(2, 2.0, Interp::Linear));
        upsert(&mut v, k(0, 0.0, Interp::Linear));
        upsert(&mut v, k(1, 1.0, Interp::Hold));
        upsert(&mut v, k(1, 5.0, Interp::Linear));
        assert_eq!(v.iter().map(|x| (x.t.as_f64(), x.v)).collect::<Vec<_>>(), vec![(0.0, 0.0), (1.0, 5.0), (2.0, 2.0)]);
        assert!(validate("x", &v).is_ok());
        v.push(k(1, 0.0, Interp::Linear));
        assert!(validate("x", &v).is_err());
    }

    #[test]
    fn window_keeps_the_curve_identical_inside() {
        let kfs = [k(0, 0.0, Interp::Linear), k(2, 10.0, Interp::Linear), k(4, 0.0, Interp::Linear), k(6, 5.0, Interp::Linear)];
        // right half of a split at t=3: keys at 2 (before), 4, 6 survive, shifted by -3
        let w = window(&kfs, Rational::from_int(3), Rational::from_int(6), Rational::from_int(3));
        assert_eq!(w.iter().map(|x| x.t.as_f64()).collect::<Vec<_>>(), vec![-1.0, 1.0, 3.0]);
        for t in [3.0, 3.5, 4.0, 5.0, 6.0] {
            assert!((eval(&kfs, t).unwrap() - eval(&w, t - 3.0).unwrap()).abs() < 1e-9, "t={t}");
        }
        // left half: window [0,3], no shift
        let l = window(&kfs, Rational::ZERO, Rational::from_int(3), Rational::ZERO);
        assert_eq!(l.len(), 3);
        for t in [0.0, 1.0, 2.5, 3.0] {
            assert!((eval(&kfs, t).unwrap() - eval(&l, t).unwrap()).abs() < 1e-9);
        }
    }

    #[test]
    fn expression_shape() {
        let e = to_expr(&[k(0, 0.0, Interp::Linear), k(2, 1.0, Interp::Linear)], "t");
        assert_eq!(e, "if(lt(t,0),0,if(lt(t,2),(0+1*((t-0)/2)),1))");
        assert_eq!(to_expr(&[k(1, -0.5, Interp::Linear)], "t"), "(-0.5)");
        assert!(!to_expr(&[k(0, 0.0, Interp::EaseInOut), k(1, 1.0, Interp::Linear)], "t").contains('\''));
    }
}
