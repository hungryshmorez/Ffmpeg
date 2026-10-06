//! Keyframes, transform/blend params, speed/reverse/freeze at the command level (no external tools).
use ffworks_core::commands::{Command, Edge};
use ffworks_core::engine::Engine;
use ffworks_core::ffprobe::{AudioStream, ColorInfo, MediaInfo, VideoStream};
use ffworks_core::keyframes::{eval, Interp};
use ffworks_core::process::Tools;
use ffworks_core::project::{Clip, MediaAsset, ProjectSettings, TrackKind};
use ffworks_core::Rational;

fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

fn asset(id: &str, dur: i64) -> MediaAsset {
    MediaAsset {
        id: id.into(),
        name: format!("{id}.mp4"),
        path: format!("/nonexistent/{id}.mp4"),
        fingerprint: None,
        generator: None,
        color_override: None,
        info: MediaInfo {
            container: "mov,mp4".into(),
            duration: secs(dur),
            video: vec![VideoStream { index: 0, codec: "h264".into(), width: 640, height: 360, fps: Some(secs(30)), bit_rate: None, color: ColorInfo::default() }],
            audio: vec![AudioStream { index: 1, codec: "aac".into(), sample_rate: 48000, channels: 2, channel_layout: None, bit_rate: None }],
            ..Default::default()
        },
    }
}

