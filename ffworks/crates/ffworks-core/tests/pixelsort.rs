//! Pixel sort end to end: real FFmpeg decodes, the engine sorts the frames, real FFmpeg encodes and renders. Pictures are
//! measured, never just checked for existing.
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile, compile_project, ExportSettings, RenderOptions};
use ffworks_core::jobs::{run_job, CancelToken, JobState};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::ProjectSettings;
use ffworks_core::{render_graph, Error, Rational};
use std::path::{Path, PathBuf};
use std::process::Command as Proc;

const W: usize = 320;
const H: usize = 240;

fn tools() -> Tools {
    Tools::discover(None, None)
}
fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

/// 320x240 @25, `seconds` long, luma given by a `geq` expression of X and Y (chroma neutral), stored losslessly.
fn pattern(dir: &Path, name: &str, luma: &str, seconds: u32) -> PathBuf {
    let p = dir.join(name);
    let out = Proc::new(tools().ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
        .arg(format!("nullsrc=s={W}x{H}:r=25:d={seconds},format=yuv420p,geq=lum='{luma}':cb=128:cr=128"))
        .args(["-c:v", "ffv1"])
        .arg(&p)
        .output()
        .unwrap();
    assert!(out.status.success(), "fixture: {}", String::from_utf8_lossy(&out.stderr));
    p
}

/// Luma of the frame at `t`, row by row.
fn luma_frame(video: &Path, t: f64) -> Vec<u8> {
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-ss", &t.to_string(), "-i"]).arg(video).args(["-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "-"]).output().unwrap();
    assert_eq!(out.stdout.len(), W * H, "no frame at t={t}");
    out.stdout
}

/// Fraction of neighbouring pixels (along rows, or down columns) that step down by more than `slack`.
fn falling(frame: &[u8], vertical: bool, slack: i32) -> f64 {
    let (mut n, mut bad) = (0u32, 0u32);
    let (outer, inner) = if vertical { (W, H) } else { (H, W) };
    for o in 0..outer {
        for i in 1..inner {
            let at = |k: usize| if vertical { frame[k * W + o] } else { frame[o * W + k] } as i32;
            n += 1;
            bad += u32::from(at(i) < at(i - 1) - slack);
        }
    }
    bad as f64 / n as f64
}
/// Same, for steps up.
fn rising(frame: &[u8], vertical: bool, slack: i32) -> f64 {
    let flipped: Vec<u8> = frame.iter().map(|v| 255 - v).collect();
    falling(&flipped, vertical, slack)
}

const NOISE: &str = "mod(X*97+Y*13,256)";

