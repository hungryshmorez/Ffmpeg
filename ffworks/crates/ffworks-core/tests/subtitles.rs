//! Subtitle files become title clips on their own track; rendered and checked by sampling pixels.
#![allow(dead_code)]
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile, ExportSettings, RenderOptions};
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::{ProjectSettings, TrackKind};
use ffworks_core::{render_graph, Rational};
use std::path::{Path, PathBuf};
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}
fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}
fn ff(args: &[&str]) {
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-y"]).args(args).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

fn export(eng: &Engine, out: &Path) {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let g = render_graph::build(&eng.project).unwrap_or_else(|e| panic!("build: {e}"));
    let mut job = compile(&g, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap_or_else(|e| panic!("compile: {e}"));
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "t", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export failed: {e}"));
}

fn rgb_at(video: &Path, t: f64, x: u32, y: u32) -> (i32, i32, i32) {
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-ss", &format!("{t}"), "-i"]).arg(video).args(["-frames:v", "1", "-vf", &format!("crop=2:2:{x}:{y},scale=1:1"), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap();
    assert_eq!(o.stdout.len(), 3, "no frame at t={t}");
    (o.stdout[0] as i32, o.stdout[1] as i32, o.stdout[2] as i32)
}
fn is(p: (i32, i32, i32), want: (i32, i32, i32)) -> bool {
    (p.0 - want.0).abs() < 70 && (p.1 - want.1).abs() < 70 && (p.2 - want.2).abs() < 70
}
const RED: (i32, i32, i32) = (255, 0, 0);
const BLUE: (i32, i32, i32) = (0, 0, 255);
const GREEN: (i32, i32, i32) = (0, 255, 0);

/// Whole frame at `t` as raw RGB (for counting text pixels).
fn frame(video: &Path, t: f64, w: usize, h: usize) -> Vec<u8> {
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-ss", &format!("{t}"), "-i"]).arg(video).args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap();
    assert_eq!(o.stdout.len(), w * h * 3, "unexpected frame size");
    o.stdout
}
/// Number of pixels in the rectangle that differ clearly from `bg`.
fn non_bg(f: &[u8], w: usize, rect: (usize, usize, usize, usize), bg: (i32, i32, i32)) -> usize {
    let (x0, y0, x1, y1) = rect;
    let mut n = 0;
    for y in y0..y1 {
        for x in x0..x1 {
            let i = (y * w + x) * 3;
            let d = (f[i] as i32 - bg.0).abs() + (f[i + 1] as i32 - bg.1).abs() + (f[i + 2] as i32 - bg.2).abs();
            if d > 120 {
                n += 1;
            }
        }
    }
    n
}

fn engine(w: u32, h: u32) -> Engine {
    Engine::new("gen", ProjectSettings { width: w, height: h, fps: secs(25), sample_rate: 48000 }, tools())
}
fn track(eng: &Engine, kind: TrackKind, nth: usize) -> String {
    eng.project.active().unwrap().tracks.iter().filter(|t| t.kind == kind).nth(nth).unwrap().id.clone()
}
fn add_video_track(eng: &mut Engine) -> String {
    eng.dispatch(Command::AddTrack { kind: TrackKind::Video, name: None }).unwrap();
    let n = eng.project.active().unwrap().tracks.iter().filter(|t| t.kind == TrackKind::Video).count();
    track(eng, TrackKind::Video, n - 1)
}
fn halves_png(dir: &Path, name: &str, alpha_right: bool) -> PathBuf {
    let p = dir.join(name);
    // left half red, right half blue (or fully transparent)
    let right = if alpha_right { "color=c=blue@0:s=160x240,format=rgba" } else { "color=c=blue:s=160x240,format=rgba" };
    ff(&["-f", "lavfi", "-i", "color=c=red:s=160x240,format=rgba", "-f", "lavfi", "-i", right, "-filter_complex", "[0:v][1:v]hstack,format=rgba", "-frames:v", "1", p.to_str().unwrap()]);
    p
}

#[test]
fn srt_import_makes_timed_titles_that_render_only_while_their_cue_is_active() {
    let dir = tempfile::tempdir().unwrap();
    let (w, h) = (640usize, 360usize);
    let mut eng = engine(w as u32, h as u32);
    eng.dispatch(Command::AddSolid { track: track(&eng, TrackKind::Video, 0), start: secs(0), duration: secs(6), color: "#102040".into() }).unwrap();
    let cues = ffworks_core::subtitles::parse("1\n00:00:01,000 --> 00:00:02,000\nHELLO\n\n2\n00:00:04,000 --> 00:00:05,000\nBYE\n").unwrap();
    let before = eng.history().len();
    eng.dispatch(Command::ImportCues { track: "Subtitles".into(), offset: secs(0), cues: cues.iter().map(|c| (c.start, c.end, c.text.clone())).collect() }).unwrap();
    assert_eq!(eng.history().len(), before + 1, "one undo step");
    let seq = eng.project.active().unwrap();
    let t = seq.tracks.iter().find(|t| t.name == "Subtitles").expect("new track");
    assert_eq!(t.clips.len(), 2);
    assert_eq!(t.clips[0].start, secs(1));
    assert_eq!(t.clips[1].duration, secs(1));
    let out = dir.path().join("s.mp4");
    export(&eng, &out);
    let bg = (16, 32, 64);
    let lit = |at: f64| non_bg(&frame(&out, at, w, h), w, (120, 100, 520, 260), bg);
    assert!(lit(1.5) > 300, "text while the first cue is active: {}", lit(1.5));
    assert!(lit(3.0) < 50, "no text between cues: {}", lit(3.0));
    assert!(lit(4.5) > 200, "text during the second cue: {}", lit(4.5));
    eng.undo().unwrap();
    assert!(eng.project.active().unwrap().tracks.iter().all(|t| t.name != "Subtitles"), "undo removes the track too");
    // shifting by an offset; empty input refused
    eng.dispatch(Command::ImportCues { track: "S".into(), offset: secs(2), cues: vec![(secs(0), secs(1), "X".into())] }).unwrap();
    assert_eq!(eng.project.active().unwrap().tracks.iter().find(|t| t.name == "S").unwrap().clips[0].start, secs(2));
    assert!(eng.dispatch(Command::ImportCues { track: "E".into(), offset: secs(0), cues: vec![] }).is_err());
}
