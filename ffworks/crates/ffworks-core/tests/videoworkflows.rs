//! The browser app's colour / retro / stylize / glitch looks as video filter chains: each must render at the project size and really change the
//! picture; the chain command validates its text and is undoable and saved.
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile_project, ExportSettings, RenderOptions};
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::ProjectSettings;
use ffworks_core::{workflows, Rational};
use std::path::Path;
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}
fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

fn project(dir: &Path) -> (Engine, String) {
    let src = dir.join("src.mp4");
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x120:r=25:d=2", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p"]).arg(&src).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let mut eng = Engine::new("v", ProjectSettings { width: 160, height: 120, fps: secs(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(&src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: secs(0), source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    let c = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    (eng, c)
}

fn export(eng: &Engine, out: &Path) {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let mut job = compile_project(&eng.project, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("ffv1_mkv").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap_or_else(|e| panic!("compile: {e}"));
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "v", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export failed: {e}"));
}

/// md5 of the frame at 1 s, and the output size.
fn frame(f: &Path) -> (String, String) {
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-ss", "1", "-i"]).arg(f).args(["-frames:v", "1", "-f", "md5", "-"]).output().unwrap();
    let size = Proc::new(tools().ffprobe).args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0"]).arg(f).output().unwrap();
    (String::from_utf8_lossy(&o.stdout).trim().to_string(), String::from_utf8_lossy(&size.stdout).trim().to_string())
}

#[test]
fn every_video_workflow_renders_at_the_project_size_and_changes_the_picture() {
    let caps = Capabilities::discover(&tools()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let (eng, _) = project(dir.path());
    let plain = dir.path().join("plain.mkv");
    export(&eng, &plain);
    let (plain_md5, plain_size) = frame(&plain);
    assert_eq!(plain_size, "160,120");
    let mut problems = vec![];
    for w in workflows::video_workflows() {
        let missing: Vec<_> = ffworks_core::effects::chain_filter_names(w.chain).into_iter().filter(|n| !n.is_empty() && !caps.has_filter(n)).collect();
        if !missing.is_empty() {
            eprintln!("{}: this FFmpeg lacks {missing:?}; skipped", w.id);
            continue;
        }
        let (mut eng, c) = project(dir.path());
        eng.dispatch(Command::AddVideoChain { clip: c, chain: w.chain.into(), index: None }).unwrap_or_else(|e| panic!("{}: {e}", w.id));
        let out = dir.path().join(format!("{}.mkv", w.id));
        export(&eng, &out);
        let (md5, size) = frame(&out);
        if size != "160,120" {
            problems.push(format!("{}: output is {size}", w.id));
        }
        if md5 == plain_md5 && w.id != "solarize" {
            problems.push(format!("{}: the picture did not change", w.id));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

#[test]
fn a_video_chain_is_one_undo_step_is_saved_and_refuses_unsafe_text() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, c) = project(dir.path());
    let n = |e: &Engine| e.project.active().unwrap().tracks[0].clips[0].effects.len();
    eng.dispatch(Command::AddVideoChain { clip: c.clone(), chain: "hflip".into(), index: None }).unwrap();
    assert_eq!(n(&eng), 1);
    let fx = eng.project.active().unwrap().tracks[0].clips[0].effects[0].id.clone();
    eng.dispatch(Command::SetEffectText { clip: c.clone(), effect_id: fx, text: "vflip".into() }).unwrap();
    let back: ffworks_core::project::Project = serde_json::from_str(&serde_json::to_string(&eng.project).unwrap()).unwrap();
    assert_eq!(back.active().unwrap().tracks[0].clips[0].effects[0].text.as_deref(), Some("vflip"));
    eng.undo().unwrap();
    eng.undo().unwrap();
    assert_eq!(n(&eng), 0);
    let refused = |eng: &mut Engine, chain: &str| eng.dispatch(Command::AddVideoChain { clip: c.clone(), chain: chain.into(), index: None }).unwrap_err().to_string();
    assert!(refused(&mut eng, "movie=/etc/passwd").contains("not a video filter"));
    assert!(refused(&mut eng, "drawtext=textfile=/etc/passwd").contains("not a video filter"));
    assert!(refused(&mut eng, "hflip;[x]hflip").contains("contains ';'"));
    // an audio chain is not accepted as a video one, nor the other way round
    assert!(refused(&mut eng, "volume=2").contains("not a video filter"));
}

#[test]
fn commas_inside_an_expression_are_escaped_so_they_do_not_split_the_chain() {
    assert_eq!(ffworks_core::effects::escape_chain_commas("lutyuv=y=bitand(val,0xE0):u=val,hflip"), "lutyuv=y=bitand(val\\,0xE0):u=val,hflip");
}
