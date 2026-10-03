//! Pixel sorting: the glitch-art classic where runs of pixels along a row or column are reordered by brightness, hue
//! and so on. FFmpeg has no filter for it (and nothing in a filter graph can reorder pixels by value), so the sorting is
//! done here, on raw RGB frames, by the `bake` stage that runs before the final render.
//!
//! One pass over a frame is O(pixels): each span is sorted with a stable counting sort on an 8-bit key.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// What the pixels of a span are ordered by.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Key {
    Luma,
    Hue,
    Saturation,
    /// Brightest channel (HSV value).
    Value,
    Red,
    Green,
    Blue,
}

/// Which pixels form a span that gets sorted.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Mode {
    /// Runs of pixels whose brightness lies between the two thresholds (Kim Asendorf's original).
    Threshold,
    /// Every row (or column) is one span.
    Line,
    /// Spans of random length around `length`.
    Blocks,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Direction {
    Horizontal,
    Vertical,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Params {
    pub direction: Direction,
    pub key: Key,
    pub mode: Mode,
    /// Brightness thresholds (0..=255) of [`Mode::Threshold`].
    pub low: u8,
    pub high: u8,
    /// Mean span length of [`Mode::Blocks`], in pixels.
    pub length: u32,
    /// How far block lengths stray from `length` (0 = all equal, 1 = from 0 to twice as long).
    pub variation: f32,
    /// Sort from high to low instead of low to high.
    pub reverse: bool,
    /// 0 = untouched picture, 1 = fully sorted.
    pub mix: f32,
    pub seed: u64,
    /// Draw new random blocks on every frame instead of keeping one pattern.
    pub flicker: bool,
    /// Turns the sorting direction by this many degrees (positive = clockwise) from `direction`. Spans then follow diagonal
    /// lines of pixels, one pixel apart.
    #[serde(default)]
    pub angle: f32,
}

impl Default for Params {
    fn default() -> Self {
        Params { direction: Direction::Horizontal, key: Key::Luma, mode: Mode::Threshold, low: 64, high: 204, length: 120, variation: 0.5, reverse: false, mix: 1.0, seed: 1, flicker: false, angle: 0.0 }
    }
}

impl Params {
    /// Read the effect's parameter map (see the `pixel_sort` registry entry); missing entries keep their defaults.
    pub fn from_map(m: &BTreeMap<String, f64>) -> Params {
        let d = Params::default();
        let get = |k: &str| m.get(k).copied();
        let pick = |k: &str, n: usize| get(k).map(|v| (v.round().max(0.0) as usize).min(n - 1));
        Params {
            direction: [Direction::Horizontal, Direction::Vertical][pick("direction", 2).unwrap_or(0)],
            key: [Key::Luma, Key::Hue, Key::Saturation, Key::Value, Key::Red, Key::Green, Key::Blue][pick("key", 7).unwrap_or(0)],
            mode: [Mode::Threshold, Mode::Line, Mode::Blocks][pick("mode", 3).unwrap_or(0)],
            low: get("low").map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8).unwrap_or(d.low),
            high: get("high").map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8).unwrap_or(d.high),
            length: get("length").map(|v| v.clamp(2.0, 4000.0).round() as u32).unwrap_or(d.length),
            variation: get("variation").map(|v| v.clamp(0.0, 1.0) as f32).unwrap_or(d.variation),
            reverse: get("reverse").is_some_and(|v| v >= 0.5),
            mix: get("mix").map(|v| v.clamp(0.0, 1.0) as f32).unwrap_or(d.mix),
            seed: get("seed").map(|v| v.max(0.0).round() as u64).unwrap_or(d.seed),
            flicker: get("flicker").is_some_and(|v| v >= 0.5),
            angle: get("angle").map(|v| v.clamp(-90.0, 90.0) as f32).unwrap_or(d.angle),
        }
    }
}

