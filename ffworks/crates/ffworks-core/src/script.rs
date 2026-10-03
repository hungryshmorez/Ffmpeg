//! Scripting: small programs (variables, loops, conditions, functions) that edit a project through the same command bus as
//! the UI, written in [Rhai](https://rhai.rs) (MIT OR Apache-2.0). JSON command lists (macros) can only replay; a script can
//! look at the project and decide: "add a blur to every clip longer than 5 s", "a marker every 10 s".
//!
//! **Permissions model.** A script is a sandbox: it can read the project (never files), and issue editing commands. It has
//! no file, network, process or module access (the language has none, `import` is compiled out); the commands that read a
//! file from disk (`import_media`, `relink_media`) are refused even through the generic `command()` function. Commands that run
//! FFmpeg on the project's own media (`animate_from_audio`, `animate_from_beats`) need [`Permissions::analysis`]. With
//! [`Permissions::edit`] off the script runs read-only (a dry run: it can compute and print but every edit is refused).
//! It is also bounded: operation count, call depth, value sizes, wall-clock time and at most [`MAX_COMMANDS`] edits.
//!
//! **Atomic.** Everything a script does is one undo step; if it fails half way, nothing of it is left.

use crate::commands::Command;
use crate::engine::Engine;
use crate::error::{Error, Result};
use crate::time::Rational;
use rhai::{Dynamic, EvalAltResult, Map};
use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;
use std::time::{Duration, Instant};

/// Most editing commands one script run may issue.
pub const MAX_COMMANDS: usize = 2000;
/// Longest a script may run.
pub const MAX_RUNTIME: Duration = Duration::from_secs(20);
/// Largest script accepted (bytes).
pub const MAX_SOURCE: usize = 200_000;
const MAX_OPERATIONS: u64 = 3_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Permissions {
    /// May edit the project. Off = read-only dry run.
    pub edit: bool,
    /// May run commands that analyse the project's own media with FFmpeg (follow audio / beats).
    pub analysis: bool,
}

impl Permissions {
    /// Edit the project, no media analysis.
    pub const EDIT: Permissions = Permissions { edit: true, analysis: false };
    /// Read only: a dry run.
    pub const READ_ONLY: Permissions = Permissions { edit: false, analysis: false };
}

#[derive(Debug, Default)]
pub struct Report {
    /// Lines the script printed.
    pub log: Vec<String>,
    /// Editing commands it issued.
    pub commands: usize,
    /// What they did, in order, as the undo list would name them (at most [`MAX_CHANGES`]).
    pub changes: Vec<String>,
}

/// Example scripts for the editor panel: (title, one line about it, source). Each one is run as a dry run in the tests.
pub const EXAMPLES: &[(&str, &str, &str)] = &[
    ("Tint long clips", "loops, conditions, print and a marker", include_str!("../assets/scripts/tint_long_clips.rhai")),
    ("Markers every five seconds", "a while loop over the timeline's length", include_str!("../assets/scripts/markers_every_five_seconds.rhai")),
    ("Pixel-sort every clip", "add_effect with parameters", include_str!("../assets/scripts/pixel_sort_every_clip.rhai")),
    ("Pulse the opacity", "an LFO baked to keyframes", include_str!("../assets/scripts/pulse_the_opacity.rhai")),
];

/// How many command names a [`Report`] keeps.
pub const MAX_CHANGES: usize = 500;

type Fail = Box<EvalAltResult>;
type Res<T> = std::result::Result<T, Fail>;

struct Ctx {
    eng: Rc<RefCell<Engine>>,
    perms: Permissions,
    count: Cell<usize>,
    changes: RefCell<Vec<String>>,
    selected: String,
}

fn fail(msg: impl Into<String>) -> Fail {
    msg.into().into()
}

fn secs(d: &Dynamic) -> Res<Rational> {
    let v = d.as_float().or_else(|_| d.as_int().map(|i| i as f64)).map_err(|_| fail("a time must be a number of seconds"))?;
    if !v.is_finite() {
        return Err(fail("a time must be a finite number of seconds"));
    }
    Ok(Rational::from_secs_f64(v))
}

