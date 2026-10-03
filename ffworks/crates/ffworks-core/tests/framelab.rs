//! Frame lab with real FFmpeg: the AVI is read and written back without changing a pixel, the modes change what they say they
//! change, the decoded result keeps the clip's length, and cancelling leaves nothing behind.
use ffworks_core::commands::Command;
use ffworks_core::framelab::{assemble, encode_avi, order, run, Avi, Kind, Mode, Request, Settings};
use ffworks_core::engine::Engine;
use ffworks_core::jobs::CancelToken;
use ffworks_core::moshlab::{place_on_track, source_for, Source};
use ffworks_core::process::Tools;
use ffworks_core::project::ProjectSettings;
use ffworks_core::{Error, Rational};
use std::path::{Path, PathBuf};
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}

fn lavfi(dir: &Path, name: &str, input: &str) -> PathBuf {
    let p = dir.join(name);
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", input, "-t", "3", "-c:v", "ffv1"]).arg(&p).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    p
}

/// 320x240 @25, 3 s, a moving test picture.
fn source(dir: &Path) -> PathBuf {
    lavfi(dir, "src.mkv", "testsrc2=s=320x240:r=25:d=3")
}

fn src_of(path: &Path) -> Source {
    Source { path: path.to_path_buf(), start: Rational::ZERO, duration: Rational::from_int(3) }
}

fn settings(mode: Mode) -> Settings {
    Settings { mode, keyframe_every: 15, drop_keyframes: true, keep_first: true, kill: None }
}

fn request(src: &Path, out: &Path, s: Settings) -> Request {
    Request { source: src_of(src), settings: s, width: 320, height: 240, fps: Rational::from_int(25), output: out.to_path_buf() }
}

fn make(src: &Path, out: &Path, s: Settings) {
    run(&tools(), &request(src, out, s), &CancelToken::new(), &mut |_| {}).unwrap_or_else(|e| panic!("frame lab failed: {e}"));
}

fn frame_hashes(p: &Path) -> Vec<String> {
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-i"]).arg(p).args(["-f", "framemd5", "-"]).output().unwrap();
    String::from_utf8_lossy(&o.stdout).lines().filter(|l| !l.starts_with('#') && !l.is_empty()).map(|l| l.rsplit(',').next().unwrap().trim().to_string()).collect()
}

/// The clip as the lab encodes it, and its plain decode (what "no editing" looks like).
fn base(dir: &Path, src: &Path) -> (PathBuf, Avi) {
    let avi = dir.join("base.avi");
    encode_avi(&tools(), &src_of(src), &request(src, &dir.join("x.mkv"), settings(Mode::Classic)), &avi, &CancelToken::new()).unwrap();
    let parsed = Avi::parse(&std::fs::read(&avi).unwrap()).unwrap();
    (avi, parsed)
}

