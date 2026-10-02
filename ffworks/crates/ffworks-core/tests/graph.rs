//! User filter graphs (node editor) rendered by real FFmpeg and checked by sampling output pixels.
use ffworks_core::commands::{Command, Edge};
use ffworks_core::filtergraph::{FilterGraph, GEdge, GNode};
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

fn rgb_at(video: &Path, t: f64, x: u32, y: u32) -> (i32, i32, i32) {
    let out = Proc::new(tools().ffmpeg)
        .args(["-v", "error", "-ss", &format!("{t}"), "-i"])
        .arg(video)
        .args(["-frames:v", "1", "-vf", &format!("crop=2:2:{x}:{y},scale=1:1"), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .output()
        .unwrap();
    assert_eq!(out.stdout.len(), 3, "no frame at t={t}");
    (out.stdout[0] as i32, out.stdout[1] as i32, out.stdout[2] as i32)
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


fn near(p: (i32, i32, i32), want: (i32, i32, i32)) -> bool {
    (p.0 - want.0).abs() < 30 && (p.1 - want.1).abs() < 30 && (p.2 - want.2).abs() < 30
}
const RED: (i32, i32, i32) = (255, 0, 0);
const BLUE: (i32, i32, i32) = (0, 0, 255);
const GRAY: (i32, i32, i32) = (127, 127, 127);

fn node(id: &str, filter: &str, opts: &[(&str, &str)]) -> GNode {
    GNode { id: id.into(), filter: filter.into(), options: opts.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), x: 0.0, y: 0.0 }
}
fn edge(from: &str, fp: usize, to: &str, tp: usize) -> GEdge {
    GEdge { from: from.into(), from_pad: fp, to: to.into(), to_pad: tp }
}
fn graph(extra: Vec<GNode>, edges: Vec<GEdge>) -> FilterGraph {
    let mut g = FilterGraph::passthrough();
    g.nodes.extend(extra);
    g.edges = edges;
    g
}
/// Adds a graph effect to the clip and sets its graph.
fn apply(eng: &mut Engine, clip: &str, g: FilterGraph) -> String {
    eng.dispatch(Command::AddEffect { clip: clip.into(), effect: "graph".into(), params: Default::default(), index: None }).unwrap();
    let fx = eng.project.active().unwrap().find_clip(clip).unwrap().1.effects.last().unwrap().id.clone();
    eng.dispatch(Command::SetEffectGraph { clip: clip.into(), effect_id: fx.clone(), graph: g }).unwrap_or_else(|e| panic!("set graph: {e}"));
    fx
}

#[test]
fn split_negate_blend_graph_renders_the_blend() {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "h.mp4", "red", "blue", 2);
    let (mut eng, id, _) = one_clip(&src);
    let base = dir.path().join("base.mp4");
    export(&eng, &base);
    assert!(near(rgb_at(&base, 1.0, 40, 120), RED) && near(rgb_at(&base, 1.0, 280, 120), BLUE));
    // original and its negative averaged: both halves go mid-grey
    let g = graph(
        vec![node("sp", "split", &[]), node("ng", "negate", &[]), node("bl", "blend", &[("all_expr", "A*0.5+B*0.5")])],
        vec![edge("in", 0, "sp", 0), edge("sp", 0, "bl", 0), edge("sp", 1, "ng", 0), edge("ng", 0, "bl", 1), edge("bl", 0, "out", 0)],
    );
    apply(&mut eng, &id, g);
    let out = dir.path().join("o.mp4");
    export(&eng, &out);
    let (l, r) = (rgb_at(&out, 1.0, 40, 120), rgb_at(&out, 1.0, 280, 120));
    assert!(near(l, GRAY) && near(r, GRAY), "expected mid grey both sides, got {l:?} {r:?}");
    let info = probe(&tools(), &out).unwrap();
    assert_eq!((info.video[0].width, info.video[0].height), (320, 240));
}

#[test]
fn source_node_inside_the_graph_composites_a_generated_picture() {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "h.mp4", "red", "blue", 2);
    let (mut eng, id, _) = one_clip(&src);
    // a 80x60 green patch overlaid at the top-left corner of the clip
    let g = graph(
        vec![node("patch", "color", &[("c", "green"), ("s", "80x60"), ("r", "25")]), node("ov", "overlay", &[("x", "0"), ("y", "0"), ("shortest", "1")])],
        vec![edge("in", 0, "ov", 0), edge("patch", 0, "ov", 1), edge("ov", 0, "out", 0)],
    );
    apply(&mut eng, &id, g);
    let out = dir.path().join("o.mp4");
    export(&eng, &out);
    assert!(near(rgb_at(&out, 1.0, 20, 20), (0, 128, 0)), "patch at top-left, got {:?}", rgb_at(&out, 1.0, 20, 20));
    assert!(near(rgb_at(&out, 1.0, 40, 200), RED) && near(rgb_at(&out, 1.0, 280, 120), BLUE), "rest of the picture unchanged");
    let d = probe(&tools(), &out).unwrap().duration.as_f64();
    assert!((d - 2.0).abs() < 0.1, "graph must not change the clip length, got {d}");
}

