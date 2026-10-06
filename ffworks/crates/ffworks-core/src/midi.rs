//! MIDI files as a source for parameters: a Standard MIDI File (parsed with [`midly`], Unlicense) becomes keyframes, so a clip's
//! opacity, scale, an effect's strength… can follow a controller, the notes (gate or velocity pulses), the pitch or the
//! pitch wheel of a track. The timing comes from the file's own tempo map. Files only: live MIDI devices are not supported.

use crate::error::{Error, Result};
use crate::keyframes::{Interp, Keyframe};
use crate::reactive::{thin, MAX_KEYS};
use crate::time::{Fps, Rational};
use midly::{MetaMessage, MidiMessage, Smf, Timing, TrackEventKind};

/// Largest `.mid` file read.
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    NoteOn { key: u8, velocity: u8 },
    NoteOff { key: u8 },
    Controller { number: u8, value: u8 },
    /// -1.0 (all the way down) to 1.0.
    Bend(f64),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Event {
    /// Seconds from the start of the file.
    pub t: f64,
    pub track: usize,
    /// 0-based MIDI channel (shown to users as 1-16).
    pub channel: u8,
    pub kind: Kind,
}

#[derive(Clone, Debug)]
pub struct MidiFile {
    /// Every note, controller and pitch-wheel event of every track, in time order.
    pub events: Vec<Event>,
    pub tracks: usize,
    /// Time of the last event, seconds.
    pub length: f64,
}

/// What of the file drives the parameter.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Source {
    /// A controller (mod wheel 1, volume 7, expression 11…), 0..127.
    Controller(u8),
    /// Each note starts a pulse as high as its velocity, falling back over the decay time.
    Velocity,
    /// High while any note is held, low otherwise.
    Gate,
    /// The key of the latest note, 0..127.
    Pitch,
    /// The pitch wheel, -1..1 mapped to 0..1.
    Bend,
}

impl Source {
    /// `cc:7`, `velocity`, `gate`, `pitch`, `bend`.
    pub fn parse(s: &str) -> Result<Source> {
        match s {
            "velocity" => Ok(Source::Velocity),
            "gate" => Ok(Source::Gate),
            "pitch" => Ok(Source::Pitch),
            "bend" => Ok(Source::Bend),
            other => match other.strip_prefix("cc:").and_then(|n| n.parse::<u8>().ok()).filter(|n| *n < 128) {
                Some(n) => Ok(Source::Controller(n)),
                None => Err(Error::validation(format!("unknown MIDI source '{s}' (cc:0 to cc:127, velocity, gate, pitch or bend)"))),
            },
        }
    }
}

/// Parse a Standard MIDI File.
pub fn parse(bytes: &[u8]) -> Result<MidiFile> {
    let smf = Smf::parse(bytes).map_err(|e| Error::validation(format!("not a readable MIDI file: {e}")))?;
    // tempo changes can sit on any track: gather them all, then convert every event's tick to seconds
    let mut tempos: Vec<(u64, u32)> = vec![];
    for track in &smf.tracks {
        let mut tick = 0u64;
        for ev in track {
            tick += u64::from(ev.delta.as_int());
            if let TrackEventKind::Meta(MetaMessage::Tempo(t)) = ev.kind {
                tempos.push((tick, t.as_int()));
            }
        }
    }
    tempos.sort_by_key(|t| t.0);
    let seconds_at = |tick: u64| -> f64 {
        match smf.header.timing {
            Timing::Timecode(fps, sub) => tick as f64 / (f64::from(fps.as_f32()) * f64::from(sub)),
            Timing::Metrical(tpq) => {
                let tpq = f64::from(tpq.as_int());
                let (mut secs, mut last, mut us) = (0.0, 0u64, 500_000.0);
                for (t, new_us) in &tempos {
                    if *t >= tick {
                        break;
                    }
                    secs += (*t - last) as f64 * us / 1e6 / tpq;
                    last = *t;
                    us = f64::from(*new_us);
                }
                secs + (tick - last) as f64 * us / 1e6 / tpq
            }
        }
    };
    let mut events = vec![];
    for (i, track) in smf.tracks.iter().enumerate() {
        let mut tick = 0u64;
        for ev in track {
            tick += u64::from(ev.delta.as_int());
            let TrackEventKind::Midi { channel, message } = ev.kind else { continue };
            let kind = match message {
                // a note-on with velocity 0 is a note-off
                MidiMessage::NoteOn { key, vel } if vel.as_int() > 0 => Kind::NoteOn { key: key.as_int(), velocity: vel.as_int() },
                MidiMessage::NoteOn { key, .. } | MidiMessage::NoteOff { key, .. } => Kind::NoteOff { key: key.as_int() },
                MidiMessage::Controller { controller, value } => Kind::Controller { number: controller.as_int(), value: value.as_int() },
                MidiMessage::PitchBend { bend } => Kind::Bend(f64::from(bend.as_int()) / 8192.0),
                _ => continue,
            };
            events.push(Event { t: seconds_at(tick), track: i, channel: channel.as_int(), kind });
        }
    }
    events.sort_by(|a, b| a.t.total_cmp(&b.t));
    let length = events.last().map_or(0.0, |e| e.t);
    Ok(MidiFile { events, tracks: smf.tracks.len(), length })
}