/// splitmix64: tiny, fast, and the same sequence on every platform (so a bake is reproducible).
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in [0, 1).
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[inline]
fn luma(p: &[u8]) -> u8 {
    ((54 * p[0] as u32 + 183 * p[1] as u32 + 19 * p[2] as u32) >> 8) as u8
}

#[inline]
fn sort_key(key: Key, p: &[u8]) -> u8 {
    let (r, g, b) = (p[0] as i32, p[1] as i32, p[2] as i32);
    match key {
        Key::Luma => luma(p),
        Key::Red => p[0],
        Key::Green => p[1],
        Key::Blue => p[2],
        Key::Value => r.max(g).max(b) as u8,
        Key::Saturation => {
            let (mx, mn) = (r.max(g).max(b), r.min(g).min(b));
            if mx == 0 { 0 } else { ((mx - mn) * 255 / mx) as u8 }
        }
        Key::Hue => {
            let (mx, mn) = (r.max(g).max(b), r.min(g).min(b));
            let d = mx - mn;
            if d == 0 {
                return 0;
            }
            // sextant 0..6 in 1/256ths, then rescaled to 0..=255
            let h = if mx == r {
                ((g - b) * 256 / d).rem_euclid(6 * 256)
            } else if mx == g {
                (b - r) * 256 / d + 2 * 256
            } else {
                (r - g) * 256 / d + 4 * 256
            };
            (h * 255 / (6 * 256)) as u8
        }
    }
}

/// Sort `line` (RGB triples) in place according to `p`. `rng` is seeded per line by the caller.
fn sort_line(line: &mut [u8], p: &Params, rng: &mut Rng, scratch: &mut Vec<u8>, spans: &mut Vec<(usize, usize)>) {
    let n = line.len() / 3;
    spans.clear();
    match p.mode {
        Mode::Line => spans.push((0, n)),
        Mode::Threshold => {
            let mut start = None;
            for i in 0..n {
                let l = luma(&line[i * 3..i * 3 + 3]);
                let inside = l >= p.low && l <= p.high;
                match (inside, start) {
                    (true, None) => start = Some(i),
                    (false, Some(s)) => {
                        spans.push((s, i));
                        start = None;
                    }
                    _ => {}
                }
            }
            if let Some(s) = start {
                spans.push((s, n));
            }
        }
        Mode::Blocks => {
            let mut at = 0;
            while at < n {
                let scale = 1.0 + p.variation as f64 * (2.0 * rng.unit() - 1.0);
                let len = ((p.length as f64 * scale).round() as usize).max(2);
                spans.push((at, (at + len).min(n)));
                at += len;
            }
        }
    }
    let mix = (p.mix.clamp(0.0, 1.0) * 256.0).round() as u32;
    for &(a, b) in spans.iter() {
        let len = b - a;
        if len < 2 {
            continue;
        }
        // stable counting sort on the 8-bit key
        let mut counts = [0u32; 256];
        for i in a..b {
            counts[sort_key(p.key, &line[i * 3..i * 3 + 3]) as usize] += 1;
        }
        let mut next = [0u32; 256];
        let mut sum = 0;
        if p.reverse {
            for k in (0..256).rev() {
                next[k] = sum;
                sum += counts[k];
            }
        } else {
            for k in 0..256 {
                next[k] = sum;
                sum += counts[k];
            }
        }
        scratch.clear();
        scratch.resize(len * 3, 0);
        for i in a..b {
            let px = &line[i * 3..i * 3 + 3];
            let k = sort_key(p.key, px) as usize;
            let o = next[k] as usize * 3;
            next[k] += 1;
            scratch[o..o + 3].copy_from_slice(px);
        }
        if mix >= 256 {
            line[a * 3..b * 3].copy_from_slice(scratch);
        } else if mix > 0 {
            for (dst, src) in line[a * 3..b * 3].iter_mut().zip(scratch.iter()) {
                *dst = ((*dst as u32 * (256 - mix) + *src as u32 * mix) >> 8) as u8;
            }
        }
    }
}

