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
