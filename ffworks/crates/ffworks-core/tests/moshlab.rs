//! Mosh lab end to end with real FFglitch. Needs `ffedit` and `ffgac` (folder in FFWORKS_FFGLITCH, or on PATH); without them
//! the tests print that they were skipped, and fail instead when FFWORKS_REQUIRE_FFGLITCH is set (CI sets it).
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::ffprobe::probe;
use ffworks_core::jobs::CancelToken;
use ffworks_core::moshlab::{self, GlitchTools, Mode, Request, Source};
use ffworks_core::process::Tools;
use ffworks_core::project::ProjectSettings;
use ffworks_core::{Error, Rational};
use std::path::{Path, PathBuf};
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}
fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

fn glitch() -> Option<GlitchTools> {
    let g = GlitchTools::discover(None);
    if g.is_none() {
        assert!(std::env::var_os("FFWORKS_REQUIRE_FFGLITCH").is_none(), "FFglitch is required here but was not found");
        eprintln!("SKIPPED: FFglitch not found (set FFWORKS_FFGLITCH)");
    }
    g
}

/// 320x240 @25 clip with real motion (a moving test pattern).
fn moving(dir: &Path, name: &str, pattern: &str, seconds: u32) -> PathBuf {
    let p = dir.join(name);
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i"]).arg(format!("{pattern}=s=320x240:r=25")).args(["-t", &seconds.to_string(), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "50"]).arg(&p).output().unwrap();
    assert!(out.status.success(), "fixture: {}", String::from_utf8_lossy(&out.stderr));
    p
}

fn gray(video: &Path, t: f64) -> Vec<u8> {
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-ss", &t.to_string(), "-i"]).arg(video).args(["-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "-"]).output().unwrap();
    assert_eq!(out.stdout.len(), 320 * 240, "no frame at t={t}");
    out.stdout
}
fn mse(a: &[u8], b: &[u8]) -> f64 {
    a.iter().zip(b).map(|(x, y)| (*x as f64 - *y as f64).powi(2)).sum::<f64>() / a.len() as f64
}

fn req(src: &Path, dur: i64, mode: Mode, out: &Path) -> Request {
    Request { source: Source { path: src.to_path_buf(), start: Rational::ZERO, duration: secs(dur) }, mode, width: 320, height: 240, fps: secs(25), output: out.to_path_buf() }
}

fn run(g: &GlitchTools, r: &Request) -> Vec<f64> {
    let mut seen = vec![];
    moshlab::run(&tools(), g, r, &CancelToken::new(), &mut |f| seen.push(f)).unwrap_or_else(|e| panic!("mosh failed: {e}"));
    seen
}

#[test]
fn amplified_motion_changes_the_picture_and_the_file_is_a_normal_lossless_clip() {
    let Some(g) = glitch() else { return };
    let dir = tempfile::tempdir().unwrap();
    let src = moving(dir.path(), "a.mp4", "testsrc2", 3);
    let (plain, wild) = (dir.path().join("plain.mkv"), dir.path().join("wild.mkv"));
    run(&g, &req(&src, 3, Mode::Amplify { factor: 1.0 }, &plain));
    let progress = run(&g, &req(&src, 3, Mode::Amplify { factor: 4.0 }, &wild));
    assert!(progress.first() == Some(&0.0) && progress.last() == Some(&1.0) && progress.windows(2).all(|w| w[0] <= w[1]), "{progress:?}");

    let info = probe(&tools(), &wild).unwrap();
    assert_eq!((info.video[0].width, info.video[0].height), (320, 240));
    assert_eq!(info.video[0].codec.as_str(), "ffv1");
    assert!((info.duration.as_f64() - 3.0).abs() < 0.2, "{}", info.duration.as_f64());
    // x1 is the untouched stream, x4 moves things four times as far: the later pictures are clearly different
    let d = mse(&gray(&plain, 2.5), &gray(&wild, 2.5));
    assert!(d > 800.0, "amplified picture differs from the plain one (mse {d})");
    // the very first frame has no motion to amplify
    assert!(mse(&gray(&plain, 0.0), &gray(&wild, 0.0)) < 5.0);
}

