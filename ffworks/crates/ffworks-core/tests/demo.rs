//! Demo mode: a throwaway timeline of random transitions/effects, rendered by the real preview pipeline.
use ffworks_core::commands::Command;
use ffworks_core::demo::{build, DemoOptions};
use ffworks_core::engine::Engine;
use ffworks_core::ffprobe::probe;
use ffworks_core::jobs::CancelToken;
use ffworks_core::preview;
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::ProjectSettings;
use ffworks_core::Rational;
use std::path::Path;
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}

fn source(dir: &Path, secs_: u32) -> std::path::PathBuf {
    let p = dir.join("src.mp4");
    let r = Proc::new(tools().ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", &format!("testsrc2=s=320x240:r=25:d={secs_}"), "-f", "lavfi", "-i", &format!("sine=f=440:r=44100:d={secs_}"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "5", "-c:a", "aac", "-shortest"])
        .arg(&p)
        .output()
        .unwrap();
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    p
}

fn project_with(src: &Path) -> Engine {
    let mut eng = Engine::new("user", ProjectSettings { width: 320, height: 240, fps: Rational::from_int(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: Rational::from_int(0), source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
    eng
}

fn opts(seed: u64) -> DemoOptions {
    DemoOptions {
        media: None,
        segments: 4,
        segment_secs: 2.0,
        transition_secs: 0.5,
        transitions: Some(vec!["fade".into(), "wipeleft".into(), "slideup".into(), "circleopen".into()]),
        effects: Some((2, None)),
        seed,
    }
}

#[test]
fn builds_segments_transitions_and_effects_without_touching_the_users_project() {
    let dir = tempfile::tempdir().unwrap();
    let eng = project_with(&source(dir.path(), 8));
    let before = serde_json::to_string(&eng.project).unwrap();
    let (demo, steps) = build(&eng.project, &tools(), &opts(7)).unwrap();
    assert_eq!(serde_json::to_string(&eng.project).unwrap(), before, "the user's project is untouched");
    let track = &demo.active().unwrap().tracks[0];
    assert_eq!(track.clips.len(), 4);
    assert_eq!(track.transitions.len(), 3);
    assert!(track.clips.iter().all(|c| c.effects.len() == 2), "two random effects on every segment");
    assert_eq!(steps.len(), 4);
    assert!(steps.iter().flat_map(|s| &s.fx).any(|f| !f.params.is_empty()), "random values are recorded");
    for st in &steps {
        assert_eq!(st.fx.iter().map(|f| f.effect.clone()).collect::<Vec<_>>(), st.effects, "kept values belong to the listed effects");
    }
    assert!(steps[0].transition.is_none() && steps[1..].iter().all(|s| s.transition.is_some()));
    assert!(steps.iter().all(|s| s.effects.len() == 2));
    assert_eq!(steps[2].start, 4.0);
    // same seed, same demo; another seed, another demo
    let (_, again) = build(&eng.project, &tools(), &opts(7)).unwrap();
    assert_eq!(steps, again);
    let (_, other) = build(&eng.project, &tools(), &opts(8)).unwrap();
    assert_ne!(steps, other);
}

#[test]
fn transitions_only_and_effects_only_and_refusals() {
    let dir = tempfile::tempdir().unwrap();
    let eng = project_with(&source(dir.path(), 8));
    let (p, s) = build(&eng.project, &tools(), &DemoOptions { effects: None, ..opts(1) }).unwrap();
    assert_eq!(p.active().unwrap().tracks[0].transitions.len(), 3);
    assert!(s.iter().all(|x| x.effects.is_empty()));
    let (p, s) = build(&eng.project, &tools(), &DemoOptions { transitions: None, ..opts(1) }).unwrap();
    assert!(p.active().unwrap().tracks[0].transitions.is_empty() && s.iter().all(|x| x.transition.is_none() && x.effects.len() == 2));
    // the favourites-style pool restricts the picks
    let (_, s) = build(&eng.project, &tools(), &DemoOptions { transitions: Some(vec!["wipeleft".into()]), effects: Some((3, Some(vec!["blur".into()]))), ..opts(3) }).unwrap();
    assert!(s[1..].iter().all(|x| x.transition.as_deref() == Some("wipeleft")) && s.iter().all(|x| x.effects == ["blur", "blur", "blur"]));
    // a source shorter than one segment plus a transition cannot be demoed
    let short = project_with(&source(dir.path(), 2));
    let e = build(&short.project, &tools(), &opts(1)).unwrap_err().to_string();
    assert!(e.contains("only"), "{e}");
}

#[test]
fn a_demo_renders_through_the_preview_pipeline_with_native_and_gl_transitions() {
    let dir = tempfile::tempdir().unwrap();
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let eng = project_with(&source(dir.path(), 8));
    let mut o = opts(11);
    if caps.xfade_custom {
        o.transitions = Some(vec!["fade".into(), "gl_angular".into(), "gl_swap".into()]);
    }
    let (demo, _) = build(&eng.project, &t, &o).unwrap();
    let r = preview::render(&t, Some(&caps), &demo, Rational::from_int(0), Rational::from_int(8), 2, &dir.path().join("cache"), &CancelToken::new(), &mut |_| {}).unwrap();
    let d = probe(&t, &r.path).unwrap().duration.as_f64();
    assert!((d - 8.0).abs() < 0.3, "demo preview is {d} s");
}
