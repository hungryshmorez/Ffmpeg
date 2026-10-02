//! Sequence markers: commands, ordering, validation, undo and loading projects saved before markers existed.
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::process::Tools;
use ffworks_core::project::ProjectSettings;
use ffworks_core::Rational;

fn engine() -> Engine {
    Engine::new("m", ProjectSettings { width: 640, height: 360, fps: Rational::from_int(30), sample_rate: 48000 }, Tools { ffmpeg: "ffmpeg".into(), ffprobe: "ffprobe".into() })
}
fn add(e: &mut Engine, t: Rational, name: &str) {
    e.dispatch(Command::AddMarker { time: t, name: name.into(), color: None, note: None }).unwrap();
}
fn names(e: &Engine) -> Vec<String> {
    e.project.active().unwrap().markers.iter().map(|m| m.name.clone()).collect()
}

#[test]
fn markers_stay_sorted_snap_to_frames_and_undo() {
    let mut e = engine();
    add(&mut e, Rational::from_int(5), "five");
    add(&mut e, Rational::new(51, 100), "half"); // 0.51 s -> frame 15 = 0.5 s
    add(&mut e, Rational::from_int(2), "two");
    assert_eq!(names(&e), vec!["half", "two", "five"]);
    assert_eq!(e.project.active().unwrap().markers[0].time, Rational::new(1, 2));
    // moving a marker re-sorts; one undo step
    let id = e.project.active().unwrap().markers[0].id.clone();
    e.dispatch(Command::SetMarker { marker: id.clone(), time: Some(Rational::from_int(9)), name: None, color: None, note: Some("see this".into()) }).unwrap();
    assert_eq!(names(&e), vec!["two", "five", "half"]);
    assert_eq!(e.project.active().unwrap().markers[2].note, "see this");
    e.undo().unwrap();
    assert_eq!(names(&e), vec!["half", "two", "five"]);
    assert!(e.project.active().unwrap().markers[0].note.is_empty());
    e.redo().unwrap();
    e.dispatch(Command::RemoveMarker { marker: id }).unwrap();
    assert_eq!(names(&e), vec!["two", "five"]);
    e.undo().unwrap();
    assert_eq!(names(&e), vec!["two", "five", "half"]);
}

#[test]
fn invalid_markers_are_refused_and_leave_the_project_alone() {
    let mut e = engine();
    let before = e.project.clone();
    assert!(e.dispatch(Command::AddMarker { time: Rational::from_int(-1), name: "x".into(), color: None, note: None }).is_err());
    assert!(e.dispatch(Command::AddMarker { time: Rational::ZERO, name: "x".repeat(101), color: None, note: None }).is_err());
    assert!(e.dispatch(Command::AddMarker { time: Rational::ZERO, name: "x".into(), color: Some("orange".into()), note: None }).is_err());
    assert!(e.dispatch(Command::RemoveMarker { marker: "nope".into() }).is_err());
    assert!(e.dispatch(Command::SetMarker { marker: "nope".into(), time: None, name: None, color: None, note: None }).is_err());
    assert_eq!(e.project, before);
}

#[test]
fn old_projects_without_markers_load_and_markers_round_trip_through_json() {
    let mut e = engine();
    add(&mut e, Rational::from_int(3), "chapter");
    let mut v: serde_json::Value = serde_json::to_value(&e.project).unwrap();
    let back: ffworks_core::project::Project = serde_json::from_value(v.clone()).unwrap();
    assert_eq!(back, e.project);
    v["sequences"][0].as_object_mut().unwrap().remove("markers");
    let old: ffworks_core::project::Project = serde_json::from_value(v).unwrap();
    assert!(old.sequences[0].markers.is_empty());
    old.validate().unwrap();
}

#[test]
fn a_batch_of_marker_edits_is_one_undo_step() {
    let mut e = engine();
    let cmds = (1..=3).map(|i| Command::AddMarker { time: Rational::from_int(i), name: format!("m{i}"), color: None, note: None }).collect();
    e.dispatch(Command::Batch { label: "Add 3 markers".into(), commands: cmds }).unwrap();
    assert_eq!(names(&e).len(), 3);
    e.undo().unwrap();
    assert!(names(&e).is_empty());
}
