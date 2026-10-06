//! The browser app's audio-mastering workflows as audio filter chains on a clip: each must render, keep the clip's exact length and not
//! go silent; the chain command validates its text, and everything is undoable and saved.
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile_project, ExportSettings, RenderOptions};
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::{ProjectSettings, TrackKind};
use ffworks_core::{workflows, Rational};
use std::path::Path;
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}
fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

/// 3 s of a 220 Hz tone plus noise, in a 48 kHz project.
fn project(dir: &Path) -> (Engine, String) {
    let src = dir.join("src.mp4");
    let o = Proc::new(tools().ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=3", "-f", "lavfi", "-i", "sine=f=220:r=44100:d=3", "-f", "lavfi", "-i", "anoisesrc=a=0.05:r=44100:d=3", "-filter_complex", "[1][2]amix=inputs=2:duration=first[a]", "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le"])
        .arg(&src)
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let mut eng = Engine::new("w", ProjectSettings { width: 64, height: 64, fps: secs(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(&src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: secs(0), source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
    let a = eng.project.active().unwrap().tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap().clips[0].id.clone();
    (eng, a)
}

fn export(eng: &Engine, out: &Path) {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let mut job = compile_project(&eng.project, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("wav").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap_or_else(|e| panic!("compile: {e}"));
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "w", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export failed: {e}"));
}

fn duration(f: &Path) -> f64 {
    let o = Proc::new(tools().ffprobe).args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"]).arg(f).output().unwrap();
    String::from_utf8_lossy(&o.stdout).trim().parse().unwrap()
}
fn mean_db(f: &Path) -> f64 {
    let o = Proc::new(tools().ffmpeg).args(["-nostdin", "-i"]).arg(f).args(["-af", "volumedetect", "-f", "null", "-"]).output().unwrap();
    let e = String::from_utf8_lossy(&o.stderr);
    e.lines().find_map(|l| l.split("mean_volume:").nth(1)).and_then(|v| v.trim().trim_end_matches(" dB").parse().ok()).unwrap_or(-91.0)
}

#[test]
fn every_audio_mastering_workflow_renders_at_the_clips_exact_length_and_is_not_silent() {
    let caps = Capabilities::discover(&tools()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut problems = vec![];
    for w in workflows::audio_workflows() {
        let missing: Vec<_> = ffworks_core::effects::chain_filter_names(w.chain).into_iter().filter(|n| !caps.has_filter(n)).collect();
        if !missing.is_empty() {
            eprintln!("{}: this FFmpeg lacks {missing:?}; skipped", w.id);
            continue;
        }
        let (mut eng, a) = project(dir.path());
        eng.dispatch(Command::AddAudioChain { clip: a, chain: w.chain.into(), index: None }).unwrap_or_else(|e| panic!("{}: {e}", w.id));
        let out = dir.path().join(format!("{}.wav", w.id));
        export(&eng, &out);
        let (d, m) = (duration(&out), mean_db(&out));
        if (d - 3.0).abs() > 0.06 {
            problems.push(format!("{}: length {d:.3} s instead of 3 s", w.id));
        }
        if m < -70.0 {
            problems.push(format!("{}: silent (mean {m} dB)", w.id));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

#[test]
fn a_chain_changes_the_sound_is_one_undo_step_and_is_saved() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, a) = project(dir.path());
    let plain = dir.path().join("plain.wav");
    export(&eng, &plain);
    let before = eng.project.active().unwrap().tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap().clips[0].effects.len();
    eng.dispatch(Command::AddAudioChain { clip: a.clone(), chain: "volume=0.25".into(), index: None }).unwrap();
    let quiet = dir.path().join("quiet.wav");
    export(&eng, &quiet);
    assert!(mean_db(&plain) - mean_db(&quiet) > 10.0, "{} vs {}", mean_db(&plain), mean_db(&quiet));

    // edit the text through its own command
    let fx = eng.project.active().unwrap().tracks.iter().flat_map(|t| &t.clips).find(|c| c.id == a).unwrap().effects[0].id.clone();
    eng.dispatch(Command::SetEffectText { clip: a.clone(), effect_id: fx, text: "volume=0.5".into() }).unwrap();
    let back: ffworks_core::project::Project = serde_json::from_str(&serde_json::to_string(&eng.project).unwrap()).unwrap();
    assert_eq!(back.active().unwrap().tracks.iter().flat_map(|t| &t.clips).find(|c| c.id == a).unwrap().effects[0].text.as_deref(), Some("volume=0.5"));
    eng.undo().unwrap();
    eng.undo().unwrap();
    assert_eq!(eng.project.active().unwrap().tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap().clips[0].effects.len(), before);
}

#[test]
fn chains_that_could_reach_outside_the_filter_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, a) = project(dir.path());
    let refused = |eng: &mut Engine, chain: &str| eng.dispatch(Command::AddAudioChain { clip: a.clone(), chain: chain.into(), index: None }).unwrap_err().to_string();
    assert!(refused(&mut eng, "amovie=/etc/passwd").contains("not an audio filter"));
    assert!(refused(&mut eng, "volume=1;[x]amovie=a").contains("contains ';'"));
    assert!(refused(&mut eng, "volume='1'").contains("contains '''"));
    assert!(refused(&mut eng, "volume=1,,volume=2").contains("empty step"));
    assert!(refused(&mut eng, "volume=pow(10,2").contains("unmatched"));
    // video clips cannot take one
    let v = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    let err = eng.dispatch(Command::AddAudioChain { clip: v, chain: "volume=1".into(), index: None }).unwrap_err().to_string();
    assert!(err.contains("audio clip"), "{err}");
}