#[test]
fn drift_pushes_the_picture_along() {
    let Some(g) = glitch() else { return };
    let dir = tempfile::tempdir().unwrap();
    let src = moving(dir.path(), "a.mp4", "testsrc2", 3);
    let (plain, drift) = (dir.path().join("plain.mkv"), dir.path().join("drift.mkv"));
    run(&g, &req(&src, 3, Mode::Amplify { factor: 1.0 }, &plain));
    run(&g, &req(&src, 3, Mode::Drift { x: 6, y: 0 }, &drift));
    assert!(mse(&gray(&plain, 2.5), &gray(&drift, 2.5)) > 800.0);
    // the settings really reach the script: pushing the other way gives a different picture
    let back = dir.path().join("back.mkv");
    run(&g, &req(&src, 3, Mode::Drift { x: -6, y: 0 }, &back));
    assert!(mse(&gray(&drift, 2.5), &gray(&back, 2.5)) > 800.0, "x=+6 and x=-6 must not give the same picture");
}

#[test]
fn motion_can_be_borrowed_from_another_clip() {
    let Some(g) = glitch() else { return };
    let dir = tempfile::tempdir().unwrap();
    let a = moving(dir.path(), "a.mp4", "testsrc2", 3);
    let b = moving(dir.path(), "b.mp4", "mandelbrot", 3);
    let (own, borrowed) = (dir.path().join("own.mkv"), dir.path().join("borrowed.mkv"));
    run(&g, &req(&b, 3, Mode::Amplify { factor: 1.0 }, &own));
    run(&g, &req(&b, 3, Mode::Transfer { donor: Source { path: a.clone(), start: Rational::ZERO, duration: secs(3) } }, &borrowed));
    assert!(mse(&gray(&own, 2.5), &gray(&borrowed, 2.5)) > 800.0, "B moved with A's motion looks different from B");
}

#[test]
fn cancelling_stops_it_and_leaves_nothing_behind() {
    let Some(g) = glitch() else { return };
    let dir = tempfile::tempdir().unwrap();
    let src = moving(dir.path(), "long.mp4", "testsrc2", 20);
    let out = dir.path().join("o.mkv");
    let cancel = CancelToken::new();
    let c2 = cancel.clone();
    let r = std::thread::scope(|s| {
        s.spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            c2.cancel();
        });
        moshlab::run(&tools(), &g, &req(&src, 20, Mode::Amplify { factor: 2.0 }, &out), &cancel, &mut |_| {})
    });
    assert!(matches!(r, Err(Error::Canceled)), "{r:?}");
    assert!(!out.exists());
    let stray: Vec<_> = std::fs::read_dir(dir.path()).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().contains("partial")).collect();
    assert!(stray.is_empty());
}

#[test]
fn a_failing_tool_is_reported_not_swallowed() {
    let Some(g) = glitch() else { return };
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("nope.mp4");
    let e = moshlab::run(&tools(), &g, &req(&missing, 2, Mode::Amplify { factor: 2.0 }, &dir.path().join("o.mkv")), &CancelToken::new(), &mut |_| {}).unwrap_err();
    assert!(matches!(e, Error::ToolFailed { .. }), "{e}");
    assert!(!dir.path().join("o.mkv").exists());
}

