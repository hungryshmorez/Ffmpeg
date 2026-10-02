//! Random effect / transition stacking against real projects and a real FFmpeg render.
use ffworks_core::commands::{Command, Edge};
use ffworks_core::random;
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile, ExportSettings, RenderOptions};
use ffworks_core::ffprobe::probe;
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::{ProjectSettings, TrackKind};
use ffworks_core::{render_graph, Rational};
use std::path::{Path, PathBuf};
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}
fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

fn ffmpeg(args: &[&str]) {
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-y"]).args(args).output().expect("ffmpeg runs");
    assert!(out.status.success(), "fixture generation failed: {}", String::from_utf8_lossy(&out.stderr));
}

/// 320x240, 25 fps, left half `left` | right half `right`, with a sine tone.
fn halves(dir: &Path, name: &str, left: &str, right: &str, secs_: u32) -> PathBuf {
    let p = dir.join(name);
    ffmpeg(&[
        "-f", "lavfi", "-i", &format!("color=c={left}:s=160x240:r=25:d={secs_}"),
        "-f", "lavfi", "-i", &format!("color=c={right}:s=160x240:r=25:d={secs_}"),
        "-f", "lavfi", "-i", &format!("sine=f=440:r=44100:d={secs_}"),
        "-filter_complex", "[0:v][1:v]hstack[v]", "-map", "[v]", "-map", "2:a",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "5", "-c:a", "aac", "-shortest", p.to_str().unwrap(),
    ]);
    p
}


fn export(eng: &Engine, out: &Path) {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let g = render_graph::build(&eng.project).unwrap();
    let mut job = compile(&g, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap_or_else(|e| panic!("compile: {e}"));
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "t", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export failed: {e}"));
}

/// Project 320x240@25 with one clip of `src` on V1 at 0. Returns (engine, video clip id, V1 track id).
fn one_clip(src: &Path) -> (Engine, String, String) {
    let mut eng = Engine::new("fx", ProjectSettings { width: 320, height: 240, fps: secs(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v.clone(), start: secs(0), source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
    let id = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    (eng, id, v)
}



fn stack(eng: &mut Engine, cmds: Vec<Command>) {
    eng.dispatch(Command::Batch { label: "Random effects".into(), commands: cmds }).unwrap_or_else(|e| panic!("batch: {e}"));
}
fn effects_of(eng: &Engine, clip: &str) -> Vec<String> {
    eng.project.active().unwrap().find_clip(clip).unwrap().1.effects.iter().map(|e| e.effect.clone()).collect()
}

#[test]
fn same_seed_gives_the_same_stack_and_a_batch_is_one_undo_step() {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "h.mp4", "red", "blue", 2);
    let (mut eng, id, _) = one_clip(&src);
    let clip = eng.project.active().unwrap().find_clip(&id).unwrap().1.clone();
    let a = random::effect_stack(&clip, 3, 42, None).unwrap();
    let b = random::effect_stack(&clip, 3, 42, None).unwrap();
    assert_eq!(serde_json::to_string(&a).unwrap(), serde_json::to_string(&b).unwrap(), "same seed, same picks and values");
    let c = random::effect_stack(&clip, 3, 43, None).unwrap();
    assert_ne!(serde_json::to_string(&a).unwrap(), serde_json::to_string(&c).unwrap(), "another seed differs");

    let before = eng.undo_label().map(str::to_string);
    stack(&mut eng, a);
    let fx = effects_of(&eng, &id);
    assert_eq!(fx.len(), 3);
    let mut uniq = fx.clone();
    uniq.sort();
    uniq.dedup();
    assert_eq!(uniq.len(), 3, "three different effects: {fx:?}");
    eng.undo().unwrap();
    assert!(effects_of(&eng, &id).is_empty(), "all three go with one undo");
    assert_eq!(eng.undo_label().map(str::to_string), before);
}

#[test]
fn pool_restricts_the_choice_and_unusable_pools_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "h.mp4", "red", "blue", 2);
    let (eng, id, _) = one_clip(&src);
    let clip = eng.project.active().unwrap().find_clip(&id).unwrap().1.clone();
    let pool = vec!["blur".to_string(), "hue".to_string()];
    for seed in 0..10 {
        for cmd in random::effect_stack(&clip, 4, seed, Some(&pool)).unwrap() {
            let Command::AddEffect { effect, .. } = cmd else { panic!() };
            assert!(pool.contains(&effect), "{effect}");
        }
    }
    let audio_only = vec!["compressor".to_string()];
    assert!(random::effect_stack(&clip, 2, 1, Some(&audio_only)).is_err(), "an audio effect cannot go on a video clip");
    assert!(random::effect_stack(&clip, 0, 1, None).is_err() && random::effect_stack(&clip, 21, 1, None).is_err());
    // audio clips get audio effects
    let audio = eng.project.active().unwrap().tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap().clips[0].clone();
    for cmd in random::effect_stack(&audio, 3, 5, None).unwrap() {
        let Command::AddEffect { effect, .. } = cmd else { panic!() };
        assert!(ffworks_core::effects::find(&effect).unwrap().kind == "audio", "{effect}");
    }
}

#[test]
fn a_random_stack_actually_renders() {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "h.mp4", "red", "blue", 2);
    let (mut eng, id, _) = one_clip(&src);
    let clip = eng.project.active().unwrap().find_clip(&id).unwrap().1.clone();
    // several seeds so more than one combination is exercised through real FFmpeg
    for seed in [1u64, 2, 3, 4, 5] {
        let cmds = random::effect_stack(&clip, 3, seed, None).unwrap();
        stack(&mut eng, cmds);
        let out = dir.path().join(format!("o{seed}.mp4"));
        export(&eng, &out);
        assert!(probe(&tools(), &out).unwrap().duration.as_f64() > 1.5, "seed {seed} produced a short file");
        eng.undo().unwrap();
    }
}