fn num(d: &Dynamic) -> Res<f64> {
    d.as_float().or_else(|_| d.as_int().map(|i| i as f64)).map_err(|_| fail("expected a number"))
}

/// Why untrusted code (a script or a plugin) may not issue a command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    ReadOnly,
    ReadsFiles,
    NeedsAnalysis,
}

/// The one place that decides which commands untrusted code may issue: nothing when read-only, nothing that reads a file from
/// disk, and media analysis only with [`Permissions::analysis`].
pub(crate) fn vet(perms: Permissions, cmd: &Command) -> std::result::Result<(), Refusal> {
    if !perms.edit {
        return Err(Refusal::ReadOnly);
    }
    match cmd {
        Command::ImportMedia { .. } | Command::RelinkMedia { .. } | Command::AnimateFromMidi { .. } | Command::SetEffectFile { .. } => Err(Refusal::ReadsFiles),
        Command::AnimateFromAudio { .. } | Command::AnimateFromBeats { .. } if !perms.analysis => Err(Refusal::NeedsAnalysis),
        _ => Ok(()),
    }
}

impl Ctx {
    fn send(&self, cmd: Command) -> Res<()> {
        match vet(self.perms, &cmd) {
            Err(Refusal::ReadOnly) => return Err(fail("this script is running read-only (a dry run): editing is not allowed")),
            Err(Refusal::ReadsFiles) => return Err(fail("scripts cannot read files from disk (import_media / relink_media / animate_from_midi / set_effect_file are not allowed)")),
            Err(Refusal::NeedsAnalysis) => return Err(fail("this command analyses the project's audio with FFmpeg; run the script with analysis allowed")),
            Ok(()) => {}
        }
        let n = self.count.get() + 1;
        if n > MAX_COMMANDS {
            return Err(fail(format!("a script may issue at most {MAX_COMMANDS} editing commands")));
        }
        self.count.set(n);
        let name = cmd.label();
        self.eng.borrow_mut().dispatch(cmd).map_err(|e| fail(e.to_string()))?;
        let mut changes = self.changes.borrow_mut();
        if changes.len() < MAX_CHANGES {
            changes.push(name);
        }
        Ok(())
    }

    fn clip_ids(&self) -> HashSet<String> {
        let e = self.eng.borrow();
        e.project.active().map(|s| s.tracks.iter().flat_map(|t| t.clips.iter().map(|c| c.id.clone())).collect()).unwrap_or_default()
    }

    /// Send a command that creates one clip and return that clip's id.
    fn create_clip(&self, cmd: Command) -> Res<String> {
        let before = self.clip_ids();
        self.send(cmd)?;
        let e = self.eng.borrow();
        let seq = e.project.active().map_err(|e| fail(e.to_string()))?;
        seq.tracks.iter().flat_map(|t| t.clips.iter()).find(|c| !before.contains(&c.id) && c.kind == crate::project::TrackKind::Video).map(|c| c.id.clone()).ok_or_else(|| fail("the clip was not created"))
    }

    fn json(&self, v: serde_json::Value) -> Dynamic {
        rhai::serde::to_dynamic(v).unwrap_or(Dynamic::UNIT)
    }
}

fn rd<T: serde::Serialize>(ctx: &Ctx, v: &T) -> Dynamic {
    ctx.json(serde_json::to_value(v).unwrap_or(serde_json::Value::Null))
}

