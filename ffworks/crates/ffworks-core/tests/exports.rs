//! Every export preset the installed FFmpeg can encode is rendered for real and the output codec is read back with ffprobe.
use ffworks_core::commands::Command;
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

#[test]
fn every_available_preset_renders_with_the_right_codec() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("s.mp4");
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=2", "-f", "lavfi", "-i", "sine=f=440:r=44100:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]).arg(&src).output().unwrap();
    assert!(o.status.success());
    let mut eng = Engine::new("x", ProjectSettings { width: 320, height: 240, fps: Rational::from_int(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(&src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: Rational::ZERO, source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
    let caps = Capabilities::discover(&tools()).unwrap();
    let mut done = vec![];
    for st in ExportSettings::builtin() {
        let usable = st.video_codec.as_ref().is_none_or(|c| caps.has_encoder(c)) && st.audio_codec.as_ref().is_none_or(|c| caps.has_encoder(c));
        let usable = usable && st.video_codec.as_deref().is_none_or(|v| !ffworks_core::hwenc::is_hardware(v) || ffworks_core::hwenc::works(&tools(), v));
        if !usable {
            continue;
        }
        let out = dir.path().join(format!("{}.{}", st.id, st.extension));
        let out = if st.id == "png_sequence" { dir.path().join("frames.png") } else { out };
        let mut job = compile_project(&eng.project, &RenderOptions { output: out.clone(), settings: st.clone(), range: None, scale_div: 1 }, Some(&caps)).unwrap_or_else(|e| panic!("{}: {e}", st.id));
        job.program = tools().ffmpeg;
        run_job(&tools(), &job, "t", "export", &CancelToken::new(), &dir.path().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("{} failed: {e}", st.id));
        if st.id == "png_sequence" {
            assert!(job.output.exists(), "first frame {} exists", job.output.display());
            let n = std::fs::read_dir(dir.path()).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with("frames_")).count();
            assert_eq!(n, 50, "2 s at 25 fps");
            done.push(st.id);
            continue;
        }
        if st.id == "datamosh_mp4" {
            let o = Proc::new(tools().ffprobe).args(["-v", "error", "-skip_frame", "nokey", "-select_streams", "v", "-show_entries", "frame=pts_time", "-of", "csv"]).arg(&out).output().unwrap();
            let keyframes = String::from_utf8_lossy(&o.stdout).lines().filter(|l| !l.trim().is_empty()).count();
            assert_eq!(keyframes, 1, "only the first keyframe survives");
        }
        let info = probe(&tools(), &out).unwrap();
        if let Some(vc) = &st.video_codec {
            let want = match vc.as_str() { "libx264" => "h264", "libx265" => "hevc", "libvpx-vp9" => "vp9", "libsvtav1" => "av1", "prores_ks" => "prores", "dnxhd" => "dnxhd", other => other };
            assert_eq!(info.video[0].codec, want, "{}", st.id);
            assert_eq!((info.video[0].width, info.video[0].height), (320, 240), "{}", st.id);
        }
        assert!((info.duration.as_f64() - 2.0).abs() < 0.2, "{} lasts {}", st.id, info.duration.as_f64());
        done.push(st.id);
    }
    assert!(done.contains(&"h264_mp4".to_string()) && done.contains(&"wav".to_string()));
    eprintln!("rendered presets: {done:?}");
}
