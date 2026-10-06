//! Baking: effects FFmpeg cannot express as a filter (today: pixel sorting) are applied by FFWORKS itself before the
//! final render. For every clip use that carries such an effect, [`prepare`] plans one stage that
//!
//! 1. renders the use up to (not including) the effect through the normal compiler, as raw RGB frames on a pipe,
//! 2. sorts each frame ([`crate::pixelsort`]), and
//! 3. encodes the result losslessly (FFV1) into a cache file.
//!
//! The render graph then reads that file instead of the original, with only the effects that come after it still in the
//! chain, so the effect keeps its place in the stack and everything after it (colour, keyframes, transitions, blends) works
//! unchanged. `prepare` only plans: nothing runs until the job does (`jobs::run_job` calls [`run_stage`] first).
//!
//! Limits, by design: the picture passes through the sort as opaque RGB (transparency is composited on black first), and
//! it is sorted at project resolution whatever the preview quality.

use crate::error::{Error, Result};
use crate::ffmpeg::{compile, ExportSettings, FfmpegJob, RenderOptions};
use crate::jobs::{kill_pid, CancelToken};
use crate::pixelsort::{self, Params};
use crate::process::{explain_failure, suppress_console_window, Tools};
use crate::render_graph::{InputRef, RenderGraph, VideoSegment};
use crate::time::Rational;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Starts a filter string that is not an FFmpeg filter but a baked effect (see [`mark`]).
pub const MARK: char = '\u{2}';

/// Bump when the sorter's output changes for the same parameters, so stale cache files are not reused.
const ALGORITHM_VERSION: u32 = 1;

/// Cached bakes older than this are never pruned (they may belong to a render that is still running).
const PRUNE_GRACE_SECS: u64 = 600;
/// Size the preview bake cache is trimmed to.
pub(crate) const CACHE_LIMIT_BYTES: u64 = 4 << 30;

/// The filter-list entry for a pixel sort: a marker plus its parameters.
pub fn mark(p: &Params) -> String {
    format!("{MARK}pixel_sort:{}", serde_json::to_string(p).expect("params serialise"))
}

pub fn is_mark(filter: &str) -> bool {
    filter.starts_with(MARK)
}

/// The sort parameters of a marker produced by [`mark`].
pub fn parse(filter: &str) -> Option<Params> {
    serde_json::from_str(filter.strip_prefix(MARK)?.strip_prefix("pixel_sort:")?).ok()
}

/// `mark` text with the mask picture filled in (its path and a fingerprint of its content, so a changed picture is not served
/// from the cache). Marks that do not use a picture mask come back unchanged.
pub fn with_picture(mark_text: &str, path: &str) -> Result<String> {
    let mut p = parse(mark_text).ok_or_else(|| Error::validation("unreadable pixel sort settings"))?;
    if p.mask != 3 {
        return Ok(mark_text.to_string());
    }
    p.picture = Some(path.to_string());
    p.picture_fp = Some(crate::engine::fingerprint(std::path::Path::new(path)).map_err(|_| Error::validation(format!("the pixel sort mask picture '{path}' cannot be read")))?);
    Ok(mark(&p))
}

/// Decode the mask picture to `w`x`h` gray bytes (stretched to the frame).
fn load_picture(tools: &Tools, path: &str, w: usize, h: usize, cancel: &CancelToken) -> Result<Vec<u8>> {
    let mut cmd = std::process::Command::new(&tools.ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-i", path, "-frames:v", "1", "-vf"]).arg(format!("scale={w}:{h},format=gray")).args(["-f", "rawvideo", "-"]);
    let out = crate::process::run_cancellable(&mut cmd, cancel)?;
    if !out.status.success() || out.stdout.len() != w * h {
        return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: out.status.code(), hint: format!("reading the pixel sort mask picture: {}", explain_failure(&String::from_utf8_lossy(&out.stderr))) });
    }
    Ok(out.stdout)
}

/// One planned pixel sort.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BakeStage {
    /// Fingerprint of everything the result depends on.
    pub key: String,
    /// The lossless file this stage writes.
    pub output: PathBuf,
    /// Renders the picture to be sorted; its output is raw RGB24 on stdout.
    pub render: FfmpegJob,
    pub sort: Params,
    pub width: u32,
    pub height: u32,
    /// Frame rate as FFmpeg writes it (`num/den`).
    pub fps: String,
    /// Frames the render is expected to produce (progress only).
    pub frames: u64,
    /// Index, within the clip, of the first frame this stage renders: animated settings are read at its time.
    #[serde(default)]
    pub first_frame: u64,
    /// Kept in the content-keyed cache for reuse (previews and exports alike; the cache is trimmed to a size limit). A stage
    /// that is not kept is deleted once its job has finished.
    pub keep: bool,
}

