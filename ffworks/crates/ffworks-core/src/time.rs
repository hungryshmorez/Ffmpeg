//! Exact rational time. Floating-point seconds are never authoritative (spec §105).
//!
//! `Rational` is a normalised fraction of seconds (`den > 0`, `gcd(|num|,den) == 1`).
//! Frame rates such as 30000/1001 therefore never accumulate drift: frame N of an
//! NTSC sequence is exactly `N * 1001 / 30000` seconds.

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use std::cmp::Ordering;
use std::fmt;
use std::ops::{Add, Neg, Sub};
use std::str::FromStr;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Rational {
    num: i64,
    den: i64,
}

fn gcd(mut a: i128, mut b: i128) -> i128 {
    a = a.abs();
    b = b.abs();
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

impl Default for Rational {
    fn default() -> Self {
        Rational::ZERO
    }
}

impl Rational {
    pub const ZERO: Rational = Rational { num: 0, den: 1 };

    /// Build a normalised rational. `den == 0` is clamped to 1 (callers validate input earlier).
    pub fn new(num: i64, den: i64) -> Rational {
        Self::from_i128(num as i128, den as i128)
    }

    fn from_i128(num: i128, den: i128) -> Rational {
        let (mut n, mut d) = if den == 0 { (num, 1) } else { (num, den) };
        if d < 0 {
            n = -n;
            d = -d;
        }
        let g = gcd(n, d).max(1);
        Rational { num: (n / g) as i64, den: (d / g) as i64 }
    }

    pub fn from_int(n: i64) -> Rational {
        Rational { num: n, den: 1 }
    }

    pub fn num(self) -> i64 {
        self.num
    }
    pub fn den(self) -> i64 {
        self.den
    }

    /// Approximate float for display and for FFmpeg expressions only.
    pub fn as_f64(self) -> f64 {
        self.num as f64 / self.den as f64
    }

    pub fn is_zero(self) -> bool {
        self.num == 0
    }

    /// Convert from float seconds (only used at the boundary, e.g. FFprobe `duration`).
    /// Rounds to microsecond precision.
    pub fn from_secs_f64(s: f64) -> Rational {
        Rational::new((s * 1_000_000.0).round() as i64, 1_000_000)
    }

    #[allow(clippy::should_implement_trait)]
    pub fn mul(self, o: Rational) -> Rational {
        Self::from_i128(self.num as i128 * o.num as i128, self.den as i128 * o.den as i128)
    }

    #[allow(clippy::should_implement_trait)]
    pub fn div(self, o: Rational) -> Rational {
        Self::from_i128(self.num as i128 * o.den as i128, self.den as i128 * o.num as i128)
    }

    pub fn mul_int(self, k: i64) -> Rational {
        Self::from_i128(self.num as i128 * k as i128, self.den as i128)
    }

    /// floor(self * rate) where `rate` is a frame/sample rate.
    pub fn floor_units(self, rate: Rational) -> i64 {
        let n = self.num as i128 * rate.num as i128;
        let d = self.den as i128 * rate.den as i128;
        n.div_euclid(d) as i64
    }

    /// round-half-up(self * rate).
    pub fn round_units(self, rate: Rational) -> i64 {
        let n = self.num as i128 * rate.num as i128;
        let d = self.den as i128 * rate.den as i128;
        (2 * n + d).div_euclid(2 * d) as i64
    }

    pub fn min(self, o: Rational) -> Rational {
        if self <= o { self } else { o }
    }
    pub fn max(self, o: Rational) -> Rational {
        if self >= o { self } else { o }
    }
}

impl Add for Rational {
    type Output = Rational;
    fn add(self, o: Rational) -> Rational {
        Self::from_i128(
            self.num as i128 * o.den as i128 + o.num as i128 * self.den as i128,
            self.den as i128 * o.den as i128,
        )
    }
}
impl Sub for Rational {
    type Output = Rational;
    fn sub(self, o: Rational) -> Rational {
        self + (-o)
    }
}
impl Neg for Rational {
    type Output = Rational;
    fn neg(self) -> Rational {
        Rational { num: -self.num, den: self.den }
    }
}
impl PartialOrd for Rational {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Rational {
    fn cmp(&self, o: &Self) -> Ordering {
        (self.num as i128 * o.den as i128).cmp(&(o.num as i128 * self.den as i128))
    }
}

impl fmt::Display for Rational {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.den == 1 {
            write!(f, "{}", self.num)
        } else {
            write!(f, "{}/{}", self.num, self.den)
        }
    }
}

impl FromStr for Rational {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        let s = s.trim();
        if let Some((n, d)) = s.split_once('/') {
            let n: i64 = n.trim().parse().map_err(|_| format!("bad rational '{s}'"))?;
            let d: i64 = d.trim().parse().map_err(|_| format!("bad rational '{s}'"))?;
            if d == 0 {
                return Err(format!("zero denominator in '{s}'"));
            }
            Ok(Rational::new(n, d))
        } else {
            s.parse::<i64>().map(Rational::from_int).map_err(|_| format!("bad rational '{s}'"))
        }
    }
}

