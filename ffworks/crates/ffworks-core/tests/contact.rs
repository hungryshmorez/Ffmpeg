//! The variation contact sheet: a tiled picture of N random looks, reproducible by seed, with the matching effects listed.
use ffworks_core::commands::Command;
use ffworks_core::contact::render_sheet;
use ffworks_core::engine::Engine;
use ffworks_core::ffprobe::probe;
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::ProjectSettings;
use ffworks_core::Rational;
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}

#[test]
fn nine_variations_tile_into_one_sheet_that_is_reproducible_and_leaves_the_project_alone() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("s.mp4");
    assert!(Proc::new(tools().ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p"]).arg(&src).status().unwrap().success());
    let mut eng = Engine::new("c", ProjectSettings { width: 320, height: 240, fps: Rational::from_int(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(&src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: Rational::ZERO, source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    let clip = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    let before = serde_json::to_string(&eng.project).unwrap();
    let caps = Capabilities::discover(&tools()).unwrap();
    let a = render_sheet(&tools(), Some(&caps), &eng.project, &clip, 9, 2, None, 7, Rational::from_int(1), &dir.path().join("a")).unwrap();
    assert_eq!((a.columns, a.rows, a.seeds.len(), a.effects.len()), (3, 3, 9, 9));
    assert!(a.effects.iter().all(|e| e.len() == 2));
    let info = probe(&tools(), &a.path).unwrap();
    // half-size tiles (160x120) plus 4 px padding between and around them
    assert!(info.video[0].width >= 3 * 160 && info.video[0].height >= 3 * 120, "{}x{}", info.video[0].width, info.video[0].height);
    assert_eq!(serde_json::to_string(&eng.project).unwrap(), before, "the project is untouched");
    // same seed -> same sheet; another seed -> different effects
    let b = render_sheet(&tools(), Some(&caps), &eng.project, &clip, 9, 2, None, 7, Rational::from_int(1), &dir.path().join("b")).unwrap();
    assert_eq!(a.effects, b.effects);
    assert_eq!(std::fs::read(&a.path).unwrap(), std::fs::read(&b.path).unwrap(), "reproducible pixels");
    let c = render_sheet(&tools(), Some(&caps), &eng.project, &clip, 4, 1, None, 99, Rational::from_int(1), &dir.path().join("c")).unwrap();
    assert_eq!((c.columns, c.rows), (2, 2));
    assert_ne!(a.effects[..4], c.effects[..]);
    // refusals
    assert!(render_sheet(&tools(), Some(&caps), &eng.project, &clip, 1, 1, None, 1, Rational::ZERO, &dir.path().join("d")).is_err());
    assert!(render_sheet(&tools(), Some(&caps), &eng.project, "nope", 4, 1, None, 1, Rational::ZERO, &dir.path().join("e")).is_err());
}