/// Which events to listen to and how to map them.
#[derive(Clone, Copy, Debug)]
pub struct Options {
    pub source: Source,
    /// 1-16, or None for every channel.
    pub channel: Option<u8>,
    /// Track index (0-based), or None for every track.
    pub track: Option<usize>,
    pub low: f64,
    pub high: f64,
    /// Seconds a velocity pulse takes to fall back to `low`.
    pub decay: f64,
    /// Seconds the file starts later than the project start.
    pub offset: f64,
}

/// Keyframes for a clip that starts at `clip_start` seconds on the timeline and lasts `clip_dur` seconds. Errors when the file
/// has nothing for the chosen source, or the curve would need more than [`MAX_KEYS`] keys.
pub fn keys(file: &MidiFile, o: &Options, fps: Fps, clip_start: f64, clip_dur: f64) -> Result<Vec<Keyframe>> {
    if !(o.low.is_finite() && o.high.is_finite() && o.decay.is_finite() && o.offset.is_finite()) || o.decay < 0.0 {
        return Err(Error::validation("MIDI mapping needs finite values and a decay of zero or more"));
    }
    if let Some(c) = o.channel {
        if !(1..=16).contains(&c) {
            return Err(Error::validation("a MIDI channel is 1 to 16"));
        }
    }
    let fpsf = fps.as_f64();
    let frame = 1.0 / fpsf;
    let snap = |t: f64| (t * fpsf).round() / fpsf;
    let val = |u: f64| o.low + (o.high - o.low) * u;
    // clip-relative time of an event
    let rel = |e: &Event| e.t + o.offset - clip_start;
    let wanted = |e: &&Event| o.channel.is_none_or(|c| e.channel == c - 1) && o.track.is_none_or(|t| e.track == t);
    let events: Vec<&Event> = file.events.iter().filter(wanted).collect();

    // (time, normalised 0..1 value, interpolation after this point)
    let mut pts: Vec<(f64, f64, Interp)> = vec![];
    match o.source {
        Source::Controller(n) => {
            for e in &events {
                if let Kind::Controller { number, value } = e.kind {
                    if number == n {
                        pts.push((rel(e), f64::from(value) / 127.0, Interp::Linear));
                    }
                }
            }
        }
        Source::Bend => {
            for e in &events {
                if let Kind::Bend(b) = e.kind {
                    pts.push((rel(e), (b + 1.0) / 2.0, Interp::Linear));
                }
            }
        }
        Source::Pitch => {
            for e in &events {
                if let Kind::NoteOn { key, .. } = e.kind {
                    pts.push((rel(e), f64::from(key) / 127.0, Interp::Hold));
                }
            }
        }
        Source::Gate => {
            let mut held = 0i32;
            for e in &events {
                match e.kind {
                    Kind::NoteOn { .. } => held += 1,
                    Kind::NoteOff { .. } => held = (held - 1).max(0),
                    _ => continue,
                }
                pts.push((rel(e), f64::from(u8::from(held > 0)), Interp::Hold));
            }
        }
        Source::Velocity => {
            let ons: Vec<(f64, f64)> = events.iter().filter_map(|e| if let Kind::NoteOn { velocity, .. } = e.kind { Some((rel(e), f64::from(velocity) / 127.0)) } else { None }).collect();
            for (i, (t, v)) in ons.iter().enumerate() {
                let next = ons.get(i + 1).map_or(f64::INFINITY, |n| n.0);
                // like a beat pulse: jump to the velocity, fall over `decay` (or until just before the next note)
                let end = (t + o.decay.max(frame)).min(next - frame);
                if end > *t + 1e-9 {
                    pts.push((*t, *v, Interp::EaseOut));
                    pts.push((end, 0.0, Interp::Hold));
                } else {
                    pts.push((*t, *v, Interp::Hold));
                }
            }
        }
    }
    if pts.is_empty() {
        let what = match o.source {
            Source::Controller(n) => format!("controller {n}"),
            Source::Velocity | Source::Gate | Source::Pitch => "notes".into(),
            Source::Bend => "pitch-wheel moves".into(),
        };
        return Err(Error::validation(format!("the MIDI file has no {what}{}", if o.channel.is_some() || o.track.is_some() { " on that channel/track" } else { "" })));
    }
    // the value at the start of the clip is whatever the latest earlier point said (held), so a clip placed late in a song starts right
    let before: Option<(f64, f64, Interp)> = pts.iter().rev().find(|p| p.0 < 0.0).copied();
    let mut inside: Vec<(f64, f64, Interp)> = pts.into_iter().filter(|p| p.0 >= 0.0 && p.0 <= clip_dur + 1e-9).collect();
    if inside.first().is_none_or(|p| snap(p.0) > 0.0) {
        match before {
            Some((_, v, _)) => inside.insert(0, (0.0, v, Interp::Hold)),
            // before the first event a gate or pulse is off; a controller or pitch holds its first value
            None if matches!(o.source, Source::Gate | Source::Velocity) => inside.insert(0, (0.0, 0.0, Interp::Hold)),
            None => {}
        }
    }
    if inside.is_empty() {
        return Err(Error::validation("the MIDI file has nothing under this clip (check the offset: the file's time 0 is the project start)"));
    }
    // snap to frames; two points on one frame: the later one wins
    let mut snapped: Vec<(f64, f64, Interp)> = vec![];
    for (t, v, i) in inside {
        let t = snap(t);
        if snapped.last().is_some_and(|p| (p.0 - t).abs() < 1e-9) {
            snapped.pop();
        }
        snapped.push((t, v, i));
    }
    let smoothable = matches!(o.source, Source::Controller(_) | Source::Bend);
    let mut out: Vec<(f64, f64, Interp)> = snapped.iter().map(|(t, n, i)| (*t, val(*n), *i)).collect();
    if out.len() > MAX_KEYS && smoothable {
        let xy: Vec<(f64, f64)> = out.iter().map(|p| (p.0, p.1)).collect();
        let tol0 = (o.high - o.low).abs() * 0.01;
        let mut tol = tol0;
        let mut kept = thin(&xy, tol);
        while kept.len() > MAX_KEYS {
            tol += tol0.max(1e-6);
            kept = thin(&xy, tol);
        }
        out = kept.into_iter().map(|(t, v)| (t, v, Interp::Linear)).collect();
    }
    if out.len() > MAX_KEYS {
        return Err(Error::validation(format!("{} key points under this clip is too many for one curve (at most {MAX_KEYS}); split the clip first", out.len())));
    }
    Ok(out.into_iter().map(|(t, v, interp)| Keyframe { t: Rational::new((t * fpsf).round() as i64 * fps.den(), fps.num()), v: (v * 1e4).round() / 1e4, interp }).collect())
}