#[test]
fn the_result_is_placed_on_a_new_track_beside_the_original() {
    let Some(g) = glitch() else { return };
    let dir = tempfile::tempdir().unwrap();
    let src = moving(dir.path(), "a.mp4", "testsrc2", 4);
    let mut eng = Engine::new("m", ProjectSettings { width: 320, height: 240, fps: secs(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(&src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: secs(1), source_in: Some(secs(1)), duration: Some(secs(2)), with_audio: false, audio_track: None }).unwrap();
    let clip = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    let source = moshlab::source_of(&eng, &clip).unwrap();
    assert_eq!((source.start, source.duration), (secs(1), secs(2)));
    let out = dir.path().join("mosh.mkv");
    run(&g, &Request { source, mode: Mode::Amplify { factor: 3.0 }, width: 320, height: 240, fps: secs(25), output: out.clone() });
    moshlab::place(&mut eng, &clip, &out).unwrap();
    let seq = eng.project.active().unwrap();
    let t = seq.tracks.iter().find(|t| t.name == "Datamosh").expect("a Datamosh track");
    assert_eq!((t.clips.len(), t.clips[0].start, t.clips[0].duration), (1, secs(1), secs(2)));
    assert_eq!(seq.tracks[0].clips.len(), 1, "the original clip stays");
    // clips that are not plain footage are refused with a reason
    eng.dispatch(Command::SetClipSpeed { clip: clip.clone(), speed: secs(2) }).unwrap();
    assert!(moshlab::source_of(&eng, &clip).unwrap_err().to_string().contains("normal speed"));
}

fn fx(name: &str, params: &[(&str, f64)]) -> Mode {
    let mut m = serde_json::Map::new();
    for (k, v) in params {
        m.insert((*k).into(), (*v).into());
    }
    Mode::Fx { fx: name.into(), params: m }
}

#[test]
fn every_vector_effect_runs_with_its_defaults_and_changes_the_picture() {
    let Some(g) = glitch() else { return };
    let dir = tempfile::tempdir().unwrap();
    let src = moving(dir.path(), "a.mp4", "testsrc2", 3);
    let plain = dir.path().join("plain.mkv");
    run(&g, &req(&src, 3, Mode::Amplify { factor: 1.0 }, &plain));
    let reference = gray(&plain, 2.5);
    for def in moshlab::FX {
        let out = dir.path().join(format!("{}.mkv", def.id));
        run(&g, &req(&src, 3, fx(def.id, &[]), &out));
        let info = probe(&tools(), &out).unwrap();
        assert_eq!((info.video[0].width, info.video[0].height, info.video[0].codec.as_str()), (320, 240, "ffv1"), "{}", def.id);
        let d = mse(&reference, &gray(&out, 2.5));
        eprintln!("{}: mse against the plain picture {d:.0}", def.id);
        assert!(d > 150.0, "{} changes the picture (mse {d})", def.id);
    }
}

/// Centre of the bright patch's mass, across (everything brighter than the gray background counts, by how much).
fn patch_x(video: &Path, t: f64) -> f64 {
    let g = gray(video, t);
    let (mut sum, mut weight) = (0.0, 0.0);
    for (i, v) in g.iter().enumerate() {
        let w = (*v as f64 - 150.0).max(0.0);
        sum += w * (i % 320) as f64;
        weight += w;
    }
    assert!(weight > 2000.0, "the bright patch is still in the picture in {} at {t} s (weight {weight}, brightest {})", video.display(), g.iter().max().unwrap());
    sum / weight
}

#[test]
fn zoom_pushes_blocks_away_from_the_centre_and_a_negative_number_pulls_them_in() {
    let Some(g) = glitch() else { return };
    let dir = tempfile::tempdir().unwrap();
    // a still picture: gray with a white patch right of centre; every vector starts at zero
    let src = dir.path().join("patch.mp4");
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=320x240:r=25,drawbox=x=216:y=108:w=32:h=24:color=white:t=fill", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "50"]).arg(&src).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let (out_, in_, still) = (dir.path().join("out.mkv"), dir.path().join("in.mkv"), dir.path().join("still.mkv"));
    run(&g, &req(&src, 3, fx("zoom", &[("strength", 6.0)]), &out_));
    run(&g, &req(&src, 3, fx("zoom", &[("strength", -6.0)]), &in_));
    run(&g, &req(&src, 3, Mode::Amplify { factor: 1.0 }, &still));
    let (x0, x_out, x_in) = (patch_x(&still, 0.8), patch_x(&out_, 0.8), patch_x(&in_, 0.8));
    eprintln!("patch across: still {x0:.1}, zoom +6 {x_out:.1}, zoom -6 {x_in:.1}");
    assert!(x_out > x0 + 3.0, "positive zoom moves the patch away from the centre ({x0} -> {x_out})");
    assert!(x_in < x0 - 3.0, "negative zoom moves it toward the centre ({x0} -> {x_in})");
}

fn patch_y(video: &Path, t: f64) -> f64 {
    let g = gray(video, t);
    let (mut sum, mut weight) = (0.0, 0.0);
    for (i, v) in g.iter().enumerate() {
        let w = (*v as f64 - 150.0).max(0.0);
        sum += w * (i / 320) as f64;
        weight += w;
    }
    assert!(weight > 2000.0, "the bright patch is still in the picture in {} at {t} s (weight {weight})", video.display());
    sum / weight
}

fn still_patch(dir: &Path, x: u32, y: u32) -> PathBuf {
    let src = dir.join("patch2.mp4");
    let f = format!("color=c=gray:s=320x240:r=25,drawbox=x={x}:y={y}:w=32:h=24:color=white:t=fill");
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", &f, "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "50"]).arg(&src).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    src
}

