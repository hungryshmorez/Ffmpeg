//! Timeline/command/undo tests that need no external tools (media assets are hand-built).
use ffworks_core::commands::{Command, Edge};
use ffworks_core::engine::Engine;
use ffworks_core::ffprobe::{AudioStream, ColorInfo, MediaInfo, VideoStream};
use ffworks_core::process::Tools;
use ffworks_core::project::{MediaAsset, ProjectSettings, TrackKind};
use ffworks_core::Rational;

fn r(n: i64, d: i64) -> Rational {
    Rational::new(n, d)
}
fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

fn asset(id: &str, dur: i64, audio: bool) -> MediaAsset {
    MediaAsset {
        id: id.into(),
        name: format!("{id}.mp4"),
        path: format!("/nonexistent/{id}.mp4"),
        fingerprint: None,
        generator: None,
        info: MediaInfo {
            container: "mov,mp4".into(),
            duration: secs(dur),
            video: vec![VideoStream { index: 0, codec: "h264".into(), width: 640, height: 360, fps: Some(secs(30)), bit_rate: None, color: ColorInfo::default() }],
            audio: if audio { vec![AudioStream { index: 1, codec: "aac".into(), sample_rate: 48000, channels: 2, channel_layout: None, bit_rate: None }] } else { vec![] },
            ..Default::default()
        },
    }
}

fn engine() -> (Engine, String, String, String) {
    let tools = Tools { ffmpeg: "ffmpeg".into(), ffprobe: "ffprobe".into() };
    let mut e = Engine::new("t", ProjectSettings { width: 640, height: 360, fps: secs(30), sample_rate: 48000 }, tools);
    e.dispatch(Command::ImportMedia { asset: asset("m1", 10, true) }).unwrap();
    let seq = e.project.active().unwrap();
    let v1 = seq.tracks.iter().find(|t| t.kind == TrackKind::Video).unwrap().id.clone();
    let a1 = seq.tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap().id.clone();
    (e, "m1".into(), v1, a1)
}