#[test]
fn the_avi_is_read_classified_and_written_back_so_it_plays_exactly_the_same() {
    let dir = tempfile::tempdir().unwrap();
    let src = source(dir.path());
    let (avi, parsed) = base(dir.path(), &src);
    assert_eq!(parsed.frames.len(), 75);
    let intra: Vec<usize> = parsed.frames.iter().enumerate().filter(|(_, f)| f.kind == Kind::Intra).map(|(i, _)| i).collect();
    assert_eq!(intra, vec![0, 15, 30, 45, 60], "a full picture every 15 frames");

    let again = dir.path().join("again.avi");
    std::fs::write(&again, parsed.write(&parsed.frames)).unwrap();
    assert_eq!(frame_hashes(&again), frame_hashes(&avi), "an unedited rewrite decodes to the same pictures");
    let probe = Proc::new(tools().ffprobe).args(["-v", "error", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0"]).arg(&again).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&probe.stdout).trim(), "75");
}

#[test]
fn classic_keeps_the_first_pictures_then_lets_motion_pile_onto_the_old_picture() {
    let dir = tempfile::tempdir().unwrap();
    let src = source(dir.path());
    let (avi, _) = base(dir.path(), &src);
    let straight = frame_hashes(&avi);
    let out = dir.path().join("o.mkv");
    make(&src, &out, settings(Mode::Classic));
    let moshed = frame_hashes(&out);
    assert_eq!(moshed.len(), 75, "the clip keeps its length (the missing frames are held)");
    assert_eq!(moshed[..14], straight[..14], "up to the first removed keyframe nothing changes");
    let differing = (15..60).filter(|&i| moshed[i] != straight[i]).count();
    assert!(differing >= 40, "after that the picture is no longer the clean one: {differing} of 45 frames differ");
}

#[test]
fn modes_are_deterministic_and_change_the_order_they_promise() {
    let dir = tempfile::tempdir().unwrap();
    let src = source(dir.path());
    let (avi, _) = base(dir.path(), &src);
    let straight = frame_hashes(&avi);
    let keep_all = |mode| Settings { drop_keyframes: false, ..settings(mode) };

    // reversing every frame but the first (the first is kept as the start): last decoded picture differs from the clean one
    let rev = dir.path().join("rev.mkv");
    make(&src, &rev, keep_all(Mode::Reverse));
    let h = frame_hashes(&rev);
    assert_eq!((h.len(), &h[0]), (75, &straight[0]), "first frame stays");
    assert_ne!(h[1..], straight[1..]);

    let (r1, r2, r3) = (dir.path().join("r1.mkv"), dir.path().join("r2.mkv"), dir.path().join("r3.mkv"));
    make(&src, &r1, settings(Mode::Random { seed: 7 }));
    make(&src, &r2, settings(Mode::Random { seed: 7 }));
    make(&src, &r3, settings(Mode::Random { seed: 8 }));
    assert_eq!(frame_hashes(&r1), frame_hashes(&r2), "same seed, same picture");
    assert_ne!(frame_hashes(&r1), frame_hashes(&r3), "another seed, another picture");
}

#[test]
fn bloom_repeats_one_frames_movement_so_the_picture_smears_for_many_frames() {
    let dir = tempfile::tempdir().unwrap();
    let src = source(dir.path());
    let out = dir.path().join("bloom.mkv");
    make(&src, &out, settings(Mode::Bloom { count: 30, at: 20 }));
    let h = frame_hashes(&out);
    assert_eq!(h.len(), 75);
    // 30 extra copies of one predicted frame: the result keeps changing while the clean clip would have moved on
    let moving = h[20..50].windows(2).filter(|w| w[0] != w[1]).count();
    assert!(moving >= 20, "the repeated frame keeps pushing the picture: {moving} changes in 30 frames");
}

#[test]
fn splicing_takes_the_picture_of_one_clip_and_the_movement_of_another() {
    let dir = tempfile::tempdir().unwrap();
    let a = source(dir.path());
    let b = lavfi(dir.path(), "b.mkv", "mandelbrot=s=320x240:r=25");
    let (a_avi, _) = base(dir.path(), &a);
    let straight_a = frame_hashes(&a_avi);
    let b_dir = dir.path().join("bb");
    std::fs::create_dir_all(&b_dir).unwrap();
    let (b_avi, _) = base(&b_dir, &b);
    let straight_b = frame_hashes(&b_avi);
    let out = dir.path().join("splice.mkv");
    make(&a, &out, settings(Mode::Splice { donor: src_of(&b), at: Rational::from_int(1) }));
    let h = frame_hashes(&out);
    assert_eq!(h.len(), 75);
    assert_eq!(h[..25], straight_a[..25], "the first second is this clip, untouched (even its own keyframes)");
    let after: Vec<usize> = (30..75).collect();
    assert!(after.iter().filter(|&&i| h[i] != straight_a[i]).count() >= 40, "then it is no longer this clip");
    assert!(after.iter().filter(|&&i| h[i] != straight_b[i]).count() >= 40, "and not the other clip either: its movement on this clip's picture");
}

#[test]
fn keyframe_removal_that_leaves_one_frame_is_a_clear_error() {
    let dir = tempfile::tempdir().unwrap();
    let src = source(dir.path());
    let out = dir.path().join("o.mkv");
    let e = run(&tools(), &request(&src, &out, Settings { keyframe_every: 1, ..settings(Mode::Classic) }), &CancelToken::new(), &mut |_| {}).unwrap_err().to_string();
    assert!(e.contains("only one frame is left"), "{e}");
    assert!(!out.exists());
    let e = run(&tools(), &request(&src, &out, settings(Mode::Bloom { count: 3, at: 500 })), &CancelToken::new(), &mut |_| {}).unwrap_err().to_string();
    assert!(e.contains("beyond"), "{e}");
    let e = run(&tools(), &request(&src, &out, settings(Mode::Splice { donor: src_of(&src), at: Rational::from_int(9) })), &CancelToken::new(), &mut |_| {}).unwrap_err().to_string();
    assert!(e.contains("splice moment"), "{e}");
}

#[test]
fn cancelling_stops_at_once_and_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let src = source(dir.path());
    let out = dir.path().join("never.mkv");
    let cancel = CancelToken::new();
    cancel.cancel();
    let r = run(&tools(), &request(&src, &out, settings(Mode::Classic)), &cancel, &mut |_| {});
    assert!(matches!(r, Err(Error::Canceled)), "{r:?}");
    assert!(!out.exists());
    let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.contains("partial")).collect();
    assert!(left.is_empty(), "{left:?}");
}

