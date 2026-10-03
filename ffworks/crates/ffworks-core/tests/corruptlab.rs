//! Corruption lab with real FFmpeg: damage is measured against the original picture, deterministic, scales with the setting,
//! drops packets without changing the clip's length, and is cancellable. No FFglitch needed.
use ffworks_core::commands::Command;
use ffworks_core::corruptlab::{run, Request, Settings};
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

/// 320x240 @25, 3 s, a moving test picture, stored losslessly.
fn source(dir: &Path) -> PathBuf {
    let p = dir.join("src.mkv");
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=3", "-c:v", "ffv1"]).arg(&p).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    p
}

fn request(src: &Path, out: &Path, settings: Settings) -> Request {
    Request { source: Source { path: src.to_path_buf(), start: Rational::ZERO, duration: Rational::from_int(3) }, settings, width: 320, height: 240, fps: Rational::from_int(25), output: out.to_path_buf() }
}

fn settings(codec: &str, bits: Option<u32>, drop_every: Option<u32>) -> Settings {
    Settings { codec: codec.into(), bits, drop_every, keyframe_every: 30 }
}

fn make(src: &Path, out: &Path, s: Settings) {
    run(&tools(), &request(src, out, s), &CancelToken::new(), &mut |_| {}).unwrap_or_else(|e| panic!("corruption lab failed: {e}"));
}

/// Average PSNR (dB) of `b` against `a`: lower means more different.
fn psnr(a: &Path, b: &Path) -> f64 {
    let o = Proc::new(tools().ffmpeg).args(["-v", "info", "-i"]).arg(b).arg("-i").arg(a).args(["-lavfi", "psnr", "-f", "null", "-"]).output().unwrap();
    let text = String::from_utf8_lossy(&o.stderr);
    let v = text.split("average:").nth(1).unwrap_or_else(|| panic!("no psnr in: {text}")).split_whitespace().next().unwrap().to_string();
    if v == "inf" { 99.0 } else { v.parse().unwrap() }
}

/// MD5 of every frame, in order.
fn frame_hashes(p: &Path) -> Vec<String> {
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-i"]).arg(p).args(["-f", "framemd5", "-"]).output().unwrap();
    String::from_utf8_lossy(&o.stdout).lines().filter(|l| !l.starts_with('#') && !l.is_empty()).map(|l| l.rsplit(',').next().unwrap().trim().to_string()).collect()
}

fn frames(p: &Path) -> usize {
    frame_hashes(p).len()
}

#[test]
fn damage_grows_with_the_level_and_the_clip_keeps_its_length() {
    let dir = tempfile::tempdir().unwrap();
    let src = source(dir.path());
    let (mild, wild) = (dir.path().join("mild.mkv"), dir.path().join("wild.mkv"));
    make(&src, &mild, settings("mpeg4", Some(2), None));
    make(&src, &wild, settings("mpeg4", Some(9), None));
    let (p_mild, p_wild) = (psnr(&src, &mild), psnr(&src, &wild));
    assert!(p_mild > 20.0, "a light touch still looks like the clip: {p_mild} dB");
    assert!(p_wild < p_mild - 6.0, "level 9 damages far more than level 2: {p_wild} dB vs {p_mild} dB");
    assert_eq!(frames(&mild), 75);
    assert_eq!(frames(&wild), 75, "75 frames in, 75 frames out");
}

#[test]
fn the_same_bytes_are_damaged_every_time() {
    let dir = tempfile::tempdir().unwrap();
    let src = source(dir.path());
    let base = dir.path().join("base.avi");
    let enc = Proc::new(tools().ffmpeg).args(["-v", "error", "-y", "-i"]).arg(&src).args(["-c:v", "mpeg4", "-qscale:v", "3", "-g", "30", "-bf", "0"]).arg(&base).output().unwrap();
    assert!(enc.status.success());
    let (a, b, c) = (dir.path().join("a.avi"), dir.path().join("b.avi"), dir.path().join("c.avi"));
    let s = settings("mpeg4", Some(7), Some(9));
    ffworks_core::corruptlab::damage(&tools(), &base, &a, &s, &CancelToken::new()).unwrap();
    ffworks_core::corruptlab::damage(&tools(), &base, &b, &s, &CancelToken::new()).unwrap();
    ffworks_core::corruptlab::damage(&tools(), &base, &c, &settings("mpeg4", Some(8), Some(9)), &CancelToken::new()).unwrap();
    let bytes = |p: &Path| std::fs::read(p).unwrap();
    assert_eq!(bytes(&a), bytes(&b), "identical damage for identical settings");
    assert_ne!(bytes(&a), bytes(&c), "another level damages other bytes");
    assert_ne!(bytes(&a), bytes(&base));
}

