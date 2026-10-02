//! Every video effect, applied to only ONE side of a transition, must still render (yadif/bwdif broke xfade this way).
use ffworks_core::commands::Command;
use ffworks_core::demo::{build, DemoOptions};
use ffworks_core::engine::Engine;
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
fn every_video_effect_on_one_side_of_a_transition_still_renders() {
    let dir = tempfile::tempdir().unwrap();
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let eng = project_with(&source(dir.path(), 8));
    let mut bad = vec![];
    for def in ffworks_core::effects::registry().into_iter().filter(|d| d.kind == "video" && d.id != "graph") {
        let mut o = opts(3);
        o.segments = 2;
        o.transitions = Some(vec!["fade".into()]);
        o.effects = Some((1, Some(vec![def.id.to_string()])));
        let (mut demo, _) = match build(&eng.project, &t, &o) { Ok(x) => x, Err(e) => { bad.push(format!("{}: build {e}", def.id)); continue; } };
        let id = demo.active_sequence.clone();
        for c in demo.sequence_mut(&id).unwrap().tracks[0].clips.iter_mut().skip(1) {
            c.effects.clear();
        }
        if let Err(e) = preview::render(&t, Some(&caps), &demo, Rational::from_int(0), Rational::from_int(4), 2, &dir.path().join(format!("c_{}", def.id)), &CancelToken::new(), &mut |_| {}) {
            bad.push(format!("{}: {e}", def.id));
        }
    }
    assert!(bad.is_empty(), "{bad:#?}");
}
