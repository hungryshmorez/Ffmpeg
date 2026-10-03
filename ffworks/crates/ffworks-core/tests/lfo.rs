//! LFO modulators: keyframes from a waveform, rendered by real FFmpeg and measured.
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile_project, ExportSettings, RenderOptions};
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::ProjectSettings;
use ffworks_core::Rational;
use std::path::Path;
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}
fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

/// White solid for 4 s on V1 over the black base; returns (engine, clip id).
fn white() -> (Engine, String) {
    let mut eng = Engine::new("lfo", ProjectSettings { width: 160, height: 120, fps: secs(40), sample_rate: 48000 }, tools());
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::AddSolid { track: v, start: secs(0), duration: secs(4), color: "#ffffff".into() }).unwrap();
    let id = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    (eng, id)
}

fn luma_at(video: &Path, t: f64) -> f64 {
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-ss", &t.to_string(), "-i"]).arg(video).args(["-frames:v", "1", "-vf", "scale=1:1,format=gray", "-f", "rawvideo", "-"]).output().unwrap();
    assert_eq!(o.stdout.len(), 1, "no frame at {t}");
    o.stdout[0] as f64
}

fn export(eng: &Engine, out: &Path) {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let mut job = compile_project(&eng.project, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap();
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "lfo", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export: {e}"));
}

fn lfo(eng: &mut Engine, clip: &str, shape: &str, rate: f64) -> Result<(), ffworks_core::Error> {
    eng.dispatch(Command::AnimateFromLfo { clip: clip.into(), param: "opacity".into(), shape: shape.into(), rate, low: 0.0, high: 1.0, phase: 0.0, seed: 3 })
}

#[test]
fn a_square_lfo_blinks_the_picture_in_the_export() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, c) = white();
    lfo(&mut eng, &c, "square", 1.0).unwrap();
    assert_eq!(eng.undo_label(), Some("square LFO on opacity"));
    let out = dir.path().join("o.mp4");
    export(&eng, &out);
    // 1 Hz square, low first: dark at 0.25 and 1.25, bright at 0.75 and 1.75
    let (d1, b1, d2, b2) = (luma_at(&out, 0.25), luma_at(&out, 0.75), luma_at(&out, 1.25), luma_at(&out, 1.75));
    assert!(d1 < 40.0 && d2 < 40.0, "dark phases: {d1} {d2}");
    assert!(b1 > 190.0 && b2 > 190.0, "bright phases: {b1} {b2}");
}

#[test]
fn a_sine_lfo_glides_and_is_ordinary_editable_keyframes() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, c) = white();
    lfo(&mut eng, &c, "sine", 0.5).unwrap();
    let keys = eng.project.active().unwrap().find_clip(&c).unwrap().1.keyframes["opacity"].clone();
    assert!(keys.len() <= 8, "two keys per cycle: {}", keys.len());
    let out = dir.path().join("o.mp4");
    export(&eng, &out);
    // 0.5 Hz: low at 0, high at 1 s, low at 2 s
    let (a, m, b) = (luma_at(&out, 0.0), luma_at(&out, 1.0), luma_at(&out, 2.0));
    let rising = (luma_at(&out, 0.4), luma_at(&out, 0.7));
    assert!(a < 30.0 && b < 30.0 && m > 200.0, "{a} {m} {b}");
    assert!(rising.0 > a && rising.1 > rising.0, "it rises smoothly: {rising:?}");
    // editing one key afterwards works like any keyframe
    eng.dispatch(Command::SetKeyframe { clip: c.clone(), param: "opacity".into(), time: keys[1].t, value: 0.5, interp: None }).unwrap();
    eng.undo().unwrap();
    eng.undo().unwrap();
    assert!(!eng.project.active().unwrap().find_clip(&c).unwrap().1.keyframes.contains_key("opacity"), "the LFO is one undo step");
}

#[test]
fn refusals_name_the_reason() {
    let (mut eng, c) = white();
    let e = lfo(&mut eng, &c, "sine", 99.0).unwrap_err().to_string();
    assert!(e.contains("at most"), "{e}");
    let e = lfo(&mut eng, &c, "sine", 20.0).unwrap_err().to_string();
    assert!(e.contains("rate") || e.contains("keyframes"), "{e}");
    let e = eng.dispatch(Command::AnimateFromLfo { clip: c.clone(), param: "opacity".into(), shape: "sine".into(), rate: 1.0, low: 0.0, high: 5.0, phase: 0.0, seed: 0 }).unwrap_err().to_string();
    assert!(e.to_lowercase().contains("opacity"), "out-of-range high end: {e}");
    let e = eng.dispatch(Command::AnimateFromLfo { clip: c.clone(), param: "fx:nope:amount".into(), shape: "sine".into(), rate: 1.0, low: 0.0, high: 1.0, phase: 0.0, seed: 0 }).unwrap_err().to_string();
    assert!(!e.is_empty());
    assert!(lfo(&mut eng, "ghost", "sine", 1.0).is_err());
    assert!(eng.project.active().unwrap().find_clip(&c).unwrap().1.keyframes.is_empty(), "a refused LFO leaves no keyframes");
}
