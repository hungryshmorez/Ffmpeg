//! The bundled GL transitions against the real installed FFmpeg: every expression must be accepted by `xfade`, start on picture A,
//! end on picture B and look different from both in the middle. Then a few go through the whole project -> export path.
use ffworks_core::commands::{Command, Edge};
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile, ExportSettings, RenderOptions};
use ffworks_core::ffprobe::probe;
use ffworks_core::glx;
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::ProjectSettings;
use ffworks_core::titles::escape_filter_value;
use ffworks_core::{render_graph, Rational};
use std::path::Path;
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}

/// Mean colour of the frame at `t` seconds.
fn mean_rgb(video: &Path, t: f64) -> (i32, i32, i32) {
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-ss", &t.to_string(), "-i"]).arg(video).args(["-frames:v", "1", "-vf", "scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap();
    assert_eq!(out.stdout.len(), 3, "no frame at t={t} of {}", video.display());
    (out.stdout[0] as i32, out.stdout[1] as i32, out.stdout[2] as i32)
}
fn far(a: (i32, i32, i32), b: (i32, i32, i32), by: i32) -> bool {
    (a.0 - b.0).abs() > by || (a.1 - b.1).abs() > by || (a.2 - b.2).abs() > by
}
const RED: (i32, i32, i32) = (255, 0, 0);
const BLUE: (i32, i32, i32) = (0, 0, 255);

#[test]
fn every_bundled_gl_transition_runs_and_goes_from_a_to_b() {
    let caps = Capabilities::discover(&tools()).unwrap();
    if !caps.xfade_custom {
        eprintln!("this FFmpeg's xfade has no custom expressions; skipping");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let mut problems = vec![];
    for (name, expr) in glx::all() {
        let out = dir.path().join(format!("{name}.mp4"));
        let graph = format!("[0][1]xfade=transition=custom:expr={}:duration=1:offset=0.5,format=yuv420p", escape_filter_value(expr));
        let mut child = Proc::new(tools().ffmpeg)
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=128x96:r=25:d=2,format=yuv420p", "-f", "lavfi", "-i", "color=c=blue:s=128x96:r=25:d=2,format=yuv420p", "-filter_complex", &graph, "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&out)
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        // a pathological expression must fail the test, not hang it
        let started = std::time::Instant::now();
        let status = loop {
            if let Some(st) = child.try_wait().unwrap() {
                break Some(st);
            }
            if started.elapsed() > std::time::Duration::from_secs(60) {
                child.kill().ok();
                child.wait().ok();
                break None;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        let Some(status) = status else {
            problems.push(format!("{name}: took more than 60 s for a 128x96 clip"));
            continue;
        };
        let r = std::process::Output { status, stdout: vec![], stderr: vec![] };
        if !r.status.success() {
            problems.push(format!("{name}: ffmpeg failed: {}", String::from_utf8_lossy(&r.stderr).lines().next().unwrap_or("")));
            continue;
        }
        let (start, mid, end) = (mean_rgb(&out, 0.2), mean_rgb(&out, 1.0), mean_rgb(&out, 1.9));
        if far(start, RED, 40) {
            problems.push(format!("{name}: before the transition the picture should be A (red), got {start:?}"));
        }
        if far(end, BLUE, 40) {
            problems.push(format!("{name}: after the transition the picture should be B (blue), got {end:?}"));
        }
        if !far(mid, RED, 25) || !far(mid, BLUE, 25) {
            problems.push(format!("{name}: halfway it looks like a plain A or B: {mid:?}"));
        }
    }
    assert!(problems.is_empty(), "{} of {} GL transitions misbehave:\n{}", problems.len(), glx::all().len(), problems.join("\n"));
}

#[test]
fn a_gl_transition_renders_through_the_project_pipeline_and_survives_save_and_load() {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    if !caps.xfade_custom {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("h.mp4");
    let r = Proc::new(&t.ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=160x240:r=25:d=8", "-f", "lavfi", "-i", "color=c=blue:s=160x240:r=25:d=8", "-f", "lavfi", "-i", "sine=f=440:r=44100:d=8", "-filter_complex", "[0:v][1:v]hstack[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "5", "-c:a", "aac", "-shortest"])
        .arg(&src)
        .output()
        .unwrap();
    assert!(r.status.success());
    let mut eng = Engine::new("glx", ProjectSettings { width: 320, height: 240, fps: Rational::from_int(25), sample_rate: 48000 }, t.clone());
    let m = eng.import_media(&src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m.clone(), track: v.clone(), start: Rational::from_int(0), source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    let a = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    eng.dispatch(Command::TrimClip { clip: a.clone(), edge: Edge::End, to: Rational::from_int(2) }).unwrap();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: Rational::from_int(2), source_in: Some(Rational::from_int(3)), duration: Some(Rational::from_int(2)), with_audio: false, audio_track: None }).unwrap();
    let b = eng.project.active().unwrap().tracks[0].clips[1].id.clone();
    // a made-up GL name and a non-GL custom name are refused; a real one is accepted
    for bad in ["gl_does_not_exist", "custom"] {
        assert!(eng.dispatch(Command::AddTransition { clip_a: a.clone(), clip_b: b.clone(), kind: bad.into(), duration: Rational::new(1, 1) }).is_err(), "{bad}");
    }
    for kind in ["gl_angular", "gl_swap", "gl_pinwheel"] {
        if glx::expr(kind).is_none() {
            continue;
        }
        eng.dispatch(Command::AddTransition { clip_a: a.clone(), clip_b: b.clone(), kind: kind.into(), duration: Rational::new(1, 1) }).unwrap();
        let out = dir.path().join(format!("{kind}.mp4"));
        let g = render_graph::build(&eng.project).unwrap();
        let mut job = compile(&g, &RenderOptions { output: out.clone(), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap_or_else(|e| panic!("compile {kind}: {e}"));
        job.program = t.ffmpeg.clone();
        run_job(&t, &job, "t", "export", &CancelToken::new(), &dir.path().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export {kind}: {e}"));
        let d = probe(&t, &out).unwrap().duration.as_f64();
        assert!((d - 4.0).abs() < 0.2, "{kind}: duration {d}");
        // before the cut it is still clip A's red|blue halves; long after, clip B's
        assert!(!far(mean_rgb(&out, 0.5), mean_rgb(&out, 3.5), 25), "{kind}: both clips show the same red|blue halves outside the transition");
        eng.undo().unwrap();
    }
    eng.dispatch(Command::AddTransition { clip_a: a, clip_b: b, kind: "gl_angular".into(), duration: Rational::new(1, 1) }).unwrap();
    let p = dir.path().join("p.ffworks");
    eng.save(&p).unwrap();
    let loaded = Engine::load(&p, t).unwrap();
    assert_eq!(loaded.project.active().unwrap().tracks[0].transitions[0].kind, "gl_angular");
}