/// 10 s clip at 0 on V1 with linked audio.
fn engine() -> (Engine, String) {
    let tools = Tools { ffmpeg: "ffmpeg".into(), ffprobe: "ffprobe".into() };
    let mut e = Engine::new("t", ProjectSettings { width: 640, height: 360, fps: secs(30), sample_rate: 48000 }, tools);
    e.dispatch(Command::ImportMedia { asset: asset("m1", 10) }).unwrap();
    let v = e.project.active().unwrap().tracks[0].id.clone();
    e.dispatch(Command::PlaceClip { media: "m1".into(), track: v, start: secs(0), source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
    let id = e.project.active().unwrap().tracks[0].clips[0].id.clone();
    (e, id)
}

fn vclip(e: &Engine, id: &str) -> Clip {
    e.project.active().unwrap().find_clip(id).unwrap().1.clone()
}

fn key(e: &mut Engine, id: &str, param: &str, t: i64, v: f64) -> ffworks_core::Result<()> {
    e.dispatch(Command::SetKeyframe { clip: id.into(), param: param.into(), time: secs(t), value: v, interp: None })
}

#[test]
fn keyframes_are_commands_with_undo_and_validation() {
    let (mut e, id) = engine();
    key(&mut e, &id, "opacity", 4, 1.0).unwrap();
    key(&mut e, &id, "opacity", 0, 0.0).unwrap();
    let c = vclip(&e, &id);
    assert_eq!(c.keyframes["opacity"].iter().map(|k| k.t).collect::<Vec<_>>(), vec![secs(0), secs(4)], "kept sorted");
    assert_eq!(eval(&c.keyframes["opacity"], 2.0), Some(0.5));

    // updating the same time replaces instead of duplicating, interpolation sticks unless changed
    e.dispatch(Command::SetKeyframe { clip: id.clone(), param: "opacity".into(), time: secs(0), value: 0.2, interp: Some(Interp::Hold) }).unwrap();
    key(&mut e, &id, "opacity", 0, 0.3).unwrap();
    let k0 = vclip(&e, &id).keyframes["opacity"][0];
    assert_eq!((k0.v, k0.interp), (0.3, Interp::Hold));

    // out of range / unknown / outside the clip are refused with the project untouched
    let before = e.project.clone();
    assert!(key(&mut e, &id, "opacity", 1, 2.0).is_err());
    assert!(key(&mut e, &id, "bogus", 1, 0.5).is_err());
    assert!(key(&mut e, &id, "opacity", 11, 0.5).is_err());
    assert_eq!(e.project, before);

    // while animated the static setter is refused
    assert!(e.dispatch(Command::SetClipOpacity { clip: id.clone(), opacity: 0.5 }).is_err());
    assert!(e.dispatch(Command::SetClipParam { clip: id.clone(), param: "opacity".into(), value: 0.5 }).is_err());

    // undo/redo walk back through every step
    e.undo().unwrap();
    assert_eq!(vclip(&e, &id).keyframes["opacity"][0].v, 0.2, "undo restores the previous key value");
    e.redo().unwrap();
    assert_eq!(vclip(&e, &id).keyframes["opacity"][0].v, 0.3);

    // removing the last key keeps the value as static
    e.dispatch(Command::RemoveKeyframe { clip: id.clone(), param: "opacity".into(), time: secs(0) }).unwrap();
    e.dispatch(Command::RemoveKeyframe { clip: id.clone(), param: "opacity".into(), time: secs(4) }).unwrap();
    let c = vclip(&e, &id);
    assert!(c.keyframes.is_empty());
    assert_eq!(c.opacity, 1.0);
    // clear keeps the first key's value
    key(&mut e, &id, "scale", 0, 2.0).unwrap();
    key(&mut e, &id, "scale", 3, 4.0).unwrap();
    e.dispatch(Command::ClearKeyframes { clip: id.clone(), param: "scale".into() }).unwrap();
    assert_eq!(vclip(&e, &id).transform.scale, 2.0);
}

#[test]
fn keyframe_times_snap_to_frames_and_effect_params_animate() {
    let (mut e, id) = engine();
    e.dispatch(Command::AddEffect { clip: id.clone(), effect: "brightness".into(), params: Default::default(), index: None }).unwrap();
    e.dispatch(Command::AddEffect { clip: id.clone(), effect: "blur".into(), params: Default::default(), index: None }).unwrap();
    let c = vclip(&e, &id);
    let (br, bl) = (c.effects[0].id.clone(), c.effects[1].id.clone());
    // 0.51 s at 30 fps snaps to frame 15 = 0.5 s
    e.dispatch(Command::SetKeyframe { clip: id.clone(), param: format!("fx:{br}:amount"), time: Rational::new(51, 100), value: -0.5, interp: None }).unwrap();
    assert_eq!(vclip(&e, &id).keyframes[&format!("fx:{br}:amount")][0].t, Rational::new(1, 2));
    // blur sigma is not animatable (FFmpeg takes a fixed value)
    let err = e.dispatch(Command::SetKeyframe { clip: id.clone(), param: format!("fx:{bl}:sigma"), time: secs(1), value: 3.0, interp: None }).unwrap_err();
    assert!(err.to_string().contains("cannot be animated"), "{err}");
    // removing the effect drops its keyframes
    e.dispatch(Command::RemoveEffect { clip: id.clone(), effect_id: br }).unwrap();
    assert!(vclip(&e, &id).keyframes.is_empty());
}

#[test]
fn transform_and_blend_params_validate_and_roundtrip_through_save_load() {
    let (mut e, id) = engine();
    for (p, v) in [("x", 120.0), ("y", -30.0), ("scale", 0.5), ("rotation", 45.0)] {
        e.dispatch(Command::SetClipParam { clip: id.clone(), param: p.into(), value: v }).unwrap();
    }
    assert!(e.dispatch(Command::SetClipParam { clip: id.clone(), param: "scale".into(), value: 0.0 }).is_err());
    assert!(e.dispatch(Command::SetClipBlend { clip: id.clone(), blend: "nonsense".into() }).is_err());
    e.dispatch(Command::SetClipBlend { clip: id.clone(), blend: "multiply".into() }).unwrap();
    key(&mut e, &id, "x", 0, 0.0).unwrap();
    key(&mut e, &id, "x", 5, 300.0).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p.ffworks");
    e.save(&path).unwrap();
    // load() re-probes nothing here (media path is fake) but the project must come back identical
    let json = std::fs::read_to_string(&path).unwrap();
    let back: ffworks_core::project::Project = serde_json::from_str(&json).unwrap();
    assert_eq!(back, e.project);
    let c = vclip(&e, &id);
    assert_eq!((c.transform.scale, c.transform.rotation, c.blend.as_str()), (0.5, 45.0, "multiply"));
}

#[test]
fn old_projects_without_the_new_fields_still_load() {
    let (e, _) = engine();
    let mut v: serde_json::Value = serde_json::to_value(&e.project).unwrap();
    for c in v["sequences"][0]["tracks"].as_array_mut().unwrap().iter_mut().flat_map(|t| t["clips"].as_array_mut().unwrap().iter_mut()) {
        for k in ["speed", "reverse", "freeze", "transform", "blend", "keyframes"] {
            c.as_object_mut().unwrap().remove(k);
        }
    }
    let p: ffworks_core::project::Project = serde_json::from_value(v).unwrap();
    let c = &p.sequences[0].tracks[0].clips[0];
    assert_eq!((c.speed, c.reverse, c.freeze, c.blend.as_str()), (secs(1), false, None, "normal"));
    assert!(c.transform.is_identity() && c.keyframes.is_empty());
}

#[test]
fn speed_changes_duration_for_linked_clips_and_keeps_source_span() {
    let (mut e, id) = engine();
    // trim to 4 s of the source first so there is room to slow down on the track
    e.dispatch(Command::TrimClip { clip: id.clone(), edge: Edge::End, to: secs(4) }).unwrap();
    e.dispatch(Command::SetClipSpeed { clip: id.clone(), speed: secs(2) }).unwrap();
    let seq = e.project.active().unwrap();
    let all: Vec<_> = seq.tracks.iter().flat_map(|t| t.clips.iter()).collect();
    assert_eq!(all.len(), 2);
    for c in &all {
        assert_eq!((c.speed, c.duration, c.source_in), (secs(2), secs(2), secs(0)), "{:?}", c.kind);
    }
    // 50% -> twice as long as the 4 s source span
    e.dispatch(Command::SetClipSpeed { clip: id.clone(), speed: Rational::new(1, 2) }).unwrap();
    assert_eq!(vclip(&e, &id).duration, secs(8));
    // too fast / too slow refused
    assert!(e.dispatch(Command::SetClipSpeed { clip: id.clone(), speed: secs(11) }).is_err());
    assert!(e.dispatch(Command::SetClipSpeed { clip: id.clone(), speed: Rational::new(1, 20) }).is_err());
    e.undo().unwrap();
    assert_eq!(vclip(&e, &id).duration, secs(2), "undo restores the previous duration");
}

#[test]
fn slowing_down_needs_free_space_on_the_track() {
    let (mut e, id) = engine();
    e.dispatch(Command::TrimClip { clip: id.clone(), edge: Edge::End, to: secs(4) }).unwrap();
    let v = e.project.active().unwrap().tracks[0].id.clone();
    e.dispatch(Command::PlaceClip { media: "m1".into(), track: v, start: secs(4), source_in: None, duration: Some(secs(2)), with_audio: false, audio_track: None }).unwrap();
    let before = e.project.clone();
    let err = e.dispatch(Command::SetClipSpeed { clip: id.clone(), speed: Rational::new(1, 2) }).unwrap_err();
    assert!(err.to_string().contains("overlaps"), "{err}");
    assert_eq!(e.project, before);
}

#[test]
fn trim_and_split_keep_source_ranges_right_with_speed_and_reverse() {
    let (mut e, id) = engine();
    e.dispatch(Command::TrimClip { clip: id.clone(), edge: Edge::End, to: secs(4) }).unwrap();
    e.dispatch(Command::SetClipSpeed { clip: id.clone(), speed: secs(2) }).unwrap(); // 4 s source -> 2 s on the timeline
    // trim 0.5 s off the start: the source moves by 0.5 * 2 = 1 s
    e.dispatch(Command::TrimClip { clip: id.clone(), edge: Edge::Start, to: Rational::new(1, 2) }).unwrap();
    let c = vclip(&e, &id);
    assert_eq!((c.start, c.source_in, c.duration), (Rational::new(1, 2), secs(1), Rational::new(3, 2)));
    // split at 1.2 s (frame 36): 0.7 s into the clip = 1.4 s of source
    e.dispatch(Command::SplitClip { clip: id.clone(), at: Rational::new(6, 5) }).unwrap();
    let seq = e.project.active().unwrap();
    let v: Vec<_> = seq.tracks[0].clips.iter().map(|c| (c.start, c.source_in, c.duration)).collect();
    assert_eq!(v, vec![(Rational::new(1, 2), secs(1), Rational::new(7, 10)), (Rational::new(6, 5), Rational::new(12, 5), Rational::new(4, 5))]);

    // reversed clip: the left piece plays the LATER part of the source
    let (mut e, id) = engine();
    e.dispatch(Command::SetClipReverse { clip: id.clone(), reverse: true }).unwrap();
    e.dispatch(Command::SplitClip { clip: id.clone(), at: secs(3) }).unwrap();
    let seq = e.project.active().unwrap();
    let v: Vec<_> = seq.tracks[0].clips.iter().map(|c| (c.start, c.source_in, c.duration)).collect();
    assert_eq!(v, vec![(secs(0), secs(7), secs(3)), (secs(3), secs(0), secs(7))], "left = source 7..10, right = 0..7");
    // trimming the start of a reversed clip removes the END of its source: source_in stays
    e.dispatch(Command::TrimClip { clip: seq.tracks[0].clips[1].id.clone(), edge: Edge::Start, to: secs(4) }).unwrap();
    let c = e.project.active().unwrap().tracks[0].clips[1].clone();
    assert_eq!((c.start, c.source_in, c.duration), (secs(4), secs(0), secs(6)));
}

#[test]
fn splitting_a_keyframed_clip_keeps_the_animation_continuous() {
    let (mut e, id) = engine();
    key(&mut e, &id, "x", 0, 0.0).unwrap();
    key(&mut e, &id, "x", 10, 1000.0).unwrap();
    let orig = vclip(&e, &id).keyframes["x"].clone();
    e.dispatch(Command::SplitClip { clip: id.clone(), at: secs(4) }).unwrap();
    let seq = e.project.active().unwrap();
    let (l, r) = (&seq.tracks[0].clips[0], &seq.tracks[0].clips[1]);
    for t in [0.0, 1.5, 3.9] {
        assert!((eval(&l.keyframes["x"], t).unwrap() - eval(&orig, t).unwrap()).abs() < 1e-9);
    }
    for t in [0.0, 2.0, 5.9] {
        assert!((eval(&r.keyframes["x"], t).unwrap() - eval(&orig, t + 4.0).unwrap()).abs() < 1e-9, "t={t}");
    }
}

#[test]
fn trimming_the_start_keeps_keyframes_on_the_same_picture() {
    let (mut e, id) = engine();
    key(&mut e, &id, "x", 4, 400.0).unwrap();
    key(&mut e, &id, "x", 8, 800.0).unwrap();
    e.dispatch(Command::TrimClip { clip: id.clone(), edge: Edge::Start, to: secs(2) }).unwrap();
    let c = vclip(&e, &id);
    // the picture that was at clip time 6 s is now at 4 s: value 600 either way
    assert!((eval(&c.keyframes["x"], 4.0).unwrap() - 600.0).abs() < 1e-9);
}

#[test]
fn freeze_ignores_source_span_and_can_be_extended_freely() {
    let (mut e, id) = engine();
    e.dispatch(Command::TrimClip { clip: id.clone(), edge: Edge::End, to: secs(2) }).unwrap();
    e.dispatch(Command::SetClipFreeze { clip: id.clone(), at: Some(Rational::new(3, 2)) }).unwrap();
    // a frozen clip may be longer than the media it came from
    e.dispatch(Command::TrimClip { clip: id.clone(), edge: Edge::End, to: secs(30) }).unwrap();
    assert_eq!(vclip(&e, &id).duration, secs(30));
    assert!(vclip(&e, &id).link.is_none(), "freezing detaches the linked audio");
    let seq = e.project.active().unwrap();
    assert_eq!(seq.tracks[1].clips[0].duration, secs(2), "audio keeps its own length");
    assert!(e.dispatch(Command::SetClipSpeed { clip: id.clone(), speed: secs(2) }).is_err(), "no speed on a frozen clip");
    assert!(e.dispatch(Command::SetClipFreeze { clip: id.clone(), at: Some(secs(99)) }).is_err());
    // unfreezing a clip longer than its media is rejected by validation and rolled back
    let before = e.project.clone();
    assert!(e.dispatch(Command::SetClipFreeze { clip: id.clone(), at: None }).is_err());
    assert_eq!(e.project, before);
}

#[test]
fn transitions_refuse_retimed_or_transformed_clips() {
    let (mut e, id) = engine();
    e.dispatch(Command::TrimClip { clip: id.clone(), edge: Edge::End, to: secs(4) }).unwrap();
    let v = e.project.active().unwrap().tracks[0].id.clone();
    e.dispatch(Command::PlaceClip { media: "m1".into(), track: v, start: secs(4), source_in: Some(secs(2)), duration: Some(secs(4)), with_audio: true, audio_track: None }).unwrap();
    let b = e.project.active().unwrap().tracks[0].clips[1].id.clone();
    let add = |e: &mut Engine| e.dispatch(Command::AddTransition { clip_a: id.clone(), clip_b: b.clone(), kind: "fade".into(), duration: Rational::new(1, 2) });
    e.dispatch(Command::SetClipReverse { clip: id.clone(), reverse: true }).unwrap();
    assert!(add(&mut e).unwrap_err().to_string().contains("transitions need normal playback"));
    e.dispatch(Command::SetClipReverse { clip: id.clone(), reverse: false }).unwrap();
    e.dispatch(Command::SetClipParam { clip: id.clone(), param: "scale".into(), value: 0.5 }).unwrap();
    assert!(add(&mut e).unwrap_err().to_string().contains("transform"));
    e.dispatch(Command::SetClipParam { clip: id.clone(), param: "scale".into(), value: 1.0 }).unwrap();
    add(&mut e).unwrap();
    // and the other way round: a clip in a transition cannot be retimed
    assert!(e.dispatch(Command::SetClipSpeed { clip: id.clone(), speed: secs(2) }).is_err());
}

#[test]
fn audio_clips_reject_video_only_properties() {
    let (mut e, id) = engine();
    let aud = {
        let seq = e.project.active().unwrap();
        seq.linked_group(&id).into_iter().find(|g| seq.find_clip(g).unwrap().1.kind == TrackKind::Audio).unwrap()
    };
    assert!(e.dispatch(Command::SetClipParam { clip: aud.clone(), param: "scale".into(), value: 2.0 }).is_err());
    assert!(e.dispatch(Command::SetClipFreeze { clip: aud, at: Some(secs(1)) }).is_err());
}

fn audio_of(e: &Engine, video: &str) -> Clip {
    let seq = e.project.active().unwrap();
    let id = seq.linked_group(video).into_iter().find(|g| seq.find_clip(g).unwrap().1.kind == TrackKind::Audio).unwrap();
    seq.find_clip(&id).unwrap().1.clone()
}

#[test]
fn audio_pan_fades_gain_envelope_and_track_mixer_properties_are_commands() {
    let (mut e, vid) = engine();
    let a = audio_of(&e, &vid).id;
    e.dispatch(Command::SetClipParam { clip: a.clone(), param: "pan".into(), value: -0.5 }).unwrap();
    assert_eq!(audio_of(&e, &vid).pan, -0.5);
    assert!(e.dispatch(Command::SetClipParam { clip: a.clone(), param: "pan".into(), value: 2.0 }).is_err());
    // pan cannot be keyframed, gain can
    assert!(e.dispatch(Command::SetKeyframe { clip: a.clone(), param: "pan".into(), time: secs(1), value: 0.0, interp: None }).unwrap_err().to_string().contains("cannot be animated"));
    key(&mut e, &a, "gain_db", 0, -60.0).unwrap();
    key(&mut e, &a, "gain_db", 2, 0.0).unwrap();
    assert!(e.dispatch(Command::SetClipGain { clip: vid.clone(), gain_db: -3.0, relative: false }).is_err(), "static gain refused while the envelope exists");
    // video-only parameters are refused on audio
    assert!(e.dispatch(Command::SetClipOpacity { clip: a.clone(), opacity: 0.5 }).is_err());
    // fades are snapped to frames and must fit the clip
    e.dispatch(Command::SetClipFades { clip: a.clone(), fade_in: Some(Rational::new(51, 100)), fade_out: Some(secs(2)) }).unwrap();
    let c = audio_of(&e, &vid);
    assert_eq!((c.fade_in, c.fade_out), (Rational::new(1, 2), secs(2)));
    assert!(e.dispatch(Command::SetClipFades { clip: a.clone(), fade_in: Some(secs(9)), fade_out: None }).is_err(), "9 + 2 > 10");
    assert!(e.dispatch(Command::SetClipFades { clip: vid.clone(), fade_in: Some(secs(1)), fade_out: None }).is_err(), "fades are for audio clips");
    // track mixer properties
    let at = e.project.active().unwrap().tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap().id.clone();
    e.dispatch(Command::SetTrack { track: at.clone(), name: None, muted: None, locked: None, gain_db: Some(-6.0), pan: Some(0.25), solo: Some(true) }).unwrap();
    let t = e.project.active().unwrap().track(&at).unwrap().clone();
    assert_eq!((t.gain_db, t.pan, t.solo), (-6.0, 0.25, true));
    assert!(e.dispatch(Command::SetTrack { track: at.clone(), name: None, muted: None, locked: None, gain_db: None, pan: Some(1.5), solo: None }).is_err());
    e.undo().unwrap();
    assert!(!e.project.active().unwrap().track(&at).unwrap().solo, "undo restores the mixer state");
}

#[test]
fn audio_and_video_effects_cannot_be_mixed_up() {
    let (mut e, vid) = engine();
    let a = audio_of(&e, &vid).id;
    assert!(e.dispatch(Command::AddEffect { clip: vid.clone(), effect: "compressor".into(), params: Default::default(), index: None }).unwrap_err().to_string().contains("audio effect"));
    assert!(e.dispatch(Command::AddEffect { clip: a.clone(), effect: "blur".into(), params: Default::default(), index: None }).unwrap_err().to_string().contains("video effect"));
    e.dispatch(Command::AddEffect { clip: a.clone(), effect: "compressor".into(), params: Default::default(), index: None }).unwrap();
    let fx = audio_of(&e, &vid).effects[0].id.clone();
    e.dispatch(Command::SetEffectParam { clip: a.clone(), effect_id: fx, param: "ratio".into(), value: 8.0 }).unwrap();
    assert_eq!(audio_of(&e, &vid).effects[0].params["ratio"], 8.0);
    assert!(e.dispatch(Command::SetEffectParam { clip: a, effect_id: audio_of(&e, &vid).effects[0].id.clone(), param: "ratio".into(), value: 99.0 }).is_err());
}

#[test]
fn splitting_gives_the_fade_in_to_the_left_and_the_fade_out_to_the_right_and_trims_clamp_fades() {
    let (mut e, vid) = engine();
    let a = audio_of(&e, &vid).id;
    e.dispatch(Command::SetClipFades { clip: a.clone(), fade_in: Some(secs(1)), fade_out: Some(secs(2)) }).unwrap();
    e.dispatch(Command::SplitClip { clip: vid.clone(), at: secs(5) }).unwrap();
    let seq = e.project.active().unwrap();
    let at = seq.tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap();
    assert_eq!((at.clips[0].fade_in, at.clips[0].fade_out), (secs(1), Rational::ZERO));
    assert_eq!((at.clips[1].fade_in, at.clips[1].fade_out), (Rational::ZERO, secs(2)));
    // shortening a clip below its fades shrinks them instead of failing
    let left = at.clips[0].id.clone();
    e.dispatch(Command::SetClipFades { clip: left.clone(), fade_in: None, fade_out: Some(secs(3)) }).unwrap();
    e.dispatch(Command::TrimClip { clip: left.clone(), edge: Edge::End, to: Rational::new(3, 2) }).unwrap();
    let c = e.project.active().unwrap().find_clip(&left).unwrap().1.clone();
    assert!(c.fade_in + c.fade_out <= c.duration, "{:?} {:?} {:?}", c.fade_in, c.fade_out, c.duration);
}

#[test]
fn solo_silences_other_audio_tracks_in_the_render_graph() {
    let (mut e, vid) = engine();
    let _ = vid;
    e.dispatch(Command::AddTrack { kind: TrackKind::Audio, name: None }).unwrap();
    let tracks: Vec<_> = e.project.active().unwrap().tracks.iter().filter(|t| t.kind == TrackKind::Audio).map(|t| t.id.clone()).collect();
    e.dispatch(Command::PlaceClip { media: "m1".into(), track: tracks[1].clone(), start: secs(0), source_in: None, duration: Some(secs(4)), with_audio: false, audio_track: None }).unwrap();
    assert_eq!(ffworks_core::render_graph::build(&e.project).unwrap().audio.len(), 2);
    e.dispatch(Command::SetTrack { track: tracks[1].clone(), name: None, muted: None, locked: None, gain_db: None, pan: None, solo: Some(true) }).unwrap();
    let g = ffworks_core::render_graph::build(&e.project).unwrap();
    assert_eq!(g.audio.len(), 1, "only the soloed track is heard");
    assert!(g.has_audio, "the output still carries an audio stream");
    // a muted soloed track is not a solo
    e.dispatch(Command::SetTrack { track: tracks[1].clone(), name: None, muted: Some(true), locked: None, gain_db: None, pan: None, solo: None }).unwrap();
    assert_eq!(ffworks_core::render_graph::build(&e.project).unwrap().audio.len(), 1, "the other track plays again");
}

#[test]
fn transitions_refuse_audio_with_effects_pan_or_fades() {
    let (mut e, id) = engine();
    e.dispatch(Command::TrimClip { clip: id.clone(), edge: Edge::End, to: secs(4) }).unwrap();
    let v = e.project.active().unwrap().tracks[0].id.clone();
    e.dispatch(Command::PlaceClip { media: "m1".into(), track: v, start: secs(4), source_in: Some(secs(2)), duration: Some(secs(4)), with_audio: true, audio_track: None }).unwrap();
    let b = e.project.active().unwrap().tracks[0].clips[1].id.clone();
    let a = audio_of(&e, &id).id;
    e.dispatch(Command::SetClipParam { clip: a.clone(), param: "pan".into(), value: 0.5 }).unwrap();
    let err = e.dispatch(Command::AddTransition { clip_a: id.clone(), clip_b: b.clone(), kind: "fade".into(), duration: Rational::new(1, 2) }).unwrap_err();
    assert!(err.to_string().contains("audio"), "{err}");
    e.dispatch(Command::SetClipParam { clip: a, param: "pan".into(), value: 0.0 }).unwrap();
    e.dispatch(Command::AddTransition { clip_a: id, clip_b: b, kind: "fade".into(), duration: Rational::new(1, 2) }).unwrap();
}