#[test]
fn something_that_is_not_an_avi_is_refused_without_panicking() {
    assert!(Avi::parse(b"not an avi at all").is_err());
    assert!(Avi::parse(b"RIFF\x04\x00\x00\x00AVI ").is_err());
    let mut cut = b"RIFF\xff\xff\xff\x7fAVI LIST\xff\xff\xff\x7fmovi00dc\xff\xff\xff\x7f".to_vec();
    cut.extend_from_slice(&[0u8; 8]);
    assert!(Avi::parse(&cut).is_err(), "a frame that runs past the end of the file");
}

#[test]
fn the_result_lands_on_its_own_track_at_the_clips_place_and_the_original_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let src = source(dir.path());
    let mut eng = Engine::new("c", ProjectSettings { width: 320, height: 240, fps: Rational::from_int(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(&src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: Rational::from_int(2), source_in: None, duration: Some(Rational::from_int(2)), with_audio: false, audio_track: None }).unwrap();
    let clip = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    let source = source_for(&eng, &clip, "frame lab").unwrap();
    let out = dir.path().join("lab.mkv");
    run(&tools(), &Request { source, settings: settings(Mode::Pulse { count: 3, every: 5 }), width: 320, height: 240, fps: Rational::from_int(25), output: out.clone() }, &CancelToken::new(), &mut |_| {}).unwrap();
    place_on_track(&mut eng, &clip, &out, "Frames").unwrap();
    let seq = eng.project.active().unwrap();
    let t = seq.tracks.iter().find(|t| t.name == "Frames").expect("a Frames track");
    assert_eq!((t.clips.len(), t.clips[0].start, t.clips[0].duration), (1, Rational::from_int(2), Rational::from_int(2)));
    assert_eq!(seq.tracks[0].clips.len(), 1, "the original clip is untouched");
}

// ---- the arrangement itself, without FFmpeg ----------------------------------------------------------------------------

fn synthetic(n: usize, intra_every: usize) -> Vec<ffworks_core::framelab::Frame> {
    (0..n).map(|i| ffworks_core::framelab::Frame { data: vec![0; 10 + (i * 7) % 13], kind: if i % intra_every == 0 { Kind::Intra } else { Kind::Predicted } }).collect()
}

fn picks(frames: &[ffworks_core::framelab::Frame], s: &Settings) -> Vec<usize> {
    order(frames, &[], s, Rational::from_int(25), 10_000).unwrap()
}

#[test]
fn every_mode_orders_frames_exactly_as_documented() {
    let f = synthetic(12, 6); // I at 0 and 6
    let base = settings(Mode::Classic);
    assert_eq!(picks(&f, &base), vec![0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11], "keyframe 6 removed, the first kept");
    assert_eq!(picks(&f, &Settings { keep_first: false, ..base.clone() }), vec![1, 2, 3, 4, 5, 7, 8, 9, 10, 11], "no first frame kept");
    assert_eq!(picks(&f, &Settings { drop_keyframes: false, ..settings(Mode::Reverse) }), vec![0, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    assert_eq!(picks(&f, &settings(Mode::Reverse)), vec![0, 11, 10, 9, 8, 7, 5, 4, 3, 2, 1]);
    assert_eq!(picks(&f, &Settings { drop_keyframes: false, ..settings(Mode::Invert) }), vec![0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 11]);
    assert_eq!(picks(&f, &Settings { drop_keyframes: false, ..settings(Mode::InvertReverse) }), vec![0, 11, 9, 10, 7, 8, 5, 6, 3, 4, 1, 2]);
    assert_eq!(picks(&f, &settings(Mode::Bloom { count: 3, at: 2 })), vec![0, 1, 2, 3, 3, 3, 3, 4, 5, 7, 8, 9, 10, 11]);
    assert_eq!(picks(&f, &Settings { drop_keyframes: false, ..settings(Mode::Pulse { count: 2, every: 4 }) }), vec![0, 1, 2, 3, 4, 5, 5, 5, 6, 7, 8, 9, 9, 9, 10, 11], "frames are counted after the kept first one");
    assert_eq!(picks(&f, &Settings { drop_keyframes: false, ..settings(Mode::Overlap { count: 4, every: 2 }) }), vec![0, 1, 2, 3, 4, 3, 4, 5, 6, 5, 6, 7, 8, 7, 8, 9, 10, 9, 10, 11, 11], "the last windows are cut short at the end");
    assert_eq!(picks(&f, &settings(Mode::Repeat { count: 2, at: 3 })).iter().take(10).copied().collect::<Vec<_>>(), vec![0, 1, 2, 3, 4, 5, 4, 5, 4, 5]);
    let sorted = picks(&f, &Settings { drop_keyframes: false, ..settings(Mode::Sort { descending: false }) });
    assert_eq!(sorted[0], 0, "the first frame stays first");
    assert!(sorted[1..].windows(2).all(|w| f[w[0]].data.len() <= f[w[1]].data.len()));
    let down = picks(&f, &Settings { drop_keyframes: false, ..settings(Mode::Sort { descending: true }) });
    assert!(down[1..].windows(2).all(|w| f[w[0]].data.len() >= f[w[1]].data.len()));
}

#[test]
fn random_and_jiggle_are_permutations_or_neighbours_and_repeatable() {
    let f = synthetic(40, 100);
    let s = settings(Mode::Random { seed: 3 });
    let p = picks(&f, &s);
    assert_eq!(p[0], 0);
    let mut sorted = p.clone();
    sorted.sort();
    assert_eq!(sorted, (0..40).collect::<Vec<_>>(), "every frame exactly once");
    assert_eq!(p, picks(&f, &s));
    assert_ne!(p, picks(&f, &settings(Mode::Random { seed: 4 })));
    let j = picks(&f, &settings(Mode::Jiggle { spread: 3, seed: 1 }));
    assert_eq!(j.len(), 40);
    assert!(j.iter().enumerate().skip(1).all(|(i, &x)| x.abs_diff(i) <= 3 + 1), "within the spread: {j:?}");
}

#[test]
fn killing_big_frames_removes_them_and_assembling_restores_the_setup_header() {
    let mut f = synthetic(8, 100);
    f[3].data = vec![1; 1000];
    let p = picks(&f, &Settings { kill: Some(0.5), ..settings(Mode::Classic) });
    assert!(!p.contains(&3) && p.len() == 7);

    let vol = [0u8, 0, 1, 0xB0, 1, 0, 0, 1, 0xB5, 0x89, 0, 0, 1, 0xB6, 0x10];
    let mut g = synthetic(4, 2);
    g[0].data = vol.to_vec();
    g[1].data = vec![0, 0, 1, 0xB6, 0x50];
    g[2].data = vec![0, 0, 1, 0xB6, 0x10];
    let out = assemble(&g, &[], &[1, 2]);
    assert!(out[0].data.starts_with(&[0, 0, 1, 0xB0]), "the decoder's setup bytes are put in front of a first frame that lacks them");
    assert!(out[0].data.ends_with(&[0, 0, 1, 0xB6, 0x50]));
}
