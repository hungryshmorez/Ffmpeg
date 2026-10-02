//! Stylise / keying / audio-modulation effects: each is rendered by real FFmpeg and the output is measured.
use ffworks_core::commands::Command;
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


fn add(eng: &mut Engine, clip: &str, fx: &str, params: &[(&str, f64)]) {
    eng.dispatch(Command::AddEffect { clip: clip.into(), effect: fx.into(), params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect(), index: None }).unwrap_or_else(|e| panic!("{fx}: {e}"));
}

#[test]
fn colour_effects_change_the_picture_as_named() {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "h.mp4", "red", "blue", 2);
    let check = |fx: &str, params: &[(&str, f64)], x: u32, f: &dyn Fn((i32, i32, i32)) -> bool| {
        let (mut eng, c, _) = one_clip(&src);
        add(&mut eng, &c, fx, params);
        let out = dir.path().join(format!("{fx}.mp4"));
        export(&eng, &out);
        let px = rgb_at(&out, 1.0, x, 120);
        assert!(f(px), "{fx} at x={x}: got {px:?}");
    };
    // left half is red, right half is blue
    check("grayscale", &[], 40, &|p| (p.0 - p.1).abs() < 25 && (p.1 - p.2).abs() < 25);
    check("negate", &[], 40, &|p| is(p, (0, 255, 255)));
    check("sepia", &[], 250, &|p| p.0 >= p.2); // blue becomes brownish: red channel >= blue channel
    check("posterize", &[("bits", 1.0)], 40, &|p| (p.0 - 128).abs() < 20 && p.1 < 20); // 255 keeps only the top bit: 128
}

#[test]
fn pixelate_and_edges_and_rgb_split_modify_the_frame() {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "h.mp4", "red", "blue", 2);
    let base = dir.path().join("base.mp4");
    let (eng, _, _) = one_clip(&src);
    export(&eng, &base);
    // edge detect: flat colour areas go black, the seam stays bright
    let (mut eng, c, _) = one_clip(&src);
    add(&mut eng, &c, "edges", &[]);
    let out = dir.path().join("edges.mp4");
    export(&eng, &out);
    assert!(is(rgb_at(&out, 1.0, 40, 120), BLACK), "flat area is black after edge detect");
    // rgb split shifts the red channel: at the seam the neighbour of the red half picks up other channels
    let (mut eng, c, _) = one_clip(&src);
    add(&mut eng, &c, "rgb_split", &[("amount", 20.0)]);
    let out = dir.path().join("split.mp4");
    export(&eng, &out);
    let a = rgb_at(&base, 1.0, 150, 120);
    let b = rgb_at(&out, 1.0, 150, 120);
    assert!(a != b, "rgb split changes pixels near the seam: {a:?} vs {b:?}");
    // pixelate renders at full size
    let (mut eng, c, _) = one_clip(&src);
    add(&mut eng, &c, "pixelate", &[("size", 64.0)]);
    let out = dir.path().join("pix.mp4");
    export(&eng, &out);
    assert_eq!(probe(&tools(), &out).unwrap().video[0].width, 320);
}

#[test]
fn chroma_key_makes_green_transparent_so_the_layer_below_shows() {
    let dir = tempfile::tempdir().unwrap();
    let key_src = halves(dir.path(), "k.mp4", "0x00ff00", "red", 2);
    let under = halves(dir.path(), "u.mp4", "blue", "blue", 2);
    let mut eng = Engine::new("key", ProjectSettings { width: 320, height: 240, fps: secs(25), sample_rate: 48000 }, tools());
    let mu = eng.import_media(&under).unwrap();
    let mk = eng.import_media(&key_src).unwrap();
    let v1 = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: mu, track: v1, start: secs(0), source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    eng.dispatch(Command::AddTrack { kind: TrackKind::Video, name: None }).unwrap();
    let v2 = eng.project.active().unwrap().tracks.iter().filter(|t| t.kind == TrackKind::Video).last().unwrap().id.clone();
    eng.dispatch(Command::PlaceClip { media: mk, track: v2.clone(), start: secs(0), source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    let top = eng.project.active().unwrap().tracks.iter().find(|t| t.id == v2).unwrap().clips[0].id.clone();
    add(&mut eng, &top, "chroma_key", &[("similarity", 0.3)]);
    let out = dir.path().join("keyed.mp4");
    export(&eng, &out);
    assert!(is(rgb_at(&out, 1.0, 40, 120), BLUE), "keyed green shows blue below: {:?}", rgb_at(&out, 1.0, 40, 120));
    assert!(is(rgb_at(&out, 1.0, 250, 120), RED), "red stays");
}

#[test]
fn tremolo_gate_and_volume_change_the_sound() {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "h.mp4", "black", "black", 3);
    let render = |fx: &str, params: &[(&str, f64)]| {
        let (mut eng, _, _) = one_clip(&src);
        let at = eng.project.active().unwrap().tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap().clips[0].id.clone();
        add(&mut eng, &at, fx, params);
        let out = dir.path().join(format!("{fx}.mp4"));
        export(&eng, &out);
        mean_volume_db(&out, 0.5, 2.0)
    };
    let base = {
        let (eng, _, _) = one_clip(&src);
        let out = dir.path().join("plain.mp4");
        export(&eng, &out);
        mean_volume_db(&out, 0.5, 2.0)
    };
    assert!(render("volume", &[("gain", -12.0)]) < base - 9.0, "volume -12 dB is quieter");
    assert!(render("tremolo", &[("freq", 5.0), ("depth", 1.0)]) < base - 1.0, "tremolo lowers the average level");
    assert!(render("gate", &[("threshold", -5.0), ("ratio", 20.0)]) < base - 3.0, "a high threshold gates the quiet sine");
}

fn frame_bytes(video: &Path, t: f64) -> Vec<u8> {
    Proc::new(tools().ffmpeg).args(["-v", "error", "-ss", &t.to_string(), "-i"]).arg(video).args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap().stdout
}

#[test]
fn glitch_effects_really_change_the_picture_but_keep_its_size() {
    let dir = tempfile::tempdir().unwrap();
    let src = seasons(dir.path());
    let (eng, _, _) = one_clip(&src);
    // a busier picture than flat colours: a test pattern
    let busy = dir.path().join("busy.mp4");
    ffmpeg(&["-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", busy.to_str().unwrap()]);
    let _ = eng;
    let (plain_eng, _, _) = one_clip(&busy);
    let base = dir.path().join("base.mp4");
    export(&plain_eng, &base);
    let want = frame_bytes(&base, 1.0);
    for (fx, params) in [("shuffle_pixels", vec![("size", 32.0)]), ("chroma_shift", vec![("amount", 12.0)]), ("scroll", vec![("speed", 0.05)])] {
        let (mut e, c, _) = one_clip(&busy);
        add(&mut e, &c, fx, &params);
        let out = dir.path().join(format!("{fx}.mp4"));
        export(&e, &out);
        let got = frame_bytes(&out, 1.0);
        assert_eq!(got.len(), want.len(), "{fx} keeps the frame size");
        let differing = got.iter().zip(&want).filter(|(a, b)| (**a as i32 - **b as i32).abs() > 12).count();
        assert!(differing > want.len() / 50, "{fx} changed only {differing} of {} bytes", want.len());
    }
}
