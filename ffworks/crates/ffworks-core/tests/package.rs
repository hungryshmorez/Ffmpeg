//! Packaging copies the project and all media (files and image sequences) and the copy opens and renders on its own.
use ffworks_core::commands::Command;
use ffworks_core::engine::{prepare_sequence_asset, Engine};
use ffworks_core::package::package;
use ffworks_core::process::Tools;
use ffworks_core::project::ProjectSettings;
use ffworks_core::time::Fps;
use ffworks_core::Rational;
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}

#[test]
fn a_packaged_project_is_self_contained_and_the_original_is_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let ff = |args: &[&str]| assert!(Proc::new(tools().ffmpeg).args(["-v", "error", "-y"]).args(args).status().unwrap().success());
    let video = dir.path().join("src").join("clip.mp4");
    std::fs::create_dir_all(video.parent().unwrap()).unwrap();
    ff(&["-f", "lavfi", "-i", "testsrc2=s=160x120:r=25:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", video.to_str().unwrap()]);
    let frames = dir.path().join("frames");
    std::fs::create_dir_all(&frames).unwrap();
    ff(&["-f", "lavfi", "-i", "testsrc2=s=160x120:r=25:d=1", frames.join("f_%03d.png").to_str().unwrap()]);
    let mut eng = Engine::new("pkg", ProjectSettings { width: 160, height: 120, fps: Rational::from_int(25), sample_rate: 48000 }, tools());
    let m1 = eng.import_media(&video).unwrap();
    let m2 = eng.import_asset(prepare_sequence_asset(&tools(), &frames.join("f_010.png"), Fps::new(25, 1)).unwrap()).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m1, track: v.clone(), start: Rational::ZERO, source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    eng.dispatch(Command::PlaceClip { media: m2, track: v, start: Rational::from_int(1), source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    let before = serde_json::to_string(&eng.project).unwrap();
    let out = dir.path().join("pack");
    let r = package(&eng.project, &out, "My Project").unwrap();
    assert_eq!(serde_json::to_string(&eng.project).unwrap(), before, "the live project is untouched");
    assert!(r.files_copied >= 26 && r.bytes > 0, "1 video + 25 frames: {r:?}");
    // remove the originals: the package must still open, find its media and render
    std::fs::remove_dir_all(dir.path().join("src")).unwrap();
    std::fs::remove_dir_all(&frames).unwrap();
    let mut loaded = Engine::load(&r.project_file, tools()).unwrap();
    assert!(loaded.offline_media().is_empty(), "{:?}", loaded.project.media.iter().map(|m| &m.path).collect::<Vec<_>>());
    assert!(loaded.project.media.iter().all(|m| m.path.starts_with(out.to_string_lossy().as_ref())));
    let video_out = dir.path().join("o.mp4");
    let caps = ffworks_core::process::Capabilities::discover(&tools()).unwrap();
    let mut job = ffworks_core::ffmpeg::compile_project(&loaded.project, &ffworks_core::ffmpeg::RenderOptions { output: video_out.clone(), settings: ffworks_core::ffmpeg::ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap();
    job.program = tools().ffmpeg;
    ffworks_core::jobs::run_job(&tools(), &job, "t", "export", &ffworks_core::jobs::CancelToken::new(), &dir.path().join("tmp"), &mut |_| {}).unwrap();
    assert!((ffworks_core::ffprobe::probe(&tools(), &video_out).unwrap().duration.as_f64() - 2.0).abs() < 0.2, "the package renders on its own");
    loaded.undo().ok();
    // missing media is refused with the names
    let e2 = Engine::load(&r.project_file, tools()).unwrap();
    std::fs::remove_file(&e2.project.media[0].path).unwrap();
    let err = package(&e2.project, &dir.path().join("pack2"), "x").unwrap_err().to_string();
    assert!(err.contains("missing") && err.contains("clip.mp4"), "{err}");
}
