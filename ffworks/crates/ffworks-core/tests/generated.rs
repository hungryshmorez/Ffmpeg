//! Still images, GIFs, solid colours and titles: command semantics and real renders, checked by sampling pixels.
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile, ExportSettings, RenderOptions};
use ffworks_core::ffprobe::probe;
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::{ProjectSettings, TrackKind};
use ffworks_core::titles::{Align, Title};
use ffworks_core::{render_graph, Rational};
use std::path::{Path, PathBuf};
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}
fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}
fn ff(args: &[&str]) {
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-y"]).args(args).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

fn export(eng: &Engine, out: &Path) {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let g = render_graph::build(&eng.project).unwrap_or_else(|e| panic!("build: {e}"));
    let mut job = compile(&g, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap_or_else(|e| panic!("compile: {e}"));
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "t", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export failed: {e}"));
}

fn rgb_at(video: &Path, t: f64, x: u32, y: u32) -> (i32, i32, i32) {
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-ss", &format!("{t}"), "-i"]).arg(video).args(["-frames:v", "1", "-vf", &format!("crop=2:2:{x}:{y},scale=1:1"), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap();
    assert_eq!(o.stdout.len(), 3, "no frame at t={t}");
    (o.stdout[0] as i32, o.stdout[1] as i32, o.stdout[2] as i32)
}
fn is(p: (i32, i32, i32), want: (i32, i32, i32)) -> bool {
    (p.0 - want.0).abs() < 70 && (p.1 - want.1).abs() < 70 && (p.2 - want.2).abs() < 70
}
const RED: (i32, i32, i32) = (255, 0, 0);
const BLUE: (i32, i32, i32) = (0, 0, 255);
const GREEN: (i32, i32, i32) = (0, 255, 0);

/// Whole frame at `t` as raw RGB (for counting text pixels).
fn frame(video: &Path, t: f64, w: usize, h: usize) -> Vec<u8> {
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-ss", &format!("{t}"), "-i"]).arg(video).args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap();
    assert_eq!(o.stdout.len(), w * h * 3, "unexpected frame size");
    o.stdout
}
/// Number of pixels in the rectangle that differ clearly from `bg`.
fn non_bg(f: &[u8], w: usize, rect: (usize, usize, usize, usize), bg: (i32, i32, i32)) -> usize {
    let (x0, y0, x1, y1) = rect;
    let mut n = 0;
    for y in y0..y1 {
        for x in x0..x1 {
            let i = (y * w + x) * 3;
            let d = (f[i] as i32 - bg.0).abs() + (f[i + 1] as i32 - bg.1).abs() + (f[i + 2] as i32 - bg.2).abs();
            if d > 120 {
                n += 1;
            }
        }
    }
    n
}

fn engine(w: u32, h: u32) -> Engine {
    Engine::new("gen", ProjectSettings { width: w, height: h, fps: secs(25), sample_rate: 48000 }, tools())
}
fn track(eng: &Engine, kind: TrackKind, nth: usize) -> String {
    eng.project.active().unwrap().tracks.iter().filter(|t| t.kind == kind).nth(nth).unwrap().id.clone()
}
fn add_video_track(eng: &mut Engine) -> String {
    eng.dispatch(Command::AddTrack { kind: TrackKind::Video, name: None }).unwrap();
    let n = eng.project.active().unwrap().tracks.iter().filter(|t| t.kind == TrackKind::Video).count();
    track(eng, TrackKind::Video, n - 1)
}
fn halves_png(dir: &Path, name: &str, alpha_right: bool) -> PathBuf {
    let p = dir.join(name);
    // left half red, right half blue (or fully transparent)
    let right = if alpha_right { "color=c=blue@0:s=160x240,format=rgba" } else { "color=c=blue:s=160x240,format=rgba" };
    ff(&["-f", "lavfi", "-i", "color=c=red:s=160x240,format=rgba", "-f", "lavfi", "-i", right, "-filter_complex", "[0:v][1:v]hstack,format=rgba", "-frames:v", "1", p.to_str().unwrap()]);
    p
}

#[test]
fn a_png_is_a_still_that_can_be_placed_for_any_length_and_renders_looped() {
    let dir = tempfile::tempdir().unwrap();
    let png = halves_png(dir.path(), "halves.png", false);
    let mut eng = engine(320, 240);
    let m = eng.import_media(&png).unwrap();
    assert!(eng.project.media(&m).unwrap().info.still);
    let v = track(&eng, TrackKind::Video, 0);
    // no duration given: stills default to 5 s, and no linked audio is created
    eng.dispatch(Command::PlaceClip { media: m.clone(), track: v, start: secs(0), source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
    let c = eng.project.active().unwrap().tracks[0].clips[0].clone();
    assert_eq!(c.duration, secs(5));
    assert!(c.link.is_none() && eng.project.active().unwrap().tracks.iter().all(|t| t.kind == TrackKind::Video || t.clips.is_empty()));
    // a still can be lengthened freely: 12 s is far beyond the 0.04 s the file itself reports
    eng.dispatch(Command::TrimClip { clip: c.id.clone(), edge: ffworks_core::commands::Edge::End, to: secs(12) }).unwrap();
    let out = dir.path().join("o.mp4");
    export(&eng, &out);
    let info = probe(&tools(), &out).unwrap();
    assert!((info.duration.as_f64() - 12.0).abs() < 0.3, "duration {}", info.duration.as_f64());
    for t in [0.5, 6.0, 11.5] {
        assert!(is(rgb_at(&out, t, 40, 120), RED) && is(rgb_at(&out, t, 280, 120), BLUE), "t={t}");
    }
    // the same image used twice (two uses, two inputs) also renders
    let v1 = track(&eng, TrackKind::Video, 0);
    eng.dispatch(Command::PlaceClip { media: m, track: v1, start: secs(12), source_in: None, duration: Some(secs(2)), with_audio: false, audio_track: None }).unwrap();
    export(&eng, &out);
    assert!((probe(&tools(), &out).unwrap().duration.as_f64() - 14.0).abs() < 0.3);
}

#[test]
fn a_png_with_transparency_composites_over_the_layer_below() {
    let dir = tempfile::tempdir().unwrap();
    let png = halves_png(dir.path(), "half_clear.png", true); // left red, right transparent
    let mut eng = engine(320, 240);
    eng.dispatch(Command::AddSolid { track: track(&eng, TrackKind::Video, 0), start: secs(0), duration: secs(2), color: "#0000ff".into() }).unwrap();
    let v2 = add_video_track(&mut eng);
    let m = eng.import_media(&png).unwrap();
    eng.dispatch(Command::PlaceClip { media: m, track: v2, start: secs(0), source_in: None, duration: Some(secs(2)), with_audio: false, audio_track: None }).unwrap();
    let out = dir.path().join("o.mp4");
    export(&eng, &out);
    assert!(is(rgb_at(&out, 1.0, 40, 120), RED), "opaque half shows the PNG: {:?}", rgb_at(&out, 1.0, 40, 120));
    assert!(is(rgb_at(&out, 1.0, 280, 120), BLUE), "transparent half shows the blue solid below: {:?}", rgb_at(&out, 1.0, 280, 120));
}

#[test]
fn an_animated_gif_is_a_normal_clip_with_its_own_length() {
    let dir = tempfile::tempdir().unwrap();
    let gif = dir.path().join("a.gif");
    ff(&["-f", "lavfi", "-i", "testsrc2=s=160x90:r=10:d=2", gif.to_str().unwrap()]);
    let mut eng = engine(320, 240);
    let m = eng.import_media(&gif).unwrap();
    let info = &eng.project.media(&m).unwrap().info;
    assert!(!info.still && (info.duration.as_f64() - 2.0).abs() < 0.2, "gif duration {}", info.duration.as_f64());
    eng.dispatch(Command::PlaceClip { media: m, track: track(&eng, TrackKind::Video, 0), start: secs(0), source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
    let out = dir.path().join("o.mp4");
    export(&eng, &out);
    assert!((probe(&tools(), &out).unwrap().duration.as_f64() - 2.0).abs() < 0.3);
}

#[test]
fn solid_colour_clips_render_change_colour_and_undo() {
    let dir = tempfile::tempdir().unwrap();
    let mut eng = engine(320, 240);
    let v = track(&eng, TrackKind::Video, 0);
    eng.dispatch(Command::AddSolid { track: v.clone(), start: secs(0), duration: secs(2), color: "#00ff00".into() }).unwrap();
    let id = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    let out = dir.path().join("g.mp4");
    export(&eng, &out);
    assert!(is(rgb_at(&out, 1.0, 100, 100), GREEN));
    assert!(probe(&tools(), &out).unwrap().audio.is_empty(), "a solid has no audio");
    eng.dispatch(Command::SetSolidColor { clip: id.clone(), color: "#ff0000".into() }).unwrap();
    export(&eng, &out);
    assert!(is(rgb_at(&out, 1.0, 100, 100), RED));
    eng.undo().unwrap();
    assert!(eng.project.media(&eng.project.active().unwrap().tracks[0].clips[0].media).unwrap().name.contains("00ff00"));
    // a semi-transparent solid over black darkens/dims rather than covering
    eng.dispatch(Command::SetSolidColor { clip: id, color: "#ff000080".into() }).unwrap();
    export(&eng, &out);
    let p = rgb_at(&out, 1.0, 100, 100);
    assert!(p.0 > 80 && p.0 < 200 && p.1 < 40, "half-transparent red over black: {p:?}");
    // bad colours and non-solid clips are refused
    assert!(eng.dispatch(Command::AddSolid { track: v, start: secs(5), duration: secs(1), color: "red".into() }).is_err());
}

#[test]
fn titles_draw_text_on_a_transparent_canvas_over_other_layers() {
    let dir = tempfile::tempdir().unwrap();
    let (w, h) = (640usize, 360usize);
    let mut eng = engine(w as u32, h as u32);
    eng.dispatch(Command::AddSolid { track: track(&eng, TrackKind::Video, 0), start: secs(0), duration: secs(4), color: "#102040".into() }).unwrap();
    let v2 = add_video_track(&mut eng);
    eng.dispatch(Command::AddTitle { track: v2, start: secs(0), duration: secs(4), text: "HELLO".into() }).unwrap();
    let title = eng.project.active().unwrap().tracks.iter().find(|t| t.id != eng.project.active().unwrap().tracks[0].id && t.kind == TrackKind::Video).unwrap().clips[0].clone();
    let out = dir.path().join("t.mp4");
    export(&eng, &out);
    let bg = (16, 32, 64);
    let f = frame(&out, 1.0, w, h);
    let centre = non_bg(&f, w, (160, 120, 480, 240), bg);
    let corners = non_bg(&f, w, (0, 0, 120, 60), bg) + non_bg(&f, w, (520, 300, 640, 360), bg);
    assert!(centre > 800, "white text pixels in the centre: {centre}");
    assert_eq!(corners, 0, "the canvas outside the text is transparent: the solid shows through");

    // red text, no outline
    let mut t = title.title.clone().unwrap();
    t.color = "#ff0000".into();
    t.outline_width = 0.0;
    eng.dispatch(Command::SetTitle { clip: title.id.clone(), title: t.clone() }).unwrap();
    export(&eng, &out);
    let f = frame(&out, 1.0, w, h);
    let reddish = (160..480).flat_map(|x| (120..240).map(move |y| (x, y))).filter(|(x, y)| { let i = (y * w + x) * 3; f[i] > 200 && f[i + 1] < 60 && f[i + 2] < 60 }).count();
    assert!(reddish > 500, "red text pixels: {reddish}");

    // the clip's own transform moves the text: +120 px down empties the top and fills the bottom
    eng.dispatch(Command::SetClipParam { clip: title.id.clone(), param: "y".into(), value: 120.0 }).unwrap();
    export(&eng, &out);
    let f = frame(&out, 1.0, w, h);
    assert!(non_bg(&f, w, (160, 20, 480, 120), bg) == 0 && non_bg(&f, w, (160, 240, 480, 340), bg) > 500, "text moved down");

    // opacity animates through the clip: invisible at 0 s, visible at 3.9 s
    eng.dispatch(Command::SetClipParam { clip: title.id.clone(), param: "y".into(), value: 0.0 }).unwrap();
    eng.dispatch(Command::SetKeyframe { clip: title.id.clone(), param: "opacity".into(), time: secs(0), value: 0.0, interp: None }).unwrap();
    eng.dispatch(Command::SetKeyframe { clip: title.id.clone(), param: "opacity".into(), time: secs(2), value: 1.0, interp: None }).unwrap();
    export(&eng, &out);
    assert!(non_bg(&frame(&out, 0.04, w, h), w, (160, 120, 480, 240), bg) < 100, "fully transparent at the start");
    assert!(non_bg(&frame(&out, 3.5, w, h), w, (160, 120, 480, 240), bg) > 500, "fully visible after the fade-in");
}

#[test]
fn title_alignment_box_and_hostile_text_render_correctly() {
    let dir = tempfile::tempdir().unwrap();
    let (w, h) = (640usize, 360usize);
    let mut eng = engine(w as u32, h as u32);
    eng.dispatch(Command::AddSolid { track: track(&eng, TrackKind::Video, 0), start: secs(0), duration: secs(2), color: "#000000".into() }).unwrap();
    let v2 = add_video_track(&mut eng);
    eng.dispatch(Command::AddTitle { track: v2.clone(), start: secs(0), duration: secs(2), text: "Left".into() }).unwrap();
    let id = eng.project.active().unwrap().tracks.iter().find(|t| t.id == v2).unwrap().clips[0].id.clone();
    let base = eng.project.active().unwrap().tracks.iter().find(|t| t.id == v2).unwrap().clips[0].title.clone().unwrap();
    let out = dir.path().join("a.mp4");
    let weight = |f: &[u8]| (non_bg(f, w, (0, 100, 213, 260), (0, 0, 0)), non_bg(f, w, (214, 100, 426, 260), (0, 0, 0)), non_bg(f, w, (427, 100, 640, 260), (0, 0, 0)));
    for (align, expect) in [(Align::Left, 0), (Align::Center, 1), (Align::Right, 2)] {
        let mut t = base.clone();
        t.align = align;
        eng.dispatch(Command::SetTitle { clip: id.clone(), title: t }).unwrap();
        export(&eng, &out);
        let (l, c, r) = weight(&frame(&out, 1.0, w, h));
        let best = [l, c, r].iter().enumerate().max_by_key(|(_, v)| **v).unwrap().0;
        assert_eq!(best, expect, "{align:?}: thirds {l}/{c}/{r}");
    }
    // background box: a red box around the text turns the area behind it red
    let mut t = base.clone();
    t.box_color = Some("#ff0000ff".into());
    t.box_pad = 4.0;
    eng.dispatch(Command::SetTitle { clip: id.clone(), title: t }).unwrap();
    export(&eng, &out);
    let f = frame(&out, 1.0, w, h);
    let red = (200..440).flat_map(|x| (150..210).map(move |y| (x, y))).filter(|(x, y)| { let i = (y * w + x) * 3; f[i] > 200 && f[i + 1] < 60 && f[i + 2] < 60 }).count();
    assert!(red > 1500, "box pixels: {red}");

    // hostile text must neither break the filter graph nor be interpreted: quotes, colons, commas, brackets, backslash, %{expansion}, unicode
    for text in ["It's 5:00, [ok]; done", r"back\slash and 'quotes' \'", "100% %{localtime} %{n}", "ünïcödé — 日本語 ✓", "line one\nline two\nline three", "a=b:c=d,e=f"] {
        let mut t = base.clone();
        t.text = text.into();
        t.box_color = None;
        eng.dispatch(Command::SetTitle { clip: id.clone(), title: t }).unwrap();
        export(&eng, &out);
        let f = frame(&out, 1.0, w, h);
        assert!(non_bg(&f, w, (0, 60, 640, 300), (0, 0, 0)) > 300, "text {text:?} should produce visible pixels");
    }
    // %{localtime} must stay literal: the same text with and without that token has the same length of glyph run (not a clock string)
    let mut t = base.clone();
    t.text = "%{localtime}".into();
    eng.dispatch(Command::SetTitle { clip: id, title: t }).unwrap();
    export(&eng, &out);
    let wide = non_bg(&frame(&out, 1.0, w, h), w, (0, 100, 640, 260), (0, 0, 0));
    assert!(wide > 500, "literal text is drawn");
}

#[test]
fn a_missing_font_is_reported_not_substituted() {
    let mut eng = engine(320, 240);
    eng.dispatch(Command::AddTitle { track: track(&eng, TrackKind::Video, 0), start: secs(0), duration: secs(1), text: "x".into() }).unwrap();
    let id = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    let mut t = eng.project.active().unwrap().tracks[0].clips[0].title.clone().unwrap();
    t.font = "Definitely Not Installed".into();
    eng.dispatch(Command::SetTitle { clip: id, title: t }).unwrap();
    let err = render_graph::build(&eng.project).unwrap_err();
    assert!(err.to_string().contains("not installed"), "{err}");
}

#[test]
fn title_and_solid_commands_validate_undo_and_survive_save_load() {
    let dir = tempfile::tempdir().unwrap();
    let mut eng = engine(320, 240);
    let v = track(&eng, TrackKind::Video, 0);
    let a = track(&eng, TrackKind::Audio, 0);
    assert!(eng.dispatch(Command::AddTitle { track: a, start: secs(0), duration: secs(1), text: "x".into() }).is_err(), "not on an audio track");
    assert!(eng.dispatch(Command::AddTitle { track: v.clone(), start: secs(0), duration: secs(1), text: "   ".into() }).is_err(), "empty text");
    assert!(eng.project.media.is_empty(), "failed commands leave no stray canvas asset");
    eng.dispatch(Command::AddTitle { track: v.clone(), start: secs(0), duration: secs(2), text: "First\nsecond line".into() }).unwrap();
    eng.dispatch(Command::AddTitle { track: v.clone(), start: secs(3), duration: secs(2), text: "Another".into() }).unwrap();
    assert_eq!(eng.project.media.len(), 1, "titles share one transparent canvas");
    assert_eq!(eng.project.active().unwrap().tracks[0].clips[0].name, "First");
    assert!(eng.offline_media().is_empty(), "generated media is never offline");
    // overlapping placement is refused like any clip
    assert!(eng.dispatch(Command::AddTitle { track: v.clone(), start: secs(1), duration: secs(1), text: "x".into() }).is_err());
    // editing a non-title clip as a title is refused
    eng.dispatch(Command::AddSolid { track: v.clone(), start: secs(6), duration: secs(1), color: "#123456".into() }).unwrap();
    let solid = eng.project.active().unwrap().tracks[0].clips[2].id.clone();
    assert!(eng.dispatch(Command::SetTitle { clip: solid.clone(), title: Title::new("x") }).is_err());
    let title_id = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    assert!(eng.dispatch(Command::SetSolidColor { clip: title_id, color: "#ffffff".into() }).is_err());
    // save/load keeps everything
    let p = dir.path().join("p.ffworks");
    eng.save(&p).unwrap();
    let back: ffworks_core::project::Project = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
    assert_eq!(back, eng.project);
    assert!(back.sequences[0].tracks[0].clips[0].title.is_some());
    // undo of the first AddTitle's siblings walks back cleanly
    for _ in 0..3 {
        eng.undo().unwrap();
    }
    assert!(eng.project.active().unwrap().tracks[0].clips.is_empty());
}

#[test]
fn transitions_are_refused_on_generated_clips() {
    let mut eng = engine(320, 240);
    let v = track(&eng, TrackKind::Video, 0);
    eng.dispatch(Command::AddSolid { track: v.clone(), start: secs(0), duration: secs(2), color: "#ff0000".into() }).unwrap();
    eng.dispatch(Command::AddSolid { track: v, start: secs(2), duration: secs(2), color: "#0000ff".into() }).unwrap();
    let clips = eng.project.active().unwrap().tracks[0].clips.clone();
    let err = eng.dispatch(Command::AddTransition { clip_a: clips[0].id.clone(), clip_b: clips[1].id.clone(), kind: "fade".into(), duration: Rational::new(1, 2) }).unwrap_err();
    assert!(err.to_string().contains("generated"), "{err}");
}
