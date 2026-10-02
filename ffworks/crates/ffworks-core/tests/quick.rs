//! Quick export (stream copy): the output keeps the source codec byte-for-byte, honours the trim, and unsuitable timelines are refused.
use ffworks_core::commands::{Command, Edge};
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile_project, ExportSettings, RenderOptions};
use ffworks_core::ffprobe::probe;
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::ProjectSettings;
use ffworks_core::Rational;
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}
fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

#[test]
fn quick_export_copies_streams_honours_the_trim_and_refuses_edited_timelines() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("s.mp4");
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=6", "-f", "lavfi", "-i", "sine=f=440:r=44100:d=6", "-c:v", "libx264", "-g", "25", "-pix_fmt", "yuv420p", "-c:a", "aac"]).arg(&src).output().unwrap();
    assert!(o.status.success());
    let mut eng = Engine::new("q", ProjectSettings { width: 320, height: 240, fps: secs(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(&src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: secs(0), source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
    let clip = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    // trim to 1 s .. 5 s (keyframes every second, so the cut is exact here)
    eng.dispatch(Command::TrimClip { clip: clip.clone(), edge: Edge::Start, to: secs(1) }).unwrap();
    eng.dispatch(Command::TrimClip { clip: clip.clone(), edge: Edge::End, to: secs(5) }).unwrap();
    let st = ExportSettings::find("quick_copy").unwrap();
    let out = dir.path().join("o.mkv");
    let mut job = compile_project(&eng.project, &RenderOptions { output: out.clone(), settings: st.clone(), range: None, scale_div: 1 }, Some(&Capabilities::discover(&tools()).unwrap())).unwrap();
    assert!(!job.display().contains("filter_complex") && job.display().contains("-c copy"), "{}", job.display());
    job.program = tools().ffmpeg;
    run_job(&tools(), &job, "t", "export", &CancelToken::new(), &dir.path().join("tmp"), &mut |_| {}).unwrap();
    let info = probe(&tools(), &out).unwrap();
    assert_eq!(info.video[0].codec, "h264");
    assert_eq!(info.audio.len(), 1);
    assert!((info.duration.as_f64() - 4.0).abs() < 0.3, "duration {}", info.duration.as_f64());
    // an effect makes the timeline unsuitable, with a reason
    eng.dispatch(Command::AddEffect { clip, effect: "blur".into(), params: Default::default(), index: None }).unwrap();
    let err = compile_project(&eng.project, &RenderOptions { output: dir.path().join("x.mkv"), settings: st, range: None, scale_div: 1 }, None).unwrap_err().to_string();
    assert!(err.contains("untouched") && err.contains("effects"), "{err}");
}
