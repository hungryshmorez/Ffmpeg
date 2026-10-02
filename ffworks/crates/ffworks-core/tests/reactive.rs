//! Audio-reactive parameters: a brightness that follows the clip's own loudness, measured in the exported video.
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile, ExportSettings, RenderOptions};
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::{ProjectSettings, TrackKind};
use ffworks_core::{render_graph, Rational};
use std::path::{Path, PathBuf};
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}

/// 4 s grey video; the tone is quiet for the first 2 s and loud for the last 2 s.
fn source(dir: &Path) -> PathBuf {
    let p = dir.join("src.mp4");
    let st = Proc::new(tools().ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=64x64:r=25:d=4", "-f", "lavfi", "-i"])
        .arg("sine=f=440:r=48000:d=4,volume='if(lt(t,2),0.01,1)':eval=frame")
        .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest"])
        .arg(&p)
        .status()
        .unwrap();
    assert!(st.success());
    p
}

fn luma_at(video: &Path, t: f64) -> f64 {
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-ss", &format!("{t}"), "-i"]).arg(video).args(["-frames:v", "1", "-vf", "scale=1:1,format=gray", "-f", "rawvideo", "-"]).output().unwrap();
    assert_eq!(out.stdout.len(), 1, "no frame at {t}");
    out.stdout[0] as f64
}

fn export(eng: &Engine, out: &Path) {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let g = render_graph::build(&eng.project).unwrap();
    let mut job = compile(&g, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap();
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "t", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export: {e}"));
}

/// Project with the source on V1 (+ linked audio). Returns (engine, video clip, audio clip).
fn project(src: &Path) -> (Engine, String, String) {
    let mut eng = Engine::new("r", ProjectSettings { width: 64, height: 64, fps: Rational::from_int(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: Rational::from_int(0), source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
    let s = eng.project.active().unwrap();
    let vc = s.tracks[0].clips[0].id.clone();
    let ac = s.tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap().clips[0].id.clone();
    (eng, vc, ac)
}

#[test]
fn brightness_follows_the_linked_audio_and_undo_and_save_keep_it_right() {
    let dir = tempfile::tempdir().unwrap();
    let src = source(dir.path());
    let (mut eng, v, _a) = project(&src);
    eng.dispatch(Command::AddEffect { clip: v.clone(), effect: "brightness".into(), params: Default::default(), index: None }).unwrap();
    let fx = eng.project.active().unwrap().find_clip(&v).unwrap().1.effects[0].id.clone();
    let param = format!("fx:{fx}:amount");
    eng.dispatch(Command::AnimateFromAudio { clip: v.clone(), param: param.clone(), source: None, low: -0.4, high: 0.4, smooth: 0.0, band: None }).unwrap();
    let keys = eng.project.active().unwrap().find_clip(&v).unwrap().1.keyframes[&param].clone();
    assert!(keys.len() >= 2 && keys.len() <= 200, "{} keys", keys.len());
    let val = |t: f64| ffworks_core::keyframes::eval(&keys, t).unwrap();
    assert!(val(1.0) < -0.35 && val(3.0) > 0.35, "curve: {} at 1 s, {} at 3 s", val(1.0), val(3.0));

    let out = dir.path().join("o.mp4");
    export(&eng, &out);
    let (q, l) = (luma_at(&out, 1.0), luma_at(&out, 3.0));
    assert!(l > q + 60.0, "loud part brighter than quiet part: {q} vs {l}");

    // save/load keeps the curve; undo removes it in one step
    let pf = dir.path().join("p.ffworks");
    eng.save(&pf).unwrap();
    let back = Engine::load(&pf, tools()).unwrap();
    assert_eq!(back.project.active().unwrap().find_clip(&v).unwrap().1.keyframes[&param], keys);
    eng.undo().unwrap();
    assert!(!eng.project.active().unwrap().find_clip(&v).unwrap().1.keyframes.contains_key(&param));
}

#[test]
fn bad_requests_are_refused_before_measuring() {
    let dir = tempfile::tempdir().unwrap();
    let src = source(dir.path());
    let (mut eng, v, a) = project(&src);
    let rev = eng.revision();
    // opacity is animatable; 5 is out of range
    let e = eng.dispatch(Command::AnimateFromAudio { clip: v.clone(), param: "opacity".into(), source: None, low: 0.0, high: 5.0, smooth: 0.0, band: None }).unwrap_err();
    assert!(e.to_string().contains("outside"), "{e}");
    // following a video clip is refused
    let e = eng.dispatch(Command::AnimateFromAudio { clip: v.clone(), param: "opacity".into(), source: Some(v.clone()), low: 0.0, high: 1.0, smooth: 0.0, band: None }).unwrap_err();
    assert!(e.to_string().contains("audio clip"), "{e}");
    assert_eq!(eng.revision(), rev, "nothing changed");
    // an audio clip can drive its own volume (a crude expander: the quiet part is turned down further)
    eng.dispatch(Command::AnimateFromAudio { clip: a.clone(), param: "gain_db".into(), source: None, low: -20.0, high: 0.0, smooth: 0.2, band: None }).unwrap();
    let k = &eng.project.active().unwrap().find_clip(&a).unwrap().1.keyframes["gain_db"];
    assert!(ffworks_core::keyframes::eval(k, 0.5).unwrap() < -19.0 && ffworks_core::keyframes::eval(k, 3.5).unwrap() > -1.0);
    // SetKeyframes with an empty list removes the animation
    eng.dispatch(Command::SetKeyframes { clip: a.clone(), param: "gain_db".into(), keys: vec![] }).unwrap();
    assert!(!eng.project.active().unwrap().find_clip(&a).unwrap().1.keyframes.contains_key("gain_db"));
}

/// 4 s: a 60 Hz tone for 2 s, then a 6 kHz tone for 2 s, both equally loud.
fn two_tones(dir: &Path) -> PathBuf {
    let p = dir.join("tones.mp4");
    let st = Proc::new(tools().ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=64x64:r=25:d=4", "-f", "lavfi", "-i"])
        .arg("aevalsrc='0.5*sin(2*PI*if(lt(t,2),60,6000)*t)':s=48000:d=4")
        .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest"])
        .arg(&p)
        .status()
        .unwrap();
    assert!(st.success());
    p
}

#[test]
fn a_band_listens_only_to_its_frequencies() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, v, _) = project(&two_tones(dir.path()));
    let curve = |eng: &mut Engine, band: &str| {
        eng.dispatch(Command::AnimateFromAudio { clip: v.clone(), param: "opacity".into(), source: None, low: 0.0, high: 1.0, smooth: 0.0, band: Some(band.into()) }).unwrap();
        let k = eng.project.active().unwrap().find_clip(&v).unwrap().1.keyframes["opacity"].clone();
        let at = |t: f64| ffworks_core::keyframes::eval(&k, t).unwrap();
        (at(1.0), at(3.0))
    };
    let (b1, b3) = curve(&mut eng, "bass");
    assert!(b1 > 0.9 && b3 < 0.1, "bass follows the 60 Hz half: {b1} {b3}");
    let (t1, t3) = curve(&mut eng, "treble");
    assert!(t1 < 0.1 && t3 > 0.9, "treble follows the 6 kHz half: {t1} {t3}");
    let (a1, a3) = curve(&mut eng, "all");
    assert!((a1 - a3).abs() < 0.3, "the whole signal is about equally loud: {a1} {a3}");
    let e = eng.dispatch(Command::AnimateFromAudio { clip: v.clone(), param: "opacity".into(), source: None, low: 0.0, high: 1.0, smooth: 0.0, band: Some("ultra".into()) }).unwrap_err();
    assert!(e.to_string().contains("unknown band"), "{e}");
}

/// 4 s white video whose sound is a 60 ms burst at 0.4, 1.4, 2.4 and 3.4 s (frame-aligned at 25 fps).
fn clicks(dir: &Path) -> PathBuf {
    let p = dir.join("clicks.mp4");
    let st = Proc::new(tools().ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=64x64:r=25:d=4", "-f", "lavfi", "-i"])
        .arg("aevalsrc='0.8*sin(2*PI*1000*t)*between(mod(t,1),0.4,0.46)':s=48000:d=4")
        .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest"])
        .arg(&p)
        .status()
        .unwrap();
    assert!(st.success());
    p
}

#[test]
fn opacity_pulses_on_each_beat_in_the_export() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, v, _) = project(&clicks(dir.path()));
    eng.dispatch(Command::AnimateFromBeats { clip: v.clone(), param: "opacity".into(), source: None, low: 0.1, high: 1.0, decay: 0.3 }).unwrap();
    assert_eq!(eng.undo_label(), Some("Pulse opacity on beats"));
    let k = eng.project.active().unwrap().find_clip(&v).unwrap().1.keyframes["opacity"].clone();
    let at = |t: f64| ffworks_core::keyframes::eval(&k, t).unwrap();
    for b in [1.4, 2.4, 3.4] {
        // the detector may place an onset a frame or two early
        let peak = (-3..=3).map(|f| at(b + f as f64 * 0.04)).fold(0.0, f64::max);
        assert!(peak > 0.95, "pulse near {b}: {peak} ({k:?})");
        assert!(at(b + 0.5) < 0.15, "back down after {b}: {}", at(b + 0.5));
    }
    let out = dir.path().join("o.mp4");
    export(&eng, &out);
    let between = luma_at(&out, 2.0);
    let on = (-2..=2).map(|f| luma_at(&out, 2.4 + f as f64 * 0.04)).fold(0.0, f64::max);
    assert!(on > between + 100.0, "the frame on the beat is bright, between beats dim: {on} vs {between}");
    eng.undo().unwrap();
    assert!(!eng.project.active().unwrap().find_clip(&v).unwrap().1.keyframes.contains_key("opacity"));
}