fn place(e: &mut Engine, m: &str, v: &str, start: Rational) {
    e.dispatch(Command::PlaceClip { media: m.into(), track: v.into(), start, source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
}

fn clips(e: &Engine, kind: TrackKind) -> Vec<(Rational, Rational, Rational)> {
    e.project.active().unwrap().tracks.iter().filter(|t| t.kind == kind).flat_map(|t| t.clips.iter().map(|c| (c.start, c.source_in, c.duration))).collect()
}

#[test]
fn place_creates_linked_audio() {
    let (mut e, m, v, _) = engine();
    place(&mut e, &m, &v, secs(2));
    assert_eq!(clips(&e, TrackKind::Video), vec![(secs(2), secs(0), secs(10))]);
    assert_eq!(clips(&e, TrackKind::Audio), vec![(secs(2), secs(0), secs(10))]);
    let seq = e.project.active().unwrap();
    let vid = &seq.tracks[0].clips[0];
    assert_eq!(seq.linked_group(&vid.id).len(), 2);
}

#[test]
fn overlap_is_rejected_and_state_unchanged() {
    let (mut e, m, v, _) = engine();
    place(&mut e, &m, &v, secs(0));
    let before = e.project.clone();
    let err = e.dispatch(Command::PlaceClip { media: m, track: v, start: secs(5), source_in: None, duration: None, with_audio: true, audio_track: None });
    assert!(err.is_err());
    assert_eq!(e.project, before, "failed command must not change the project");
}

#[test]
fn trim_start_and_end_move_source_in_correctly() {
    let (mut e, m, v, _) = engine();
    place(&mut e, &m, &v, secs(0));
    let id = e.project.active().unwrap().tracks[0].clips[0].id.clone();
    e.dispatch(Command::TrimClip { clip: id.clone(), edge: Edge::Start, to: secs(2) }).unwrap();
    e.dispatch(Command::TrimClip { clip: id.clone(), edge: Edge::End, to: secs(7) }).unwrap();
    assert_eq!(clips(&e, TrackKind::Video), vec![(secs(2), secs(2), secs(5))]);
    // linked audio followed
    assert_eq!(clips(&e, TrackKind::Audio), vec![(secs(2), secs(2), secs(5))]);
    // cannot extend before source start
    assert!(e.dispatch(Command::TrimClip { clip: id, edge: Edge::Start, to: secs(-1) }).is_err());
}

#[test]
fn split_produces_contiguous_halves_with_new_links() {
    let (mut e, m, v, _) = engine();
    place(&mut e, &m, &v, secs(1));
    let id = e.project.active().unwrap().tracks[0].clips[0].id.clone();
    e.dispatch(Command::SplitClip { clip: id, at: secs(4) }).unwrap();
    assert_eq!(clips(&e, TrackKind::Video), vec![(secs(1), secs(0), secs(3)), (secs(4), secs(3), secs(7))]);
    assert_eq!(clips(&e, TrackKind::Audio), vec![(secs(1), secs(0), secs(3)), (secs(4), secs(3), secs(7))]);
    let seq = e.project.active().unwrap();
    let left = &seq.tracks[0].clips[0];
    let right = &seq.tracks[0].clips[1];
    assert_ne!(left.link, right.link);
    assert_eq!(seq.linked_group(&right.id).len(), 2);
}

#[test]
fn split_snaps_to_frames_and_rejects_edges() {
    let (mut e, m, v, _) = engine();
    place(&mut e, &m, &v, secs(0));
    let id = e.project.active().unwrap().tracks[0].clips[0].id.clone();
    assert!(e.dispatch(Command::SplitClip { clip: id.clone(), at: secs(0) }).is_err());
    assert!(e.dispatch(Command::SplitClip { clip: id.clone(), at: secs(10) }).is_err());
    e.dispatch(Command::SplitClip { clip: id, at: r(1001, 300) }).unwrap(); // 3.3366s -> frame 100 = 10/3
    assert_eq!(clips(&e, TrackKind::Video)[0].2, r(10, 3));
}

#[test]
fn move_carries_linked_clips_and_changes_nothing_on_collision() {
    let (mut e, m, v, _) = engine();
    place(&mut e, &m, &v, secs(0));
    let id = e.project.active().unwrap().tracks[0].clips[0].id.clone();
    e.dispatch(Command::MoveClip { clip: id.clone(), start: secs(5), track: None }).unwrap();
    assert_eq!(clips(&e, TrackKind::Video)[0].0, secs(5));
    assert_eq!(clips(&e, TrackKind::Audio)[0].0, secs(5));
    assert!(e.dispatch(Command::MoveClip { clip: id, start: secs(-1), track: None }).is_err());
}

#[test]
fn ripple_delete_closes_the_gap() {
    let (mut e, m, v, _) = engine();
    place(&mut e, &m, &v, secs(0));
    place(&mut e, &m, &v, secs(10));
    let first = e.project.active().unwrap().tracks[0].clips[0].id.clone();
    e.dispatch(Command::DeleteClip { clip: first, ripple: true }).unwrap();
    assert_eq!(clips(&e, TrackKind::Video), vec![(secs(0), secs(0), secs(10))]);
    assert_eq!(clips(&e, TrackKind::Audio), vec![(secs(0), secs(0), secs(10))]);
}

#[test]
fn undo_redo_restores_exact_states() {
    let (mut e, m, v, _) = engine();
    let s0 = e.project.clone();
    place(&mut e, &m, &v, secs(0));
    let s1 = e.project.clone();
    let id = e.project.active().unwrap().tracks[0].clips[0].id.clone();
    e.dispatch(Command::SplitClip { clip: id, at: secs(5) }).unwrap();
    let s2 = e.project.clone();
    e.undo().unwrap();
    assert_eq!(e.project, s1);
    e.undo().unwrap();
    assert_eq!(e.project.media.len(), 1);
    assert_eq!(e.project.active().unwrap().tracks, s0.active().unwrap().tracks);
    e.redo().unwrap();
    e.redo().unwrap();
    assert_eq!(e.project, s2);
    assert!(e.redo().is_err());
}

#[test]
fn batch_is_one_undo_step_and_atomic() {
    let (mut e, m, v, _) = engine();
    let cmds = vec![
        Command::PlaceClip { media: m.clone(), track: v.clone(), start: secs(0), source_in: None, duration: Some(secs(2)), with_audio: true, audio_track: None },
        Command::PlaceClip { media: m.clone(), track: v.clone(), start: secs(2), source_in: None, duration: Some(secs(2)), with_audio: true, audio_track: None },
    ];
    e.dispatch(Command::Batch { label: "two clips".into(), commands: cmds }).unwrap();
    assert_eq!(clips(&e, TrackKind::Video).len(), 2);
    assert_eq!(e.history().len(), 2); // import + batch
    e.undo().unwrap();
    assert_eq!(clips(&e, TrackKind::Video).len(), 0);
    // failing batch rolls back fully
    let before = e.project.clone();
    let bad = vec![
        Command::PlaceClip { media: m.clone(), track: v.clone(), start: secs(0), source_in: None, duration: Some(secs(2)), with_audio: true, audio_track: None },
        Command::PlaceClip { media: m, track: v, start: secs(1), source_in: None, duration: Some(secs(2)), with_audio: true, audio_track: None },
    ];
    assert!(e.dispatch(Command::Batch { label: "bad".into(), commands: bad }).is_err());
    assert_eq!(e.project, before);
}

#[test]
fn relative_gain_and_range_validation() {
    let (mut e, m, v, _) = engine();
    place(&mut e, &m, &v, secs(0));
    let vid = e.project.active().unwrap().tracks[0].clips[0].id.clone();
    e.dispatch(Command::SetClipGain { clip: vid.clone(), gain_db: 2.0, relative: true }).unwrap();
    e.dispatch(Command::SetClipGain { clip: vid.clone(), gain_db: 2.0, relative: true }).unwrap();
    let a = e.project.active().unwrap().tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap().clips[0].gain_db;
    assert_eq!(a, 4.0);
    assert!(e.dispatch(Command::SetClipGain { clip: vid, gain_db: 100.0, relative: false }).is_err());
}

#[test]
fn locked_track_blocks_edits() {
    let (mut e, m, v, _) = engine();
    place(&mut e, &m, &v, secs(0));
    e.dispatch(Command::SetTrack { track: v.clone(), name: None, muted: None, locked: Some(true), gain_db: None, pan: None, solo: None }).unwrap();
    let id = e.project.active().unwrap().tracks[0].clips[0].id.clone();
    assert!(e.dispatch(Command::DeleteClip { clip: id, ripple: false }).is_err());
}

#[test]
fn dirty_tracking_follows_undo() {
    let (mut e, m, v, _) = engine();
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("a.ffworks");
    e.save(&p).unwrap();
    assert!(!e.is_dirty());
    place(&mut e, &m, &v, secs(0));
    assert!(e.is_dirty());
    e.undo().unwrap();
    assert!(!e.is_dirty());
    // diverging after an undo past the save point must stay dirty
    place(&mut e, &m, &v, secs(0));
    e.save(&p).unwrap();
    e.undo().unwrap();
    assert!(e.is_dirty());
    let id = e.project.active().unwrap().tracks[0].id.clone();
    e.dispatch(Command::SetTrack { track: id, name: Some("renamed".into()), muted: None, locked: None, gain_db: None, pan: None, solo: None }).unwrap();
    assert!(e.is_dirty(), "new edit at the same history depth as the save must not look clean");
}

#[test]
fn recorder_captures_replayable_commands() {
    let (mut e, m, v, _) = engine();
    e.start_recording();
    place(&mut e, &m, &v, secs(0));
    let id = e.project.active().unwrap().tracks[0].clips[0].id.clone();
    e.dispatch(Command::SplitClip { clip: id, at: secs(5) }).unwrap();
    let script = e.stop_recording();
    assert_eq!(script.len(), 2);
    // round-trips through JSON (the same representation scripts will use)
    let json = serde_json::to_string(&script).unwrap();
    let back: Vec<Command> = serde_json::from_str(&json).unwrap();
    assert_eq!(back, script);
}

#[test]
fn save_load_roundtrip_preserves_project() {
    let (mut e, m, v, _) = engine();
    place(&mut e, &m, &v, r(1001, 30000));
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("x y/ü.ffworks");
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    e.save(&p).unwrap();
    let loaded = Engine::load(&p, Tools { ffmpeg: "ffmpeg".into(), ffprobe: "ffprobe".into() }).unwrap();
    assert_eq!(loaded.project, e.project);
}

#[test]
fn effects_stack_commands_undo_and_validation() {
    let (mut e, m, v, _) = engine();
    place(&mut e, &m, &v, secs(0));
    let vid = e.project.active().unwrap().tracks[0].clips[0].id.clone();
    let aud = e.project.active().unwrap().tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap().clips[0].id.clone();
    let add = |fx: &str, c: &str| Command::AddEffect { clip: c.into(), effect: fx.into(), params: Default::default(), index: None };
    assert!(e.dispatch(add("blur", &aud)).is_err(), "effects are video-only");
    assert!(e.dispatch(add("nope", &vid)).is_err());
    e.dispatch(add("blur", &vid)).unwrap();
    e.dispatch(add("saturation", &vid)).unwrap();
    let ids: Vec<String> = e.project.active().unwrap().tracks[0].clips[0].effects.iter().map(|x| x.id.clone()).collect();
    assert_eq!(ids.len(), 2);
    e.dispatch(Command::MoveEffect { clip: vid.clone(), effect_id: ids[1].clone(), index: 0 }).unwrap();
    assert_eq!(e.project.active().unwrap().tracks[0].clips[0].effects[0].effect, "saturation");
    assert!(e.dispatch(Command::SetEffectParam { clip: vid.clone(), effect_id: ids[0].clone(), param: "sigma".into(), value: 999.0 }).is_err());
    e.dispatch(Command::SetEffectParam { clip: vid.clone(), effect_id: ids[0].clone(), param: "sigma".into(), value: 9.0 }).unwrap();
    e.dispatch(Command::SetEffectEnabled { clip: vid.clone(), effect_id: ids[0].clone(), enabled: false }).unwrap();
    assert!(e.dispatch(Command::SetClipOpacity { clip: vid.clone(), opacity: 1.5 }).is_err());
    e.dispatch(Command::SetClipOpacity { clip: vid.clone(), opacity: 0.5 }).unwrap();
    // graph only contains enabled effects
    let g = ffworks_core::render_graph::build(&e.project).unwrap();
    assert_eq!(g.video[0].filters, vec!["eq=saturation=1"]);
    assert_eq!(g.video[0].opacity, 0.5);
    // full undo returns to a clean clip
    for _ in 0..6 {
        e.undo().unwrap();
    }
    let c = &e.project.active().unwrap().tracks[0].clips[0];
    assert!(c.effects.is_empty() && c.opacity == 1.0);
    // save/load keeps effects
    e.redo().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("fx.ffworks");
    e.save(&p).unwrap();
    let l = Engine::load(&p, Tools { ffmpeg: "ffmpeg".into(), ffprobe: "ffprobe".into() }).unwrap();
    assert_eq!(l.project, e.project);
}

#[test]
fn old_projects_without_effect_fields_still_load() {
    // schema-1 clip JSON written before effects/opacity existed
    let j = r#"{"id":"c","media":"m","name":"n","kind":"video","start":"0","source_in":"0","duration":"1"}"#;
    let c: ffworks_core::project::Clip = serde_json::from_str(j).unwrap();
    assert_eq!(c.opacity, 1.0);
    assert!(c.effects.is_empty());
}

#[test]
fn autosave_recovery_rotation_and_corruption_fallback() {
    use ffworks_core::recovery;
    let dir = tempfile::tempdir().unwrap();
    let ad = dir.path().join("auto");
    let (mut e, m, v, _) = engine();
    // a clean engine writes nothing
    e.save(&dir.path().join("p.ffworks")).unwrap();
    assert!(!e.autosave(&ad).unwrap());
    assert!(recovery::find(&ad).is_none());

    place(&mut e, &m, &v, secs(0));
    assert!(e.autosave(&ad).unwrap());
    assert!(!e.autosave(&ad).unwrap(), "no change since last autosave -> no rewrite");
    let first = e.project.clone();
    let id = e.project.active().unwrap().tracks[0].clips[0].id.clone();
    e.dispatch(Command::SplitClip { clip: id, at: secs(5) }).unwrap();
    assert!(e.autosave(&ad).unwrap());

    let info = recovery::find(&ad).unwrap();
    assert_eq!(info.clips, 4);
    assert_eq!(info.original_path.as_deref(), Some(dir.path().join("p.ffworks").to_str().unwrap()));
    let rec = recovery::load(&info, Tools { ffmpeg: "ffmpeg".into(), ffprobe: "ffprobe".into() }).unwrap();
    assert_eq!(rec.project, e.project);
    assert!(rec.is_dirty(), "recovered work must still be unsaved");

    // simulate a crash mid-write: latest file truncated -> previous rotation is used
    std::fs::write(ad.join("recovery.autosave.json"), b"{\"saved_unix\": 1, \"proj").unwrap();
    let info = recovery::find(&ad).unwrap();
    assert_eq!(recovery::load(&info, Tools { ffmpeg: "ffmpeg".into(), ffprobe: "ffprobe".into() }).unwrap().project, first);

    recovery::clear(&ad);
    assert!(recovery::find(&ad).is_none());
}

fn two_clips(e: &mut Engine, m: &str, v: &str, a_in: i64, b_in: i64) -> (String, String) {
    // A: timeline 0..2 from source a_in..a_in+2 ; B: 2..4 from source b_in..b_in+2 (media is 10 s long)
    let mk = |start: i64, s_in: i64| Command::PlaceClip { media: m.into(), track: v.into(), start: secs(start), source_in: Some(secs(s_in)), duration: Some(secs(2)), with_audio: true, audio_track: None };
    e.dispatch(mk(0, a_in)).unwrap();
    e.dispatch(mk(2, b_in)).unwrap();
    let t = &e.project.active().unwrap().tracks[0];
    (t.clips[0].id.clone(), t.clips[1].id.clone())
}

#[test]
fn transitions_validate_handles_adjacency_and_undo() {
    let (mut e, m, v, _) = engine();
    let (a, b) = two_clips(&mut e, &m, &v, 3, 4);
    let add = |k: &str, d: Rational| Command::AddTransition { clip_a: a.clone(), clip_b: b.clone(), kind: k.into(), duration: d };
    assert!(e.dispatch(add("Bad;name", secs(1))).is_err(), "names go into a filter graph, so only plain lowercase names are accepted");
    let before = e.project.clone();
    e.dispatch(add("fade", r(1, 2))).unwrap(); // 15 frames -> snapped to 16 frames
    let t = e.project.active().unwrap().tracks[0].transitions[0].clone();
    assert_eq!(t.duration, r(8, 15));
    assert!(e.dispatch(add("fade", secs(1))).is_err(), "one transition per cut");
    // moving / trimming a clip that is part of a transition is refused with a clear message
    let err = e.dispatch(Command::MoveClip { clip: b.clone(), start: secs(3), track: None }).unwrap_err().to_string();
    assert!(err.contains("touch") || err.contains("transition"), "{err}");
    // edit then undo
    e.dispatch(Command::SetTransition { transition: t.id.clone(), kind: Some("wipeleft".into()), duration: Some(secs(1)) }).unwrap();
    assert_eq!(e.project.active().unwrap().tracks[0].transitions[0].kind, "wipeleft");
    e.undo().unwrap();
    assert_eq!(e.project.active().unwrap().tracks[0].transitions[0].kind, "fade");
    e.undo().unwrap();
    assert_eq!(e.project, before);
    // save/load keeps them
    e.redo().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("t.ffworks");
    e.save(&p).unwrap();
    assert_eq!(Engine::load(&p, Tools { ffmpeg: "ffmpeg".into(), ffprobe: "ffprobe".into() }).unwrap().project, e.project);
    // deleting a clip removes its transition automatically (and undo restores both)
    let with = e.project.clone();
    e.dispatch(Command::DeleteClip { clip: a.clone(), ripple: false }).unwrap();
    assert!(e.project.active().unwrap().tracks[0].transitions.is_empty());
    e.undo().unwrap();
    assert_eq!(e.project, with);
}

#[test]
fn transitions_need_media_handles_and_opacity_100() {
    let (mut e, m, v, _) = engine();
    // A ends exactly at the media end (source 8..10): no handle after its out point
    let (a, b) = two_clips(&mut e, &m, &v, 8, 4);
    let err = e.dispatch(Command::AddTransition { clip_a: a.clone(), clip_b: b.clone(), kind: "fade".into(), duration: secs(1) }).unwrap_err().to_string();
    assert!(err.contains("no media left after"), "{err}");
    // B starts at source 0: no handle before its in point
    let (mut e2, m2, v2, _) = engine();
    let (a2, b2) = two_clips(&mut e2, &m2, &v2, 3, 0);
    let err = e2.dispatch(Command::AddTransition { clip_a: a2.clone(), clip_b: b2.clone(), kind: "fade".into(), duration: secs(1) }).unwrap_err().to_string();
    assert!(err.contains("no media before"), "{err}");
    // opacity < 1 not allowed
    let (mut e3, m3, v3, _) = engine();
    let (a3, b3) = two_clips(&mut e3, &m3, &v3, 3, 4);
    e3.dispatch(Command::SetClipOpacity { clip: a3.clone(), opacity: 0.5 }).unwrap();
    assert!(e3.dispatch(Command::AddTransition { clip_a: a3, clip_b: b3, kind: "fade".into(), duration: secs(1) }).is_err());
    // non-adjacent
    let (mut e4, m4, v4, _) = engine();
    e4.dispatch(Command::PlaceClip { media: m4.clone(), track: v4.clone(), start: secs(0), source_in: Some(secs(3)), duration: Some(secs(2)), with_audio: true, audio_track: None }).unwrap();
    e4.dispatch(Command::PlaceClip { media: m4, track: v4, start: secs(3), source_in: Some(secs(4)), duration: Some(secs(2)), with_audio: true, audio_track: None }).unwrap();
    let t = &e4.project.active().unwrap().tracks[0];
    assert!(e4.dispatch(Command::AddTransition { clip_a: t.clips[0].id.clone(), clip_b: t.clips[1].id.clone(), kind: "fade".into(), duration: secs(1) }).is_err());
}

#[test]
fn render_graph_splits_clips_around_a_transition() {
    let (mut e, m, v, _) = engine();
    let (a, b) = two_clips(&mut e, &m, &v, 3, 4);
    e.dispatch(Command::AddTransition { clip_a: a, clip_b: b, kind: "fade".into(), duration: secs(1) }).unwrap();
    let g = ffworks_core::render_graph::build(&e.project).unwrap();
    // A: 0..1.5 (source 3..4.5); transition 1.5..2.5; B: 2.5..4 (source 4.5..6)
    assert_eq!(g.video.iter().map(|s| (s.start, s.source_in, s.duration)).collect::<Vec<_>>(), vec![(secs(0), secs(3), r(3, 2)), (r(5, 2), r(9, 2), r(3, 2))]);
    let t = &g.video_transitions[0];
    // A part = source 3+2-0.5 = 4.5 s; B part = source 4-0.5 = 3.5 s
    assert_eq!((t.start, t.duration, t.a.source_in, t.b.source_in), (r(3, 2), secs(1), r(9, 2), r(7, 2)));
    // linked audio crossfades too
    assert_eq!(g.audio_transitions.len(), 1);
    assert_eq!(g.audio.len(), 2);
}

#[test]
fn a_transition_the_installed_ffmpeg_lacks_is_refused_when_the_render_is_compiled() {
    use ffworks_core::ffmpeg::{compile, ExportSettings, RenderOptions};
    use ffworks_core::process::Capabilities;
    let (mut e, m, v, _) = engine();
    let (a, b) = two_clips(&mut e, &m, &v, 3, 4);
    // a well-formed name that a newer FFmpeg might add is accepted by the model...
    e.dispatch(Command::AddTransition { clip_a: a, clip_b: b, kind: "futuristicwipe".into(), duration: secs(1) }).unwrap();
    let g = ffworks_core::render_graph::build(&e.project).unwrap();
    let mut caps = Capabilities::default();
    caps.filters.insert("xfade".into());
    caps.filters.insert("acrossfade".into());
    caps.encoders.insert("libx264".into());
    caps.encoders.insert("aac".into());
    caps.xfade_transitions = vec![("fade".into(), "fade".into())];
    let r = compile(&g, &RenderOptions { output: "/tmp/x.mp4".into(), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, Some(&caps));
    assert!(matches!(r, Err(ffworks_core::Error::Validation(m)) if m.contains("futuristicwipe") && m.contains("newer FFmpeg")));
}
