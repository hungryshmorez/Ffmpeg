//! Smooth slow motion (optical flow) on a half-speed clip, measured on the exported frames.

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

fn engine(dir: &Path) -> (Engine, String) {
    let src = dir.join("moving.mp4");
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x120:r=25:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "5"]).arg(&src).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let mut eng = Engine::new("c", ProjectSettings { width: 160, height: 120, fps: secs(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(&src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: secs(0), source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    let id = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    eng.dispatch(Command::SetClipSpeed { clip: id.clone(), speed: Rational::new(1, 2) }).unwrap();
    (eng, id)
}

fn export(eng: &Engine, out: &Path) -> ffworks_core::ffmpeg::FfmpegJob {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let mut job = compile_project(&eng.project, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("ffv1_mkv").unwrap(), range: Some((secs(0), secs(2))), scale_div: 1 }, Some(&caps)).unwrap();
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "c", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export failed: {e}"));
    job
}

/// How many of the consecutive frame pairs of the first two seconds are *identical* (a repeated frame).
fn repeated_pairs(video: &Path) -> (usize, usize) {
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-i"]).arg(video).args(["-an", "-f", "framemd5", "-"]).output().unwrap();
    let text = String::from_utf8_lossy(&o.stdout).to_string();
    let hashes: Vec<&str> = text.lines().filter(|l| !l.starts_with('#') && !l.is_empty()).map(|l| l.rsplit(',').next().unwrap().trim()).collect();
    (hashes.windows(2).filter(|w| w[0] == w[1]).count(), hashes.len())
}

#[test]
fn smooth_slow_motion_fills_the_gaps_instead_of_repeating_frames() {
    let caps = Capabilities::discover(&tools()).unwrap();
    if !caps.has_filter("minterpolate") {
        eprintln!("this FFmpeg has no minterpolate; skipping");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, id) = engine(dir.path());

    let plain = dir.path().join("plain.mkv");
    let j = export(&eng, &plain);
    assert!(!j.filter_graph.contains("minterpolate"));
    let (rep_plain, n) = repeated_pairs(&plain);
    assert!(n >= 40, "frames: {n}");
    assert!(rep_plain >= n / 3, "half speed without help repeats frames: {rep_plain} of {n}");

    eng.dispatch(Command::SetClipSmooth { clip: id.clone(), smooth: true }).unwrap();
    let smooth = dir.path().join("smooth.mkv");
    let j = export(&eng, &smooth);
    assert!(j.filter_graph.contains("minterpolate=fps="), "{}", j.filter_graph);
    let (rep_smooth, n2) = repeated_pairs(&smooth);
    assert_eq!(n2, n, "same length either way");
    assert!(rep_smooth * 4 < rep_plain, "interpolated frames are new pictures: {rep_smooth} repeats vs {rep_plain}");

    // undo goes back, and the setting is part of the saved project
    let back: ffworks_core::project::Project = serde_json::from_str(&serde_json::to_string(&eng.project).unwrap()).unwrap();
    assert!(back.active().unwrap().find_clip(&id).unwrap().1.smooth);
    eng.undo().unwrap();
    assert!(!eng.project.active().unwrap().find_clip(&id).unwrap().1.smooth);
}

#[test]
fn smooth_does_nothing_at_normal_speed() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, id) = engine(dir.path());
    eng.dispatch(Command::SetClipSmooth { clip: id.clone(), smooth: true }).unwrap();
    eng.dispatch(Command::SetClipSpeed { clip: id, speed: Rational::from_int(1) }).unwrap();
    let j = export(&eng, &dir.path().join("n.mkv"));
    assert!(!j.filter_graph.contains("minterpolate"), "{}", j.filter_graph);
}