static CACHE_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Where export bakes go. The app points this into its cache folder; the default is the system temp folder.
pub fn set_cache_dir(dir: PathBuf) {
    *CACHE_DIR.lock().unwrap() = Some(dir);
}

pub fn cache_dir() -> PathBuf {
    CACHE_DIR.lock().unwrap().clone().unwrap_or_else(|| std::env::temp_dir().join("ffworks-bake"))
}

/// One use of a source (a clip's segment or one side of a transition) that carries baked effects.
struct Use {
    input: usize,
    source_in: Rational,
    duration: Rational,
    speed: Rational,
    reverse: bool,
    smooth: bool,
    freeze: Option<Rational>,
    title: Option<(crate::titles::Title, PathBuf)>,
    filters: Vec<String>,
    requires: Vec<String>,
}

/// Plan every baked effect in the graph and rewrite the graph to read the baked files. `range` is the part of the
/// timeline being rendered: only what shows in it is baked.
pub fn prepare(g: &mut RenderGraph, range: Option<(Rational, Rational)>, cache: &Path, keep: bool) -> Result<Vec<BakeStage>> {
    let mut stages = vec![];
    for i in 0..g.video.len() {
        if !g.video[i].filters.iter().any(|f| is_mark(f)) {
            continue;
        }
        let s = g.video[i].clone();
        let u = Use { input: s.input, source_in: s.source_in, duration: s.duration, speed: s.speed, reverse: s.reverse, smooth: s.smooth, freeze: s.freeze, title: s.title, filters: s.filters, requires: s.requires };
        let window = visible(range, s.start, s.duration, g.fps, true);
        let b = bake_use(g, u, window, cache, keep, &mut stages)?;
        let seg: &mut VideoSegment = &mut g.video[i];
        (seg.input, seg.source_in, seg.speed, seg.reverse, seg.smooth, seg.freeze, seg.title, seg.filters, seg.requires) = (b.input, b.source_in, b.speed, b.reverse, b.smooth, b.freeze, b.title, b.filters, b.requires);
    }
    for i in 0..g.video_transitions.len() {
        for side in 0..2 {
            let t = &g.video_transitions[i];
            let part = if side == 0 { &t.a } else { &t.b };
            if !part.filters.iter().any(|f| is_mark(f)) {
                continue;
            }
            let u = Use { input: part.input, source_in: part.source_in, duration: t.duration, speed: Rational::from_int(1), reverse: false, smooth: false, freeze: None, title: None, filters: part.filters.clone(), requires: part.requires.clone() };
            // both sides of a transition must keep the same length, so they are baked whole
            let window = visible(range, t.start, t.duration, g.fps, false);
            let b = bake_use(g, u, window, cache, keep, &mut stages)?;
            let t = &mut g.video_transitions[i];
            let part = if side == 0 { &mut t.a } else { &mut t.b };
            (part.input, part.source_in, part.filters, part.requires) = (b.input, b.source_in, b.filters, b.requires);
        }
    }
    prune_inputs(g);
    Ok(stages)
}

/// Frames `[lo, hi)` (relative to the use) that the render range can show, or None when it shows none of it. `narrow` lets the
/// window shrink to the range; otherwise it is the whole use whenever any of it is visible.
fn visible(range: Option<(Rational, Rational)>, start: Rational, duration: Rational, fps: Rational, narrow: bool) -> Option<(i64, i64)> {
    let total = -(-duration).floor_units(fps); // ceil(duration × fps)
    let Some((a, b)) = range else { return Some((0, total)) };
    let (lo, hi) = (a.max(start) - start, b.min(start + duration) - start);
    if hi <= lo {
        return None;
    }
    if !narrow {
        return Some((0, total));
    }
    // a frame of margin each side, so rounding can never drop a frame the range needs
    Some(((lo.floor_units(fps) - 1).max(0), (hi.floor_units(fps) + 2).min(total)))
}