#[test]
fn dropped_packets_freeze_the_picture_without_shortening_the_clip() {
    let dir = tempfile::tempdir().unwrap();
    let src = source(dir.path());
    let out = dir.path().join("o.mkv");
    make(&src, &out, settings("mpeg4", None, Some(4)));
    assert_eq!(frames(&out), 75, "the retimed output still fills the 3 s");
    let hashes = frame_hashes(&out);
    let repeats = hashes.windows(2).filter(|w| w[0] == w[1]).count();
    assert!(repeats >= 5, "frozen repeats where packets went missing: {repeats}");
    // the moving test picture has no repeats of its own
    let clean = frame_hashes(&src);
    assert_eq!(clean.windows(2).filter(|w| w[0] == w[1]).count(), 0);
}

#[test]
fn every_codec_works_and_looks_different() {
    let dir = tempfile::tempdir().unwrap();
    let src = source(dir.path());
    let mut hashes = vec![];
    for codec in ["mpeg4", "mjpeg", "mpeg2video"] {
        let out = dir.path().join(format!("{codec}.mkv"));
        make(&src, &out, settings(codec, Some(6), None));
        assert_eq!(frames(&out), 75, "{codec}");
        assert!(psnr(&src, &out) < 40.0, "{codec} was damaged");
        hashes.push(frame_hashes(&out));
    }
    assert!(hashes[0] != hashes[1] && hashes[1] != hashes[2] && hashes[0] != hashes[2]);
}

#[test]
fn the_keyframe_spacing_changes_the_result() {
    let dir = tempfile::tempdir().unwrap();
    let src = source(dir.path());
    let (a, b) = (dir.path().join("a.mkv"), dir.path().join("b.mkv"));
    make(&src, &a, Settings { keyframe_every: 2, ..settings("mpeg4", Some(5), None) });
    make(&src, &b, Settings { keyframe_every: 300, ..settings("mpeg4", Some(5), None) });
    assert_eq!((frames(&a), frames(&b)), (75, 75));
    assert_ne!(frame_hashes(&a), frame_hashes(&b));
}

#[test]
fn cancelling_stops_at_once_and_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let src = source(dir.path());
    let out = dir.path().join("never.mkv");
    let cancel = CancelToken::new();
    cancel.cancel();
    let r = run(&tools(), &request(&src, &out, settings("mpeg4", Some(5), None)), &cancel, &mut |_| {});
    assert!(matches!(r, Err(Error::Canceled)), "{r:?}");
    assert!(!out.exists());
    let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.contains("partial")).collect();
    assert!(left.is_empty(), "{left:?}");
}

#[test]
fn bad_requests_and_a_missing_source_are_clear_errors() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("o.mkv");
    let nothing = run(&tools(), &request(Path::new("x.mkv"), &out, settings("mpeg4", None, None)), &CancelToken::new(), &mut |_| {}).unwrap_err().to_string();
    assert!(nothing.contains("choose something to break"), "{nothing}");
    let missing = run(&tools(), &request(&dir.path().join("nope.mkv"), &out, settings("mpeg4", Some(5), None)), &CancelToken::new(), &mut |_| {}).unwrap_err().to_string();
    assert!(missing.contains("reading the clip"), "{missing}");
    assert!(!out.exists());
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
    let source = source_for(&eng, &clip, "corruption lab").unwrap();
    let out = dir.path().join("lab.mkv");
    run(&tools(), &Request { source, settings: settings("mjpeg", Some(6), None), width: 320, height: 240, fps: Rational::from_int(25), output: out.clone() }, &CancelToken::new(), &mut |_| {}).unwrap();
    place_on_track(&mut eng, &clip, &out, "Corruption").unwrap();
    let seq = eng.project.active().unwrap();
    let t = seq.tracks.iter().find(|t| t.name == "Corruption").expect("a Corruption track");
    assert_eq!((t.clips.len(), t.clips[0].start, t.clips[0].duration), (1, Rational::from_int(2), Rational::from_int(2)));
    assert_eq!(seq.tracks[0].clips.len(), 1, "the original clip is untouched");

    // clips that cannot be corrupted say why, naming this lab
    eng.dispatch(Command::SetClipSpeed { clip: clip.clone(), speed: Rational::from_int(2) }).ok();
    if let Err(e) = source_for(&eng, &clip, "corruption lab") {
        assert!(e.to_string().contains("corruption lab"), "{e}");
    }
}