#[test]
fn sink_pushes_the_picture_down_and_slam_zoom_builds_then_resets() {
    let Some(g) = glitch() else { return };
    let dir = tempfile::tempdir().unwrap();
    let src = still_patch(dir.path(), 216, 60);
    let (still, sink, sunk_up) = (dir.path().join("still.mkv"), dir.path().join("sink.mkv"), dir.path().join("sinkup.mkv"));
    run(&g, &req(&src, 3, Mode::Amplify { factor: 1.0 }, &still));
    run(&g, &req(&src, 3, fx("sink", &[("strength", 8.0)]), &sink));
    run(&g, &req(&src, 3, fx("sink", &[("strength", -8.0)]), &sunk_up));
    let (y0, y_down, y_up) = (patch_y(&still, 0.8), patch_y(&sink, 0.8), patch_y(&sunk_up, 0.8));
    eprintln!("patch down: still {y0:.1}, sink +8 {y_down:.1}, sink -8 {y_up:.1}");
    assert!(y_down > y0 + 2.0, "sink moves the patch down ({y0} -> {y_down})");
    assert!(y_up < y0 - 2.0, "a negative sink lifts it ({y0} -> {y_up})");

    // shift: a vector's sign points at where the picture comes from, so the documented direction has to be measured
    let shifted = dir.path().join("shift.mkv");
    run(&g, &req(&src, 3, fx("shift", &[("amount", 16.0), ("share", 1.0)]), &shifted));
    let y_shift = patch_y(&shifted, 0.8);
    eprintln!("patch down: still {y0:.1}, shift 16 {y_shift:.1}");
    assert!(y_shift > y0 + 2.0, "shift pushes the picture downward ({y0} -> {y_shift})");

    // slam: the zoom is strongest late in each run and gone again at its start
    let src = still_patch(dir.path(), 216, 108);
    let slam = dir.path().join("slam.mkv");
    run(&g, &req(&src, 3, fx("slam", &[("strength", 12.0), ("period", 50.0)]), &slam));
    run(&g, &req(&src, 3, Mode::Amplify { factor: 1.0 }, &still));
    let x0 = patch_x(&still, 1.5);
    let late = patch_x(&slam, 1.9);
    eprintln!("patch across: still {x0:.1}, slam late in a run {late:.1}");
    assert!(late > x0 + 3.0, "late in a slam the patch has been pushed outward ({x0} -> {late})");
}

#[test]
fn slice_and_echo_are_refused_out_of_range_and_run_otherwise() {
    let none = serde_json::Map::new();
    for id in ["sink", "slam", "slice", "echo"] {
        assert!(moshlab::resolve_fx(id, &none).is_ok(), "{id}");
    }
    let mut p = serde_json::Map::new();
    p.insert("mix".into(), 1.0.into());
    assert!(moshlab::resolve_fx("echo", &p).unwrap_err().to_string().contains("must be from 0 to 0.98"));
    p.clear();
    p.insert("period".into(), 1.into());
    assert!(moshlab::resolve_fx("slam", &p).is_err());
}

#[test]
fn random_vector_effects_are_repeatable_per_seed() {
    let Some(g) = glitch() else { return };
    let dir = tempfile::tempdir().unwrap();
    let src = moving(dir.path(), "a.mp4", "testsrc2", 3);
    let (a, b, c) = (dir.path().join("a.mkv"), dir.path().join("b.mkv"), dir.path().join("c.mkv"));
    run(&g, &req(&src, 3, fx("noise", &[("seed", 5.0)]), &a));
    run(&g, &req(&src, 3, fx("noise", &[("seed", 5.0)]), &b));
    run(&g, &req(&src, 3, fx("noise", &[("seed", 6.0)]), &c));
    assert!(mse(&gray(&a, 2.5), &gray(&b, 2.5)) < 1.0, "the same seed gives the same picture");
    assert!(mse(&gray(&a, 2.5), &gray(&c, 2.5)) > 150.0, "another seed gives another picture");
}

#[test]
fn a_bad_effect_setting_is_refused_before_anything_runs() {
    let Some(g) = glitch() else { return };
    let dir = tempfile::tempdir().unwrap();
    let src = moving(dir.path(), "a.mp4", "testsrc2", 2);
    let out = dir.path().join("o.mkv");
    let e = moshlab::run(&tools(), &g, &req(&src, 2, fx("noise", &[("amount", 9999.0)]), &out), &CancelToken::new(), &mut |_| {}).unwrap_err().to_string();
    assert!(e.contains("must be from 1 to 64"), "{e}");
    assert!(!out.exists());
}