/// Three 2 s clips of a 6 s source touching on V1; the middle one has handles on both sides, the last has none after it.
fn three_clips(dir: &Path) -> (Engine, Vec<String>) {
    let src = halves(dir, "h.mp4", "red", "blue", 8);
    let (mut eng, a, v) = one_clip(&src);
    eng.dispatch(Command::TrimClip { clip: a.clone(), edge: Edge::End, to: secs(2) }).unwrap();
    let m = eng.project.media[0].id.clone();
    for (start, from) in [(2, 3), (4, 3)] {
        eng.dispatch(Command::PlaceClip { media: m.clone(), track: v.clone(), start: secs(start), source_in: Some(secs(from)), duration: Some(secs(2)), with_audio: false, audio_track: None }).unwrap();
    }
    let ids = eng.project.active().unwrap().tracks[0].clips.iter().map(|c| c.id.clone()).collect();
    (eng, ids)
}

#[test]
fn transition_stack_covers_consecutive_cuts_one_undo_step_and_is_seeded() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, ids) = three_clips(dir.path());
    let kinds: Vec<String> = ["fade", "wipeleft", "slideup", "circleopen"].iter().map(|s| s.to_string()).collect();
    let plan = random::transition_stack(&eng.project, &ids[0], 2, 7, &kinds, Rational::new(1, 2)).unwrap();
    assert_eq!(plan.commands.len(), 2, "skipped: {:?}", plan.skipped);
    let again = random::transition_stack(&eng.project, &ids[0], 2, 7, &kinds, Rational::new(1, 2)).unwrap();
    assert_eq!(serde_json::to_string(&plan.commands).unwrap(), serde_json::to_string(&again.commands).unwrap());
    eng.dispatch(Command::Batch { label: "Random transitions".into(), commands: plan.commands }).unwrap();
    assert_eq!(eng.project.active().unwrap().tracks[0].transitions.len(), 2);
    let used: Vec<String> = eng.project.active().unwrap().tracks[0].transitions.iter().map(|t| t.kind.clone()).collect();
    assert!(used.iter().all(|k| kinds.contains(k)), "{used:?}");
    eng.undo().unwrap();
    assert!(eng.project.active().unwrap().tracks[0].transitions.is_empty(), "one undo removes both");
}

#[test]
fn transition_stack_skips_cuts_that_cannot_take_one_and_says_why() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, ids) = three_clips(dir.path());
    // a retimed last clip cannot take a transition, so of the two cuts only the first works
    eng.dispatch(Command::SetClipSpeed { clip: ids[2].clone(), speed: Rational::from_int(2) }).unwrap();
    let kinds = vec!["fade".to_string()];
    let plan = random::transition_stack(&eng.project, &ids[0], 3, 1, &kinds, Rational::new(1, 2)).unwrap();
    assert_eq!(plan.commands.len(), 1, "{:?}", plan.skipped);
    assert_eq!(plan.skipped.len(), 1);
    assert!(plan.skipped[0].starts_with("cut before") && plan.skipped[0].contains("speed"), "{:?}", plan.skipped);
    eng.dispatch(Command::Batch { label: "t".into(), commands: plan.commands }).unwrap();
    assert!(random::transition_stack(&eng.project, &ids[0], 1, 1, &[], Rational::new(1, 2)).is_err());
    // a clip with no clip after it has nothing to do
    let last = random::transition_stack(&eng.project, &ids[2], 1, 1, &kinds, Rational::new(1, 2)).unwrap();
    assert!(last.commands.is_empty() && last.skipped.is_empty());
}
