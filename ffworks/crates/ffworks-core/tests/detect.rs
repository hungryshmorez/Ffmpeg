//! Silence / black / freeze detection and "cut out ranges" on real media.
use ffworks_core::commands::Command;
use ffworks_core::detect::{detect, Kind};
use ffworks_core::engine::Engine;
use ffworks_core::process::Tools;
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

/// 6 s: tone 0-2 s, silence 2-4 s, tone 4-6 s; picture red 0-2, black 2-4 (frozen), red-noise-free test pattern later.
fn fixture(dir: &Path) -> PathBuf {
    let p = dir.join("f.mp4");
    let out = Proc::new(tools().ffmpeg)
        .args(["-v", "error", "-y"])
        .args(["-f", "lavfi", "-i", "color=c=red:s=160x120:r=25:d=2", "-f", "lavfi", "-i", "color=c=black:s=160x120:r=25:d=2", "-f", "lavfi", "-i", "testsrc2=s=160x120:r=25:d=2"])
        .args(["-f", "lavfi", "-i", "sine=f=440:r=44100:d=2", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=2", "-f", "lavfi", "-i", "sine=f=440:r=44100:d=2"])
        .args(["-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1[v];[3:a][4:a][5:a]concat=n=3:v=0:a=1[a]", "-map", "[v]", "-map", "[a]"])
        .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"])
        .arg(&p)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    p
}

fn near(r: &[(f64, f64)], want: (f64, f64)) -> bool {
    r.iter().any(|(a, b)| (a - want.0).abs() < 0.15 && (b - want.1).abs() < 0.15)
}

#[test]
fn finds_the_silent_black_and_frozen_stretches() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path());
    let sil = detect(&tools(), &f, 6.0, Kind::Silence, -40.0, 0.5).unwrap();
    assert!(near(&sil, (2.0, 4.0)), "silence: {sil:?}");
    let blk = detect(&tools(), &f, 6.0, Kind::Black, 0.1, 0.5).unwrap();
    assert!(near(&blk, (2.0, 4.0)), "black: {blk:?}");
    let frz = detect(&tools(), &f, 6.0, Kind::Freeze, -60.0, 0.5).unwrap();
    assert!(near(&frz, (0.0, 4.0)) || near(&frz, (2.0, 4.0)) || near(&frz, (0.0, 2.0)), "freeze: {frz:?}");
    assert!(detect(&tools(), &f, 6.0, Kind::Silence, -40.0, 0.0).is_err());
}

#[test]
fn removing_the_silence_shortens_the_timeline_keeps_av_linked_and_undoes_in_one_step() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path());
    let mut eng = Engine::new("cut", ProjectSettings { width: 160, height: 120, fps: secs(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(&f).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: secs(0), source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
    let clip = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    let before_undo = eng.history().len();
    eng.dispatch(Command::RemoveRanges { clip: clip.clone(), ranges: vec![(secs(2), secs(4))] }).unwrap();
    assert_eq!(eng.history().len(), before_undo + 1, "one undo step");
    let seq = eng.project.active().unwrap();
    let total: f64 = seq.tracks.iter().filter(|t| t.kind == TrackKind::Video).flat_map(|t| t.clips.iter()).map(|c| c.duration.as_f64()).sum();
    assert!((total - 4.0).abs() < 0.05, "video is now 4 s, got {total}");
    let at: Vec<_> = seq.tracks.iter().filter(|t| t.kind == TrackKind::Audio).flat_map(|t| t.clips.iter()).collect();
    assert_eq!(at.len(), 2, "audio split in two pieces");
    let end = at.iter().map(|c| c.end().as_f64()).fold(0.0, f64::max);
    assert!((end - 4.0).abs() < 0.05, "audio ends at 4 s too: {end}");
    // second piece starts exactly where the first ends, and plays the source from 4 s
    let mut vs: Vec<_> = seq.tracks[0].clips.iter().collect();
    vs.sort_by_key(|a| a.start);
    assert_eq!(vs[0].end(), vs[1].start);
    assert!((vs[1].source_in.as_f64() - 4.0).abs() < 0.05);
    eng.undo().unwrap();
    assert_eq!(eng.project.active().unwrap().tracks[0].clips.len(), 1);
    assert!((eng.project.active().unwrap().tracks[0].clips[0].duration.as_f64() - 6.0).abs() < 0.01);
    // several ranges, one of them overlapping the clip start, one past the end
    eng.dispatch(Command::RemoveRanges { clip, ranges: vec![(secs(0), Rational::new(1, 2)), (secs(2), secs(3)), (secs(5), secs(9)), (Rational::new(5, 2), secs(4))] }).unwrap();
    let total: f64 = eng.project.active().unwrap().tracks[0].clips.iter().map(|c| c.duration.as_f64()).sum();
    // removed: 0-0.5, 2-4 (merged), 5-6 => 6 - 0.5 - 2 - 1 = 2.5
    assert!((total - 2.5).abs() < 0.06, "got {total}");
    assert!(eng.dispatch(Command::RemoveRanges { clip: "nope".into(), ranges: vec![(secs(1), secs(2))] }).is_err());
}