fn one_clip(src: &Path) -> (Engine, String) {
    let mut eng = Engine::new("ps", ProjectSettings { width: W as u32, height: H as u32, fps: secs(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: secs(0), source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    let id = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    (eng, id)
}

fn add(eng: &mut Engine, clip: &str, fx: &str, params: &[(&str, f64)]) {
    eng.dispatch(Command::AddEffect { clip: clip.into(), effect: fx.into(), params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect(), index: None }).unwrap_or_else(|e| panic!("{fx}: {e}"));
}

/// Export through the real path (bake stages included); returns the job so its stages can be inspected.
fn export(eng: &Engine, out: &Path) -> ffworks_core::ffmpeg::FfmpegJob {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let mut job = compile_project(&eng.project, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("ffv1_mkv").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap_or_else(|e| panic!("compile: {e}"));
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "ps", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export failed: {e}"));
    job
}

#[test]
fn sorting_whole_rows_puts_every_row_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let src = pattern(dir.path(), "n.mkv", NOISE, 2);
    // the source really is unsorted, so the result below is the sorter's doing
    assert!(falling(&luma_frame(&src, 0.5), false, 3) > 0.3);

    let (mut eng, c) = one_clip(&src);
    add(&mut eng, &c, "pixel_sort", &[("mode", 1.0)]);
    let out = dir.path().join("o.mkv");
    let job = export(&eng, &out);
    assert_eq!(job.stages.len(), 1);
    assert!(job.stages.iter().all(|s| !s.output.exists()), "an export's bake file is deleted afterwards");
    for t in [0.0, 0.5, 1.5] {
        let f = luma_frame(&out, t);
        assert!(falling(&f, false, 3) < 0.005, "rows ascend at t={t}: {}", falling(&f, false, 3));
    }
    // light to dark when reversed
    let (mut eng, c) = one_clip(&src);
    add(&mut eng, &c, "pixel_sort", &[("mode", 1.0), ("reverse", 1.0)]);
    export(&eng, &out);
    assert!(rising(&luma_frame(&out, 0.5), false, 3) < 0.005);
}

#[test]
fn sorting_down_orders_the_columns() {
    let dir = tempfile::tempdir().unwrap();
    let src = pattern(dir.path(), "n.mkv", "mod(X*13+Y*97,256)", 1);
    let (mut eng, c) = one_clip(&src);
    add(&mut eng, &c, "pixel_sort", &[("mode", 1.0), ("direction", 1.0)]);
    let out = dir.path().join("o.mkv");
    export(&eng, &out);
    let f = luma_frame(&out, 0.2);
    assert!(falling(&f, true, 3) < 0.005, "columns ascend: {}", falling(&f, true, 3));
    assert!(falling(&luma_frame(&src, 0.2), true, 3) > 0.3, "and they did not before");
}

#[test]
fn only_pixels_inside_the_brightness_range_move() {
    let dir = tempfile::tempdir().unwrap();
    // dark (Y=30) | mid-tones in a scramble | bright (Y=220); only the middle is inside the default range
    let src = pattern(dir.path(), "t.mkv", "if(lt(X,100),30,if(gt(X,219),220,90+mod(X*53,91)))", 1);
    let (mut eng, c) = one_clip(&src);
    add(&mut eng, &c, "pixel_sort", &[]);
    let out = dir.path().join("o.mkv");
    export(&eng, &out);
    let before = luma_frame(&src, 0.2);
    let after = luma_frame(&out, 0.2);
    for y in [0usize, 100, 239] {
        let (b, a) = (&before[y * W..(y + 1) * W], &after[y * W..(y + 1) * W]);
        for x in (0..100).chain(220..W) {
            assert!((a[x] as i32 - b[x] as i32).abs() <= 3, "outside the range, ({x},{y}) {} -> {}", b[x], a[x]);
        }
        assert!(a[100..220].windows(2).all(|p| p[1] as i32 >= p[0] as i32 - 3), "the middle run is in order, row {y}");
        assert!(b[100..220].windows(2).any(|p| (p[1] as i32) < p[0] as i32 - 10), "and it was not before");
    }
}

#[test]
fn the_effect_keeps_its_place_in_the_stack() {
    let dir = tempfile::tempdir().unwrap();
    let src = pattern(dir.path(), "n.mkv", NOISE, 1);
    let out = dir.path().join("o.mkv");
    // sort, then invert: the sorted ramp is flipped, so it falls
    let (mut eng, c) = one_clip(&src);
    add(&mut eng, &c, "pixel_sort", &[("mode", 1.0)]);
    add(&mut eng, &c, "negate", &[]);
    export(&eng, &out);
    let f = luma_frame(&out, 0.2);
    let mean = |lo: usize, hi: usize| (0..H).flat_map(|y| (lo..hi).map(move |x| (y, x))).map(|(y, x)| f[y * W + x] as f64).sum::<f64>() / (H * (hi - lo)) as f64;
    assert!(rising(&f, false, 4) < 0.005 && mean(0, 80) > mean(240, W) + 100.0, "inverted after sorting: falls from light to dark");
    // invert, then sort: the ramp ends up rising again
    let (mut eng, c) = one_clip(&src);
    add(&mut eng, &c, "negate", &[]);
    add(&mut eng, &c, "pixel_sort", &[("mode", 1.0)]);
    export(&eng, &out);
    assert!(falling(&luma_frame(&out, 0.2), false, 4) < 0.005, "sorted after inverting: rises");
}

#[test]
fn a_retimed_clip_is_sorted_at_its_new_speed() {
    let dir = tempfile::tempdir().unwrap();
    let src = pattern(dir.path(), "n.mkv", "mod(X*97+Y*13+N*40,256)", 4);
    let (mut eng, c) = one_clip(&src);
    eng.dispatch(Command::SetClipSpeed { clip: c.clone(), speed: secs(2) }).unwrap();
    add(&mut eng, &c, "pixel_sort", &[("mode", 1.0)]);
    let out = dir.path().join("o.mkv");
    export(&eng, &out);
    let info = ffworks_core::ffprobe::probe(&tools(), &out).unwrap();
    assert!((info.duration.as_f64() - 2.0).abs() < 0.1, "the 4 s clip at 2x lasts 2 s: {}", info.duration.as_f64());
    assert!(falling(&luma_frame(&out, 1.5), false, 3) < 0.005);
}

#[test]
fn a_transition_side_is_sorted_and_the_other_clip_is_not() {
    let dir = tempfile::tempdir().unwrap();
    let a = pattern(dir.path(), "a.mkv", NOISE, 4);
    let b = pattern(dir.path(), "b.mkv", "mod(X*101+Y*7,256)", 4);
    let mut eng = Engine::new("tr", ProjectSettings { width: W as u32, height: H as u32, fps: secs(25), sample_rate: 48000 }, tools());
    let (ma, mb) = (eng.import_media(&a).unwrap(), eng.import_media(&b).unwrap());
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: ma, track: v.clone(), start: secs(0), source_in: Some(secs(0)), duration: Some(secs(2)), with_audio: false, audio_track: None }).unwrap();
    eng.dispatch(Command::PlaceClip { media: mb, track: v, start: secs(2), source_in: Some(secs(1)), duration: Some(secs(2)), with_audio: false, audio_track: None }).unwrap();
    let t = &eng.project.active().unwrap().tracks[0];
    let (ca, cb) = (t.clips[0].id.clone(), t.clips[1].id.clone());
    eng.dispatch(Command::AddTransition { clip_a: ca.clone(), clip_b: cb, kind: "fade".into(), duration: secs(1) }).unwrap();
    add(&mut eng, &ca, "pixel_sort", &[("mode", 1.0)]);
    let out = dir.path().join("o.mkv");
    let job = export(&eng, &out);
    assert_eq!(job.stages.len(), 2, "the clip body and its side of the transition are baked separately");
    assert!(falling(&luma_frame(&out, 0.5), false, 3) < 0.005, "the body of the sorted clip");
    assert!(falling(&luma_frame(&out, 3.5), false, 3) > 0.3, "the clip without the effect is untouched");
    let mid = luma_frame(&out, 2.0);
    assert_eq!(mid.len(), W * H, "the transition itself rendered");
}

#[test]
fn a_preview_bakes_only_the_range_it_shows_and_a_later_edit_reuses_the_bake() {
    let dir = tempfile::tempdir().unwrap();
    let src = pattern(dir.path(), "n.mkv", "mod(X*97+Y*13+N*7,256)", 4);
    let (mut eng, c) = one_clip(&src);
    add(&mut eng, &c, "pixel_sort", &[("mode", 1.0)]);
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let cache = dir.path().join("cache");
    let r = ffworks_core::preview::render(&t, Some(&caps), &eng.project, Rational::new(3, 2), Rational::new(2, 1), 1, &cache, &CancelToken::new(), &mut |_| {}).unwrap();
    let f = luma_frame(&r.path, 0.1);
    assert!(falling(&f, false, 12) < 0.03, "the previewed frames are sorted: {}", falling(&f, false, 12));
    let baked = |d: &Path| std::fs::read_dir(d.join("bake")).map(|r| r.filter_map(|e| e.ok()).filter(|e| e.path().extension().is_some_and(|x| x == "mkv")).count()).unwrap_or(0);
    assert_eq!(baked(&cache), 1, "one bake file is kept");
    let frames = |p: &Path| {
        let o = Proc::new(tools().ffprobe).args(["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0"]).arg(p).output().unwrap();
        String::from_utf8_lossy(&o.stdout).trim().parse::<u32>().unwrap()
    };
    let bake_file = std::fs::read_dir(cache.join("bake")).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "mkv")).unwrap();
    assert!(frames(&bake_file) < 25, "0.5 s of preview did not bake the whole 4 s clip: {} frames", frames(&bake_file));

    // change something after the sort: new preview, same bake
    add(&mut eng, &c, "negate", &[]);
    let r2 = ffworks_core::preview::render(&t, Some(&caps), &eng.project, Rational::new(3, 2), Rational::new(2, 1), 1, &cache, &CancelToken::new(), &mut |_| {}).unwrap();
    assert_ne!(r.key, r2.key);
    assert_eq!(baked(&cache), 1, "the bake was reused, not redone");
    assert!(rising(&luma_frame(&r2.path, 0.1), false, 12) < 0.03, "and the later effect applies on top");
}

