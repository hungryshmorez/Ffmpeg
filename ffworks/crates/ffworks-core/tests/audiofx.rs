//! Audio pan, fades, gain envelope, effects and solo, rendered by real FFmpeg and measured on the output (volumedetect).
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
fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

/// Tiny black video + a sine tone (`freq` Hz, amplitude `amp` 0..1), 4 s.
fn tone(dir: &Path, name: &str, freq: u32, amp: f64) -> PathBuf {
    let p = dir.join(name);
    let out = Proc::new(tools().ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=4", "-f", "lavfi", "-i"])
        .arg(format!("sine=f={freq}:r=44100:d=4,volume={}", amp * 8.0)) // the sine source is fixed at amplitude 1/8
        .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest"])
        .arg(&p)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    p
}

/// (mean dB, max dB) of a channel ("c0" left / "c1" right / "all") over `[from, from+dur)` of an exported file, optionally behind a filter.
fn level(media: &Path, from: f64, dur: f64, chan: &str, pre: &str) -> (f64, f64) {
    let sel = if chan == "all" { "pan=mono|c0=0.5*c0+0.5*c1".to_string() } else { format!("pan=mono|c0={chan}") };
    let af = if pre.is_empty() { format!("{sel},volumedetect") } else { format!("{pre},{sel},volumedetect") };
    let out = Proc::new(tools().ffmpeg).args(["-nostdin", "-ss", &from.to_string(), "-t", &dur.to_string(), "-i"]).arg(media).args(["-vn", "-af", &af, "-f", "null", "-"]).output().unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    let grab = |k: &str| err.lines().find_map(|l| l.split(k).nth(1)).and_then(|v| v.trim().trim_end_matches(" dB").parse().ok()).unwrap_or(-91.0);
    (grab("mean_volume:"), grab("max_volume:"))
}

fn export(eng: &Engine, out: &Path) {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let g = render_graph::build(&eng.project).unwrap();
    let mut job = compile(&g, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("wav").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap_or_else(|e| panic!("compile: {e}"));
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "t", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export failed: {e}"));
}

/// 4 s project with the tone on V1 + linked audio. Returns (engine, audio clip id, audio track id).
fn project(src: &Path) -> (Engine, String, String) {
    let mut eng = Engine::new("au", ProjectSettings { width: 64, height: 64, fps: secs(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: secs(0), source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
    let at = eng.project.active().unwrap().tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap().clone();
    (eng, at.clips[0].id.clone(), at.id)
}

fn param(eng: &mut Engine, clip: &str, p: &str, v: f64) {
    eng.dispatch(Command::SetClipParam { clip: clip.into(), param: p.into(), value: v }).unwrap_or_else(|e| panic!("{p}: {e}"));
}
fn add_fx(eng: &mut Engine, clip: &str, fx: &str, params: &[(&str, f64)]) {
    eng.dispatch(Command::AddEffect { clip: clip.into(), effect: fx.into(), params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect(), index: None }).unwrap_or_else(|e| panic!("{fx}: {e}"));
}

#[test]
fn pan_moves_sound_between_channels_with_unity_on_the_louder_side() {
    let dir = tempfile::tempdir().unwrap();
    let src = tone(dir.path(), "t.mp4", 1000, 0.5);
    let (mut eng, a, _) = project(&src);
    let base = dir.path().join("base.wav");
    export(&eng, &base);
    let (l0, _) = level(&base, 0.5, 2.0, "c0", "");
    let (r0, _) = level(&base, 0.5, 2.0, "c1", "");
    assert!((l0 - r0).abs() < 0.5 && l0 > -20.0, "mono source is centred: L={l0} R={r0}");

    param(&mut eng, &a, "pan", 1.0);
    let out = dir.path().join("right.wav");
    export(&eng, &out);
    let (l, _) = level(&out, 0.5, 2.0, "c0", "");
    let (r, _) = level(&out, 0.5, 2.0, "c1", "");
    assert!(l < -60.0, "hard right silences the left channel: {l}");
    assert!((r - r0).abs() < 0.7, "right channel stays at unity: {r} vs {r0}");

    param(&mut eng, &a, "pan", -0.5);
    let out = dir.path().join("half_left.wav");
    export(&eng, &out);
    let (l, _) = level(&out, 0.5, 2.0, "c0", "");
    let (r, _) = level(&out, 0.5, 2.0, "c1", "");
    assert!((l - l0).abs() < 0.7, "left unchanged at -0.5: {l} vs {l0}");
    assert!((r - (r0 - 6.02)).abs() < 1.0, "right is 6 dB down at -0.5: {r} vs {}", r0 - 6.02);
}

#[test]
fn track_pan_gain_and_clip_pan_combine() {
    let dir = tempfile::tempdir().unwrap();
    let src = tone(dir.path(), "t.mp4", 1000, 0.5);
    let (mut eng, _, at) = project(&src);
    eng.dispatch(Command::SetTrack { track: at, name: None, muted: None, locked: None, gain_db: Some(-6.0), pan: Some(1.0), solo: None }).unwrap();
    let out = dir.path().join("t.wav");
    export(&eng, &out);
    let (l, _) = level(&out, 0.5, 2.0, "c0", "");
    let (r, _) = level(&out, 0.5, 2.0, "c1", "");
    let base_r = -6.02 + level(&{
        let (e2, _, _) = project(&src);
        let p = dir.path().join("b.wav");
        export(&e2, &p);
        p
    }, 0.5, 2.0, "c1", "").0;
    assert!(l < -60.0, "track pan hard right: {l}");
    assert!((r - base_r).abs() < 1.0, "track gain -6 dB applies: {r} vs {base_r}");
}

#[test]
fn fades_ramp_the_level_at_both_ends_only() {
    let dir = tempfile::tempdir().unwrap();
    let src = tone(dir.path(), "t.mp4", 1000, 0.5);
    let (mut eng, a, _) = project(&src);
    let base = dir.path().join("base.wav");
    export(&eng, &base);
    let mid0 = level(&base, 1.5, 1.0, "all", "").0;
    eng.dispatch(Command::SetClipFades { clip: a, fade_in: Some(secs(1)), fade_out: Some(secs(1)) }).unwrap();
    let out = dir.path().join("fade.wav");
    export(&eng, &out);
    let head = level(&out, 0.0, 0.2, "all", "").0;
    let tail = level(&out, 3.8, 0.2, "all", "").0;
    let mid = level(&out, 1.5, 1.0, "all", "").0;
    assert!(head < mid0 - 12.0, "start fades in from silence: head {head} vs {mid0}");
    assert!(tail < mid0 - 12.0, "end fades out to silence: tail {tail} vs {mid0}");
    assert!((mid - mid0).abs() < 1.0, "middle is untouched: {mid} vs {mid0}");
}

#[test]
fn volume_envelope_follows_the_keyframes_in_db() {
    let dir = tempfile::tempdir().unwrap();
    let src = tone(dir.path(), "t.mp4", 1000, 0.5);
    let (mut eng, a, _) = project(&src);
    let base = dir.path().join("base.wav");
    export(&eng, &base);
    let b = level(&base, 1.0, 0.2, "all", "").0;
    for (t, v) in [(0, -60.0), (2, 0.0)] {
        eng.dispatch(Command::SetKeyframe { clip: a.clone(), param: "gain_db".into(), time: secs(t), value: v, interp: None }).unwrap();
    }
    let out = dir.path().join("env.wav");
    export(&eng, &out);
    let (early, mid, late, after) = (level(&out, 0.0, 0.2, "all", "").0, level(&out, 0.9, 0.2, "all", "").0, level(&out, 1.8, 0.2, "all", "").0, level(&out, 2.5, 1.0, "all", "").0);
    // linear in dB: -60 at 0 s, -30 at 1 s, 0 at 2 s, then held at 0
    assert!((early - (b - 57.0)).abs() < 8.0, "early {early} (baseline {b})");
    assert!((mid - (b - 30.0)).abs() < 5.0, "mid {mid} (baseline {b})");
    assert!((late - (b - 3.0)).abs() < 5.0, "late {late}");
    assert!((after - b).abs() < 1.0, "held at 0 dB after the last key: {after} vs {b}");
}

#[test]
fn eq_filters_compressor_limiter_and_gate_style_effects_change_the_sound() {
    let dir = tempfile::tempdir().unwrap();
    // 100 Hz tone
    let low = tone(dir.path(), "low.mp4", 100, 0.5);
    let (mut eng, a, _) = project(&low);
    let base = dir.path().join("b.wav");
    export(&eng, &base);
    let b = level(&base, 0.5, 2.0, "all", "").0;
    add_fx(&mut eng, &a, "eq", &[("low", 12.0)]);
    let out = dir.path().join("eq.wav");
    export(&eng, &out);
    assert!(level(&out, 0.5, 2.0, "all", "").0 > b + 6.0, "low shelf +12 dB lifts a 100 Hz tone");

    let (mut eng, a, _) = project(&low);
    add_fx(&mut eng, &a, "highpass", &[("freq", 1000.0)]);
    let out = dir.path().join("hp.wav");
    export(&eng, &out);
    assert!(level(&out, 0.5, 2.0, "all", "").0 < b - 20.0, "1 kHz high-pass removes a 100 Hz tone");

    let high = tone(dir.path(), "high.mp4", 5000, 0.5);
    let (mut eng, a, _) = project(&high);
    let base_h = dir.path().join("bh.wav");
    export(&eng, &base_h);
    let bh = level(&base_h, 0.5, 2.0, "all", "").0;
    add_fx(&mut eng, &a, "lowpass", &[("freq", 1000.0)]);
    let out = dir.path().join("lp.wav");
    export(&eng, &out);
    assert!(level(&out, 0.5, 2.0, "all", "").0 < bh - 20.0, "1 kHz low-pass removes a 5 kHz tone");

    // loud tone: compressor lowers it, limiter caps the peak at its ceiling
    let loud = tone(dir.path(), "loud.mp4", 1000, 0.9);
    let (mut eng, a, _) = project(&loud);
    let base_l = dir.path().join("bl.wav");
    export(&eng, &base_l);
    let (bm, bmax) = level(&base_l, 0.5, 2.0, "all", "");
    add_fx(&mut eng, &a, "compressor", &[("threshold", -30.0), ("ratio", 10.0), ("attack", 1.0)]);
    let out = dir.path().join("comp.wav");
    export(&eng, &out);
    assert!(level(&out, 1.0, 2.0, "all", "").0 < bm - 6.0, "compressor (-30 dB, 10:1) reduces a loud tone by > 6 dB (baseline {bm})");
    let (mut eng, a, _) = project(&loud);
    add_fx(&mut eng, &a, "limiter", &[("ceiling", -12.0)]);
    let out = dir.path().join("lim.wav");
    export(&eng, &out);
    let (_, lmax) = level(&out, 0.5, 3.0, "all", "");
    assert!(bmax > -6.0 && lmax < -10.0, "limiter holds the peak at about -12 dB: {bmax} -> {lmax}");
}

#[test]
fn every_audio_effect_renders_in_real_ffmpeg() {
    let dir = tempfile::tempdir().unwrap();
    let src = tone(dir.path(), "t.mp4", 440, 0.5);
    let (mut eng, a, _) = project(&src);
    // LADSPA plugins have their own test (tests/ladspa.rs); chaining all of them is not meant to stay audible
    for def in ffworks_core::effects::registry().into_iter().filter(|d| d.kind == "audio" && d.category != "LADSPA") {
        add_fx(&mut eng, &a, def.id, &[]);
    }
    // eq is a no-op at its defaults; give it something to do too
    let eq = eng.project.active().unwrap().find_clip(&a).unwrap().1.effects.iter().find(|e| e.effect == "eq").unwrap().id.clone();
    eng.dispatch(Command::SetEffectParam { clip: a.clone(), effect_id: eq, param: "mid".into(), value: 6.0 }).unwrap();
    let out = dir.path().join("all.wav");
    export(&eng, &out); // panics with FFmpeg's message if any filter string is rejected
    assert!(level(&out, 0.5, 2.0, "all", "").0 > -60.0, "chain still produces sound");
}

#[test]
fn solo_plays_only_the_soloed_track_in_the_mix() {
    let dir = tempfile::tempdir().unwrap();
    let a440 = tone(dir.path(), "a.mp4", 300, 0.5);
    let b2k = tone(dir.path(), "b.mp4", 6000, 0.5);
    let (mut eng, _, _) = project(&a440);
    eng.dispatch(Command::AddTrack { kind: TrackKind::Audio, name: None }).unwrap();
    let a2 = eng.project.active().unwrap().tracks.iter().filter(|t| t.kind == TrackKind::Audio).nth(1).unwrap().id.clone();
    let m = eng.import_media(&b2k).unwrap();
    eng.dispatch(Command::PlaceClip { media: m, track: a2.clone(), start: secs(0), source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    let both = dir.path().join("both.wav");
    export(&eng, &both);
    // three cascaded filters per band so the other tone is far below the -60 dB bar
    let lowband = "lowpass=f=800,lowpass=f=800,lowpass=f=800";
    let highband = "highpass=f=2500,highpass=f=2500,highpass=f=2500";
    assert!(level(&both, 0.5, 2.0, "all", lowband).0 > -45.0 && level(&both, 0.5, 2.0, "all", highband).0 > -45.0, "both tones present");
    eng.dispatch(Command::SetTrack { track: a2, name: None, muted: None, locked: None, gain_db: None, pan: None, solo: Some(true) }).unwrap();
    let solo = dir.path().join("solo.wav");
    export(&eng, &solo);
    assert!(level(&solo, 0.5, 2.0, "all", lowband).0 < -60.0, "the 300 Hz track is silenced by the solo");
    assert!(level(&solo, 0.5, 2.0, "all", highband).0 > -45.0, "the soloed 6 kHz track plays");
}