/// Sort the rows of `buf` (`w` pixels wide, RGB24), spread over worker threads. `salt` varies the random blocks.
fn sort_rows(buf: &mut [u8], w: usize, p: &Params, salt: u64) {
    let row_bytes = w * 3;
    let rows = buf.len() / row_bytes;
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).min(rows.max(1)).min(16);
    let per = rows.div_ceil(threads.max(1)).max(1);
    std::thread::scope(|s| {
        for (c, chunk) in buf.chunks_mut(per * row_bytes).enumerate() {
            s.spawn(move || {
                let (mut scratch, mut spans) = (Vec::new(), Vec::new());
                for (r, line) in chunk.chunks_mut(row_bytes).enumerate() {
                    let y = (c * per + r) as u64;
                    let mut rng = Rng(p.seed.wrapping_mul(0x2545_F491_4F6C_DD1D) ^ salt.wrapping_mul(0x9E37_79B9) ^ y.wrapping_mul(0x85EB_CA6B));
                    sort_line(line, p, &mut rng, &mut scratch, &mut spans);
                }
            });
        }
    });
}

/// How a frame of one size is cut into lines for given settings. Planning is the costly part for angled sorts (every pixel
/// is assigned to a line once), so a bake makes one plan and reuses it for every frame.
pub struct Plan {
    w: usize,
    h: usize,
    kind: Kind,
}

enum Kind {
    Rows,
    Columns,
    /// Pixel indices of all lines one after another, and where each line starts (`starts.len() == lines + 1`).
    Lines { order: Vec<u32>, starts: Vec<usize> },
}

impl Plan {
    pub fn new(w: usize, h: usize, p: &Params) -> Plan {
        let kind = if p.angle.abs() < 0.5 {
            match p.direction {
                Direction::Horizontal => Kind::Rows,
                Direction::Vertical => Kind::Columns,
            }
        } else {
            let base = if p.direction == Direction::Vertical { 90.0 } else { 0.0 };
            let (order, starts) = angled_lines(w, h, (base + p.angle as f64).to_radians());
            Kind::Lines { order, starts }
        };
        Plan { w, h, kind }
    }

    /// Pixel-sort one RGB24 frame in place. `frame` is its index in the clip (only used when the blocks flicker).
    pub fn sort(&self, buf: &mut [u8], p: &Params, frame: u64) {
        let (w, h) = (self.w, self.h);
        assert_eq!(buf.len(), w * h * 3, "frame buffer does not match {w}x{h} RGB24");
        let salt = if p.flicker { frame + 1 } else { 0 };
        match &self.kind {
            Kind::Rows => sort_rows(buf, w, p, salt),
            Kind::Columns => {
                // sort columns by turning them into rows, and back
                let mut t = vec![0u8; buf.len()];
                for y in 0..h {
                    for x in 0..w {
                        let (s, d) = ((y * w + x) * 3, (x * h + y) * 3);
                        t[d..d + 3].copy_from_slice(&buf[s..s + 3]);
                    }
                }
                sort_rows(&mut t, h, p, salt);
                for y in 0..h {
                    for x in 0..w {
                        let (s, d) = ((x * h + y) * 3, (y * w + x) * 3);
                        buf[d..d + 3].copy_from_slice(&t[s..s + 3]);
                    }
                }
            }
            Kind::Lines { order, starts } => {
                // gather the lines one after another, sort them in parallel, scatter back
                let mut g = vec![0u8; buf.len()];
                for (i, &px) in order.iter().enumerate() {
                    let px = px as usize * 3;
                    g[i * 3..i * 3 + 3].copy_from_slice(&buf[px..px + 3]);
                }
                sort_ragged(&mut g, starts, p, salt);
                for (i, &px) in order.iter().enumerate() {
                    let px = px as usize * 3;
                    buf[px..px + 3].copy_from_slice(&g[i * 3..i * 3 + 3]);
                }
            }
        }
    }
}

