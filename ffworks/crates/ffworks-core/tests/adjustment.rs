//! Adjustment layers: a clip whose effects apply to everything beneath it. Real FFmpeg renders, pixels are measured.
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile_project, ExportSettings, RenderOptions};
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::{ProjectSettings, TrackKind};
use ffworks_core::Rational;
use std::path::{Path, PathBuf};
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}
fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

/// 320x240 @25, left half red | right half blue, `n` seconds.
fn halves(dir: &Path, n: u32) -> PathBuf {
    let p = dir.join("h.mp4");
    let out = Proc::new(tools().ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
        .arg(format!("color=c=red:s=160x240:r=25:d={n}"))
        .args(["-f", "lavfi", "-i"])
        .arg(format!("color=c=blue:s=160x240:r=25:d={n}"))
        .args(["-filter_complex", "[0:v][1:v]hstack[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "5"])
        .arg(&p)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    p
}

fn rgb_at(video: &Path, t: f64, x: u32, y: u32) -> (i32, i32, i32) {
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-ss", &t.to_string(), "-i"]).arg(video).args(["-frames:v", "1", "-vf", &format!("crop=2:2:{x}:{y},scale=1:1"), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap();
    assert_eq!(out.stdout.len(), 3, "no frame at t={t}");
    (out.stdout[0] as i32, out.stdout[1] as i32, out.stdout[2] as i32)
}
fn is_gray(p: (i32, i32, i32)) -> bool {
    (p.0 - p.1).abs() < 25 && (p.1 - p.2).abs() < 25
}
fn near(p: (i32, i32, i32), w: (i32, i32, i32)) -> bool {
    (p.0 - w.0).abs() < 60 && (p.1 - w.1).abs() < 60 && (p.2 - w.2).abs() < 60
}
const RED: (i32, i32, i32) = (255, 0, 0);

struct Rig {
    eng: Engine,
    dir: tempfile::TempDir,
}

/// V1 holds the red|blue clip for 4 s. Returns the rig.
fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), 4);
    let mut eng = Engine::new("adj", ProjectSettings { width: 320, height: 240, fps: secs(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(&src).unwrap();
    let v1 = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v1, start: secs(0), source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    Rig { eng, dir }
}

fn video_track(eng: &mut Engine) -> String {
    eng.dispatch(Command::AddTrack { kind: TrackKind::Video, name: None }).unwrap();
    eng.project.active().unwrap().tracks.iter().rev().find(|t| t.kind == TrackKind::Video).unwrap().id.clone()
}

fn adjust(eng: &mut Engine, track: &str, start: i64, dur: i64) -> String {
    eng.dispatch(Command::AddAdjustment { track: track.into(), start: secs(start), duration: secs(dur) }).unwrap();
    let t = eng.project.active().unwrap().tracks.iter().find(|t| t.id == track).unwrap();
    t.clips.last().unwrap().id.clone()
}

fn fx(eng: &mut Engine, clip: &str, effect: &str, params: &[(&str, f64)]) {
    eng.dispatch(Command::AddEffect { clip: clip.into(), effect: effect.into(), params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect(), index: None }).unwrap_or_else(|e| panic!("{effect}: {e}"));
}

fn export(eng: &Engine, out: &Path, range: Option<(Rational, Rational)>) {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let mut job = compile_project(&eng.project, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("h264_mp4").unwrap(), range, scale_div: 1 }, Some(&caps)).unwrap_or_else(|e| panic!("compile: {e}"));
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "adj", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export failed: {e}"));
}

#[test]
fn effects_on_the_layer_change_everything_beneath_for_exactly_its_length() {
    let mut r = rig();
    let v2 = video_track(&mut r.eng);
    let adj = adjust(&mut r.eng, &v2, 1, 2);
    fx(&mut r.eng, &adj, "grayscale", &[]);
    let out = r.dir.path().join("o.mp4");
    export(&r.eng, &out, None);
    assert!(near(rgb_at(&out, 0.5, 40, 120), RED), "before the layer: untouched");
    assert!(is_gray(rgb_at(&out, 2.0, 40, 120)) && is_gray(rgb_at(&out, 2.0, 280, 120)), "inside the layer both halves are gray");
    assert!(near(rgb_at(&out, 3.5, 40, 120), RED), "after the layer: untouched");
    // the frames either side of the edges: 1.0 s is the first adjusted frame, 3.0 s the first untouched one
    assert!(is_gray(rgb_at(&out, 1.0, 40, 120)), "the layer's first frame is adjusted");
    assert!(near(rgb_at(&out, 0.96, 40, 120), RED), "the frame before it is not");
    assert!(near(rgb_at(&out, 3.0, 40, 120), RED), "the frame at its end is not");
    assert!(is_gray(rgb_at(&out, 2.96, 40, 120)), "the layer's last frame is adjusted");
}

#[test]
fn opacity_sets_how_strongly_the_adjustment_applies() {
    let mut r = rig();
    let v2 = video_track(&mut r.eng);
    let adj = adjust(&mut r.eng, &v2, 0, 4);
    fx(&mut r.eng, &adj, "grayscale", &[]);
    r.eng.dispatch(Command::SetClipOpacity { clip: adj, opacity: 0.5 }).unwrap();
    let out = r.dir.path().join("o.mp4");
    export(&r.eng, &out, None);
    let p = rgb_at(&out, 1.0, 40, 120);
    // halfway between pure red and its gray (about 76): red channel ~165, green ~38
    assert!(p.0 > 120 && p.0 < 215 && p.1 > 15 && p.1 < 90 && !is_gray(p), "half-strength: {p:?}");
}

#[test]
fn it_sees_all_tracks_below_not_just_the_one_beneath() {
    let mut r = rig();
    let v2 = video_track(&mut r.eng);
    r.eng.dispatch(Command::AddSolid { track: v2, start: secs(1), duration: secs(2), color: "#00ff00".into() }).unwrap();
    let v3 = video_track(&mut r.eng);
    let adj = adjust(&mut r.eng, &v3, 0, 4);
    fx(&mut r.eng, &adj, "grayscale", &[]);
    let out = r.dir.path().join("o.mp4");
    export(&r.eng, &out, None);
    let (l, rt) = (rgb_at(&out, 0.5, 40, 120), rgb_at(&out, 0.5, 280, 120));
    assert!(is_gray(l) && is_gray(rt) && (l.0 - rt.0).abs() > 40, "footage alone: both gray but different ({l:?} {rt:?})");
    let (gl, gr) = (rgb_at(&out, 2.0, 40, 120), rgb_at(&out, 2.0, 280, 120));
    assert!(is_gray(gl) && is_gray(gr) && (gl.0 - gr.0).abs() < 15 && gl.0 > 100, "the green solid on V2 is what got grayed: {gl:?} {gr:?}");
}

#[test]
fn a_crop_on_the_layer_limits_where_it_applies() {
    let mut r = rig();
    let v2 = video_track(&mut r.eng);
    let adj = adjust(&mut r.eng, &v2, 0, 4);
    fx(&mut r.eng, &adj, "negate", &[]);
    // crop clears the left half of the layer, so only the right half is adjusted
    fx(&mut r.eng, &adj, "crop", &[("left", 50.0)]);
    let out = r.dir.path().join("o.mp4");
    export(&r.eng, &out, None);
    assert!(near(rgb_at(&out, 1.0, 40, 120), RED), "left half untouched: {:?}", rgb_at(&out, 1.0, 40, 120));
    assert!(near(rgb_at(&out, 1.0, 280, 120), (255, 255, 0)), "right half inverted blue is yellow: {:?}", rgb_at(&out, 1.0, 280, 120));
}

#[test]
fn a_preview_starting_inside_the_layer_still_applies_it() {
    let mut r = rig();
    let v2 = video_track(&mut r.eng);
    let adj = adjust(&mut r.eng, &v2, 1, 2);
    fx(&mut r.eng, &adj, "grayscale", &[]);
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let p = ffworks_core::preview::render(&t, Some(&caps), &r.eng.project, Rational::new(3, 2), Rational::new(7, 2), 1, &r.dir.path().join("cache"), &CancelToken::new(), &mut |_| {}).unwrap();
    assert!(is_gray(rgb_at(&p.path, 0.2, 40, 120)), "1.7 s is inside the layer");
    assert!(near(rgb_at(&p.path, 1.7, 40, 120), RED), "3.2 s is after it");
}

#[test]
fn what_an_adjustment_layer_cannot_take_is_refused_with_a_reason() {
    let mut r = rig();
    let v2 = video_track(&mut r.eng);
    let adj = adjust(&mut r.eng, &v2, 0, 2);
    let audio_track = r.eng.project.active().unwrap().tracks.iter().find(|t| t.kind == TrackKind::Audio).map(|t| t.id.clone());
    let mut refused = |cmd: Command, why: &str| {
        let e = r.eng.dispatch(cmd).unwrap_err().to_string();
        assert!(e.contains(why), "{e}");
    };
    refused(Command::SetClipBlend { clip: adj.clone(), blend: "multiply".into() }, "blend");
    refused(Command::SetClipParam { clip: adj.clone(), param: "scale".into(), value: 2.0 }, "position, scale or rotation");
    refused(Command::SetClipSpeed { clip: adj.clone(), speed: secs(2) }, "retime");
    refused(Command::SetClipReverse { clip: adj.clone(), reverse: true }, "reverse");
    refused(Command::SetClipFreeze { clip: adj.clone(), at: Some(secs(0)) }, "freeze");
    refused(Command::AddEffect { clip: adj.clone(), effect: "pixel_sort".into(), params: Default::default(), index: None }, "footage of its own");
    // on audio tracks, over footage that is there, and between clips for a transition
    if let Some(a) = audio_track {
        refused(Command::AddAdjustment { track: a, start: secs(0), duration: secs(1) }, "video track");
    }
    refused(Command::AddAdjustment { track: v2.clone(), start: secs(1), duration: secs(2) }, "overlap");
    refused(Command::AddTransition { clip_a: adj.clone(), clip_b: adj.clone(), kind: "fade".into(), duration: secs(1) }, "adjustment");
    // opacity and effects, the two things it does take, work
    r.eng.dispatch(Command::SetClipOpacity { clip: adj.clone(), opacity: 0.3 }).unwrap();
    fx(&mut r.eng, &adj, "blur", &[]);
}

#[test]
fn it_saves_loads_undoes_and_leaves_ordinary_clips_alone() {
    let mut r = rig();
    let v2 = video_track(&mut r.eng);
    let adj = adjust(&mut r.eng, &v2, 1, 2);
    fx(&mut r.eng, &adj, "grayscale", &[]);
    let file = r.dir.path().join("p.ffworks");
    r.eng.save(&file).unwrap();
    let text = std::fs::read_to_string(&file).unwrap();
    assert_eq!(text.matches("\"adjustment\"").count(), 1, "only the adjustment layer carries the flag");
    let loaded = Engine::load(&file, tools()).unwrap();
    let c = loaded.project.active().unwrap().tracks.iter().flat_map(|t| &t.clips).find(|c| c.id == adj).unwrap().clone();
    assert!(c.adjustment && c.effects.len() == 1 && c.name == "Adjustment layer");
    // undo takes the effect, then the layer
    r.eng.undo().unwrap();
    r.eng.undo().unwrap();
    assert!(r.eng.project.active().unwrap().tracks.iter().flat_map(|t| &t.clips).all(|c| !c.adjustment));
}

#[test]
fn random_looks_never_pick_an_effect_the_layer_cannot_take() {
    let mut r = rig();
    let v2 = video_track(&mut r.eng);
    let adj = adjust(&mut r.eng, &v2, 0, 2);
    let clip = r.eng.project.active().unwrap().find_clip(&adj).unwrap().1.clone();
    for seed in 0..60u64 {
        let cmds = ffworks_core::random::effect_stack(&clip, 6, seed, None).unwrap();
        r.eng.dispatch(Command::Batch { label: "random".into(), commands: cmds }).unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        r.eng.undo().unwrap();
    }
}