#[test]
fn compiling_a_graph_with_an_unbaked_sort_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let src = pattern(dir.path(), "n.mkv", NOISE, 1);
    let (mut eng, c) = one_clip(&src);
    add(&mut eng, &c, "pixel_sort", &[]);
    let g = render_graph::build(&eng.project).unwrap();
    let e = compile(&g, &RenderOptions { output: dir.path().join("x.mkv"), settings: ExportSettings::find("ffv1_mkv").unwrap(), range: None, scale_div: 1 }, None).unwrap_err();
    assert!(e.to_string().contains("not been baked"), "{e}");
}

#[test]
fn the_command_inspector_shows_the_render_that_reads_the_baked_file() {
    let dir = tempfile::tempdir().unwrap();
    let src = pattern(dir.path(), "n.mkv", NOISE, 1);
    let (mut eng, c) = one_clip(&src);
    add(&mut eng, &c, "pixel_sort", &[]);
    let job = compile_project(&eng.project, &RenderOptions { output: dir.path().join("x.mkv"), settings: ExportSettings::find("ffv1_mkv").unwrap(), range: None, scale_div: 1 }, None).unwrap();
    assert_eq!(job.stages.len(), 1);
    assert!(job.display().contains(job.stages[0].output.to_str().unwrap()), "the main command opens the baked file");
    assert!(!job.stages[0].output.exists(), "planning runs nothing");
    // the plan survives the unfinished-exports journal
    let back: ffworks_core::ffmpeg::FfmpegJob = serde_json::from_str(&serde_json::to_string(&job).unwrap()).unwrap();
    assert_eq!(back.stages.len(), 1);
    assert_eq!(back.stages[0].output, job.stages[0].output);
}

