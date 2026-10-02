//! frei0r plugins as effects, rendered by the real FFmpeg when the plugin (and FFmpeg's frei0r filter) is installed.
use ffworks_core::commands::Command;
use ffworks_core::effects;
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile, ExportSettings, RenderOptions};
use ffworks_core::frei0r;
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::ProjectSettings;
use ffworks_core::{render_graph, Rational};
use std::path::Path;
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}

fn export(eng: &Engine, out: &Path) {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let g = render_graph::build(&eng.project).unwrap();
    let mut job = compile(&g, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap_or_else(|e| panic!("compile: {e}"));
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "t", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export failed: {e}"));
}

/// Average PSNR between two videos (higher = more alike; "inf" when identical).
fn psnr(a: &Path, b: &Path) -> f64 {
    let o = Proc::new(tools().ffmpeg).args(["-v", "info", "-i"]).arg(a).arg("-i").arg(b).args(["-lavfi", "psnr", "-f", "null", "-"]).output().unwrap();
    let err = String::from_utf8_lossy(&o.stderr);
    let avg = err.lines().rev().find_map(|l| l.split("average:").nth(1)).unwrap_or("0");
    let v = avg.split_whitespace().next().unwrap_or("0");
    if v == "inf" { f64::INFINITY } else { v.parse().unwrap_or(0.0) }
}

#[test]
fn offered_effects_are_only_installed_plugins_and_saved_ones_always_resolve() {
    let installed = frei0r::installed();
    for d in effects::registry().iter().filter(|d| d.id.starts_with(frei0r::PREFIX)) {
        assert!(installed.contains(&d.id[frei0r::PREFIX.len()..]), "{} offered but not installed", d.id);
        assert_eq!(d.category, "Frei0r");
    }
    // a plugin that is not installed here still resolves, so a project saved elsewhere opens
    assert!(effects::find("f0:glitch0r").is_ok());
    assert!(effects::find("f0:no_such_plugin").is_err());
}

#[test]
fn glitch0r_renders_through_the_effect_stack() {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    if !caps.has_filter("frei0r") || !frei0r::installed().contains("glitch0r") {
        eprintln!("frei0r filter or glitch0r plugin not installed here; skipping");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src.mp4");
    let r = Proc::new(&t.ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]).arg(&src).output().unwrap();
    assert!(r.status.success());
    let mut eng = Engine::new("f0", ProjectSettings { width: 320, height: 240, fps: Rational::from_int(25), sample_rate: 48000 }, t.clone());
    let m = eng.import_media(&src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: Rational::from_int(0), source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    let clip = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    let base = dir.path().join("base.mp4");
    export(&eng, &base);
    // glitch frequency (p0) up full: every frame gets block-shifted
    let mut params = std::collections::BTreeMap::new();
    params.insert("p0".to_string(), 1.0);
    params.insert("p2".to_string(), 1.0);
    eng.dispatch(Command::AddEffect { clip: clip.clone(), effect: "f0:glitch0r".into(), params, index: None }).unwrap();
    let out = dir.path().join("glitched.mp4");
    export(&eng, &out);
    let p = psnr(&base, &out);
    assert!(p < 35.0, "glitch0r should visibly change the picture, psnr {p}");
    // frequency 0 leaves the picture alone
    eng.undo().unwrap();
    let mut calm = std::collections::BTreeMap::new();
    calm.insert("p0".to_string(), 0.0);
    eng.dispatch(Command::AddEffect { clip, effect: "f0:glitch0r".into(), params: calm, index: None }).unwrap();
    let still = dir.path().join("calm.mp4");
    export(&eng, &still);
    assert!(psnr(&base, &still) > 40.0, "frequency 0 should not change the picture");
}
