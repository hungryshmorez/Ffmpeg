//! Timeline markers become chapters in the exported file (read back with ffprobe).

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

fn engine(dir: &Path) -> Engine {
    let src = dir.join("src.mp4");
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=160x120:r=25:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p"]).arg(&src).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let mut eng = Engine::new("c", ProjectSettings { width: 160, height: 120, fps: secs(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(&src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: secs(0), source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    for (t, n) in [(1, "Intro"), (3, "Middle; part=2"), (5, "Outro")] {
        eng.dispatch(Command::AddMarker { time: secs(t), name: n.into(), color: None, note: None }).unwrap();
    }
    eng
}

fn export(eng: &Engine, out: &Path, preset: &str, range: Option<(Rational, Rational)>) {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let mut job = compile_project(&eng.project, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find(preset).unwrap(), range, scale_div: 1 }, Some(&caps)).unwrap();
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "c", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export failed: {e}"));
}

/// (start seconds, end seconds, title) of every chapter.
fn chapters(f: &Path) -> Vec<(f64, f64, String)> {
    let o = Proc::new(tools().ffprobe).args(["-v", "error", "-show_chapters", "-of", "json"]).arg(f).output().unwrap();
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    v["chapters"].as_array().unwrap().iter().map(|c| (c["start_time"].as_str().unwrap().parse().unwrap(), c["end_time"].as_str().unwrap().parse().unwrap(), c["tags"]["title"].as_str().unwrap_or("").to_string())).collect()
}

#[test]
fn an_export_carries_the_markers_as_chapters() {
    let dir = tempfile::tempdir().unwrap();
    let eng = engine(dir.path());
    let out = dir.path().join("o.mp4");
    export(&eng, &out, "h264_mp4", None);
    let c = chapters(&out);
    assert_eq!(c.iter().map(|x| x.2.as_str()).collect::<Vec<_>>(), ["Start", "Intro", "Middle; part=2", "Outro"], "a chapter at 0:00 is added; special characters survive: {c:?}");
    assert!(c[0].0.abs() < 0.01 && (c[0].1 - 1.0).abs() < 0.01, "{c:?}");
    assert!((c[2].0 - 3.0).abs() < 0.01 && (c[2].1 - 5.0).abs() < 0.01, "{c:?}");
    assert!((c[3].1 - 6.0).abs() < 0.1, "the last chapter runs to the end: {c:?}");
}

#[test]
fn a_range_export_keeps_only_its_chapters_shifted_to_zero() {
    let dir = tempfile::tempdir().unwrap();
    let eng = engine(dir.path());
    let out = dir.path().join("r.mp4");
    export(&eng, &out, "h264_mp4", Some((secs(2), secs(6))));
    let c = chapters(&out);
    assert_eq!(c.iter().map(|x| x.2.as_str()).collect::<Vec<_>>(), ["Start", "Middle; part=2", "Outro"], "{c:?}");
    assert!(c[0].0.abs() < 0.01 && (c[1].0 - 1.0).abs() < 0.01, "marker at 3 s is 1 s into a range starting at 2 s: {c:?}");
}

#[test]
fn a_project_without_markers_exports_no_chapters() {
    let dir = tempfile::tempdir().unwrap();
    let mut eng = engine(dir.path());
    let ids: Vec<_> = eng.project.active().unwrap().markers.iter().map(|m| m.id.clone()).collect();
    for id in ids {
        eng.dispatch(Command::RemoveMarker { marker: id }).unwrap();
    }
    let out = dir.path().join("n.mp4");
    export(&eng, &out, "h264_mp4", None);
    assert!(chapters(&out).is_empty());
}