#[test]
fn settings_survive_save_load_and_undo() {
    let dir = tempfile::tempdir().unwrap();
    let src = pattern(dir.path(), "n.mkv", NOISE, 1);
    let (mut eng, c) = one_clip(&src);
    add(&mut eng, &c, "pixel_sort", &[("key", 1.0), ("seed", 7.0)]);
    let file = dir.path().join("p.ffworks");
    eng.save(&file).unwrap();
    let loaded = Engine::load(&file, tools()).unwrap();
    let fx = &loaded.project.active().unwrap().tracks[0].clips[0].effects[0];
    assert_eq!((fx.effect.as_str(), fx.params["key"], fx.params["seed"]), ("pixel_sort", 1.0, 7.0));
    eng.undo().unwrap();
    assert!(eng.project.active().unwrap().tracks[0].clips[0].effects.is_empty());
    assert!(eng.dispatch(Command::AddEffect { clip: c, effect: "pixel_sort".into(), params: [("mix".to_string(), 3.0)].into(), index: None }).is_err(), "out-of-range settings are refused");
}

#[test]
fn cancelling_stops_the_sort_and_leaves_no_files_behind() {
    let dir = tempfile::tempdir().unwrap();
    let src = pattern(dir.path(), "long.mkv", "mod(X*97+Y*13+N*5,256)", 40);
    let (mut eng, c) = one_clip(&src);
    add(&mut eng, &c, "pixel_sort", &[("mode", 1.0)]);
    let t = tools();
    let out = dir.path().join("o.mkv");
    let job = compile_project(&eng.project, &RenderOptions { output: out.clone(), settings: ExportSettings::find("ffv1_mkv").unwrap(), range: None, scale_div: 1 }, None).unwrap();
    let mut job = job;
    job.program = t.ffmpeg.clone();
    let cancel = CancelToken::new();
    let c2 = cancel.clone();
    let started = std::time::Instant::now();
    let mut states = vec![];
    std::thread::scope(|s| {
        s.spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(600));
            c2.cancel();
        });
        let r = run_job(&t, &job, "cx", "export", &cancel, &dir.path().join("tmp"), &mut |st| states.push(st));
        assert!(matches!(r, Err(Error::Canceled)), "{r:?}");
    });
    assert!(started.elapsed().as_secs() < 20, "cancel is prompt");
    assert!(matches!(states.last(), Some(JobState::Canceled)));
    assert!(!out.exists());
    let leftovers: Vec<_> = job.stages.iter().flat_map(|s| s.output.parent().map(|p| std::fs::read_dir(p).map(|r| r.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.to_string_lossy().contains(&s.key)).collect::<Vec<_>>().len()).unwrap_or(0))).collect();
    assert_eq!(leftovers.iter().sum::<usize>(), 0, "no partial bake files");
}

