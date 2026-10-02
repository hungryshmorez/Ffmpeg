//! "Add filter to clip" from the filter browser: one filter becomes a custom-graph effect that renders and undoes in one step.
#![allow(dead_code)]
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile, ExportSettings, RenderOptions};
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::ProjectSettings;
use ffworks_core::{render_graph, Rational};
use std::path::{Path, PathBuf};
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}
fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

fn ffmpeg(args: &[&str]) {
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-y"]).args(args).output().expect("ffmpeg runs");
    assert!(out.status.success(), "fixture generation failed: {}", String::from_utf8_lossy(&out.stderr));
}

/// 320x240, 25 fps, left half `left` | right half `right`, with a sine tone.
fn halves(dir: &Path, name: &str, left: &str, right: &str, secs_: u32) -> PathBuf {
    let p = dir.join(name);
    ffmpeg(&[
        "-f", "lavfi", "-i", &format!("color=c={left}:s=160x240:r=25:d={secs_}"),
        "-f", "lavfi", "-i", &format!("color=c={right}:s=160x240:r=25:d={secs_}"),
        "-f", "lavfi", "-i", &format!("sine=f=440:r=44100:d={secs_}"),
        "-filter_complex", "[0:v][1:v]hstack[v]", "-map", "[v]", "-map", "2:a",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "5", "-c:a", "aac", "-shortest", p.to_str().unwrap(),
    ]);
    p
}

/// 4 s: red, green, blue, yellow (1 s each) with a 440 Hz tone, 320x240 @25.
fn seasons(dir: &Path) -> PathBuf {
    let p = dir.join("seasons.mp4");
    ffmpeg(&[
        "-f", "lavfi", "-i", "color=c=red:s=320x240:r=25:d=1",
        "-f", "lavfi", "-i", "color=c=green:s=320x240:r=25:d=1",
        "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=25:d=1",
        "-f", "lavfi", "-i", "color=c=yellow:s=320x240:r=25:d=1",
        "-f", "lavfi", "-i", "sine=f=440:r=44100:d=4",
        "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1[v]", "-map", "[v]", "-map", "4:a",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "5", "-c:a", "aac", "-shortest", p.to_str().unwrap(),
    ]);
    p
}

fn rgb_at(video: &Path, t: f64, x: u32, y: u32) -> (i32, i32, i32) {
    let out = Proc::new(tools().ffmpeg)
        .args(["-v", "error", "-ss", &format!("{t}"), "-i"])
        .arg(video)
        .args(["-frames:v", "1", "-vf", &format!("crop=2:2:{x}:{y},scale=1:1"), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .output()
        .unwrap();
    assert_eq!(out.stdout.len(), 3, "no frame at t={t}");
    (out.stdout[0] as i32, out.stdout[1] as i32, out.stdout[2] as i32)
}

fn is(p: (i32, i32, i32), want: (i32, i32, i32)) -> bool {
    (p.0 - want.0).abs() < 70 && (p.1 - want.1).abs() < 70 && (p.2 - want.2).abs() < 70
}
const RED: (i32, i32, i32) = (255, 0, 0);
const GREEN: (i32, i32, i32) = (0, 128, 0); // FFmpeg's named colour `green`
const BLUE: (i32, i32, i32) = (0, 0, 255);
const YELLOW: (i32, i32, i32) = (255, 255, 0);
const BLACK: (i32, i32, i32) = (0, 0, 0);

fn export(eng: &Engine, out: &Path) {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let g = render_graph::build(&eng.project).unwrap();
    let mut job = compile(&g, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap_or_else(|e| panic!("compile: {e}"));
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "t", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export failed: {e}"));
}

/// Project 320x240@25 with one clip of `src` on V1 at 0. Returns (engine, video clip id, V1 track id).
fn one_clip(src: &Path) -> (Engine, String, String) {
    let mut eng = Engine::new("fx", ProjectSettings { width: 320, height: 240, fps: secs(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v.clone(), start: secs(0), source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
    let id = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    (eng, id, v)
}

fn set(eng: &mut Engine, clip: &str, param: &str, value: f64) {
    eng.dispatch(Command::SetClipParam { clip: clip.into(), param: param.into(), value }).unwrap_or_else(|e| panic!("{param}: {e}"));
}
fn key(eng: &mut Engine, clip: &str, param: &str, t: Rational, value: f64) {
    eng.dispatch(Command::SetKeyframe { clip: clip.into(), param: param.into(), time: t, value, interp: None }).unwrap_or_else(|e| panic!("{param}: {e}"));
}

fn mean_volume_db(media: &Path, from: f64, dur: f64) -> f64 {
    let out = Proc::new(tools().ffmpeg).args(["-nostdin", "-ss", &from.to_string(), "-t", &dur.to_string(), "-i"]).arg(media).args(["-vn", "-af", "volumedetect", "-f", "null", "-"]).output().unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    err.lines().find_map(|l| l.split("mean_volume:").nth(1)).and_then(|v| v.trim().trim_end_matches(" dB").parse().ok()).unwrap_or(-91.0)
}


#[test]
fn a_single_filter_added_from_the_browser_renders_and_undoes_in_one_step() {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "h.mp4", "red", "blue", 2);
    let (mut eng, c, _) = one_clip(&src);
    let before = eng.history().len();
    eng.dispatch(Command::AddFilterEffect { clip: c.clone(), filter: "negate".into(), options: vec![] }).unwrap();
    assert_eq!(eng.history().len(), before + 1, "one undo step");
    let out = dir.path().join("o.mp4");
    export(&eng, &out);
    assert!(is(rgb_at(&out, 1.0, 40, 120), (0, 255, 255)), "red became cyan");
    // with an option
    eng.undo().unwrap();
    assert!(eng.project.active().unwrap().tracks[0].clips[0].effects.is_empty());
    eng.dispatch(Command::AddFilterEffect { clip: c.clone(), filter: "hue".into(), options: vec![("s".into(), "0".into())] }).unwrap();
    export(&eng, &out);
    let p = rgb_at(&out, 1.0, 40, 120);
    assert!((p.0 - p.1).abs() < 25 && (p.1 - p.2).abs() < 25, "hue s=0 is grey: {p:?}");
    // a forbidden filter changes nothing
    let n = eng.project.active().unwrap().tracks[0].clips[0].effects.len();
    assert!(eng.dispatch(Command::AddFilterEffect { clip: c.clone(), filter: "movie".into(), options: vec![("filename".into(), "/etc/passwd".into())] }).is_err());
    assert_eq!(eng.project.active().unwrap().tracks[0].clips[0].effects.len(), n);
}