/// Cut a `w` x `h` frame into parallel lines running at `theta` radians (0 = left to right, positive turns towards the
/// bottom), one pixel apart. Every pixel is on exactly one line, ordered along it.
fn angled_lines(w: usize, h: usize, theta: f64) -> (Vec<u32>, Vec<usize>) {
    let (sn, cs) = theta.sin_cos();
    let mut items: Vec<(i32, i64, u32)> = Vec::with_capacity(w * h);
    for y in 0..h {
        for x in 0..w {
            let (xf, yf) = (x as f64, y as f64);
            let across = (-xf * sn + yf * cs).round() as i32;
            let along = ((xf * cs + yf * sn) * 1024.0).round() as i64;
            items.push((across, along, (y * w + x) as u32));
        }
    }
    items.sort_unstable();
    let order: Vec<u32> = items.iter().map(|i| i.2).collect();
    let mut starts = vec![0usize];
    for i in 1..items.len() {
        if items[i].0 != items[i - 1].0 {
            starts.push(i);
        }
    }
    starts.push(items.len());
    (order, starts)
}

/// Sort lines of different lengths (`starts` are pixel offsets; `buf` holds them back to back), spread over worker threads.
fn sort_ragged(buf: &mut [u8], starts: &[usize], p: &Params, salt: u64) {
    let lines = starts.len() - 1;
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).min(lines.max(1)).min(16);
    let per = lines.div_ceil(threads.max(1)).max(1);
    std::thread::scope(|s| {
        let mut rest = buf;
        for first in (0..lines).step_by(per) {
            let last = (first + per).min(lines);
            let (chunk, tail) = rest.split_at_mut((starts[last] - starts[first]) * 3);
            rest = tail;
            s.spawn(move || {
                let (mut scratch, mut spans) = (Vec::new(), Vec::new());
                let mut at = 0;
                for l in first..last {
                    let len = (starts[l + 1] - starts[l]) * 3;
                    let mut rng = Rng(p.seed.wrapping_mul(0x2545_F491_4F6C_DD1D) ^ salt.wrapping_mul(0x9E37_79B9) ^ (l as u64).wrapping_mul(0x85EB_CA6B));
                    sort_line(&mut chunk[at..at + len], p, &mut rng, &mut scratch, &mut spans);
                    at += len;
                }
            });
        }
    });
}

