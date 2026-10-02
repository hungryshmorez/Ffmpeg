//! Transform, blend, keyframes, speed/reverse/freeze rendered by real FFmpeg and checked by sampling output pixels.
use ffworks_core::commands::{Command, Edge};
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile, ExportSettings, RenderOptions};
use ffworks_core::ffprobe::probe;
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::{ProjectSettings, TrackKind};
use ffworks_core::{render_graph, Rational};
use std::path::{Path, PathBuf};
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}
fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

fn ffmpeg(args: &[&str]) {
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-y"]).args(args).output().expect("ffmpeg runs");
    assert!(out.status.success(), "fixture generation failed: {}", String::from_utf8_lossy(&out.stderr));
}

/// 320x240, 25 fps, left half `left` | right half `right`, with a sine tone.
fn halves(dir: &Path, name: &str, left: &str, right: &str, secs_: u32) -> PathBuf {
    let p = dir.join(name);
    ffmpeg(&[
        "-f", "lavfi", "-i", &format!("color=c={left}:s=160x240:r=25:d={secs_}"),
        "-f", "lavfi", "-i", &format!("color=c={right}:s=160x240:r=25:d={secs_}"),
        "-f", "lavfi", "-i", &format!("sine=f=440:r=44100:d={secs_}"),
        "-filter_complex", "[0:v][1:v]hstack[v]", "-map", "[v]", "-map", "2:a",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "5", "-c:a", "aac", "-shortest", p.to_str().unwrap(),
    ]);
    p
}

/// 4 s: red, green, blue, yellow (1 s each) with a 440 Hz tone, 320x240 @25.
fn seasons(dir: &Path) -> PathBuf {
    let p = dir.join("seasons.mp4");
    ffmpeg(&[
        "-f", "lavfi", "-i", "color=c=red:s=320x240:r=25:d=1",
        "-f", "lavfi", "-i", "color=c=green:s=320x240:r=25:d=1",
        "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=25:d=1",
        "-f", "lavfi", "-i", "color=c=yellow:s=320x240:r=25:d=1",
        "-f", "lavfi", "-i", "sine=f=440:r=44100:d=4",
        "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1[v]", "-map", "[v]", "-map", "4:a",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "5", "-c:a", "aac", "-shortest", p.to_str().unwrap(),
    ]);
    p
}

