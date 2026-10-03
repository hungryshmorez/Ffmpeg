//! MIDI files as a parameter source: tempo-aware parsing, each source (controller, gate, velocity pulses, pitch, pitch wheel),
//! channel/track filters, clips that start mid-song, and the command with undo. Pure engine work; the MIDI files are built here.
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::keyframes::{eval, Interp};
use ffworks_core::midi::{keys, parse, Kind, Options, Source};
use ffworks_core::process::Tools;
use ffworks_core::project::ProjectSettings;
use ffworks_core::Rational;
use midly::{num::{u15, u28, u4, u7}, Format, Header, MetaMessage, MidiMessage, Smf, Timing, TrackEvent, TrackEventKind};

const PPQ: u16 = 480;

type Ev = (u32, TrackEventKind<'static>);

fn on(tick: u32, ch: u8, key: u8, vel: u8) -> Ev {
    (tick, TrackEventKind::Midi { channel: u4::new(ch), message: MidiMessage::NoteOn { key: u7::new(key), vel: u7::new(vel) } })
}
fn off(tick: u32, ch: u8, key: u8) -> Ev {
    (tick, TrackEventKind::Midi { channel: u4::new(ch), message: MidiMessage::NoteOff { key: u7::new(key), vel: u7::new(0) } })
}
fn cc(tick: u32, ch: u8, number: u8, value: u8) -> Ev {
    (tick, TrackEventKind::Midi { channel: u4::new(ch), message: MidiMessage::Controller { controller: u7::new(number), value: u7::new(value) } })
}
fn tempo(tick: u32, micros: u32) -> Ev {
    (tick, TrackEventKind::Meta(MetaMessage::Tempo(midly::num::u24::new(micros))))
}

/// A parallel-format file: one track per list of events (absolute ticks, already sorted).
fn smf(tracks: Vec<Vec<Ev>>) -> Vec<u8> {
    let mut file = Smf::new(Header::new(Format::Parallel, Timing::Metrical(u15::new(PPQ))));
    for t in tracks {
        let mut last = 0;
        let mut track = vec![];
        for (tick, kind) in t {
            track.push(TrackEvent { delta: u28::new(tick - last), kind });
            last = tick;
        }
        track.push(TrackEvent { delta: u28::new(0), kind: TrackEventKind::Meta(MetaMessage::EndOfTrack) });
        file.tracks.push(track);
    }
    let mut out = vec![];
    file.write_std(&mut out).unwrap();
    out
}

fn fps() -> ffworks_core::time::Fps {
    ffworks_core::time::Fps::new(25, 1)
}

fn opts(source: Source) -> Options {
    Options { source, channel: None, track: None, low: 0.0, high: 1.0, decay: 0.25, offset: 0.0 }
}

/// 120 bpm: a beat (480 ticks) is half a second.
fn beat(n: u32) -> u32 {
    n * u32::from(PPQ)
}

fn value_at(k: &[ffworks_core::keyframes::Keyframe], t: f64) -> f64 {
    eval(k, t).unwrap()
}

#[test]
fn times_follow_the_tempo_map_even_when_the_tempo_sits_on_another_track() {
    // track 0 only carries tempo: 120 bpm, then 60 bpm from beat 1 (one beat is 1 s from there)
    let bytes = smf(vec![vec![tempo(0, 500_000), tempo(beat(1), 1_000_000)], vec![on(0, 0, 60, 100), on(beat(1), 0, 62, 100), on(beat(3), 0, 64, 100)]]);
    let f = parse(&bytes).unwrap();
    let times: Vec<f64> = f.events.iter().map(|e| e.t).collect();
    assert_eq!(f.tracks, 2);
    assert!((times[0] - 0.0).abs() < 1e-9 && (times[1] - 0.5).abs() < 1e-9, "{times:?}");
    assert!((times[2] - 2.5).abs() < 1e-9, "beat 3 = 0.5 s at 120 bpm + 2 beats of 1 s: {times:?}");
    assert!((f.length - 2.5).abs() < 1e-9);
    assert!(matches!(f.events[0].kind, Kind::NoteOn { key: 60, velocity: 100 }));
}

#[test]
fn a_note_on_with_velocity_zero_is_a_note_off_and_garbage_is_refused() {
    let f = parse(&smf(vec![vec![on(0, 0, 60, 90), on(beat(1), 0, 60, 0)]])).unwrap();
    assert!(matches!(f.events[1].kind, Kind::NoteOff { key: 60 }));
    let err = parse(b"this is not midi").err().unwrap().to_string();
    assert!(err.contains("not a readable MIDI file"), "{err}");
}

#[test]
fn a_controller_becomes_keyframes_mapped_between_low_and_high() {
    let f = parse(&smf(vec![vec![cc(0, 0, 1, 0), cc(beat(4), 0, 1, 127), cc(beat(2), 0, 7, 50)]].into_iter().map(|mut t| { t.sort_by_key(|e| e.0); t }).collect())).unwrap();
    let mut o = opts(Source::Controller(1));
    o.low = 0.2;
    o.high = 1.0;
    let k = keys(&f, &o, fps(), 0.0, 4.0).unwrap();
    assert_eq!(k.len(), 2, "controller 7 is not controller 1");
    assert!((k[0].v - 0.2).abs() < 1e-3 && (k[1].v - 1.0).abs() < 1e-3, "{k:?}");
    assert!((value_at(&k, 1.0) - 0.6).abs() < 0.01, "linear between: {}", value_at(&k, 1.0));
    assert_eq!(k[0].interp, Interp::Linear);
}

#[test]
fn the_gate_is_high_only_while_a_note_is_held() {
    // a note from 1 s to 2 s, a second one from 3 s to 3.5 s
    let f = parse(&smf(vec![vec![on(beat(2), 0, 60, 80), off(beat(4), 0, 60), on(beat(6), 0, 64, 80), off(beat(7), 0, 64)]])).unwrap();
    let k = keys(&f, &opts(Source::Gate), fps(), 0.0, 5.0).unwrap();
    let at = |t| value_at(&k, t);
    assert_eq!((at(0.5), at(1.5), at(2.5), at(3.2), at(4.0)), (0.0, 1.0, 0.0, 1.0, 0.0), "{k:?}");
    assert!(k.iter().all(|p| p.interp == Interp::Hold));
}

#[test]
fn velocity_makes_pulses_as_high_as_each_note_and_pitch_holds_the_latest_key() {
    let f = parse(&smf(vec![vec![on(beat(2), 0, 36, 127), on(beat(6), 0, 72, 64)]])).unwrap();
    let mut o = opts(Source::Velocity);
    o.decay = 0.3;
    let k = keys(&f, &o, fps(), 0.0, 4.0).unwrap();
    let peak = |t: f64| value_at(&k, t);
    assert!((peak(1.0) - 1.0).abs() < 0.02, "the loud note peaks at 1: {}", peak(1.0));
    assert!((peak(3.0) - 0.504).abs() < 0.03, "the soft note at velocity 64 peaks near 0.5: {}", peak(3.0));
    assert!(peak(1.5) < 0.05 && peak(0.5) == 0.0, "falls back to low between and before notes");

    let p = keys(&f, &opts(Source::Pitch), fps(), 0.0, 4.0).unwrap();
    assert!((value_at(&p, 1.5) - 36.0 / 127.0).abs() < 1e-3 && (value_at(&p, 3.5) - 72.0 / 127.0).abs() < 1e-3);
}

#[test]
fn the_pitch_wheel_maps_minus_one_to_one_onto_zero_to_one() {
    let bend = |tick, v: i16| (tick, TrackEventKind::Midi { channel: u4::new(0), message: MidiMessage::PitchBend { bend: midly::PitchBend(midly::num::u14::new((v + 8192) as u16)) } });
    let f = parse(&smf(vec![vec![bend(0, -8192), bend(beat(2), 0), bend(beat(4), 8191)]])).unwrap();
    let k = keys(&f, &opts(Source::Bend), fps(), 0.0, 2.0).unwrap();
    assert!(k[0].v.abs() < 1e-3 && (k[1].v - 0.5).abs() < 1e-3 && (k[2].v - 1.0).abs() < 1e-3, "{k:?}");
}

#[test]
fn channel_and_track_filters_pick_what_is_heard() {
    let f = parse(&smf(vec![vec![on(0, 0, 60, 100), off(beat(1), 0, 60)], vec![on(beat(2), 1, 60, 100), off(beat(3), 1, 60)]])).unwrap();
    let mut o = opts(Source::Gate);
    o.channel = Some(2);
    let k = keys(&f, &o, fps(), 0.0, 2.0).unwrap();
    assert_eq!((value_at(&k, 0.5), value_at(&k, 1.5)), (0.0, 1.0), "channel 2 only: the note at 1-1.5 s");
    o.channel = None;
    o.track = Some(0);
    let k = keys(&f, &o, fps(), 0.0, 2.0).unwrap();
    assert_eq!((value_at(&k, 0.25), value_at(&k, 1.5)), (1.0, 0.0), "track 0 only: the note at 0-0.5 s");
    o.channel = Some(9);
    let err = keys(&f, &o, fps(), 0.0, 2.0).unwrap_err().to_string();
    assert!(err.contains("no notes") && err.contains("that channel/track"), "{err}");
}

#[test]
fn a_clip_placed_late_in_the_song_starts_with_the_value_held_from_before() {
    let f = parse(&smf(vec![vec![cc(0, 0, 1, 64), cc(beat(2), 0, 1, 127), cc(beat(40), 0, 1, 0)]])).unwrap();
    // the clip starts at 5 s and lasts 4 s; the controller last moved at 1 s and next moves at 20 s
    let k = keys(&f, &opts(Source::Controller(1)), fps(), 5.0, 4.0).unwrap();
    assert!((k[0].v - 1.0).abs() < 1e-3 && k[0].t == Rational::ZERO, "starts at the held value: {k:?}");
    // an offset shifts the music later: the same clip now sees the first move (at 1 s + 4.5 = 5.5 s)
    let mut o = opts(Source::Controller(1));
    o.offset = 4.5;
    let k = keys(&f, &o, fps(), 5.0, 4.0).unwrap();
    assert!((value_at(&k, 0.0) - 64.0 / 127.0).abs() < 1e-3 && (value_at(&k, 1.0) - 1.0).abs() < 1e-3, "{k:?}");
    // the song ended long before the clip: the controller just stays where it was left (0 after its last move)
    o.offset = -100.0;
    let k = keys(&f, &o, fps(), 5.0, 4.0).unwrap();
    assert!(k.len() == 1 && k[0].v.abs() < 1e-3, "{k:?}");
    // the song has not started yet when the clip ends: nothing to follow
    o.offset = 100.0;
    let err = keys(&f, &o, fps(), 5.0, 4.0).unwrap_err().to_string();
    assert!(err.contains("nothing under this clip"), "{err}");
}

#[test]
fn bad_inputs_are_clear_errors() {
    let f = parse(&smf(vec![vec![on(0, 0, 60, 100), off(beat(1), 0, 60)]])).unwrap();
    assert!(Source::parse("cc:128").is_err() && Source::parse("loudness").is_err());
    assert_eq!(Source::parse("cc:7").unwrap(), Source::Controller(7));
    let err = keys(&f, &opts(Source::Controller(1)), fps(), 0.0, 2.0).unwrap_err().to_string();
    assert!(err.contains("no controller 1"), "{err}");
    let mut o = opts(Source::Gate);
    o.channel = Some(17);
    assert!(keys(&f, &o, fps(), 0.0, 2.0).unwrap_err().to_string().contains("1 to 16"));
    o.channel = None;
    o.decay = -1.0;
    assert!(keys(&f, &o, fps(), 0.0, 2.0).is_err());
}

#[test]
fn a_dense_controller_sweep_is_thinned_to_fit_and_too_many_notes_are_refused() {
    // a controller message every 10 ms for 20 s (2000 messages), a smooth curve
    let sweep: Vec<Ev> = (0..2000u32).map(|i| cc(i * 5, 0, 1, (63.5 + 63.0 * ((i as f64) / 150.0).sin()) as u8)).collect();
    let f = parse(&smf(vec![sweep])).unwrap();
    let k = keys(&f, &opts(Source::Controller(1)), fps(), 0.0, 19.0).unwrap();
    assert!(k.len() <= 200 && k.len() > 20, "{}", k.len());
    // 400 short notes need 800 pulse keys
    let notes: Vec<Ev> = (0..400u32).flat_map(|i| [on(i * 20, 0, 60, 100), off(i * 20 + 10, 0, 60)]).collect();
    let f = parse(&smf(vec![notes])).unwrap();
    let err = keys(&f, &opts(Source::Velocity), fps(), 0.0, 60.0).unwrap_err().to_string();
    assert!(err.contains("too many"), "{err}");
}

fn engine_with_clip() -> (Engine, String) {
    let mut eng = Engine::new("m", ProjectSettings { width: 320, height: 240, fps: Rational::from_int(25), sample_rate: 48000 }, Tools::discover(None, None));
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::AddSolid { track: v, start: Rational::from_int(0), duration: Rational::from_int(4), color: "#336699".into() }).unwrap();
    let id = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    (eng, id)
}