/// Pixel-sort one RGB24 frame in place. `frame` is its index in the clip (only used when the blocks flicker). For many
/// frames of one size make a [`Plan`] once instead.
pub fn sort_frame(buf: &mut [u8], w: usize, h: usize, p: &Params, frame: u64) {
    Plan::new(w, h, p).sort(buf, p, frame);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gray_row(vals: &[u8]) -> Vec<u8> {
        vals.iter().flat_map(|v| [*v, *v, *v]).collect()
    }
    fn lumas(buf: &[u8]) -> Vec<u8> {
        buf.chunks(3).map(|p| p[0]).collect()
    }
    fn line_mode() -> Params {
        Params { mode: Mode::Line, ..Params::default() }
    }

    #[test]
    fn a_whole_row_comes_out_in_order() {
        let mut f = gray_row(&[200, 10, 90, 255, 0, 128, 64, 33]);
        sort_frame(&mut f, 8, 1, &line_mode(), 0);
        assert_eq!(lumas(&f), vec![0, 10, 33, 64, 90, 128, 200, 255]);
    }

    #[test]
    fn reverse_sorts_downwards() {
        let mut f = gray_row(&[5, 200, 9, 100]);
        sort_frame(&mut f, 4, 1, &Params { reverse: true, ..line_mode() }, 0);
        assert_eq!(lumas(&f), vec![200, 100, 9, 5]);
    }

    #[test]
    fn threshold_only_sorts_the_runs_inside_the_range() {
        // 250 and 3 are outside 64..=204 and must stay exactly where they are; the two runs in between are sorted separately
        let mut f = gray_row(&[150, 70, 120, 250, 200, 100, 3, 180, 90]);
        sort_frame(&mut f, 9, 1, &Params { mode: Mode::Threshold, low: 64, high: 204, ..Params::default() }, 0);
        assert_eq!(lumas(&f), vec![70, 120, 150, 250, 100, 200, 3, 90, 180]);
    }

    #[test]
    fn sorting_only_rearranges_pixels() {
        let mut f: Vec<u8> = (0..30 * 17 * 3).map(|i| ((i * 7919) % 251) as u8).collect();
        let mut before: Vec<[u8; 3]> = f.chunks(3).map(|p| [p[0], p[1], p[2]]).collect();
        sort_frame(&mut f, 30, 17, &Params { mode: Mode::Blocks, length: 6, key: Key::Hue, ..Params::default() }, 0);
        let mut after: Vec<[u8; 3]> = f.chunks(3).map(|p| [p[0], p[1], p[2]]).collect();
        assert_ne!(before, after, "something must have moved");
        before.sort();
        after.sort();
        assert_eq!(before, after, "pixels were created or lost");
    }

    #[test]
    fn vertical_sorts_columns_not_rows() {
        // 2 wide x 3 tall: column 0 = 30,10,20 ; column 1 = 5,9,7
        let mut f = vec![30, 30, 30, 5, 5, 5, 10, 10, 10, 9, 9, 9, 20, 20, 20, 7, 7, 7];
        sort_frame(&mut f, 2, 3, &Params { direction: Direction::Vertical, ..line_mode() }, 0);
        assert_eq!(lumas(&f), vec![10, 5, 20, 7, 30, 9]);
    }

    #[test]
    fn angled_lines_cover_every_pixel_once_and_follow_the_angle() {
        let (w, h) = (23, 17);
        for deg in [-60.0f64, -45.0, -10.0, 10.0, 30.0, 45.0, 80.0] {
            let (order, starts) = angled_lines(w, h, deg.to_radians());
            let mut seen = vec![false; w * h];
            for &i in &order {
                assert!(!std::mem::replace(&mut seen[i as usize], true), "pixel {i} is on two lines at {deg}°");
            }
            assert!(seen.iter().all(|s| *s), "a pixel is on no line at {deg}°");
            assert_eq!(*starts.last().unwrap(), w * h);
            let (sn, cs) = deg.to_radians().sin_cos();
            for l in 0..starts.len() - 1 {
                let line = &order[starts[l]..starts[l + 1]];
                let along = |i: u32| (i as usize % w) as f64 * cs + (i as usize / w) as f64 * sn;
                assert!(line.windows(2).all(|p| along(p[0]) <= along(p[1]) + 1e-6), "a line is not ordered along {deg}°");
            }
        }
    }

    #[test]
    fn a_forty_five_degree_sort_orders_the_pixels_on_each_diagonal() {
        let (w, h) = (16, 16);
        let mut f: Vec<u8> = (0..w * h).flat_map(|i| { let v = ((i * 7919 + 13) % 251) as u8; [v, v, v] }).collect();
        let p = Params { mode: Mode::Line, angle: 45.0, ..Params::default() };
        let plan = Plan::new(w, h, &p);
        plan.sort(&mut f, &p, 0);
        let Kind::Lines { order, starts } = &plan.kind else { panic!("an angled sort plans lines") };
        for l in 0..starts.len() - 1 {
            let v: Vec<u8> = order[starts[l]..starts[l + 1]].iter().map(|&i| f[i as usize * 3]).collect();
            assert!(v.windows(2).all(|p| p[0] <= p[1]), "line {l} is not sorted: {v:?}");
        }
    }

    #[test]
    fn a_tiny_angle_is_the_plain_sort_and_a_big_one_is_not() {
        let src: Vec<u8> = (0..20 * 12 * 3).map(|i| ((i * 7919) % 251) as u8).collect();
        let base = Params { mode: Mode::Line, ..Params::default() };
        let (mut a, mut b, mut c) = (src.clone(), src.clone(), src.clone());
        sort_frame(&mut a, 20, 12, &base, 0);
        sort_frame(&mut b, 20, 12, &Params { angle: 0.2, ..base.clone() }, 0);
        sort_frame(&mut c, 20, 12, &Params { angle: 30.0, ..base }, 0);
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn mix_zero_leaves_the_picture_alone_and_half_lands_between() {
        let orig = gray_row(&[200, 0]);
        let mut f = orig.clone();
        sort_frame(&mut f, 2, 1, &Params { mix: 0.0, ..line_mode() }, 0);
        assert_eq!(f, orig);
        let mut f = orig.clone();
        sort_frame(&mut f, 2, 1, &Params { mix: 0.5, ..line_mode() }, 0);
        // sorted would be [0, 200]; halfway from [200, 0]
        assert_eq!(lumas(&f), vec![100, 100]);
    }

    #[test]
    fn keys_order_by_what_they_name() {
        let red = [255u8, 0, 0];
        let green = [0u8, 255, 0];
        let blue = [0u8, 0, 255];
        assert!(sort_key(Key::Hue, &red) < sort_key(Key::Hue, &green) && sort_key(Key::Hue, &green) < sort_key(Key::Hue, &blue));
        assert!(sort_key(Key::Luma, &green) > sort_key(Key::Luma, &red) && sort_key(Key::Luma, &red) > sort_key(Key::Luma, &blue));
        assert_eq!(sort_key(Key::Saturation, &[100, 100, 100]), 0);
        assert_eq!(sort_key(Key::Saturation, &red), 255);
        assert_eq!(sort_key(Key::Value, &[10, 90, 40]), 90);
        assert_eq!((sort_key(Key::Red, &red), sort_key(Key::Green, &red), sort_key(Key::Blue, &blue)), (255, 0, 255));
    }

    #[test]
    fn random_blocks_repeat_unless_asked_to_flicker() {
        let src: Vec<u8> = (0..64 * 4 * 3).map(|i| ((i * 37 + i / 5) % 256) as u8).collect();
        let run = |p: &Params, frame: u64| {
            let mut f = src.clone();
            sort_frame(&mut f, 64, 4, p, frame);
            f
        };
        let steady = Params { mode: Mode::Blocks, length: 10, variation: 0.9, ..Params::default() };
        assert_eq!(run(&steady, 0), run(&steady, 7), "same pattern every frame");
        let other_seed = Params { seed: 2, ..steady.clone() };
        assert_ne!(run(&steady, 0), run(&other_seed, 0), "the seed changes the pattern");
        let flicker = Params { flicker: true, ..steady };
        assert_ne!(run(&flicker, 0), run(&flicker, 1), "flicker draws new blocks per frame");
        assert_eq!(run(&flicker, 3), run(&flicker, 3), "but deterministically");
    }

    #[test]
    fn params_come_from_the_effect_map_and_are_clamped() {
        let m: BTreeMap<String, f64> = [("direction", 1.0), ("key", 99.0), ("mode", 2.0), ("low", -3.0), ("high", 0.5), ("reverse", 1.0), ("mix", 7.0), ("length", 1.0)]
            .iter()
            .map(|(k, v)| (k.to_string(), *v))
            .collect();
        let p = Params::from_map(&m);
        assert_eq!((p.direction, p.key, p.mode, p.low, p.high), (Direction::Vertical, Key::Blue, Mode::Blocks, 0, 128));
        assert!(p.reverse && p.mix == 1.0 && p.length == 2);
        assert_eq!(Params::from_map(&BTreeMap::new()), Params::default());
    }
}
