//! Frame lab: classic datamoshing by editing the *order of the compressed frames* inside an AVI file, with stock FFmpeg only.
//!
//! The clip's source range is encoded to MPEG-4 (no B-frames, a full picture every N frames) in an AVI container; this module
//! reads the AVI's `movi` list, rearranges / repeats / removes whole frames, writes a valid AVI again, and FFmpeg decodes it into
//! a lossless FFV1 file. Because a predicted frame only stores *change*, removing the full pictures (keyframes) makes later
//! motion pile onto an old picture; repeating one predicted frame makes its motion bloom; shuffling frames makes the picture
//! tear itself apart. Like the other labs the result is a **new file**; the original clip is never touched.
//!
//! The techniques (frame modes `void`, `random`, `reverse`, `invert`, `bloom`, `pulse`, `overlap`, `jiggle`, the keyframe removal
//! and the "kill frames with too much data" option) come from `tomato` by Kaspar Ravel (MIT) and the effects list of Datamosher
//! Pro by Akascape (MIT); both are credited in `THIRD_PARTY_NOTICES.md`. This is a clean reimplementation in Rust around the
//! documented AVI layout: no code was copied.
//!
//! Only plain single-RIFF AVI files with one video stream are handled (what FFmpeg writes for anything under 1 GiB).

