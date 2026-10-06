//! Picture-based luma wipes, measured on the exported frames: a left-to-right gradient mask makes the dark (left) side switch first.

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

fn ff(args: &[&str]) {
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-y"]).args(args).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
}

/// Red clip A, blue clip B (both with handles), and a left-dark-to-right-bright mask picture; a 1 s transition at the cut (3 s).
fn project(dir: &Path) -> (Engine, String, String) {
    let (red, blue, mask) = (dir.join("red.mp4"), dir.join("blue.mp4"), dir.join("mask.png"));
    for (p, c) in [(&red, "red"), (&blue, "blue")] {
        ff(&["-f", "lavfi", "-i", &format!("color=c={c}:s=160x120:r=25:d=5,format=yuv420p"), "-c:v", "libx264", "-pix_fmt", "yuv420p", p.to_str().unwrap()]);
    }
    ff(&["-f", "lavfi", "-i", "color=c=black:s=160x120,format=gray,geq=lum='X/W*255'", "-frames:v", "1", mask.to_str().unwrap()]);
    let mut eng = Engine::new("c", ProjectSettings { width: 160, height: 120, fps: secs(25), sample_rate: 48000 }, tools());
    let (ma, mb, mm) = (eng.import_media(&red).unwrap(), eng.import_media(&blue).unwrap(), eng.import_media(&mask).unwrap());
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: ma, track: v.clone(), start: secs(0), source_in: None, duration: Some(secs(3)), with_audio: false, audio_track: None }).unwrap();
    eng.dispatch(Command::PlaceClip { media: mb, track: v, start: secs(3), source_in: Some(secs(1)), duration: Some(secs(3)), with_audio: false, audio_track: None }).unwrap();
    let t = &eng.project.active().unwrap().tracks[0];
    let (a, b) = (t.clips[0].id.clone(), t.clips[1].id.clone());
    eng.dispatch(Command::AddTransition { clip_a: a, clip_b: b, kind: "fade".into(), duration: secs(1) }).unwrap();
    let tr = eng.project.active().unwrap().tracks[0].transitions[0].id.clone();
    (eng, tr, mm)
}

fn export(eng: &Engine, out: &Path) -> ffworks_core::ffmpeg::FfmpegJob {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let mut job = compile_project(&eng.project, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("ffv1_mkv").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap_or_else(|e| panic!("compile: {e}"));
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "c", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export failed: {e}"));
    job
}

/// Mean colour of a small patch around (x, y) at time `t`.
fn patch(video: &Path, t: f64, x: u32) -> (i32, i32, i32) {
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-ss", &t.to_string(), "-i"]).arg(video).args(["-frames:v", "1", "-vf", &format!("crop=8:8:{x}:56,scale=1:1:flags=area"), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap();
    assert_eq!(o.stdout.len(), 3, "no frame at {t}");
    (i32::from(o.stdout[0]), i32::from(o.stdout[1]), i32::from(o.stdout[2]))
}
fn is_red(c: (i32, i32, i32)) -> bool {
    c.0 > 200 && c.2 < 60
}
fn is_blue(c: (i32, i32, i32)) -> bool {
    c.2 > 200 && c.0 < 60
}

fn have() -> bool {
    Capabilities::discover(&tools()).is_ok_and(|c| c.has_filter("maskedmerge") && c.has_filter("geq"))
}

#[test]
fn a_gradient_mask_switches_the_dark_side_first_and_inverting_flips_it() {
    if !have() {
        eprintln!("needs maskedmerge and geq; skipping");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, tr, mask) = project(dir.path());
    eng.dispatch(Command::SetTransitionMask { transition: tr.clone(), media: Some(mask), softness: Some(0.05), invert: None }).unwrap();
    assert_eq!(eng.project.active().unwrap().tracks[0].transitions[0].kind, "luma");
    let out = dir.path().join("l.mkv");
    let j = export(&eng, &out);
    assert!(j.filter_graph.contains("maskedmerge"), "{}", j.filter_graph);
    assert!(is_red(patch(&out, 2.3, 16)) && is_red(patch(&out, 2.3, 136)), "before the wipe: all A");
    assert!(is_blue(patch(&out, 3.7, 16)) && is_blue(patch(&out, 3.7, 136)), "after the wipe: all B");
    // half way: the dark left has switched to B, the bright right is still A
    let (l, r) = (patch(&out, 3.0, 16), patch(&out, 3.0, 136));
    assert!(is_blue(l) && is_red(r), "left {l:?} should be B (blue), right {r:?} still A (red)");

    eng.dispatch(Command::SetTransitionMask { transition: tr, media: None, softness: None, invert: None }).unwrap();
    assert_eq!(eng.project.active().unwrap().tracks[0].transitions[0].kind, "fade", "removing the mask turns it back into a fade");
}

#[test]
fn inverting_makes_the_bright_side_switch_first_and_it_survives_save_load_and_undo() {
    if !have() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, tr, mask) = project(dir.path());
    eng.dispatch(Command::SetTransitionMask { transition: tr, media: Some(mask), softness: Some(0.05), invert: Some(true) }).unwrap();
    let out = dir.path().join("i.mkv");
    export(&eng, &out);
    let (l, r) = (patch(&out, 3.0, 16), patch(&out, 3.0, 136));
    assert!(is_red(l) && is_blue(r), "inverted: left {l:?} still A, right {r:?} already B");

    let back: ffworks_core::project::Project = serde_json::from_str(&serde_json::to_string(&eng.project).unwrap()).unwrap();
    let t = &back.active().unwrap().tracks[0].transitions[0];
    assert!(t.invert && t.mask.is_some() && t.kind == "luma");
    eng.undo().unwrap();
    assert_eq!(eng.project.active().unwrap().tracks[0].transitions[0].kind, "fade");
}

#[test]
fn a_luma_wipe_needs_a_still_picture_mask() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, tr, _mask) = project(dir.path());
    let clip_media = eng.project.media[0].id.clone();
    let err = eng.dispatch(Command::SetTransitionMask { transition: tr.clone(), media: Some(clip_media), softness: None, invert: None }).unwrap_err().to_string();
    assert!(err.contains("still image"), "{err}");
    // the luma kind with no mask picture is refused
    let err = eng.dispatch(Command::SetTransition { transition: tr, kind: Some("luma".into()), duration: None }).unwrap_err().to_string();
    assert!(err.contains("mask"), "{err}");
}