/// Fraction of pixels whose down-right neighbour is darker by more than `slack` (steps along a 45° diagonal).
fn falling_diagonal(frame: &[u8], slack: i32) -> f64 {
    let (mut n, mut bad) = (0u32, 0u32);
    for y in 0..H - 1 {
        for x in 0..W - 1 {
            n += 1;
            bad += u32::from((frame[(y + 1) * W + x + 1] as i32) < frame[y * W + x] as i32 - slack);
        }
    }
    bad as f64 / n as f64
}

#[test]
fn an_angled_sort_orders_the_pixels_along_the_diagonal() {
    let dir = tempfile::tempdir().unwrap();
    let src = pattern(dir.path(), "n.mkv", NOISE, 1);
    assert!(falling_diagonal(&luma_frame(&src, 0.2), 3) > 0.3, "the source is not ordered along the diagonal");
    let (mut eng, c) = one_clip(&src);
    add(&mut eng, &c, "pixel_sort", &[("mode", 1.0), ("angle", 45.0)]);
    let out = dir.path().join("o.mkv");
    export(&eng, &out);
    let f = luma_frame(&out, 0.2);
    assert!(falling_diagonal(&f, 3) < 0.005, "diagonals ascend: {}", falling_diagonal(&f, 3));
    // rows were not what was sorted: a row sort would leave under 0.5% falling steps, this leaves clearly more
    assert!(falling(&f, false, 3) > 0.02, "rows are not fully ordered: {}", falling(&f, false, 3));
    // (that the pixels are only moved, never changed, is the unit test's job: the YUV round trip alters values a little)
}

#[test]
fn the_sort_angle_shows_as_a_setting_and_a_zero_angle_changes_nothing() {
    let def = ffworks_core::effects::find("pixel_sort").unwrap();
    assert!(def.params.iter().any(|p| p.id == "angle" && p.min == -90.0 && p.max == 90.0));
    let dir = tempfile::tempdir().unwrap();
    let src = pattern(dir.path(), "n.mkv", NOISE, 1);
    let (mut a, ca) = one_clip(&src);
    add(&mut a, &ca, "pixel_sort", &[("mode", 1.0)]);
    let (mut b, cb) = one_clip(&src);
    add(&mut b, &cb, "pixel_sort", &[("mode", 1.0), ("angle", 0.0)]);
    let (oa, ob) = (dir.path().join("a.mkv"), dir.path().join("b.mkv"));
    export(&a, &oa);
    export(&b, &ob);
    assert_eq!(luma_frame(&oa, 0.2), luma_frame(&ob, 0.2));
}