fn bake_use(g: &mut RenderGraph, mut u: Use, window: Option<(i64, i64)>, cache: &Path, keep: bool, stages: &mut Vec<BakeStage>) -> Result<Use> {
    let Some((lo_f, hi_f)) = window else {
        // not in the rendered range at all: the effect has nothing to do
        u.filters.retain(|f| !is_mark(f));
        return Ok(u);
    };
    let total = visible(None, Rational::ZERO, u.duration, g.fps, false).map(|w| w.1).unwrap_or(0);
    let lo_rel = crate::time::frame_to_time(lo_f, g.fps);
    let hi_rel = crate::time::frame_to_time(hi_f, g.fps);
    let partial = lo_f > 0 || hi_f < total;
    while let Some(k) = u.filters.iter().position(|f| is_mark(f)) {
        let sort = parse(&u.filters[k]).ok_or_else(|| Error::validation("unreadable pixel sort settings"))?;
        let input = g.inputs[u.input].clone();
        let mini = RenderGraph {
            width: g.width,
            height: g.height,
            fps: g.fps,
            sample_rate: g.sample_rate,
            duration: u.duration,
            inputs: vec![input.clone()],
            video: vec![VideoSegment {
                input: 0,
                layer: 0,
                start: Rational::ZERO,
                source_in: u.source_in,
                duration: u.duration,
                opacity: 1.0,
                filters: u.filters[..k].to_vec(),
                requires: u.requires.clone(),
                speed: u.speed,
                reverse: u.reverse,
                smooth: u.smooth,
                freeze: u.freeze,
                transform: Default::default(),
                blend: "normal".into(),
                keyframes: BTreeMap::new(),
                alpha_fx: false,
                title: u.title.clone(),
                adjustment: false,
            }],
            audio: vec![],
            video_transitions: vec![],
            audio_transitions: vec![],
            has_audio: false,
        };
        let raw = ExportSettings {
            id: "raw_rgb".into(),
            name: "Raw RGB frames".into(),
            extension: "rgb".into(),
            video_codec: Some("rawvideo".into()),
            crf: None,
            encoder_preset: None,
            pix_fmt: Some("rgb24".into()),
            audio_codec: None,
            audio_bitrate: None,
            extra: vec!["-f".into(), "rawvideo".into()],
        };
        let mut render = compile(&mini, &RenderOptions { output: PathBuf::from("pipe:1"), settings: raw, range: partial.then_some((lo_rel, hi_rel)), scale_div: 1 }, None)?;
        // stdout carries the frames, so FFmpeg's progress stream is switched off; progress comes from counting frames
        let mut pre = vec![];
        let mut it = std::mem::take(&mut render.pre).into_iter();
        while let Some(a) = it.next() {
            match a.as_str() {
                "-progress" => {
                    it.next();
                }
                "-nostats" => {}
                _ => pre.push(a),
            }
        }
        render.pre = pre;
        render.pre.extend(["-loglevel".into(), "error".into()]);

        let key = fingerprint(&render, &sort, &input);
        let output = if keep { cache.join(format!("{key}.mkv")) } else { cache.join(format!("export-{}.mkv", uuid::Uuid::new_v4().simple())) };
        stages.push(BakeStage {
            key: key.clone(),
            output: output.clone(),
            render,
            sort,
            width: g.width,
            height: g.height,
            fps: format!("{}/{}", g.fps.num(), g.fps.den()),
            frames: (hi_f - lo_f).max(1) as u64,
            first_frame: lo_f.max(0) as u64,
            keep,
        });

        g.inputs.push(InputRef {
            key: format!("bake:{key}:{}", g.inputs.len()),
            media_id: input.media_id,
            path: output.to_string_lossy().into_owned(),
            has_video: true,
            has_audio: false,
            src_fps: Some(g.fps),
            generated: None,
            still: false,
            alpha: false,
            need: Rational::ZERO,
            nested: None,
            color: Default::default(),
        });
        u.input = g.inputs.len() - 1;
        // the baked file already holds the retimed, trimmed, titled picture
        u.source_in = Rational::ZERO;
        u.speed = Rational::from_int(1);
        u.reverse = false;
        u.smooth = false;
        u.freeze = None;
        u.title = None;
        u.filters.drain(..=k);
        // a partial bake starts at `lo_rel`: pad the front so clip-relative time (keyframes) lines up again
        if partial && lo_f > 0 {
            u.filters.insert(0, format!("tpad=start_duration={}:start_mode=clone", crate::ffmpeg::secs(lo_rel)));
            u.requires.push("tpad".into());
        }
    }
    Ok(u)
}