fn midi_command(clip: &str, path: &str) -> Command {
    Command::AnimateFromMidi { clip: clip.into(), param: "opacity".into(), path: path.into(), source: "cc:1".into(), channel: None, track: None, low: 0.1, high: 0.9, decay: 0.0, offset: 0.0 }
}

#[test]
fn the_command_keys_a_parameter_from_the_file_and_undo_takes_it_back() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("song.mid");
    std::fs::write(&path, smf(vec![vec![cc(0, 0, 1, 0), cc(beat(4), 0, 1, 127)]])).unwrap();
    let (mut eng, clip) = engine_with_clip();
    let before = serde_json::to_string(&eng.project).unwrap();
    eng.dispatch(midi_command(&clip, path.to_str().unwrap())).unwrap();
    let keys = eng.project.active().unwrap().find_clip(&clip).unwrap().1.keyframes["opacity"].clone();
    assert!((eval(&keys, 1.0).unwrap() - 0.5).abs() < 0.01, "0.1 to 0.9 over 2 s, halfway at 1 s: {}", eval(&keys, 1.0).unwrap());
    assert_eq!(eng.undo_label(), Some("Follow MIDI with opacity"));
    eng.undo().unwrap();
    assert_eq!(serde_json::to_string(&eng.project).unwrap(), before);

    // the value must be one the parameter allows, and the file must exist
    let mut bad = midi_command(&clip, path.to_str().unwrap());
    if let Command::AnimateFromMidi { high, .. } = &mut bad {
        *high = 5.0;
    }
    assert!(eng.dispatch(bad).is_err());
    assert!(eng.dispatch(midi_command(&clip, "/definitely/not/here.mid")).is_err());
    assert_eq!(serde_json::to_string(&eng.project).unwrap(), before);
}

#[test]
fn scripts_cannot_read_midi_files_from_disk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("song.mid");
    std::fs::write(&path, smf(vec![vec![cc(0, 0, 1, 0), cc(beat(4), 0, 1, 127)]])).unwrap();
    let (mut eng, clip) = engine_with_clip();
    let src = format!(r#"command(#{{ type: "animate_from_midi", clip: "{clip}", param: "opacity", path: "{}", source: "cc:1", low: 0.1, high: 0.9 }});"#, path.display());
    let err = ffworks_core::script::run(&mut eng, &src, None, ffworks_core::script::Permissions::EDIT, "s").unwrap_err().to_string();
    assert!(err.contains("cannot read files from disk"), "{err}");
}