fn register(rhai: &mut rhai::Engine, ctx: &Rc<Ctx>) {
    // ---- reading the project -----------------------------------------------------------------
    let c = Rc::clone(ctx);
    rhai.register_fn("selected", move || c.selected.clone());
    let c = Rc::clone(ctx);
    rhai.register_fn("project", move || -> Dynamic {
        let e = c.eng.borrow();
        let s = &e.project.settings;
        rd(&c, &serde_json::json!({ "name": e.project.name, "width": s.width, "height": s.height, "fps": s.fps.as_f64(), "duration": e.project.active().map(|q| q.duration().as_f64()).unwrap_or(0.0) }))
    });
    let c = Rc::clone(ctx);
    rhai.register_fn("tracks", move || -> Dynamic {
        let e = c.eng.borrow();
        let v: Vec<serde_json::Value> = e
            .project
            .active()
            .map(|s| s.tracks.iter().map(|t| serde_json::json!({ "id": t.id, "name": t.name, "kind": format!("{:?}", t.kind).to_lowercase(), "muted": t.muted, "locked": t.locked, "clips": t.clips.len() })).collect())
            .unwrap_or_default();
        rd(&c, &v)
    });
    let c = Rc::clone(ctx);
    rhai.register_fn("clips", move || -> Dynamic {
        let e = c.eng.borrow();
        let mut out = vec![];
        if let Ok(seq) = e.project.active() {
            for t in &seq.tracks {
                for k in &t.clips {
                    let effects: Vec<serde_json::Value> = k.effects.iter().map(|f| serde_json::json!({ "id": f.id, "effect": f.effect, "enabled": f.enabled })).collect();
                    out.push(serde_json::json!({
                        "id": k.id, "name": k.name, "track": t.id, "kind": format!("{:?}", t.kind).to_lowercase(), "media": k.media,
                        "start": k.start.as_f64(), "duration": k.duration.as_f64(), "end": k.end().as_f64(), "source_in": k.source_in.as_f64(),
                        "opacity": k.opacity, "gain_db": k.gain_db, "speed": k.speed.as_f64(), "effects": effects,
                        "title": k.title.is_some(), "adjustment": k.adjustment,
                    }));
                }
            }
        }
        rd(&c, &out)
    });
    let c = Rc::clone(ctx);
    rhai.register_fn("media", move || -> Dynamic {
        let e = c.eng.borrow();
        let v: Vec<serde_json::Value> = e
            .project
            .media
            .iter()
            .map(|m| serde_json::json!({ "id": m.id, "name": m.name, "duration": m.info.duration.as_f64(), "has_video": m.info.has_video(), "has_audio": m.info.has_audio(), "generated": m.generator.is_some() }))
            .collect();
        rd(&c, &v)
    });

    // ---- editing ------------------------------------------------------------------------------
    let c = Rc::clone(ctx);
    rhai.register_fn("command", move |m: Map| -> Res<()> {
        let v: serde_json::Value = rhai::serde::from_dynamic(&Dynamic::from_map(m)).map_err(|e| fail(format!("command(): {e}")))?;
        let cmd: Command = serde_json::from_value(v).map_err(|e| fail(format!("command(): not a valid command: {e}")))?;
        c.send(cmd)
    });
    let c = Rc::clone(ctx);
    rhai.register_fn("add_effect", move |clip: &str, effect: &str| -> Res<()> { c.send(Command::AddEffect { clip: clip.into(), effect: effect.into(), params: Default::default(), index: None }) });
    let c = Rc::clone(ctx);
    rhai.register_fn("add_effect", move |clip: &str, effect: &str, params: Map| -> Res<()> {
        let mut p = std::collections::BTreeMap::new();
        for (k, v) in params {
            p.insert(k.to_string(), num(&v)?);
        }
        c.send(Command::AddEffect { clip: clip.into(), effect: effect.into(), params: p, index: None })
    });
    let c = Rc::clone(ctx);
    rhai.register_fn("set_param", move |clip: &str, effect_id: &str, param: &str, value: Dynamic| -> Res<()> {
        c.send(Command::SetEffectParam { clip: clip.into(), effect_id: effect_id.into(), param: param.into(), value: num(&value)? })
    });
    let c = Rc::clone(ctx);
    rhai.register_fn("remove_effect", move |clip: &str, effect_id: &str| -> Res<()> { c.send(Command::RemoveEffect { clip: clip.into(), effect_id: effect_id.into() }) });
    let c = Rc::clone(ctx);
    rhai.register_fn("set_opacity", move |clip: &str, v: Dynamic| -> Res<()> { c.send(Command::SetClipOpacity { clip: clip.into(), opacity: num(&v)? }) });
    let c = Rc::clone(ctx);
    rhai.register_fn("set_gain", move |clip: &str, db: Dynamic| -> Res<()> { c.send(Command::SetClipGain { clip: clip.into(), gain_db: num(&db)?, relative: false }) });
    let c = Rc::clone(ctx);
    rhai.register_fn("set_speed", move |clip: &str, v: Dynamic| -> Res<()> { c.send(Command::SetClipSpeed { clip: clip.into(), speed: secs(&v)? }) });
    let c = Rc::clone(ctx);
    rhai.register_fn("add_marker", move |at: Dynamic, name: &str| -> Res<()> { c.send(Command::AddMarker { time: secs(&at)?, name: name.into(), color: None, note: None }) });
    let c = Rc::clone(ctx);
    rhai.register_fn("split", move |clip: &str, at: Dynamic| -> Res<()> { c.send(Command::SplitClip { clip: clip.into(), at: secs(&at)? }) });
    let c = Rc::clone(ctx);
    rhai.register_fn("delete", move |clip: &str| -> Res<()> { c.send(Command::DeleteClip { clip: clip.into(), ripple: false }) });
    let c = Rc::clone(ctx);
    rhai.register_fn("delete", move |clip: &str, ripple: bool| -> Res<()> { c.send(Command::DeleteClip { clip: clip.into(), ripple }) });
    let c = Rc::clone(ctx);
    rhai.register_fn("move_clip", move |clip: &str, start: Dynamic| -> Res<()> { c.send(Command::MoveClip { clip: clip.into(), start: secs(&start)?, track: None }) });
    let c = Rc::clone(ctx);
    rhai.register_fn("add_track", move |kind: &str| -> Res<String> {
        let kind = match kind {
            "video" => crate::project::TrackKind::Video,
            "audio" => crate::project::TrackKind::Audio,
            other => return Err(fail(format!("a track is 'video' or 'audio', not '{other}'"))),
        };
        let before: HashSet<String> = c.eng.borrow().project.active().map(|s| s.tracks.iter().map(|t| t.id.clone()).collect()).unwrap_or_default();
        c.send(Command::AddTrack { kind, name: None })?;
        let e = c.eng.borrow();
        let id = e.project.active().ok().and_then(|s| s.tracks.iter().find(|t| !before.contains(&t.id)).map(|t| t.id.clone()));
        id.ok_or_else(|| fail("the track was not created"))
    });
    let c = Rc::clone(ctx);
    rhai.register_fn("place", move |media: &str, track: &str, start: Dynamic| -> Res<String> {
        c.create_clip(Command::PlaceClip { media: media.into(), track: track.into(), start: secs(&start)?, source_in: None, duration: None, with_audio: false, audio_track: None })
    });
    let c = Rc::clone(ctx);
    rhai.register_fn("place", move |media: &str, track: &str, start: Dynamic, source_in: Dynamic, duration: Dynamic| -> Res<String> {
        c.create_clip(Command::PlaceClip { media: media.into(), track: track.into(), start: secs(&start)?, source_in: Some(secs(&source_in)?), duration: Some(secs(&duration)?), with_audio: false, audio_track: None })
    });
    let c = Rc::clone(ctx);
    rhai.register_fn("add_title", move |track: &str, start: Dynamic, duration: Dynamic, text: &str| -> Res<String> {
        c.create_clip(Command::AddTitle { track: track.into(), start: secs(&start)?, duration: secs(&duration)?, text: text.into() })
    });
    let c = Rc::clone(ctx);
    rhai.register_fn("add_solid", move |track: &str, start: Dynamic, duration: Dynamic, color: &str| -> Res<String> {
        c.create_clip(Command::AddSolid { track: track.into(), start: secs(&start)?, duration: secs(&duration)?, color: color.into() })
    });
    let c = Rc::clone(ctx);
    rhai.register_fn("add_adjustment", move |track: &str, start: Dynamic, duration: Dynamic| -> Res<String> {
        c.create_clip(Command::AddAdjustment { track: track.into(), start: secs(&start)?, duration: secs(&duration)? })
    });
    let c = Rc::clone(ctx);
    rhai.register_fn("animate_expr", move |clip: &str, param: &str, expr: &str| -> Res<()> {
        c.send(Command::AnimateFromExpression { clip: clip.into(), param: param.into(), expr: expr.into(), source: None, clamp: false })
    });
    let c = Rc::clone(ctx);
    rhai.register_fn("link_param", move |clip: &str, param: &str, source: &str, expr: &str| -> Res<()> {
        c.send(Command::AnimateFromExpression { clip: clip.into(), param: param.into(), expr: expr.into(), source: Some(source.into()), clamp: true })
    });
    let c = Rc::clone(ctx);
    rhai.register_fn("animate_lfo", move |clip: &str, param: &str, shape: &str, rate: Dynamic, low: Dynamic, high: Dynamic| -> Res<()> {
        c.send(Command::AnimateFromLfo { clip: clip.into(), param: param.into(), shape: shape.into(), rate: num(&rate)?, low: num(&low)?, high: num(&high)?, phase: 0.0, seed: 1 })
    });
}

