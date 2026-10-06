//! Compound clips: nesting, editing inside, taking apart, and rendering them through the normal pipeline.
//! Real FFmpeg renders; pixels and sound are measured.
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile_project, ExportSettings, RenderOptions};
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::{ProjectSettings, TrackKind};
use ffworks_core::Rational;
use std::path::{Path, PathBuf};
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}
fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

fn rgb_at(video: &Path, t: f64) -> (i32, i32, i32) {
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-ss", &t.to_string(), "-i"]).arg(video).args(["-frames:v", "1", "-vf", "crop=2:2:160:120,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap();
    assert_eq!(out.stdout.len(), 3, "no frame at t={t}");
    (out.stdout[0] as i32, out.stdout[1] as i32, out.stdout[2] as i32)
}
fn near(p: (i32, i32, i32), w: (i32, i32, i32)) -> bool {
    (p.0 - w.0).abs() < 60 && (p.1 - w.1).abs() < 60 && (p.2 - w.2).abs() < 60
}
const RED: (i32, i32, i32) = (255, 0, 0);
const GREEN: (i32, i32, i32) = (0, 255, 0);
const BLUE: (i32, i32, i32) = (0, 0, 255);
const CYAN: (i32, i32, i32) = (0, 255, 255);

struct Rig {
    eng: Engine,
    dir: tempfile::TempDir,
    v1: String,
}

fn engine() -> Engine {
    Engine::new("c", ProjectSettings { width: 320, height: 240, fps: secs(25), sample_rate: 48000 }, tools())
}

/// V1 holds a red solid for 0-2 s and a green solid for 2-4 s.
fn rig() -> Rig {
    let mut eng = engine();
    let v1 = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::AddSolid { track: v1.clone(), start: secs(0), duration: secs(2), color: "#ff0000".into() }).unwrap();
    eng.dispatch(Command::AddSolid { track: v1.clone(), start: secs(2), duration: secs(2), color: "#00ff00".into() }).unwrap();
    Rig { eng, dir: tempfile::tempdir().unwrap(), v1 }
}

fn clip_ids(eng: &Engine, track: &str) -> Vec<String> {
    eng.project.active().unwrap().tracks.iter().find(|t| t.id == track).unwrap().clips.iter().map(|c| c.id.clone()).collect()
}

fn nest_all(r: &mut Rig) {
    let ids = clip_ids(&r.eng, &r.v1);
    r.eng.dispatch(Command::NestClips { clips: ids, name: None }).unwrap();
}

fn compound_id(eng: &Engine) -> String {
    eng.project.sequences.iter().find(|s| s.compound).expect("a compound sequence").id.clone()
}

fn main_id(eng: &Engine) -> String {
    eng.project.sequences.iter().find(|s| !s.compound).unwrap().id.clone()
}