/// Hash of everything a bake's content depends on: the render that feeds the sorter (its argv names the source and every
/// effect before the sort), the sort settings, and the source file's size and modification time.
fn fingerprint(render: &FfmpegJob, sort: &Params, input: &InputRef) -> String {
    let mut h = Sha256::new();
    h.update(ALGORITHM_VERSION.to_le_bytes());
    h.update(render.argv(None).join("\u{1f}").as_bytes());
    h.update(render.filter_graph.as_bytes());
    h.update(serde_json::to_string(sort).unwrap_or_default().as_bytes());
    if input.generated.is_none() {
        if let Ok(m) = std::fs::metadata(&input.path) {
            h.update(m.len().to_le_bytes());
            if let Ok(t) = m.modified().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).map_err(std::io::Error::other)) {
                h.update(t.as_nanos().to_le_bytes());
            }
        }
    }
    format!("{:x}", h.finalize())[..24].to_string()
}

/// Drop inputs nothing refers to any more (the originals of baked uses), renumbering the rest.
fn prune_inputs(g: &mut RenderGraph) {
    let mut used = vec![false; g.inputs.len()];
    for s in &g.video {
        used[s.input] = true;
    }
    for s in &g.audio {
        used[s.input] = true;
    }
    for t in &g.video_transitions {
        used[t.a.input] = true;
        used[t.b.input] = true;
        if let Some(l) = &t.luma {
            used[l.input] = true;
        }
    }
    for t in &g.audio_transitions {
        used[t.a.input] = true;
        used[t.b.input] = true;
    }
    if used.iter().all(|u| *u) {
        return;
    }
    let mut map = vec![0usize; used.len()];
    let mut n = 0;
    for (i, u) in used.iter().enumerate() {
        map[i] = n;
        n += usize::from(*u);
    }
    let mut keep = used.iter();
    g.inputs.retain(|_| *keep.next().unwrap());
    for s in &mut g.video {
        s.input = map[s.input];
    }
    for s in &mut g.audio {
        s.input = map[s.input];
    }
    for t in &mut g.video_transitions {
        t.a.input = map[t.a.input];
        t.b.input = map[t.b.input];
        if let Some(l) = &mut t.luma {
            l.input = map[l.input];
        }
    }
    for t in &mut g.audio_transitions {
        t.a.input = map[t.a.input];
        t.b.input = map[t.b.input];
    }
}

/// Run one stage unless its file already exists. `on_progress` gets 0..=1.
pub fn run_stage(tools: &Tools, stage: &BakeStage, cancel: &CancelToken, temp_dir: &Path, on_progress: &mut dyn FnMut(f64)) -> Result<()> {
    if stage.output.exists() {
        // a cache hit counts as used now, so pruning keeps it
        touch(&stage.output);
        on_progress(1.0);
        return Ok(());
    }
    let dir = stage.output.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| Error::io(dir, e))?;
    std::fs::create_dir_all(temp_dir).map_err(|e| Error::io(temp_dir, e))?;
    if stage.keep {
        prune(dir, CACHE_LIMIT_BYTES);
    }
    let partial = dir.join(format!("{}.{}.partial.mkv", stage.key, uuid::Uuid::new_v4().simple()));

    let mut job = stage.render.clone();
    job.program = tools.ffmpeg.clone();
    let script = temp_dir.join(format!("bake_{}_{}.filtergraph", stage.key, uuid::Uuid::new_v4().simple()));
    let args = if job.needs_file() {
        std::fs::write(&script, &job.filter_graph).map_err(|e| Error::io(&script, e))?;
        job.argv(Some((&script, tools.filter_file_style())))
    } else {
        job.argv(None)
    };
    let result = pipe_frames(tools, stage, &args, &partial, cancel, on_progress);
    let _ = std::fs::remove_file(&script);
    match result {
        Ok(()) => std::fs::rename(&partial, &stage.output).map_err(|e| {
            let _ = std::fs::remove_file(&partial);
            Error::io(&stage.output, e)
        }),
        Err(e) => {
            let _ = std::fs::remove_file(&partial);
            Err(e)
        }
    }
}