use crate::error::{Error, Result};
use crate::jobs::CancelToken;
use crate::moshlab::Source;
use crate::process::{explain_failure, run_cancellable, Tools};
use crate::time::{Fps, Rational};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// `(id, name, what it does)` for the interface.
pub const MODES: &[(&str, &str, &str)] = &[
    ("classic", "Classic", "Only the full pictures are removed: motion keeps piling onto the last picture before them"),
    ("random", "Random", "Frames in a random order"),
    ("reverse", "Reverse", "Frames backwards: movement melts the wrong way"),
    ("invert", "Invert", "Every two neighbouring frames swap places"),
    ("invert_reverse", "Invert + reverse", "Neighbours swap, then everything runs backwards"),
    ("bloom", "Bloom", "One frame repeats many times: its movement keeps going and the picture blooms outward"),
    ("pulse", "Pulse", "Every N frames, one frame repeats a few times"),
    ("overlap", "Overlap", "Groups of frames taken from every N-th position, so they play twice"),
    ("jiggle", "Jiggle", "Each frame is taken from somewhere close by"),
    ("repeat", "Repeat", "A short group of frames plays over and over: a melting loop"),
    ("sort", "Sort by size", "Frames sorted by how much data they hold: quiet to busy (or the reverse)"),
    ("splice", "Splice another clip", "The picture of this clip, then the *movement* of another one: the classic transition mosh"),
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Mode {
    Classic,
    Random { seed: u64 },
    Reverse,
    Invert,
    InvertReverse,
    /// Frame number `at` (counted after the removals, not counting the kept first frame, which is 0 here) is shown `count` more times.
    Bloom { count: u32, at: u32 },
    /// Every `every`-th frame (counted like `Bloom`'s) is shown `count` more times.
    Pulse { count: u32, every: u32 },
    /// Groups of `count` frames starting at every `every`-th frame: with 4 and 2, 1 2 3 4 3 4 5 6 5 6 7 8 …
    Overlap { count: u32, every: u32 },
    /// Frame i is replaced by one up to `spread` frames away (either side).
    Jiggle { spread: u32, seed: u64 },
    /// From frame `at`, the next `count` frames play over and over until the end.
    Repeat { count: u32, at: u32 },
    Sort { descending: bool },
    /// This clip untouched up to `at` seconds, then only the predicted frames of `donor` (its full pictures are always removed;
    /// the keyframe and first-frame options do not apply).
    Splice { donor: Source, at: Rational },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    pub mode: Mode,
    /// Frames between full pictures in the encoded clip (1 to 600). Few = many removal points; many = one long hold.
    pub keyframe_every: u32,
    /// Remove the full pictures (keyframes). The usual first step of datamoshing.
    pub drop_keyframes: bool,
    /// Keep the very first frame (the one the decoder needs to start) even though it is a keyframe, and leave it out of the mode.
    pub keep_first: bool,
    /// Remove frames holding more than this fraction (0.05 to 1) of the data of the biggest remaining frame; None keeps them.
    pub kill: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct Request {
    pub source: Source,
    pub settings: Settings,
    pub width: u32,
    pub height: u32,
    pub fps: Fps,
    /// The finished FFV1 file (`.mkv`).
    pub output: PathBuf,
}

// ---- AVI reading and writing -------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// A full picture (MPEG-4 I-VOP).
    Intra,
    /// Anything that depends on earlier pictures (including empty "not coded" frames).
    Predicted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    pub data: Vec<u8>,
    pub kind: Kind,
}

/// The frames of one AVI plus everything before its `movi` list, ready to be rewritten.
#[derive(Clone, Debug)]
pub struct Avi {
    head: Vec<u8>,
    pub frames: Vec<Frame>,
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn bad(why: &str) -> Error {
    Error::validation(format!("the encoded clip is not an AVI file this lab understands ({why})"))
}

/// MPEG-4 start code of a video object plane, then its two-bit coding type (0 = I).
fn classify(data: &[u8]) -> Kind {
    let at = data.windows(4).position(|w| w == [0, 0, 1, 0xB6]);
    match at.and_then(|i| data.get(i + 4)) {
        Some(b) if b >> 6 == 0 => Kind::Intra,
        _ => Kind::Predicted,
    }
}

/// The decoder-setup bytes in front of the first picture (the part before its first VOP start code), if present.
fn setup_header(data: &[u8]) -> Option<&[u8]> {
    if !data.starts_with(&[0, 0, 1, 0xB0]) {
        return None;
    }
    let end = data.windows(4).position(|w| w == [0, 0, 1, 0xB6])?;
    Some(&data[..end])
}

impl Avi {
    pub fn parse(bytes: &[u8]) -> Result<Avi> {
        if bytes.get(0..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"AVI ") {
            return Err(bad("no RIFF/AVI header"));
        }
        let riff_end = (u32_at(bytes, 4).ok_or_else(|| bad("truncated"))? as usize + 8).min(bytes.len());
        let mut pos = 12usize;
        let mut frames = vec![];
        let mut movi_at = None;
        while pos + 8 <= riff_end {
            let id = &bytes[pos..pos + 4];
            let size = u32_at(bytes, pos + 4).ok_or_else(|| bad("truncated"))? as usize;
            let body = pos + 8;
            if id == b"LIST" && bytes.get(body..body + 4) == Some(b"movi") {
                movi_at = Some(pos);
                let end = (body + size).min(bytes.len());
                let mut p = body + 4;
                while p + 8 <= end {
                    let cid = &bytes[p..p + 4];
                    let csize = u32_at(bytes, p + 4).ok_or_else(|| bad("truncated"))? as usize;
                    let data_at = p + 8;
                    if data_at + csize > bytes.len() {
                        return Err(bad("a frame runs past the end of the file"));
                    }
                    if cid.starts_with(b"00") && (&cid[2..] == b"dc" || &cid[2..] == b"db") {
                        let data = bytes[data_at..data_at + csize].to_vec();
                        let kind = classify(&data);
                        frames.push(Frame { data, kind });
                    }
                    p = data_at + csize + (csize & 1);
                }
                break;
            }
            pos = body + size + (size & 1);
        }
        let movi_at = movi_at.ok_or_else(|| bad("no frame list"))?;
        if bytes.get(riff_end..riff_end + 4) == Some(b"RIFF") {
            return Err(bad("it is longer than 1 GiB, which needs the OpenDML layout"));
        }
        if frames.is_empty() {
            return Err(bad("no video frames"));
        }
        Ok(Avi { head: bytes[12..movi_at].to_vec(), frames })
    }

    /// A complete AVI with exactly `order` as its frames (counts in the header and a fresh index included).
    pub fn write(&self, order: &[Frame]) -> Vec<u8> {
        let mut head = self.head.clone();
        patch_header(&mut head, order.len() as u32);
        let mut movi: Vec<u8> = b"movi".to_vec();
        let mut index: Vec<u8> = vec![];
        for f in order {
            let offset = movi.len() as u32; // from the "movi" tag to this chunk's header
            movi.extend_from_slice(b"00dc");
            movi.extend_from_slice(&(f.data.len() as u32).to_le_bytes());
            movi.extend_from_slice(&f.data);
            if f.data.len() % 2 == 1 {
                movi.push(0);
            }
            index.extend_from_slice(b"00dc");
            index.extend_from_slice(&(if f.kind == Kind::Intra { 0x10u32 } else { 0 }).to_le_bytes());
            index.extend_from_slice(&offset.to_le_bytes());
            index.extend_from_slice(&(f.data.len() as u32).to_le_bytes());
        }
        let mut out = Vec::with_capacity(head.len() + movi.len() + index.len() + 64);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(b"AVI ");
        out.extend_from_slice(&head);
        out.extend_from_slice(b"LIST");
        out.extend_from_slice(&(movi.len() as u32).to_le_bytes());
        out.extend_from_slice(&movi);
        out.extend_from_slice(b"idx1");
        out.extend_from_slice(&(index.len() as u32).to_le_bytes());
        out.extend_from_slice(&index);
        let size = (out.len() - 8) as u32;
        out[4..8].copy_from_slice(&size.to_le_bytes());
        out
    }
}

/// Walk the chunks of `buf[start..end]` (recursing into `hdrl`, `strl` and `odml` lists) and fix what depends on the frame count:
/// total frames in the main header, the stream length, the OpenDML total; the old super index (`indx`) becomes padding.
fn patch_header(buf: &mut [u8], count: u32) {
    fn walk(buf: &mut [u8], start: usize, end: usize, count: u32) {
        let mut pos = start;
        let end = end.min(buf.len());
        while pos + 8 <= end {
            let id: [u8; 4] = [buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]];
            let size = u32_at(buf, pos + 4).unwrap_or(0) as usize;
            let body = pos + 8;
            match &id {
                b"LIST" if body + 4 <= end => {
                    let form: [u8; 4] = [buf[body], buf[body + 1], buf[body + 2], buf[body + 3]];
                    if matches!(&form, b"hdrl" | b"strl" | b"odml") {
                        walk(buf, body + 4, (body + size).min(end), count);
                    }
                }
                b"avih" if body + 20 <= end => buf[body + 16..body + 20].copy_from_slice(&count.to_le_bytes()),
                b"strh" if body + 36 <= end => buf[body + 32..body + 36].copy_from_slice(&count.to_le_bytes()),
                b"dmlh" if body + 4 <= end => buf[body..body + 4].copy_from_slice(&count.to_le_bytes()),
                b"indx" => buf[pos..pos + 4].copy_from_slice(b"JUNK"),
                _ => {}
            }
            pos = body + size + (size & 1);
        }
    }
    let len = buf.len();
    walk(buf, 0, len, count);
}

// ---- frame arrangement -------------------------------------------------------------------------------------------------

/// Small deterministic generator (the same seed always gives the same order).
struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Rng {
        Rng(seed ^ 0x9E37_79B9_7F4A_7C15 | 1)
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// Decide the order of the finished clip. Returns indexes into `a` followed by `b` (the donor's frames start at `a.len()`), at
/// most `cap` of them. Pure: no files, no FFmpeg.
pub fn order(a: &[Frame], b: &[Frame], s: &Settings, fps: Fps, cap: usize) -> Result<Vec<usize>> {
    if let Mode::Splice { at, .. } = &s.mode {
        // this clip untouched up to the splice moment, then only the donor's predicted frames
        let cut = at.floor_units(fps).max(0) as usize;
        if cut == 0 || cut >= a.len() {
            return Err(Error::validation(format!("the splice moment is frame {cut} but the clip has {} frames: pick a moment inside the clip", a.len())));
        }
        let mut all: Vec<usize> = (0..cut).collect();
        all.extend((0..b.len()).filter(|&i| b[i].kind != Kind::Intra).map(|i| a.len() + i));
        all.truncate(cap);
        return Ok(all);
    }
    let mut keep: Vec<usize> = (0..a.len()).collect();
    if s.drop_keyframes {
        keep.retain(|&i| a[i].kind != Kind::Intra || (i == 0 && s.keep_first));
    }
    let head: Vec<usize> = if s.keep_first && keep.first() == Some(&0) { vec![keep.remove(0)] } else { vec![] };
    if let Some(k) = s.kill {
        let biggest = keep.iter().map(|&i| a[i].data.len()).max().unwrap_or(0) as f64;
        keep.retain(|&i| a[i].data.len() as f64 <= k * biggest);
    }
    let mut body = keep;
    let len = body.len();
    let beyond = |what: &str, n: u32| Error::validation(format!("{what} {n} is beyond the {len} frames left after the removals"));
    match &s.mode {
        Mode::Classic => {}
        Mode::Random { seed } => {
            let mut r = Rng::new(*seed);
            for i in (1..len).rev() {
                body.swap(i, r.below(i + 1));
            }
        }
        Mode::Reverse => body.reverse(),
        Mode::Invert => swap_neighbours(&mut body),
        Mode::InvertReverse => {
            swap_neighbours(&mut body);
            body.reverse();
        }
        Mode::Bloom { count, at } => {
            let at = *at as usize;
            if at >= len {
                return Err(beyond("frame", at as u32));
            }
            let f = body[at];
            let mut out = body[..=at].to_vec();
            out.extend(std::iter::repeat_n(f, (*count as usize).min(cap)));
            out.extend_from_slice(&body[at + 1..]);
            body = out;
        }
        Mode::Pulse { count, every } => {
            let mut out = vec![];
            for (i, &f) in body.iter().enumerate() {
                out.push(f);
                if i > 0 && i % *every as usize == 0 {
                    out.extend(std::iter::repeat_n(f, *count as usize));
                }
                if out.len() >= cap {
                    break;
                }
            }
            body = out;
        }
        Mode::Overlap { count, every } => {
            let mut out = vec![];
            let mut at = 0usize;
            while at < len && out.len() < cap {
                out.extend_from_slice(&body[at..(at + *count as usize).min(len)]);
                at += *every as usize;
            }
            body = out;
        }
        Mode::Jiggle { spread, seed } => {
            let mut r = Rng::new(*seed);
            let spread = *spread as usize;
            let src = body.clone();
            for (i, slot) in body.iter_mut().enumerate() {
                let lo = i.saturating_sub(spread);
                let hi = (i + spread).min(len.saturating_sub(1));
                *slot = src[lo + r.below(hi - lo + 1)];
            }
        }
        Mode::Repeat { count, at } => {
            let (at, count) = (*at as usize, *count as usize);
            if at + count > len {
                return Err(Error::validation(format!("the group of {count} frames from frame {at} runs past the {len} frames left after the removals")));
            }
            let group = body[at..at + count].to_vec();
            let mut out = body[..at].to_vec();
            while out.len() < cap.max(len) {
                out.extend_from_slice(&group);
            }
            body = out;
        }
        Mode::Sort { descending } => {
            body.sort_by_key(|&i| a[i].data.len());
            if *descending {
                body.reverse();
            }
        }
        Mode::Splice { .. } => unreachable!("handled before the removals"),
    }
    let mut all = head;
    all.extend(body);
    all.truncate(cap);
    Ok(all)
}

fn swap_neighbours(v: &mut [usize]) {
    for pair in v.chunks_exact_mut(2) {
        pair.swap(0, 1);
    }
}

/// Frames of the result in order. If the first one lost the decoder setup bytes (its keyframe was removed), they are put back.
pub fn assemble(a: &[Frame], b: &[Frame], picks: &[usize]) -> Vec<Frame> {
    let mut out: Vec<Frame> = picks.iter().map(|&i| if i < a.len() { a[i].clone() } else { b[i - a.len()].clone() }).collect();
    if let (Some(first), Some(setup)) = (out.first_mut(), a.first().and_then(|f| setup_header(&f.data))) {
        if !first.data.starts_with(&[0, 0, 1, 0xB0]) {
            let mut data = setup.to_vec();
            data.extend_from_slice(&first.data);
            first.data = data;
        }
    }
    out
}

// ---- running -----------------------------------------------------------------------------------------------------------

/// Check the request without running anything.
pub fn validate(req: &Request) -> Result<()> {
    if req.source.duration <= Rational::ZERO || req.source.start < Rational::ZERO {
        return Err(Error::validation("the part of the clip to mosh is empty"));
    }
    if req.width < 16 || req.height < 16 || !req.width.is_multiple_of(2) || !req.height.is_multiple_of(2) {
        return Err(Error::validation("the project picture size must be even and at least 16 pixels"));
    }
    let s = &req.settings;
    if !(1..=600).contains(&s.keyframe_every) {
        return Err(Error::validation("keyframes every 1 to 600 frames"));
    }
    if s.kill.is_some_and(|k| !(0.05..=1.0).contains(&k)) {
        return Err(Error::validation("'kill big frames' is a fraction from 0.05 to 1"));
    }
    let range = |what: &str, v: u32, lo: u32, hi: u32| if (lo..=hi).contains(&v) { Ok(()) } else { Err(Error::validation(format!("{what} must be from {lo} to {hi}"))) };
    match &s.mode {
        Mode::Classic | Mode::Random { .. } | Mode::Reverse | Mode::Invert | Mode::InvertReverse | Mode::Sort { .. } => {
            if !s.drop_keyframes && matches!(s.mode, Mode::Classic) {
                return Err(Error::validation("Classic only removes keyframes: switch 'remove keyframes' on or pick another mode"));
            }
        }
        Mode::Bloom { count, at } => {
            range("repeats", *count, 1, 1000)?;
            range("frame number", *at, 0, 100_000)?;
        }
        Mode::Pulse { count, every } | Mode::Overlap { count, every } => {
            range("count", *count, 1, 1000)?;
            range("every", *every, 1, 1000)?;
        }
        Mode::Jiggle { spread, .. } => range("spread", *spread, 1, 100)?,
        Mode::Repeat { count, at } => {
            range("group size", *count, 1, 1000)?;
            range("frame number", *at, 0, 100_000)?;
        }
        Mode::Splice { donor, at } => {
            if donor.duration <= Rational::ZERO || donor.start < Rational::ZERO {
                return Err(Error::validation("the clip to take movement from is empty"));
            }
            if *at <= Rational::ZERO || *at >= req.source.duration {
                return Err(Error::validation("the splice moment must be inside the clip"));
            }
        }
    }
    Ok(())
}

/// Removes the working folder however the run ends.
struct Work(PathBuf);
impl Drop for Work {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn stage(tools: &Tools, args: &[String], what: &str, cancel: &CancelToken) -> Result<()> {
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-y"]).args(args);
    let out = run_cancellable(&mut cmd, cancel)?;
    if !out.status.success() {
        return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: out.status.code(), hint: format!("{what}: {}", explain_failure(&String::from_utf8_lossy(&out.stderr))) });
    }
    Ok(())
}

fn path_arg(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Encode a stretch of source to the AVI this lab edits (MPEG-4, no B-frames, `settings.keyframe_every` between full pictures).
pub fn encode_avi(tools: &Tools, src: &Source, req: &Request, to: &Path, cancel: &CancelToken) -> Result<()> {
    let (w, h) = (req.width, req.height);
    let fps = format!("{}/{}", req.fps.num(), req.fps.den());
    let fit = format!("fps={fps},scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p");
    stage(
        tools,
        &["-threads".into(), "1".into(), "-ss".into(), crate::ffmpeg::secs(src.start), "-t".into(), crate::ffmpeg::secs(src.duration), "-i".into(), path_arg(&src.path), "-an".into(), "-vf".into(), fit, "-threads".into(), "1".into(), "-c:v".into(), "mpeg4".into(), "-qscale:v".into(), "3".into(), "-g".into(), req.settings.keyframe_every.to_string(), "-sc_threshold".into(), "1000000".into(), "-bf".into(), "0".into(), "-f".into(), "avi".into(), path_arg(to)],
        "reading the clip",
        cancel,
    )
}

fn read_avi(path: &Path) -> Result<Avi> {
    Avi::parse(&std::fs::read(path).map_err(|e| Error::io(path, e))?)
}

/// Run the lab. `on_progress` gets 0..=1 (by stage). Writes `req.output` atomically; nothing is left behind on failure or cancel.
pub fn run(tools: &Tools, req: &Request, cancel: &CancelToken, on_progress: &mut dyn FnMut(f64)) -> Result<()> {
    validate(req)?;
    if let Some(dir) = req.output.parent() {
        std::fs::create_dir_all(dir).map_err(|e| Error::io(dir, e))?;
    }
    let work = Work(std::env::temp_dir().join(format!("ffworks-frames-{}", uuid::Uuid::new_v4().simple())));
    std::fs::create_dir_all(&work.0).map_err(|e| Error::io(&work.0, e))?;
    on_progress(0.0);

    let base = work.0.join("base.avi");
    encode_avi(tools, &req.source, req, &base, cancel)?;
    let a = read_avi(&base)?;
    let donor = if let Mode::Splice { donor, .. } = &req.settings.mode {
        let path = work.0.join("donor.avi");
        encode_avi(tools, donor, req, &path, cancel)?;
        Some(read_avi(&path)?)
    } else {
        None
    };
    on_progress(0.5);
    let empty: Vec<Frame> = vec![];
    let b = donor.as_ref().map(|d| &d.frames).unwrap_or(&empty);
    let picks = order(&a.frames, b, &req.settings, req.fps, a.frames.len())?;
    if picks.len() < 2 {
        return Err(Error::validation("only one frame is left after the removals: put the full pictures further apart (a larger 'full picture every'), or keep them"));
    }
    let moshed = work.0.join("moshed.avi");
    let frames = assemble(&a.frames, b, &picks);
    std::fs::write(&moshed, a.write(&frames)).map_err(|e| Error::io(&moshed, e))?;
    on_progress(0.6);

    let fps = format!("{}/{}", req.fps.num(), req.fps.den());
    let stem = req.output.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "frames".into());
    let partial = req.output.with_file_name(format!("{stem}.{}.partial.mkv", uuid::Uuid::new_v4().simple()));
    // the result may have fewer frames than the clip (padded with its last picture) or more (cut)
    let retime = format!("fps={fps}:start_time=0,tpad=stop_mode=clone:stop_duration=2,format=yuv420p");
    let r = stage(
        tools,
        &["-threads".into(), "1".into(), "-err_detect".into(), "ignore_err".into(), "-flags2".into(), "+showall".into(), "-i".into(), path_arg(&moshed), "-an".into(), "-vf".into(), retime, "-t".into(), crate::ffmpeg::secs(req.source.duration), "-c:v".into(), "ffv1".into(), "-level".into(), "3".into(), "-g".into(), "1".into(), path_arg(&partial)],
        "storing the result",
        cancel,
    );
    if let Err(e) = r {
        let _ = std::fs::remove_file(&partial);
        return Err(e);
    }
    std::fs::rename(&partial, &req.output).map_err(|e| {
        let _ = std::fs::remove_file(&partial);
        Error::io(&req.output, e)
    })?;
    on_progress(1.0);
    Ok(())
}