fn job(eng: &Engine, out: &Path) -> ffworks_core::ffmpeg::FfmpegJob {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let mut job = compile_project(&eng.project, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap_or_else(|e| panic!("compile: {e}"));
    job.program = t.ffmpeg.clone();
    job
}

fn run(j: &ffworks_core::ffmpeg::FfmpegJob, out: &Path) {
    let t = tools();
    run_job(&t, j, "cmp", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export failed: {e}"));
}

fn export(eng: &Engine, out: &Path) {
    run(&job(eng, out), out);
}

fn duration(video: &Path) -> f64 {
    let out = Proc::new("ffprobe").args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"]).arg(video).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
}

#[test]
fn nesting_folds_the_clips_into_one_and_the_picture_stays_the_same() {
    let mut r = rig();
    let before = r.dir.path().join("before.mp4");
    export(&r.eng, &before);
    assert!(near(rgb_at(&before, 1.0), RED) && near(rgb_at(&before, 3.0), GREEN));

    nest_all(&mut r);
    let seq = r.eng.project.active().unwrap();
    assert_eq!(seq.tracks[0].clips.len(), 1, "one compound clip replaces the two");
    let c = &seq.tracks[0].clips[0];
    assert_eq!((c.start, c.duration), (secs(0), secs(4)));
    let media = r.eng.project.media(&c.media).unwrap();
    assert_eq!(ffworks_core::nest::sequence_of(media), Some(compound_id(&r.eng).as_str()));
    let inner = r.eng.project.sequence(&compound_id(&r.eng)).unwrap();
    assert_eq!(inner.tracks.len(), 1);
    assert_eq!(inner.tracks[0].clips.iter().map(|c| (c.start, c.duration)).collect::<Vec<_>>(), vec![(secs(0), secs(2)), (secs(2), secs(2))]);
    assert_eq!(media.info.duration, secs(4));

    let after = r.dir.path().join("after.mp4");
    export(&r.eng, &after);
    assert!(near(rgb_at(&after, 1.0), RED), "the first half is still red");
    assert!(near(rgb_at(&after, 3.0), GREEN), "the second half is still green");
    assert!((duration(&after) - 4.0).abs() < 0.2, "{}", duration(&after));
}

#[test]
fn undo_takes_the_compound_back_and_redo_makes_it_again() {
    let mut r = rig();
    let before = serde_json::to_string(&r.eng.project).unwrap();
    nest_all(&mut r);
    assert_eq!(r.eng.history().len(), 3, "two solids and one nesting step");
    r.eng.undo().unwrap();
    assert_eq!(serde_json::to_string(&r.eng.project).unwrap(), before, "undo restores the project exactly");
    assert!(r.eng.project.sequences.iter().all(|s| !s.compound));
    r.eng.redo().unwrap();
    assert_eq!(r.eng.project.sequences.iter().filter(|s| s.compound).count(), 1);
    assert_eq!(r.eng.project.active().unwrap().tracks[0].clips.len(), 1);
}

#[test]
fn undoing_the_nesting_while_inside_the_compound_goes_back_to_the_main_timeline() {
    let mut r = rig();
    nest_all(&mut r);
    let inner = compound_id(&r.eng);
    r.eng.set_active_sequence(&inner).unwrap();
    r.eng.undo().unwrap();
    assert_eq!(r.eng.project.active_sequence, main_id(&r.eng), "the compound is gone, so the main timeline is shown");
    assert!(r.eng.project.validate().is_ok());
}

#[test]
fn the_compound_takes_effects_and_trims_like_any_clip() {
    let mut r = rig();
    nest_all(&mut r);
    let id = clip_ids(&r.eng, &r.v1)[0].clone();
    r.eng.dispatch(Command::AddEffect { clip: id.clone(), effect: "negate".into(), params: Default::default(), index: None }).unwrap();
    r.eng.dispatch(Command::TrimClip { clip: id, edge: ffworks_core::commands::Edge::End, to: secs(3) }).unwrap();
    let out = r.dir.path().join("o.mp4");
    export(&r.eng, &out);
    assert!(near(rgb_at(&out, 1.0), CYAN), "red negated is cyan");
    assert!((duration(&out) - 3.0).abs() < 0.2, "trimmed to 3 s: {}", duration(&out));
}

#[test]
fn editing_inside_changes_what_the_compound_shows_and_it_grows_with_its_contents() {
    let mut r = rig();
    nest_all(&mut r);
    let inner = compound_id(&r.eng);
    r.eng.set_active_sequence(&inner).unwrap();
    let it = r.eng.project.active().unwrap().tracks[0].id.clone();
    let green = r.eng.project.active().unwrap().tracks[0].clips[1].id.clone();
    r.eng.dispatch(Command::SetSolidColor { clip: green, color: "#0000ff".into() }).unwrap();
    r.eng.dispatch(Command::AddSolid { track: it, start: secs(4), duration: secs(2), color: "#ffffff".into() }).unwrap();
    let media = r.eng.project.media.iter().find(|m| ffworks_core::nest::sequence_of(m).is_some()).unwrap();
    assert_eq!(media.info.duration, secs(6), "the compound's length followed its contents");
    r.eng.set_active_sequence(&main_id(&r.eng)).unwrap();
    assert_eq!(r.eng.project.active().unwrap().tracks[0].clips[0].duration, secs(4), "the placed clip keeps its length");
    let out = r.dir.path().join("o.mp4");
    export(&r.eng, &out);
    assert!(near(rgb_at(&out, 1.0), RED));
    assert!(near(rgb_at(&out, 3.0), BLUE), "the edit made inside shows outside");
    // undoing the edit inside also gives the length back
    r.eng.undo().unwrap();
    let media = r.eng.project.media.iter().find(|m| ffworks_core::nest::sequence_of(m).is_some()).unwrap();
    assert_eq!(media.info.duration, secs(4));
}

#[test]
fn the_rendered_compound_is_reused_until_something_inside_changes() {
    let mut r = rig();
    nest_all(&mut r);
    let a = job(&r.eng, &r.dir.path().join("a.mp4"));
    assert_eq!(a.nests.len(), 1);
    run(&a, &r.dir.path().join("a.mp4"));
    assert!(a.nests[0].output.exists(), "the compound was rendered to its cache file");
    let b = job(&r.eng, &r.dir.path().join("b.mp4"));
    assert_eq!(a.nests[0].output, b.nests[0].output, "same contents, same file");
    // a render that would need FFmpeg cannot run with a bogus one: the second use must come from the cache
    let mut broken = tools();
    broken.ffmpeg = PathBuf::from("/nonexistent/ffmpeg");
    ffworks_core::nest::run_stage(&broken, &b.nests[0], &CancelToken::new(), &r.dir.path().join("tmp"), &mut |_| {}).expect("served from the cache");
    run(&b, &r.dir.path().join("b.mp4"));

    let inner = compound_id(&r.eng);
    r.eng.set_active_sequence(&inner).unwrap();
    let first = r.eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    r.eng.dispatch(Command::SetSolidColor { clip: first, color: "#123456".into() }).unwrap();
    r.eng.set_active_sequence(&main_id(&r.eng)).unwrap();
    let c = job(&r.eng, &r.dir.path().join("c.mp4"));
    assert_ne!(a.nests[0].output, c.nests[0].output, "a change inside needs a new render");
}

#[test]
fn compounds_nest_inside_compounds() {
    let mut r = rig();
    nest_all(&mut r);
    // nest the compound clip again
    let id = clip_ids(&r.eng, &r.v1)[0].clone();
    r.eng.dispatch(Command::NestClips { clips: vec![id], name: Some("Outer".into()) }).unwrap();
    assert_eq!(r.eng.project.sequences.iter().filter(|s| s.compound).count(), 2);
    let out = r.dir.path().join("o.mp4");
    let j = job(&r.eng, &out);
    assert_eq!(j.nests.len(), 2, "both levels are rendered, the inner one first");
    run(&j, &out);
    assert!(near(rgb_at(&out, 1.0), RED) && near(rgb_at(&out, 3.0), GREEN));
}

#[test]
fn a_compound_cannot_be_placed_inside_itself() {
    let mut r = rig();
    nest_all(&mut r);
    let inner = compound_id(&r.eng);
    let media = r.eng.project.media.iter().find(|m| ffworks_core::nest::sequence_of(m) == Some(inner.as_str())).unwrap().id.clone();
    r.eng.set_active_sequence(&inner).unwrap();
    let it = r.eng.project.active().unwrap().tracks[0].id.clone();
    let before = serde_json::to_string(&r.eng.project).unwrap();
    let e = r.eng.dispatch(Command::PlaceClip { media, track: it, start: secs(10), source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap_err().to_string();
    assert!(e.contains("contain itself"), "{e}");
    assert_eq!(serde_json::to_string(&r.eng.project).unwrap(), before, "nothing was kept");
}

#[test]
fn taking_it_apart_puts_the_clips_on_new_tracks_and_removes_the_compound() {
    let mut r = rig();
    let media_before = r.eng.project.media.len();
    nest_all(&mut r);
    let id = clip_ids(&r.eng, &r.v1)[0].clone();
    r.eng.dispatch(Command::UnnestClip { clip: id }).unwrap();
    let seq = r.eng.project.active().unwrap();
    assert!(seq.tracks[0].clips.is_empty(), "the compound clip is gone");
    let vt: Vec<_> = seq.tracks.iter().filter(|t| t.kind == TrackKind::Video && !t.clips.is_empty()).collect();
    assert_eq!(vt.len(), 1);
    assert_eq!(vt[0].clips.iter().map(|c| (c.start, c.duration)).collect::<Vec<_>>(), vec![(secs(0), secs(2)), (secs(2), secs(2))]);
    assert_eq!(r.eng.project.media.len(), media_before, "the compound's media went with it");
    assert!(r.eng.project.sequences.iter().all(|s| !s.compound));
    let out = r.dir.path().join("o.mp4");
    export(&r.eng, &out);
    assert!(near(rgb_at(&out, 1.0), RED) && near(rgb_at(&out, 3.0), GREEN));
    r.eng.undo().unwrap();
    assert_eq!(r.eng.project.sequences.iter().filter(|s| s.compound).count(), 1, "undo brings the compound back");
}

#[test]
fn taking_apart_a_trimmed_compound_keeps_only_what_showed() {
    let mut r = rig();
    nest_all(&mut r);
    let id = clip_ids(&r.eng, &r.v1)[0].clone();
    r.eng.dispatch(Command::TrimClip { clip: id.clone(), edge: ffworks_core::commands::Edge::Start, to: secs(1) }).unwrap();
    r.eng.dispatch(Command::UnnestClip { clip: id }).unwrap();
    let seq = r.eng.project.active().unwrap();
    let t = seq.tracks.iter().find(|t| t.kind == TrackKind::Video && !t.clips.is_empty()).unwrap();
    assert_eq!(t.clips.iter().map(|c| (c.start, c.duration)).collect::<Vec<_>>(), vec![(secs(1), secs(1)), (secs(2), secs(2))], "the red clip lost its first second");
}

#[test]
fn a_compound_with_settings_of_its_own_cannot_be_taken_apart_losing_them() {
    let mut r = rig();
    nest_all(&mut r);
    let id = clip_ids(&r.eng, &r.v1)[0].clone();
    r.eng.dispatch(Command::AddEffect { clip: id.clone(), effect: "negate".into(), params: Default::default(), index: None }).unwrap();
    let e = r.eng.dispatch(Command::UnnestClip { clip: id }).unwrap_err().to_string();
    assert!(e.contains("effects"), "{e}");
}

#[test]
fn nesting_a_selection_that_would_swallow_a_neighbour_is_refused() {
    let mut eng = engine();
    let v1 = eng.project.active().unwrap().tracks[0].id.clone();
    for (i, c) in ["#ff0000", "#00ff00", "#0000ff"].iter().enumerate() {
        eng.dispatch(Command::AddSolid { track: v1.clone(), start: secs(2 * i as i64), duration: secs(2), color: (*c).into() }).unwrap();
    }
    let ids = clip_ids(&eng, &v1);
    let before = serde_json::to_string(&eng.project).unwrap();
    let e = eng.dispatch(Command::NestClips { clips: vec![ids[0].clone(), ids[2].clone()], name: None }).unwrap_err().to_string();
    assert!(e.contains("overlap"), "{e}");
    assert_eq!(serde_json::to_string(&eng.project).unwrap(), before);
    assert!(eng.dispatch(Command::NestClips { clips: vec![], name: None }).is_err());
}

#[test]
fn fit_shortens_a_compound_only_when_nothing_uses_the_extra_length() {
    let mut r = rig();
    nest_all(&mut r);
    let inner = compound_id(&r.eng);
    let media = r.eng.project.media.iter().find(|m| ffworks_core::nest::sequence_of(m) == Some(inner.as_str())).unwrap().id.clone();
    r.eng.set_active_sequence(&inner).unwrap();
    let green = r.eng.project.active().unwrap().tracks[0].clips[1].id.clone();
    r.eng.dispatch(Command::DeleteClip { clip: green, ripple: false }).unwrap();
    r.eng.set_active_sequence(&main_id(&r.eng)).unwrap();
    let e = r.eng.dispatch(Command::FitCompound { media: media.clone() }).unwrap_err().to_string();
    assert!(e.contains("trim that clip first"), "{e}");
    let id = clip_ids(&r.eng, &r.v1)[0].clone();
    r.eng.dispatch(Command::TrimClip { clip: id, edge: ffworks_core::commands::Edge::End, to: secs(2) }).unwrap();
    r.eng.dispatch(Command::FitCompound { media: media.clone() }).unwrap();
    assert_eq!(r.eng.project.media(&media).unwrap().info.duration, secs(2));
}

#[test]
fn compounds_survive_save_and_load() {
    let mut r = rig();
    nest_all(&mut r);
    let file = r.dir.path().join("p.ffworks");
    r.eng.save(&file).unwrap();
    let loaded = Engine::load(&file, tools()).unwrap();
    assert_eq!(loaded.project.sequences.len(), r.eng.project.sequences.len());
    assert_eq!(loaded.project.sequences.iter().filter(|s| s.compound).count(), 1);
    let out = r.dir.path().join("o.mp4");
    export(&loaded, &out);
    assert!(near(rgb_at(&out, 1.0), RED) && near(rgb_at(&out, 3.0), GREEN));
}

fn sine(dir: &Path) -> PathBuf {
    let p = dir.join("s.wav");
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=4"]).arg(&p).output().unwrap();
    assert!(out.status.success());
    p
}

fn mean_volume(video: &Path) -> f64 {
    let out = Proc::new(tools().ffmpeg).args(["-hide_banner", "-i"]).arg(video).args(["-af", "volumedetect", "-vn", "-f", "null", "-"]).output().unwrap();
    let text = String::from_utf8_lossy(&out.stderr).to_string();
    text.lines().find_map(|l| l.split("mean_volume:").nth(1)).map(|v| v.trim().trim_end_matches(" dB").parse().unwrap()).unwrap_or(-91.0)
}

#[test]
fn sound_goes_into_the_compound_and_comes_out_of_it() {
    let mut r = rig();
    let wav = sine(r.dir.path());
    let m = r.eng.import_media(&wav).unwrap();
    let a1 = r.eng.project.active().unwrap().tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap().id.clone();
    r.eng.dispatch(Command::PlaceClip { media: m, track: a1.clone(), start: secs(0), source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
    let plain = r.dir.path().join("plain.mp4");
    export(&r.eng, &plain);
    assert!(mean_volume(&plain) > -30.0, "the sine is audible before nesting: {}", mean_volume(&plain));

    let mut ids = clip_ids(&r.eng, &r.v1);
    ids.extend(clip_ids(&r.eng, &a1));
    r.eng.dispatch(Command::NestClips { clips: ids, name: Some("With sound".into()) }).unwrap();
    let seq = r.eng.project.active().unwrap();
    let (v, a) = (&seq.tracks[0].clips[0], &seq.tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap().clips[0]);
    assert!(v.link.is_some() && v.link == a.link, "the compound's picture and sound stay linked");
    assert_eq!(v.name, "With sound");
    let out = r.dir.path().join("nested.mp4");
    export(&r.eng, &out);
    assert!(near(rgb_at(&out, 1.0), RED) && near(rgb_at(&out, 3.0), GREEN));
    let (before, after) = (mean_volume(&plain), mean_volume(&out));
    assert!((before - after).abs() < 3.0, "the level is unchanged: {before} vs {after}");
}