fn rgb_at(video: &Path, t: f64, x: u32, y: u32) -> (i32, i32, i32) {
    let out = Proc::new(tools().ffmpeg)
        .args(["-v", "error", "-ss", &format!("{t}"), "-i"])
        .arg(video)
        .args(["-frames:v", "1", "-vf", &format!("crop=2:2:{x}:{y},scale=1:1"), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .output()
        .unwrap();
    assert_eq!(out.stdout.len(), 3, "no frame at t={t}");
    (out.stdout[0] as i32, out.stdout[1] as i32, out.stdout[2] as i32)
}

fn is(p: (i32, i32, i32), want: (i32, i32, i32)) -> bool {
    (p.0 - want.0).abs() < 70 && (p.1 - want.1).abs() < 70 && (p.2 - want.2).abs() < 70
}
const RED: (i32, i32, i32) = (255, 0, 0);
const GREEN: (i32, i32, i32) = (0, 128, 0); // FFmpeg's named colour `green`
const BLUE: (i32, i32, i32) = (0, 0, 255);
const YELLOW: (i32, i32, i32) = (255, 255, 0);
const BLACK: (i32, i32, i32) = (0, 0, 0);

fn export(eng: &Engine, out: &Path) {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let g = render_graph::build(&eng.project).unwrap();
    let mut job = compile(&g, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap_or_else(|e| panic!("compile: {e}"));
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "t", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export failed: {e}"));
}

/// Project 320x240@25 with one clip of `src` on V1 at 0. Returns (engine, video clip id, V1 track id).
fn one_clip(src: &Path) -> (Engine, String, String) {
    let mut eng = Engine::new("fx", ProjectSettings { width: 320, height: 240, fps: secs(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v.clone(), start: secs(0), source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
    let id = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    (eng, id, v)
}

fn set(eng: &mut Engine, clip: &str, param: &str, value: f64) {
    eng.dispatch(Command::SetClipParam { clip: clip.into(), param: param.into(), value }).unwrap_or_else(|e| panic!("{param}: {e}"));
}
fn key(eng: &mut Engine, clip: &str, param: &str, t: Rational, value: f64) {
    eng.dispatch(Command::SetKeyframe { clip: clip.into(), param: param.into(), time: t, value, interp: None }).unwrap_or_else(|e| panic!("{param}: {e}"));
}

fn mean_volume_db(media: &Path, from: f64, dur: f64) -> f64 {
    let out = Proc::new(tools().ffmpeg).args(["-nostdin", "-ss", &from.to_string(), "-t", &dur.to_string(), "-i"]).arg(media).args(["-vn", "-af", "volumedetect", "-f", "null", "-"]).output().unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    err.lines().find_map(|l| l.split("mean_volume:").nth(1)).and_then(|v| v.trim().trim_end_matches(" dB").parse().ok()).unwrap_or(-91.0)
}

#[test]
fn transform_moves_scales_and_rotates_the_picture() {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "halves.mp4", "red", "blue", 2);
    let (mut eng, id, _) = one_clip(&src);
    let base = dir.path().join("base.mp4");
    export(&eng, &base);
    assert!(is(rgb_at(&base, 1.0, 40, 120), RED) && is(rgb_at(&base, 1.0, 280, 120), BLUE), "baseline red | blue");

    // shift right by 80 px: red now spans 80..240, blue 240..320, left strip empty
    set(&mut eng, &id, "x", 80.0);
    let out = dir.path().join("x.mp4");
    export(&eng, &out);
    assert!(is(rgb_at(&out, 1.0, 40, 120), BLACK), "uncovered strip must be black, got {:?}", rgb_at(&out, 1.0, 40, 120));
    assert!(is(rgb_at(&out, 1.0, 120, 120), RED));
    assert!(is(rgb_at(&out, 1.0, 280, 120), BLUE));

    // half size about the centre: picture occupies x 80..240, y 60..180
    set(&mut eng, &id, "x", 0.0);
    set(&mut eng, &id, "scale", 0.5);
    let out = dir.path().join("s.mp4");
    export(&eng, &out);
    assert!(is(rgb_at(&out, 1.0, 20, 120), BLACK) && is(rgb_at(&out, 1.0, 160, 20), BLACK), "outside the shrunk picture is black");
    assert!(is(rgb_at(&out, 1.0, 110, 120), RED) && is(rgb_at(&out, 1.0, 210, 120), BLUE));

    // 90° clockwise: the left (red) half ends up on top, blue at the bottom, and the picture is now 240 px wide
    set(&mut eng, &id, "scale", 1.0);
    set(&mut eng, &id, "rotation", 90.0);
    let out = dir.path().join("r.mp4");
    export(&eng, &out);
    assert!(is(rgb_at(&out, 1.0, 160, 40), RED), "top should be red, got {:?}", rgb_at(&out, 1.0, 160, 40));
    assert!(is(rgb_at(&out, 1.0, 160, 200), BLUE));
    assert!(is(rgb_at(&out, 1.0, 10, 120), BLACK), "rotated picture is only 240 px wide");
}

#[test]
fn keyframed_position_and_opacity_follow_the_curve_over_time() {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "halves.mp4", "red", "blue", 2);
    let (mut eng, id, _) = one_clip(&src);
    // slide right by 160 px over 2 s
    key(&mut eng, &id, "x", secs(0), 0.0);
    key(&mut eng, &id, "x", secs(2), 160.0);
    let out = dir.path().join("kx.mp4");
    export(&eng, &out);
    // t=0.1: nearly home -> (20,120) still red; t=1.0: shifted ~80 -> (40,120) black, (120,120) red; t=1.9: shifted ~152 -> (100,120) black
    assert!(is(rgb_at(&out, 0.1, 20, 120), RED), "{:?}", rgb_at(&out, 0.1, 20, 120));
    assert!(is(rgb_at(&out, 1.0, 40, 120), BLACK), "{:?}", rgb_at(&out, 1.0, 40, 120));
    assert!(is(rgb_at(&out, 1.0, 120, 120), RED), "{:?}", rgb_at(&out, 1.0, 120, 120));
    assert!(is(rgb_at(&out, 1.9, 100, 120), BLACK), "{:?}", rgb_at(&out, 1.9, 100, 120));
    assert!(is(rgb_at(&out, 1.9, 300, 120), RED), "red half now covers the right edge: {:?}", rgb_at(&out, 1.9, 300, 120));

    // opacity 0 -> 1 over 2 s on a red clip over black
    let src = halves(dir.path(), "red.mp4", "red", "red", 2);
    let (mut eng, id, _) = one_clip(&src);
    key(&mut eng, &id, "opacity", secs(0), 0.0);
    key(&mut eng, &id, "opacity", secs(2), 1.0);
    let out = dir.path().join("ko.mp4");
    export(&eng, &out);
    let (a, b, c) = (rgb_at(&out, 0.1, 100, 100).0, rgb_at(&out, 1.0, 100, 100).0, rgb_at(&out, 1.9, 100, 100).0);
    assert!(a < 70 && (b - 128).abs() < 50 && c > 190 && a < b && b < c, "red channel should rise with time: {a} {b} {c}");
}

#[test]
fn keyframed_effect_parameter_changes_over_time() {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "white.mp4", "white", "white", 2);
    let (mut eng, id, _) = one_clip(&src);
    eng.dispatch(Command::AddEffect { clip: id.clone(), effect: "brightness".into(), params: Default::default(), index: None }).unwrap();
    let fx = eng.project.active().unwrap().tracks[0].clips[0].effects[0].id.clone();
    let p = format!("fx:{fx}:amount");
    key(&mut eng, &id, &p, secs(0), 0.0);
    key(&mut eng, &id, &p, secs(2), -1.0);
    let out = dir.path().join("kb.mp4");
    export(&eng, &out);
    let (a, b, c) = (rgb_at(&out, 0.1, 100, 100).0, rgb_at(&out, 1.0, 100, 100).0, rgb_at(&out, 1.9, 100, 100).0);
    assert!(a > 200 && c < 60 && a > b && b > c, "white should fade to black: {a} {b} {c}");
}

#[test]
fn crop_effect_makes_the_edge_transparent_so_lower_layers_show() {
    let dir = tempfile::tempdir().unwrap();
    let blue = halves(dir.path(), "blue.mp4", "blue", "blue", 2);
    let red = halves(dir.path(), "red.mp4", "red", "red", 2);
    let (mut eng, bottom, _) = one_clip(&blue);
    let _ = bottom;
    eng.dispatch(Command::AddTrack { kind: TrackKind::Video, name: None }).unwrap();
    let v2 = eng.project.active().unwrap().tracks.iter().rfind(|t| t.kind == TrackKind::Video).unwrap().id.clone();
    let m = eng.import_media(&red).unwrap();
    eng.dispatch(Command::PlaceClip { media: m, track: v2.clone(), start: secs(0), source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    let top = eng.project.active().unwrap().tracks.iter().find(|t| t.id == v2).unwrap().clips[0].id.clone();
    let mut o = std::collections::BTreeMap::new();
    o.insert("left".to_string(), 50.0);
    eng.dispatch(Command::AddEffect { clip: top, effect: "crop".into(), params: o, index: None }).unwrap();
    let out = dir.path().join("crop.mp4");
    export(&eng, &out);
    assert!(is(rgb_at(&out, 1.0, 40, 120), BLUE), "cropped-away left half shows the blue layer below: {:?}", rgb_at(&out, 1.0, 40, 120));
    assert!(is(rgb_at(&out, 1.0, 280, 120), RED), "{:?}", rgb_at(&out, 1.0, 280, 120));
}

#[test]
fn blend_modes_combine_with_the_layer_below_and_only_where_the_clip_is() {
    let dir = tempfile::tempdir().unwrap();
    let gray = halves(dir.path(), "gray.mp4", "0x808080", "0x808080", 4);
    let red = halves(dir.path(), "red.mp4", "red", "red", 2);
    let (mut eng, _, _) = one_clip(&gray);
    eng.dispatch(Command::AddTrack { kind: TrackKind::Video, name: None }).unwrap();
    let v2 = eng.project.active().unwrap().tracks.iter().rfind(|t| t.kind == TrackKind::Video).unwrap().id.clone();
    let m = eng.import_media(&red).unwrap();
    eng.dispatch(Command::PlaceClip { media: m, track: v2.clone(), start: secs(1), source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    let top = eng.project.active().unwrap().tracks.iter().find(|t| t.id == v2).unwrap().clips[0].id.clone();

    let normal = dir.path().join("normal.mp4");
    export(&eng, &normal);
    assert!(is(rgb_at(&normal, 2.0, 100, 100), RED), "normal mode covers the gray");

    eng.dispatch(Command::SetClipBlend { clip: top.clone(), blend: "multiply".into() }).unwrap();
    let out = dir.path().join("mult.mp4");
    export(&eng, &out);
    // gray(128) × red(255,0,0) = (128,0,0): dark red, clearly different from both gray and pure red
    let p = rgb_at(&out, 2.0, 100, 100);
    assert!(p.0 > 80 && p.0 < 190 && p.1 < 50 && p.2 < 50, "multiply should give dark red, got {p:?}");
    // the blend only exists while the clip does: before (t=0.5) and after (t=3.5) it is plain gray
    for t in [0.5, 3.5] {
        let g = rgb_at(&out, t, 100, 100);
        assert!((g.0 - 128).abs() < 30 && (g.1 - 128).abs() < 30 && (g.2 - 128).abs() < 30, "t={t}: {g:?}");
    }

    eng.dispatch(Command::SetClipBlend { clip: top, blend: "screen".into() }).unwrap();
    let out = dir.path().join("screen.mp4");
    export(&eng, &out);
    // screen(gray, red) = 1-(1-.5)(1-(1,0,0)) = (1, .5, .5): light red/pink
    let p = rgb_at(&out, 2.0, 100, 100);
    assert!(p.0 > 200 && p.1 > 90 && p.1 < 190 && p.2 > 90 && p.2 < 190, "screen should give pink, got {p:?}");
}

#[test]
fn speed_up_slow_down_reverse_and_freeze_render_the_right_frames() {
    let dir = tempfile::tempdir().unwrap();
    let src = seasons(dir.path());

    // 2x: the 4 s source plays in 2 s
    let (mut eng, id, _) = one_clip(&src);
    eng.dispatch(Command::SetClipSpeed { clip: id.clone(), speed: secs(2) }).unwrap();
    let out = dir.path().join("fast.mp4");
    export(&eng, &out);
    let info = probe(&tools(), &out).unwrap();
    assert!((info.duration.as_f64() - 2.0).abs() < 0.15, "duration {}", info.duration.as_f64());
    for (t, want) in [(0.25, RED), (0.75, GREEN), (1.25, BLUE), (1.75, YELLOW)] {
        assert!(is(rgb_at(&out, t, 100, 100), want), "2x t={t}: {:?}", rgb_at(&out, t, 100, 100));
    }
    // audio still present and exactly as long as the picture (pitch is preserved by atempo; level just needs to be non-silent)
    assert!(mean_volume_db(&out, 0.2, 1.5) > -40.0);

    // 0.5x: 8 s, each colour lasts 2 s
    let (mut eng, id, _) = one_clip(&src);
    eng.dispatch(Command::SetClipSpeed { clip: id.clone(), speed: Rational::new(1, 2) }).unwrap();
    let out = dir.path().join("slow.mp4");
    export(&eng, &out);
    assert!((probe(&tools(), &out).unwrap().duration.as_f64() - 8.0).abs() < 0.2);
    for (t, want) in [(1.0, RED), (3.0, GREEN), (5.0, BLUE), (7.0, YELLOW)] {
        assert!(is(rgb_at(&out, t, 100, 100), want), "0.5x t={t}: {:?}", rgb_at(&out, t, 100, 100));
    }
    assert!(mean_volume_db(&out, 1.0, 5.0) > -40.0, "slowed audio is present");

    // reverse: yellow, blue, green, red
    let (mut eng, id, _) = one_clip(&src);
    eng.dispatch(Command::SetClipReverse { clip: id, reverse: true }).unwrap();
    let out = dir.path().join("rev.mp4");
    export(&eng, &out);
    for (t, want) in [(0.5, YELLOW), (1.5, BLUE), (2.5, GREEN), (3.5, RED)] {
        assert!(is(rgb_at(&out, t, 100, 100), want), "reverse t={t}: {:?}", rgb_at(&out, t, 100, 100));
    }
    assert!(mean_volume_db(&out, 0.5, 3.0) > -40.0, "reversed audio is present");

    // freeze on the green frame (source 1.5 s), then lengthen to 6 s: green throughout, longer than the source
    let (mut eng, id, _) = one_clip(&src);
    eng.dispatch(Command::SetClipFreeze { clip: id.clone(), at: Some(Rational::new(3, 2)) }).unwrap();
    eng.dispatch(Command::TrimClip { clip: id, edge: Edge::End, to: secs(6) }).unwrap();
    let out = dir.path().join("freeze.mp4");
    export(&eng, &out);
    assert!((probe(&tools(), &out).unwrap().duration.as_f64() - 6.0).abs() < 0.2, "frozen clip is 6 s long");
    for t in [0.2, 2.0, 3.9, 5.7] {
        assert!(is(rgb_at(&out, t, 100, 100), GREEN), "freeze t={t}: {:?}", rgb_at(&out, t, 100, 100));
    }
}

#[test]
fn reverse_that_would_not_fit_in_memory_is_refused_before_running() {
    let dir = tempfile::tempdir().unwrap();
    let src = seasons(dir.path());
    let mut eng = Engine::new("big", ProjectSettings { width: 3840, height: 2160, fps: secs(60), sample_rate: 48000 }, tools());
    let m = eng.import_media(&src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: secs(0), source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    let id = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    eng.dispatch(Command::SetClipReverse { clip: id, reverse: true }).unwrap();
    let g = render_graph::build(&eng.project).unwrap();
    let err = compile(&g, &RenderOptions { output: dir.path().join("o.mp4"), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, None).unwrap_err();
    assert!(err.to_string().contains("memory"), "{err}");
    // a preview-sized render of the same project is allowed
    assert!(compile(&g, &RenderOptions { output: dir.path().join("o.mp4"), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 4 }, None).is_ok());
}

#[test]
fn split_clip_with_speed_renders_continuously() {
    let dir = tempfile::tempdir().unwrap();
    let src = seasons(dir.path());
    let (mut eng, id, _) = one_clip(&src);
    eng.dispatch(Command::SetClipSpeed { clip: id.clone(), speed: secs(2) }).unwrap(); // 2 s on the timeline
    eng.dispatch(Command::SplitClip { clip: id, at: secs(1) }).unwrap();
    let out = dir.path().join("split.mp4");
    export(&eng, &out);
    // 2x speed: timeline 0-0.5 red, 0.5-1 green, 1-1.5 blue, 1.5-2 yellow — the cut at 1 s must not repeat or skip anything
    for (t, want) in [(0.25, RED), (0.75, GREEN), (1.25, BLUE), (1.75, YELLOW)] {
        assert!(is(rgb_at(&out, t, 100, 100), want), "t={t}: {:?}", rgb_at(&out, t, 100, 100));
    }
}

#[test]
fn every_interpolation_in_ffmpeg_matches_the_engine_curve() {
    use ffworks_core::keyframes::{eval, Interp};
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "red.mp4", "red", "red", 2);
    for interp in [Interp::Linear, Interp::EaseIn, Interp::EaseOut, Interp::EaseInOut, Interp::Hold] {
        let (mut eng, id, _) = one_clip(&src);
        eng.dispatch(Command::SetKeyframe { clip: id.clone(), param: "opacity".into(), time: secs(0), value: 0.0, interp: Some(interp) }).unwrap();
        key(&mut eng, &id, "opacity", secs(2), 1.0);
        let curve = eng.project.active().unwrap().tracks[0].clips[0].keyframes["opacity"].clone();
        let out = dir.path().join(format!("{interp:?}.mp4"));
        export(&eng, &out);
        for t in [0.4, 1.0, 1.6] {
            let want = 255.0 * eval(&curve, t).unwrap();
            let got = rgb_at(&out, t, 100, 100).0 as f64;
            assert!((got - want).abs() < 30.0, "{interp:?} t={t}: FFmpeg gave R={got}, engine curve says {want}");
        }
    }
}

#[test]
fn every_blend_mode_renders_in_real_ffmpeg() {
    let dir = tempfile::tempdir().unwrap();
    let base = halves(dir.path(), "g.mp4", "0x808080", "0x808080", 2);
    let top = halves(dir.path(), "r.mp4", "orange", "orange", 2);
    let (mut eng, _, _) = one_clip(&base);
    eng.dispatch(Command::AddTrack { kind: TrackKind::Video, name: None }).unwrap();
    let v2 = eng.project.active().unwrap().tracks.iter().rfind(|t| t.kind == TrackKind::Video).unwrap().id.clone();
    let m = eng.import_media(&top).unwrap();
    eng.dispatch(Command::PlaceClip { media: m, track: v2.clone(), start: secs(0), source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    let id = eng.project.active().unwrap().tracks.iter().find(|t| t.id == v2).unwrap().clips[0].id.clone();
    for (mode, _) in ffworks_core::clipprops::BLEND_MODES {
        eng.dispatch(Command::SetClipBlend { clip: id.clone(), blend: (*mode).into() }).unwrap();
        export(&eng, &dir.path().join(format!("{mode}.mp4"))); // panics with FFmpeg's message if a mode is rejected
    }
}

#[test]
fn static_position_combines_with_animated_scale() {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "halves.mp4", "red", "blue", 4);
    let (mut eng, id, _) = one_clip(&src);
    set(&mut eng, &id, "x", 80.0);
    eng.dispatch(Command::SetKeyframe { clip: id.clone(), param: "scale".into(), time: secs(1), value: 1.0, interp: Some(ffworks_core::keyframes::Interp::EaseInOut) }).unwrap();
    key(&mut eng, &id, "scale", secs(2), 0.5);
    let g = render_graph::build(&eng.project).unwrap();
    let job = compile(&g, &RenderOptions { output: dir.path().join("o.mp4"), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, None).unwrap();
    println!("GRAPH: {}", job.filter_graph);
    let out = dir.path().join("o.mp4");
    export(&eng, &out);
    // t=3: scale .5 + x 80 -> picture spans x 160..320: red 160..240, blue 240..320, left strip black
    assert!(is(rgb_at(&out, 3.0, 40, 120), BLACK), "{:?}", rgb_at(&out, 3.0, 40, 120));
    assert!(is(rgb_at(&out, 3.0, 200, 120), RED), "{:?}", rgb_at(&out, 3.0, 200, 120));
    assert!(is(rgb_at(&out, 3.0, 280, 120), BLUE), "{:?}", rgb_at(&out, 3.0, 280, 120));
}