fn pipe_frames(tools: &Tools, stage: &BakeStage, decode_args: &[String], partial: &Path, cancel: &CancelToken, on_progress: &mut dyn FnMut(f64)) -> Result<()> {
    // a mask picture is read before anything is started, so a missing file fails cleanly
    let mut stage_sort = stage.sort.clone();
    if let Some(path) = stage_sort.picture.clone() {
        stage_sort.picture_weights = Some(std::sync::Arc::new(load_picture(tools, &path, stage.width as usize, stage.height as usize, cancel)?));
    }
    let unavailable = |e: std::io::Error| Error::ToolUnavailable { tool: tools.ffmpeg.display().to_string(), reason: e.to_string() };
    let mut dec = Command::new(&tools.ffmpeg);
    dec.args(decode_args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    suppress_console_window(&mut dec);
    let mut dec = dec.spawn().map_err(unavailable)?;

    let mut enc = Command::new(&tools.ffmpeg);
    enc.args(["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s"])
        .arg(format!("{}x{}", stage.width, stage.height))
        .args(["-framerate", &stage.fps, "-i", "pipe:0", "-an", "-c:v", "ffv1", "-level", "3", "-g", "1", "-pix_fmt", "bgr0"])
        .arg(partial)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    suppress_console_window(&mut enc);
    let mut enc = match enc.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = dec.kill();
            let _ = dec.wait();
            return Err(unavailable(e));
        }
    };

    let drain = |mut r: std::process::ChildStderr| {
        let buf = Arc::new(Mutex::new(String::new()));
        let b = Arc::clone(&buf);
        let h = std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            while let Ok(n) = r.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let mut s = b.lock().unwrap();
                s.push_str(&String::from_utf8_lossy(&chunk[..n]));
                if s.len() > 64 * 1024 {
                    let cut = (s.len() - 32 * 1024..s.len()).find(|i| s.is_char_boundary(*i)).unwrap_or(s.len());
                    s.drain(..cut);
                }
            }
        });
        (buf, h)
    };
    let (dec_err, dec_err_thread) = drain(dec.stderr.take().expect("piped"));
    let (enc_err, enc_err_thread) = drain(enc.stderr.take().expect("piped"));

    // kills both children promptly on cancel, even while they are silent
    let (dec_id, enc_id) = (dec.id(), enc.id());
    let done = Arc::new(AtomicBool::new(false));
    let watchdog = {
        let (cancel, done) = (cancel.clone(), Arc::clone(&done));
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                if cancel.is_canceled() {
                    kill_pid(dec_id);
                    kill_pid(enc_id);
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        })
    };

    let (w, h) = (stage.width as usize, stage.height as usize);
    // animated settings are read per frame; the plan (how lines are cut) only changes when the angle or direction does
    let fps_f = stage.fps.split_once('/').and_then(|(n, d)| Some(n.parse::<f64>().ok()? / d.parse::<f64>().ok()?)).filter(|f| *f > 0.0).unwrap_or(25.0);
    let animated = !stage.sort.anim.is_empty();
    let mut params = stage_sort.at(stage.first_frame as f64 / fps_f);
    let mut plan = pixelsort::Plan::new(w, h, &params);
    let mut frame = vec![0u8; w * h * 3];
    let mut out = dec.stdout.take().expect("piped");
    let mut sink = enc.stdin.take().expect("piped");
    let mut n: u64 = 0;
    let mut failure: Option<Error> = None;
    loop {
        let mut got = 0;
        while got < frame.len() {
            match out.read(&mut frame[got..]) {
                Ok(0) => break,
                Ok(k) => got += k,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        if got == 0 {
            break;
        }
        if got < frame.len() {
            failure = Some(Error::validation("the picture feeding the pixel sort ended in the middle of a frame"));
            break;
        }
        if animated {
            let next = stage_sort.at((stage.first_frame + n) as f64 / fps_f);
            if next.angle != params.angle || next.direction != params.direction {
                plan = pixelsort::Plan::new(w, h, &next);
            }
            params = next;
        }
        plan.sort(&mut frame, &params, n);
        if sink.write_all(&frame).is_err() {
            break; // the encoder died; its exit status says why
        }
        n += 1;
        on_progress((n as f64 / stage.frames as f64).min(1.0));
    }
    drop(out);
    drop(sink);
    let dec_status = dec.wait().map_err(unavailable);
    let enc_status = enc.wait().map_err(unavailable);
    done.store(true, Ordering::SeqCst);
    let _ = watchdog.join();
    let _ = dec_err_thread.join();
    let _ = enc_err_thread.join();

    if cancel.is_canceled() {
        return Err(Error::Canceled);
    }
    if let Some(e) = failure {
        return Err(e);
    }
    let (dec_status, enc_status) = (dec_status?, enc_status?);
    if !dec_status.success() {
        return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: dec_status.code(), hint: format!("preparing the pixel sort: {}", explain_failure(&dec_err.lock().unwrap())) });
    }
    if !enc_status.success() {
        return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: enc_status.code(), hint: format!("saving the pixel-sorted picture: {}", explain_failure(&enc_err.lock().unwrap())) });
    }
    if n == 0 {
        return Err(Error::validation("the pixel sort received no picture to sort"));
    }
    on_progress(1.0);
    Ok(())
}