impl Serialize for Rational {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
impl<'de> Deserialize<'de> for Rational {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(de::Error::custom)
    }
}

/// Frame rate as an exact rational (frames per second).
pub type Fps = Rational;

/// Time of frame `n` for the given frame rate.
pub fn frame_to_time(frame: i64, fps: Fps) -> Rational {
    Rational::new(frame, 1).div(fps)
}

/// Nearest frame to `t`.
pub fn time_to_frame(t: Rational, fps: Fps) -> i64 {
    t.round_units(fps)
}

/// Snap `t` to the nearest frame boundary of `fps`.
pub fn snap_to_frame(t: Rational, fps: Fps) -> Rational {
    frame_to_time(time_to_frame(t, fps), fps)
}

/// Parse an FFprobe frame rate such as "30000/1001" or "25/1". Returns None for "0/0".
pub fn parse_fps(s: &str) -> Option<Fps> {
    let r: Rational = s.parse().ok()?;
    if r.num() <= 0 { None } else { Some(r) }
}

/// Non-drop timecode `HH:MM:SS:FF` using the nominal (rounded) frame rate.
pub fn timecode(t: Rational, fps: Fps) -> String {
    let nominal = fps.round_units(Rational::from_int(1)).max(1);
    let total = time_to_frame(t.max(Rational::ZERO), fps);
    let ff = total % nominal;
    let secs = total / nominal;
    format!("{:02}:{:02}:{:02}:{:02}", secs / 3600, (secs / 60) % 60, secs % 60, ff)
}


#[cfg(test)]
mod tests {
    use super::*;

    const NTSC: Fps = Rational { num: 30000, den: 1001 };

    #[test]
    fn normalises() {
        assert_eq!(Rational::new(2, 4), Rational::new(1, 2));
        assert_eq!(Rational::new(1, -2), Rational::new(-1, 2));
    }

    #[test]
    fn arithmetic_is_exact() {
        let third = Rational::new(1, 3);
        assert_eq!(third + third + third, Rational::from_int(1));
        assert_eq!(Rational::new(1, 2) - Rational::new(1, 3), Rational::new(1, 6));
    }

    #[test]
    fn ntsc_has_no_drift_over_ten_hours() {
        // 10 hours of 29.97 frames, computed frame-by-frame vs. by one multiplication.
        let frames: i64 = 1_080_000 * 29 + 1_080_000 / 1000 * 970; // arbitrary large count
        let direct = frame_to_time(frames, NTSC);
        let mut acc = Rational::ZERO;
        let step = frame_to_time(1, NTSC);
        for _ in 0..10_000 {
            acc = acc + step;
        }
        assert_eq!(acc, frame_to_time(10_000, NTSC));
        assert_eq!(time_to_frame(direct, NTSC), frames);
    }

    #[test]
    fn frame_roundtrip_for_common_rates() {
        for fps in [Rational::new(24000, 1001), Rational::new(30000, 1001), Rational::new(60000, 1001), Rational::from_int(25)] {
            for f in [0, 1, 2, 29, 30, 1000, 123_456] {
                assert_eq!(time_to_frame(frame_to_time(f, fps), fps), f);
            }
        }
    }

    #[test]
    fn snapping() {
        let fps = Rational::from_int(30);
        assert_eq!(snap_to_frame(Rational::new(1, 70), fps), frame_to_time(0, fps) + Rational::ZERO);
        assert_eq!(snap_to_frame(Rational::new(1, 50), fps), Rational::new(1, 30));
    }

    #[test]
    fn serde_string_form() {
        let s = serde_json::to_string(&NTSC).unwrap();
        assert_eq!(s, "\"30000/1001\"");
        let r: Rational = serde_json::from_str(&s).unwrap();
        assert_eq!(r, NTSC);
        assert!(serde_json::from_str::<Rational>("\"1/0\"").is_err());
    }

    #[test]
    fn timecode_format() {
        let fps = Rational::from_int(30);
        assert_eq!(timecode(Rational::new(3661, 1) + Rational::new(15, 30), fps), "01:01:01:15");
    }

    #[test]
    fn parse_ffprobe_fps() {
        assert_eq!(parse_fps("30000/1001"), Some(NTSC));
        assert_eq!(parse_fps("0/0"), None);
    }

    #[test]
    fn floor_and_round_units() {
        let sr = Rational::from_int(48000);
        let t = Rational::new(1, 3);
        assert_eq!(t.floor_units(sr), 16000);
        assert_eq!(Rational::new(1, 7).round_units(sr), 6857);
    }
}