fn describe(e: &EvalAltResult) -> String {
    e.to_string()
}

/// Run `source` against `eng` as one undo step (named after `label`). `selected` is what `selected()` returns (a clip id the user
/// picked, or none). On any error nothing the script did is kept.
pub fn run(eng: &mut Engine, source: &str, selected: Option<&str>, perms: Permissions, label: &str) -> Result<Report> {
    run_with(eng, source, selected, perms, label, true)
}

/// [`run`] that can keep nothing: with `keep` false the script runs for real (so its errors, log and the commands it would
/// issue are exact) and every change is then taken back, leaving the project and its undo history as they were.
pub fn run_with(eng: &mut Engine, source: &str, selected: Option<&str>, perms: Permissions, label: &str, keep: bool) -> Result<Report> {
    if source.len() > MAX_SOURCE {
        return Err(Error::validation(format!("the script is too long ({} bytes; the limit is {MAX_SOURCE})", source.len())));
    }
    // the script's functions need the engine behind a shared handle; it is put back whatever happens
    let stand_in = Engine::new("script stand-in", Default::default(), eng.tools.clone());
    let shared = Rc::new(RefCell::new(std::mem::replace(eng, stand_in)));
    let ctx = Rc::new(Ctx { eng: Rc::clone(&shared), perms, count: Cell::new(0), changes: RefCell::default(), selected: selected.unwrap_or("").to_string() });
    let log: Rc<RefCell<Vec<String>>> = Rc::default();

    let outcome = (|| -> Result<()> {
        let mut rhai = rhai::Engine::new();
        rhai.set_max_operations(MAX_OPERATIONS);
        rhai.set_max_call_levels(32);
        rhai.set_max_expr_depths(64, 32);
        rhai.set_max_string_size(100_000);
        rhai.set_max_array_size(20_000);
        rhai.set_max_map_size(5_000);
        let started = Instant::now();
        rhai.on_progress(move |_| (started.elapsed() > MAX_RUNTIME).then(|| Dynamic::from("the script ran for too long")));
        let sink = Rc::clone(&log);
        rhai.on_print(move |s| {
            let mut l = sink.borrow_mut();
            if l.len() < 1000 {
                l.push(s.to_string());
            }
        });
        let sink = Rc::clone(&log);
        rhai.on_debug(move |s, _, _| {
            let mut l = sink.borrow_mut();
            if l.len() < 1000 {
                l.push(format!("debug: {s}"));
            }
        });
        register(&mut rhai, &ctx);
        let ast = rhai.compile(source).map_err(|e| Error::validation(format!("script: {e}")))?;
        let group = shared.borrow_mut().begin_group();
        match rhai.run_ast(&ast) {
            Ok(()) if keep => {
                shared.borrow_mut().end_group(group, label);
                Ok(())
            }
            Ok(()) => {
                shared.borrow_mut().abort_group(group);
                Ok(())
            }
            Err(e) => {
                shared.borrow_mut().abort_group(group);
                Err(Error::validation(format!("script: {}", describe(&e))))
            }
        }
    })();

    let commands = ctx.count.get();
    let changes = ctx.changes.take();
    drop(ctx);
    *eng = Rc::try_unwrap(shared).map_err(|_| Error::validation("internal: the script kept a hold on the project"))?.into_inner();
    outcome?;
    let log = Rc::try_unwrap(log).map(RefCell::into_inner).unwrap_or_default();
    Ok(Report { log, commands, changes })
}