#[test]
fn graph_that_changes_size_is_refitted_to_the_project_frame() {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "h.mp4", "red", "blue", 2);
    let (mut eng, id, _) = one_clip(&src);
    apply(&mut eng, &id, graph(vec![node("sc", "scale", &[("w", "160"), ("h", "120")])], vec![edge("in", 0, "sc", 0), edge("sc", 0, "out", 0)]));
    let out = dir.path().join("o.mp4");
    export(&eng, &out);
    let info = probe(&tools(), &out).unwrap();
    assert_eq!((info.video[0].width, info.video[0].height), (320, 240));
    assert!(near(rgb_at(&out, 1.0, 40, 120), RED) && near(rgb_at(&out, 1.0, 280, 120), BLUE));
}

#[test]
fn graph_edit_is_undoable_and_survives_save_and_load() {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "h.mp4", "red", "blue", 2);
    let (mut eng, id, _) = one_clip(&src);
    let g = graph(vec![node("ng", "negate", &[])], vec![edge("in", 0, "ng", 0), edge("ng", 0, "out", 0)]);
    let fx = apply(&mut eng, &id, g.clone());
    let graph_of = |e: &Engine| e.project.active().unwrap().find_clip(&id).unwrap().1.effects.iter().find(|x| x.id == fx).unwrap().graph.clone();
    assert_eq!(graph_of(&eng), Some(g.clone()));

    let p = dir.path().join("p.ffworks");
    eng.save(&p).unwrap();
    let loaded = Engine::load(&p, tools()).unwrap();
    assert_eq!(graph_of(&loaded), Some(g.clone()), "graph persists in the project file");

    eng.undo().unwrap();
    assert_eq!(graph_of(&eng), Some(FilterGraph::passthrough()), "undo restores the previous graph");
    eng.redo().unwrap();
    assert_eq!(graph_of(&eng), Some(g));
}

#[test]
fn unsafe_or_broken_graphs_are_refused_by_the_command() {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "h.mp4", "red", "blue", 1);
    let (mut eng, id, _) = one_clip(&src);
    eng.dispatch(Command::AddEffect { clip: id.clone(), effect: "graph".into(), params: Default::default(), index: None }).unwrap();
    let fx = eng.project.active().unwrap().find_clip(&id).unwrap().1.effects[0].id.clone();
    let try_set = |eng: &mut Engine, g: FilterGraph| eng.dispatch(Command::SetEffectGraph { clip: id.clone(), effect_id: fx.clone(), graph: g });
    let movie = graph(vec![node("m", "movie", &[("filename", "/etc/passwd")])], vec![edge("m", 0, "out", 0)]);
    assert!(try_set(&mut eng, movie).unwrap_err().to_string().contains("not allowed"));
    let looped = graph(vec![node("a", "negate", &[]), node("b", "negate", &[])], vec![edge("in", 0, "a", 0), edge("a", 0, "b", 0), edge("b", 0, "a", 1), edge("a", 1, "out", 0)]);
    assert!(try_set(&mut eng, looped).is_err());
    assert_eq!(eng.project.active().unwrap().find_clip(&id).unwrap().1.effects[0].graph, Some(FilterGraph::passthrough()), "refused edits leave the graph alone");
    // a normal effect has no graph to set
    eng.dispatch(Command::AddEffect { clip: id.clone(), effect: "blur".into(), params: Default::default(), index: None }).unwrap();
    let blur = eng.project.active().unwrap().find_clip(&id).unwrap().1.effects[1].id.clone();
    assert!(eng.dispatch(Command::SetEffectGraph { clip: id.clone(), effect_id: blur, graph: FilterGraph::passthrough() }).is_err());
}

#[test]
fn graph_effect_is_refused_on_audio_clips_and_blocks_transitions() {
    let dir = tempfile::tempdir().unwrap();
    let src = halves(dir.path(), "h.mp4", "red", "blue", 6);
    let (mut eng, id, v) = one_clip(&src);
    let audio = eng.project.active().unwrap().tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap().clips[0].id.clone();
    assert!(eng.dispatch(Command::AddEffect { clip: audio, effect: "graph".into(), params: Default::default(), index: None }).is_err());

    eng.dispatch(Command::TrimClip { clip: id.clone(), edge: Edge::End, to: secs(2) }).unwrap();
    let m = eng.project.media[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: secs(2), source_in: Some(secs(2)), duration: Some(secs(2)), with_audio: false, audio_track: None }).unwrap();
    let b = eng.project.active().unwrap().tracks[0].clips[1].id.clone();
    let g = graph(vec![node("ng", "negate", &[])], vec![edge("in", 0, "ng", 0), edge("ng", 0, "out", 0)]);
    apply(&mut eng, &id, g);
    let err = eng.dispatch(Command::AddTransition { clip_a: id.clone(), clip_b: b, kind: "fade".into(), duration: Rational::new(1, 2) }).unwrap_err();
    assert!(err.to_string().contains("filter graph"), "{err}");

    // the other order: remove the graph, add the transition, then a graph on that clip is refused and leaves it untouched
    let fx = eng.project.active().unwrap().find_clip(&id).unwrap().1.effects[0].id.clone();
    eng.dispatch(Command::RemoveEffect { clip: id.clone(), effect_id: fx }).unwrap();
    let b = eng.project.active().unwrap().tracks[0].clips[1].id.clone();
    eng.dispatch(Command::AddTransition { clip_a: id.clone(), clip_b: b, kind: "fade".into(), duration: Rational::new(1, 2) }).unwrap();
    let err = eng.dispatch(Command::AddEffect { clip: id.clone(), effect: "graph".into(), params: Default::default(), index: None }).unwrap_err();
    assert!(err.to_string().contains("filter graph"), "{err}");
    assert!(eng.project.active().unwrap().find_clip(&id).unwrap().1.effects.is_empty());
}