/// Delete a finished export's bake files (previews keep theirs).
pub fn discard(stages: &[BakeStage]) {
    for s in stages.iter().filter(|s| !s.keep) {
        let _ = std::fs::remove_file(&s.output);
    }
}

pub(crate) fn touch(p: &Path) {
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(p) {
        let _ = f.set_modified(std::time::SystemTime::now());
    }
}

/// Keep the preview bake cache under `limit` bytes by deleting the least recently used files, never ones used in the last
/// few minutes (a render may be reading them).
pub fn prune(dir: &Path, limit: u64) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now();
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "mkv") && !e.file_name().to_string_lossy().starts_with("export-"))
        .filter_map(|e| e.metadata().ok().map(|m| (m.modified().unwrap_or(now), m.len(), e.path())))
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    for (t, len, p) in files {
        if total <= limit {
            break;
        }
        if now.duration_since(t).map(|d| d.as_secs()).unwrap_or(0) < PRUNE_GRACE_SECS {
            continue;
        }
        if std::fs::remove_file(&p).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_round_trip_and_are_not_ffmpeg_filters() {
        let p = Params { reverse: true, seed: 42, ..Params::default() };
        let m = mark(&p);
        assert!(is_mark(&m) && !is_mark("eq=brightness=0.1"));
        assert_eq!(parse(&m), Some(p));
        assert_eq!(parse("eq=brightness=0.1"), None);
    }

    #[test]
    fn the_visible_window_follows_the_render_range() {
        let fps = Rational::from_int(25);
        let s = |n| Rational::from_int(n);
        // whole use when no range is given: 4 s = 100 frames
        assert_eq!(visible(None, s(2), s(4), fps, true), Some((0, 100)));
        // range 3..4 s of a use starting at 2 s: relative 1..2 s = frames 25..50, plus a frame of margin each side
        assert_eq!(visible(Some((s(3), s(4))), s(2), s(4), fps, true), Some((24, 52)));
        // a range clear of the use shows none of it
        assert_eq!(visible(Some((s(10), s(11))), s(2), s(4), fps, true), None);
        assert_eq!(visible(Some((s(0), s(1))), s(2), s(4), fps, true), None);
        // the margin never reaches outside the use
        assert_eq!(visible(Some((s(0), s(3))), s(2), s(4), fps, true), Some((0, 27)));
        assert_eq!(visible(Some((s(5), s(9))), s(2), s(4), fps, true), Some((74, 100)));
        // transition parts are baked whole whenever any of them shows
        assert_eq!(visible(Some((s(3), s(4))), s(2), s(4), fps, false), Some((0, 100)));
    }

    #[test]
    fn unused_inputs_are_pruned_and_the_rest_renumbered() {
        let inp = |k: &str| InputRef { key: k.into(), media_id: "m".into(), path: k.into(), has_video: true, has_audio: false, src_fps: None, generated: None, still: false, alpha: false, need: Rational::ZERO, nested: None, color: Default::default() };
        let seg = |input| VideoSegment {
            input,
            layer: 0,
            start: Rational::ZERO,
            source_in: Rational::ZERO,
            duration: Rational::from_int(1),
            opacity: 1.0,
            filters: vec![],
            requires: vec![],
            speed: Rational::from_int(1),
            reverse: false,
            smooth: false,
            freeze: None,
            transform: Default::default(),
            blend: "normal".into(),
            keyframes: BTreeMap::new(),
            alpha_fx: false,
            title: None,
            adjustment: false,
        };
        let mut g = RenderGraph {
            width: 64,
            height: 48,
            fps: Rational::from_int(25),
            sample_rate: 48000,
            duration: Rational::from_int(1),
            inputs: vec![inp("old"), inp("a"), inp("b")],
            video: vec![seg(2), seg(1)],
            audio: vec![],
            video_transitions: vec![],
            audio_transitions: vec![],
            has_audio: false,
        };
        prune_inputs(&mut g);
        assert_eq!(g.inputs.iter().map(|i| i.key.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        assert_eq!((g.video[0].input, g.video[1].input), (1, 0));
    }
}
