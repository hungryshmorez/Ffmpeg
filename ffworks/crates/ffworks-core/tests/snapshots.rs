//! Snapshots: save the timeline, edit on, go back; undoable, saved with the project, never confused with a timeline.
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::process::Tools;
use ffworks_core::project::ProjectSettings;
use ffworks_core::Rational;
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}

#[test]
fn a_snapshot_restores_the_timeline_exactly_and_everything_is_undoable_and_saved() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("s.mp4");
    assert!(Proc::new(tools().ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x120:r=25:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p"]).arg(&src).status().unwrap().success());
    let mut eng = Engine::new("snap", ProjectSettings { width: 160, height: 120, fps: Rational::from_int(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(&src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: Rational::ZERO, source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    eng.dispatch(Command::AddMarker { time: Rational::from_int(1), name: "keep".into(), color: None, note: None }).unwrap();
    let content = |e: &Engine| { let s = e.project.active().unwrap(); serde_json::to_string(&(&s.tracks, &s.markers)).unwrap() };
    let before = content(&eng);
    eng.dispatch(Command::TakeSnapshot { name: "before recut".into() }).unwrap();
    let snap = eng.project.sequences.iter().find(|s| s.name == "Snapshot: before recut").expect("snapshot").id.clone();
    assert_eq!(eng.project.sequences.len(), 2);
    assert_eq!(content(&eng), before, "taking a snapshot changes nothing in the live timeline");
    // edit on: split, delete, marker
    let clip = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    eng.dispatch(Command::SplitClip { clip: clip.clone(), at: Rational::from_int(2) }).unwrap();
    eng.dispatch(Command::DeleteClip { clip, ripple: false }).unwrap();
    eng.dispatch(Command::AddMarker { time: Rational::from_int(3), name: "new".into(), color: None, note: None }).unwrap();
    let edited = content(&eng);
    assert_ne!(edited, before);
    // survives save / load
    let f = dir.path().join("p.ffworks");
    eng.save(&f).unwrap();
    assert!(Engine::load(&f, tools()).unwrap().project.sequences.iter().any(|s| s.id == snap));
    // restore: the timeline is exactly as it was; the edits are one undo away
    let steps = eng.history().len();
    eng.dispatch(Command::RestoreSnapshot { snapshot: snap.clone() }).unwrap();
    assert_eq!(eng.history().len(), steps + 1);
    assert_eq!(content(&eng), before);
    assert_eq!(eng.project.active_sequence, eng.project.sequences[0].id, "the live timeline is still the active one");
    eng.undo().unwrap();
    assert_eq!(content(&eng), edited);
    // refusals: a timeline is not a snapshot; bad names; unknown ids
    let main = eng.project.active_sequence.clone();
    assert!(eng.dispatch(Command::RestoreSnapshot { snapshot: main.clone() }).is_err());
    assert!(eng.dispatch(Command::DeleteSnapshot { snapshot: main }).is_err());
    assert!(eng.dispatch(Command::TakeSnapshot { name: "  ".into() }).is_err());
    assert!(eng.dispatch(Command::RestoreSnapshot { snapshot: "nope".into() }).is_err());
    // delete is undoable
    eng.dispatch(Command::DeleteSnapshot { snapshot: snap.clone() }).unwrap();
    assert_eq!(eng.project.sequences.len(), 1);
    eng.undo().unwrap();
    assert_eq!(eng.project.sequences.len(), 2);
}
