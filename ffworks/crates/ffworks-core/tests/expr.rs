//! Expressions and parameter links: formulas baked to keyframes. Real FFmpeg renders, pixels are measured.
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile_project, ExportSettings, RenderOptions};
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::keyframes::{Interp, Keyframe};
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

/// A white solid for 4 s on V1 of a 320x240 @25 project.
fn rig() -> (Engine, String, tempfile::TempDir) {
    let mut eng = Engine::new("x", ProjectSettings { width: 320, height: 240, fps: secs(25), sample_rate: 48000 }, tools());
    let v1 = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::AddSolid { track: v1.clone(), start: secs(0), duration: secs(4), color: "#ffffff".into() }).unwrap();
    let clip = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    (eng, clip, tempfile::tempdir().unwrap())
}

fn export(eng: &Engine, out: &Path) {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let mut job = compile_project(&eng.project, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap();
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "x", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export failed: {e}"));
}

fn luma_at(video: &Path, t: f64) -> i32 {
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-ss", &t.to_string(), "-i"]).arg(video).args(["-frames:v", "1", "-vf", "crop=2:2:160:120,scale=1:1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]).output().unwrap();
    assert_eq!(out.stdout.len(), 1, "no frame at t={t}");
    out.stdout[0] as i32
}

fn keys(eng: &Engine, clip: &str, param: &str) -> Vec<Keyframe> {
    eng.project.active().unwrap().find_clip(clip).unwrap().1.keyframes.get(param).cloned().unwrap_or_default()
}

fn formula(clip: &str, param: &str, expr: &str, source: Option<&str>, clamp: bool) -> Command {
    Command::AnimateFromExpression { clip: clip.into(), param: param.into(), expr: expr.into(), source: source.map(String::from), clamp }
}

#[test]
fn a_formula_in_time_drives_the_exported_picture() {
    let (mut eng, clip, dir) = rig();
    eng.dispatch(formula(&clip, "opacity", "p", None, false)).unwrap();
    assert!(keys(&eng, &clip, "opacity").len() >= 2);
    let out = dir.path().join("o.mp4");
    export(&eng, &out);
    let (a, b) = (luma_at(&out, 1.0), luma_at(&out, 3.0));
    assert!((a - 64).abs() < 25, "a quarter in is dark gray: {a}");
    assert!((b - 191).abs() < 25, "three quarters in is light gray: {b}");
}

#[test]
fn a_link_makes_one_parameter_follow_another() {
    let (mut eng, clip, dir) = rig();
    // scale grows 0.2 -> 1.0; opacity follows it
    eng.dispatch(Command::SetKeyframes { clip: clip.clone(), param: "scale".into(), keys: vec![Keyframe { t: secs(0), v: 0.2, interp: Interp::Linear }, Keyframe { t: secs(4), v: 1.0, interp: Interp::Linear }] }).unwrap();
    eng.dispatch(formula(&clip, "opacity", "v", Some("scale"), true)).unwrap();
    let k = keys(&eng, &clip, "opacity");
    assert!((ffworks_core::keyframes::eval(&k, 2.0).unwrap() - 0.6).abs() < 0.02, "{k:?}");
    let out = dir.path().join("o.mp4");
    export(&eng, &out);
    assert!((luma_at(&out, 2.0) - 153).abs() < 25, "{}", luma_at(&out, 2.0));
}

#[test]
fn the_formula_is_one_undo_step_and_survives_save_and_load() {
    let (mut eng, clip, dir) = rig();
    let before = serde_json::to_string(&eng.project).unwrap();
    eng.dispatch(formula(&clip, "opacity", "0.5 + 0.5 * sin(2 * pi() * t)", None, false)).unwrap();
    assert_eq!(eng.history().last().unwrap(), "Formula on opacity");
    let file = dir.path().join("p.ffworks");
    eng.save(&file).unwrap();
    let loaded = Engine::load(&file, tools()).unwrap();
    assert_eq!(keys(&loaded, &clip, "opacity"), keys(&eng, &clip, "opacity"));
    eng.undo().unwrap();
    assert_eq!(serde_json::to_string(&eng.project).unwrap(), before);
}

#[test]
fn a_formula_can_animate_an_effect_parameter() {
    let (mut eng, clip, _dir) = rig();
    eng.dispatch(Command::AddEffect { clip: clip.clone(), effect: "brightness".into(), params: Default::default(), index: None }).unwrap();
    let fx = eng.project.active().unwrap().find_clip(&clip).unwrap().1.effects[0].id.clone();
    let param = format!("fx:{fx}:amount");
    eng.dispatch(formula(&clip, &param, "p - 0.5", None, false)).unwrap();
    let k = keys(&eng, &clip, &param);
    assert!(ffworks_core::keyframes::eval(&k, 2.0).unwrap().abs() < 0.02, "{k:?}");
}

#[test]
fn mistakes_are_refused_and_change_nothing() {
    let (mut eng, clip, _dir) = rig();
    let before = serde_json::to_string(&eng.project).unwrap();
    for (cmd, want) in [
        (formula(&clip, "opacity", "t * 2", None, false), "outside the allowed"),
        (formula(&clip, "opacity", "sin(", None, false), "expression"),
        (formula(&clip, "opacity", "p", Some("nonsense"), false), "unknown parameter"),
        (formula(&clip, "opacity", "p", Some("fx:ghost:sigma"), false), "effect"),
        (formula(&clip, "nonsense", "p", None, false), "unknown parameter"),
        (formula("clp_none", "opacity", "p", None, false), "clip"),
    ] {
        let e = eng.dispatch(cmd).unwrap_err().to_string().to_lowercase();
        assert!(e.contains(want), "{want}: {e}");
    }
    assert_eq!(serde_json::to_string(&eng.project).unwrap(), before);
}
