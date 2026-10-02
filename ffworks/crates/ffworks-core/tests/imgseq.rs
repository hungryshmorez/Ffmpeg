//! Image sequences: one media item, right length, rendered frame by frame, survives save/load and is not "offline".
use ffworks_core::commands::Command;
use ffworks_core::engine::{prepare_sequence_asset, Engine};
use ffworks_core::ffmpeg::{compile_project, ExportSettings, RenderOptions};
use ffworks_core::ffprobe::probe;
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::ProjectSettings;
use ffworks_core::time::Fps;
use ffworks_core::Rational;
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}

fn px(video: &std::path::Path, t: f64) -> (i32, i32, i32) {
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-ss", &t.to_string(), "-i"]).arg(video).args(["-frames:v", "1", "-vf", "crop=2:2:20:20,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap();
    assert_eq!(o.stdout.len(), 3);
    (o.stdout[0] as i32, o.stdout[1] as i32, o.stdout[2] as i32)
}

#[test]
fn a_numbered_picture_set_becomes_one_clip_of_the_right_length_and_renders_each_frame() {
    let dir = tempfile::tempdir().unwrap();
    // 50 frames numbered from 3: red fading to blue
    let o = Proc::new(tools().ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=160x120:r=25:d=2,geq=r='255*(1-N/50)':g=0:b='255*N/50'", "-start_number", "3"])
        .arg(dir.path().join("fade_%04d.png"))
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let asset = prepare_sequence_asset(&tools(), &dir.path().join("fade_0020.png"), Fps::new(25, 1)).unwrap();
    assert!(asset.path.ends_with("fade_%04d.png") && asset.name.contains("50 frames"), "{} / {}", asset.path, asset.name);
    assert!((asset.info.duration.as_f64() - 2.0).abs() < 1e-9 && !asset.info.still);
    let mut eng = Engine::new("seq", ProjectSettings { width: 160, height: 120, fps: Rational::from_int(25), sample_rate: 48000 }, tools());
    let m = eng.import_asset(asset).unwrap();
    assert!(eng.offline_media().is_empty(), "a present sequence is not offline");
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: Rational::ZERO, source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
    assert_eq!(eng.project.active().unwrap().tracks[0].clips[0].duration, Rational::from_int(2));
    // save / load keeps it
    let f = dir.path().join("p.ffworks");
    eng.save(&f).unwrap();
    let eng2 = Engine::load(&f, tools()).unwrap();
    assert!(eng2.offline_media().is_empty());
    // render
    let out = dir.path().join("o.mp4");
    let caps = Capabilities::discover(&tools()).unwrap();
    let mut job = compile_project(&eng2.project, &RenderOptions { output: out.clone(), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap();
    assert!(job.display().contains("-start_number 3") && job.display().contains("-framerate 25/1"), "{}", job.display());
    job.program = tools().ffmpeg;
    run_job(&tools(), &job, "t", "export", &CancelToken::new(), &dir.path().join("tmp"), &mut |_| {}).unwrap();
    assert!((probe(&tools(), &out).unwrap().duration.as_f64() - 2.0).abs() < 0.1);
    let (a, b) = (px(&out, 0.1), px(&out, 1.8));
    assert!(a.0 > 200 && a.2 < 60, "starts red: {a:?}");
    assert!(b.2 > 180 && b.0 < 80, "ends blue: {b:?}");
    // a single picture is refused
    std::fs::write(dir.path().join("solo_1.png"), std::fs::read(dir.path().join("fade_0003.png")).unwrap()).unwrap();
    assert!(prepare_sequence_asset(&tools(), &dir.path().join("solo_1.png"), Fps::new(25, 1)).is_err());
}
