//! End-to-end tests against real FFmpeg/FFprobe with tiny synthetic fixtures (spec §173).
//! Phase 1 acceptance, engine level: import -> probe -> place -> trim/split/move/gain -> save -> load -> export -> ffprobe + pixel/audio checks.
use ffworks_core::analysis;
use ffworks_core::commands::{Command, Edge};
use ffworks_core::engine::{fingerprint, Engine};
use ffworks_core::ffmpeg::{compile, ExportSettings, RenderOptions};
use ffworks_core::ffprobe::probe;
use ffworks_core::jobs::{run_job, CancelToken, JobState};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::{ProjectSettings, TrackKind};
use ffworks_core::{render_graph, Error, Rational};
use std::path::{Path, PathBuf};
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}

fn ffmpeg(args: &[&str]) {
    let out = Proc::new(tools().ffmpeg).args(["-v", "error", "-y"]).args(args).output().expect("ffmpeg runs");
    assert!(out.status.success(), "fixture generation failed: {}", String::from_utf8_lossy(&out.stderr));
}

/// color video + sine audio. Folder name has a space and a non-ASCII char on purpose (spec §100).
fn fixture(dir: &Path, name: &str, color: &str, size: &str, rate: &str, freq: u32, secs: u32) -> PathBuf {
    let p = dir.join(name);
    ffmpeg(&[
        "-f", "lavfi", "-i", &format!("color=c={color}:s={size}:r={rate}:d={secs}"),
        "-f", "lavfi", "-i", &format!("sine=f={freq}:r=44100:d={secs}"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "12", "-c:a", "aac", "-shortest",
    ]
    .iter()
    .copied()
    .chain([p.to_str().unwrap()])
    .collect::<Vec<_>>());
    p
}

fn pixel_at(video: &Path, t: f64) -> (u8, u8, u8) {
    let out = Proc::new(tools().ffmpeg)
        .args(["-v", "error", "-ss", &format!("{t}"), "-i"])
        .arg(video)
        .args(["-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .output()
        .unwrap();
    assert_eq!(out.stdout.len(), 3, "no frame at t={t}");
    (out.stdout[0], out.stdout[1], out.stdout[2])
}

fn mean_volume_db(media: &Path, from: f64, dur: f64) -> f64 {
    let out = Proc::new(tools().ffmpeg)
        .args(["-nostdin", "-ss", &from.to_string(), "-t", &dur.to_string(), "-i"])
        .arg(media)
        .args(["-vn", "-af", "volumedetect", "-f", "null", "-"])
        .output()
        .unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    err.lines().find_map(|l| l.split("mean_volume:").nth(1)).and_then(|v| v.trim().trim_end_matches(" dB").parse().ok()).unwrap_or(-91.0)
}

fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

struct Built {
    eng: Engine,
    a: PathBuf,
    b: PathBuf,
    dir: tempfile::TempDir,
}

fn build() -> Built {
    let dir = tempfile::Builder::new().prefix("ffw ü ").tempdir().unwrap();
    let a = fixture(dir.path(), "a red.mp4", "red", "320x240", "25", 440, 4);
    let b = fixture(dir.path(), "b_blue.mp4", "blue", "640x480", "24000/1001", 880, 4);
    let mut eng = Engine::new("e2e", ProjectSettings { width: 640, height: 360, fps: secs(30), sample_rate: 48000 }, tools());
    let ma = eng.import_media(&a).unwrap();
    let mb = eng.import_media(&b).unwrap();
    let seq = eng.project.active().unwrap();
    let v1 = seq.tracks.iter().find(|t| t.kind == TrackKind::Video).unwrap().id.clone();
    let place = |media: &str, start: Rational| Command::PlaceClip { media: media.into(), track: v1.clone(), start, source_in: None, duration: None, with_audio: true, audio_track: None };
    eng.dispatch(place(&ma, secs(0))).unwrap();
    eng.dispatch(place(&mb, secs(4))).unwrap();
    // trim A to 3s -> gap 3..4
    let a_id = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    eng.dispatch(Command::TrimClip { clip: a_id.clone(), edge: Edge::End, to: secs(3) }).unwrap();
    // split B at 6, move second half to 7 -> gap 6..7
    let b_id = eng.project.active().unwrap().tracks[0].clips[1].id.clone();
    eng.dispatch(Command::SplitClip { clip: b_id, at: secs(6) }).unwrap();
    let b2 = eng.project.active().unwrap().tracks[0].clips[2].id.clone();
    eng.dispatch(Command::MoveClip { clip: b2, start: secs(7), track: None }).unwrap();
    // -6 dB on A
    eng.dispatch(Command::SetClipGain { clip: a_id, gain_db: -6.0, relative: false }).unwrap();
    Built { eng, a, b, dir }
}

fn export(eng: &Engine, out: &Path, preset: &str) -> Vec<JobState> {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let g = render_graph::build(&eng.project).unwrap();
    let mut job = compile(&g, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find(preset).unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap();
    job.program = t.ffmpeg.clone();
    let tmp = out.parent().unwrap().join("tmp");
    let mut states = vec![];
    run_job(&t, &job, "e2e", "export", &CancelToken::new(), &tmp, &mut |s| states.push(s)).unwrap_or_else(|e| panic!("export failed: {e}"));
    states
}

#[test]
fn phase1_acceptance_roundtrip_and_export() {
    let Built { mut eng, a, b, dir } = build();
    let (fa, fb) = (fingerprint(&a).unwrap(), fingerprint(&b).unwrap());

    // metadata
    let ma = &eng.project.media[0];
    assert_eq!(ma.info.video[0].width, 320);
    assert_eq!(ma.info.video[0].color.pix_fmt.as_deref(), Some("yuv420p"));
    assert!(ma.info.has_audio());
    assert_eq!(eng.project.media[1].info.video[0].fps, Some(Rational::new(24000, 1001)));

    // save -> close -> reopen
    let proj = dir.path().join("my project ü.ffworks");
    eng.save(&proj).unwrap();
    let reopened = Engine::load(&proj, tools()).unwrap();
    assert_eq!(reopened.project, eng.project);
    assert!(reopened.offline_media().is_empty());

    // export from the *reopened* project
    let out = dir.path().join("out ü.mp4");
    let states = export(&reopened, &out, "h264_mp4");
    assert!(states.contains(&JobState::Completed));
    assert!(states.iter().any(|s| matches!(s, JobState::Rendering { fraction: Some(f), .. } if *f > 0.0)), "expected real progress events");
    assert!(!out.with_file_name("out ü.ffworks-partial.mp4").exists(), "partial file must be renamed away");

    // FFprobe verification (spec §166)
    let info = probe(&tools(), &out).unwrap();
    assert_eq!((info.video[0].width, info.video[0].height), (640, 360));
    assert_eq!(info.video[0].fps, Some(secs(30)));
    assert_eq!(info.video[0].codec, "h264");
    assert_eq!(info.audio[0].sample_rate, 48000);
    let d = info.duration.as_f64();
    assert!((d - 9.0).abs() < 0.1, "duration {d}");

    // The export reflects the edit: red | black gap | blue | black gap | blue
    let near = |p: (u8, u8, u8), want: (i32, i32, i32)| {
        let (r, g, b) = (p.0 as i32, p.1 as i32, p.2 as i32);
        (r - want.0).abs() < 60 && (g - want.1).abs() < 60 && (b - want.2).abs() < 60
    };
    assert!(near(pixel_at(&out, 0.5), (255, 0, 0)), "t=0.5 should be red");
    assert!(near(pixel_at(&out, 2.9), (255, 0, 0)), "t=2.9 should be red");
    assert!(near(pixel_at(&out, 3.5), (0, 0, 0)), "t=3.5 should be black (trimmed gap)");
    assert!(near(pixel_at(&out, 5.0), (0, 0, 255)), "t=5 should be blue");
    assert!(near(pixel_at(&out, 6.5), (0, 0, 0)), "t=6.5 should be black (moved clip gap)");
    assert!(near(pixel_at(&out, 8.0), (0, 0, 255)), "t=8 should be blue");

    // audio: present in clips, silent in gaps, A is 6 dB quieter than B
    let a_level = mean_volume_db(&out, 0.5, 2.0);
    let gap1 = mean_volume_db(&out, 3.2, 0.6);
    let b_level = mean_volume_db(&out, 4.2, 1.5);
    let gap2 = mean_volume_db(&out, 6.2, 0.6);
    let b2_level = mean_volume_db(&out, 7.2, 1.5);
    assert!(a_level > -40.0 && b_level > -40.0 && b2_level > -40.0, "{a_level} {b_level} {b2_level}");
    assert!(gap1 < -60.0 && gap2 < -60.0, "gaps must be silent: {gap1} {gap2}");
    assert!((b_level - a_level - 6.0).abs() < 1.5, "gain: A={a_level} B={b_level}");

    // sources untouched
    assert_eq!(fingerprint(&a).unwrap(), fa);
    assert_eq!(fingerprint(&b).unwrap(), fb);
}

#[test]
fn preview_range_at_quarter_resolution_uses_same_graph() {
    let Built { eng, dir, .. } = build();
    let t = tools();
    let g = render_graph::build(&eng.project).unwrap();
    let out = dir.path().join("preview.mp4");
    let mut job = compile(&g, &RenderOptions { output: out.clone(), settings: ExportSettings::find("h264_mp4").unwrap(), range: Some((secs(4), secs(6))), scale_div: 4 }, None).unwrap();
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "p", "preview", &CancelToken::new(), &dir.path().join("tmp"), &mut |_| {}).unwrap();
    let info = probe(&t, &out).unwrap();
    assert_eq!((info.video[0].width, info.video[0].height), (160, 90));
    assert!((info.duration.as_f64() - 2.0).abs() < 0.15);
    let p = pixel_at(&out, 1.0);
    assert!(p.2 > 150 && p.0 < 80, "preview range 4..6 must be blue, got {p:?}");
}

#[test]
fn audio_only_export_and_webm() {
    let Built { eng, dir, .. } = build();
    let wav = dir.path().join("mix.wav");
    export(&eng, &wav, "wav");
    let i = probe(&tools(), &wav).unwrap();
    assert!(!i.has_video() && i.has_audio());
    assert!((i.duration.as_f64() - 9.0).abs() < 0.1);
    let webm = dir.path().join("o.webm");
    export(&eng, &webm, "vp9_webm");
    assert_eq!(probe(&tools(), &webm).unwrap().video[0].codec, "vp9");
}

#[test]
fn same_media_used_twice_and_overlapping_layers() {
    let dir = tempfile::tempdir().unwrap();
    let a = fixture(dir.path(), "a.mp4", "red", "320x240", "25", 440, 4);
    let mut eng = Engine::new("t", ProjectSettings { width: 320, height: 240, fps: secs(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(&a).unwrap();
    eng.dispatch(Command::AddTrack { kind: TrackKind::Video, name: None }).unwrap();
    eng.dispatch(Command::AddTrack { kind: TrackKind::Audio, name: None }).unwrap();
    let seq = eng.project.active().unwrap();
    let v: Vec<String> = seq.tracks.iter().filter(|t| t.kind == TrackKind::Video).map(|t| t.id.clone()).collect();
    eng.dispatch(Command::PlaceClip { media: m.clone(), track: v[0].clone(), start: secs(0), source_in: None, duration: Some(secs(2)), with_audio: true, audio_track: None }).unwrap();
    // same media on the upper layer overlapping in time; its audio goes to A2 automatically
    eng.dispatch(Command::PlaceClip { media: m, track: v[1].clone(), start: secs(1), source_in: Some(secs(1)), duration: Some(secs(2)), with_audio: true, audio_track: None }).unwrap();
    let out = dir.path().join("o.mp4");
    export(&eng, &out, "h264_mp4");
    let i = probe(&tools(), &out).unwrap();
    assert!((i.duration.as_f64() - 3.0).abs() < 0.1, "{}", i.duration.as_f64());
    assert!(i.has_audio());
}

#[test]
fn export_refuses_to_overwrite_a_source() {
    let Built { eng, a, dir: _dir, .. } = build();
    let g = render_graph::build(&eng.project).unwrap();
    let r = compile(&g, &RenderOptions { output: a.clone(), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, None);
    assert!(matches!(r, Err(Error::Validation(_))));
    assert!(a.exists());
}

#[test]
fn canceling_stops_ffmpeg_and_leaves_no_output() {
    let Built { eng, dir, .. } = build();
    let t = tools();
    let g = render_graph::build(&eng.project).unwrap();
    let out = dir.path().join("c.mp4");
    // slow settings so there is time to cancel
    let mut settings = ExportSettings::find("h264_mp4").unwrap();
    settings.encoder_preset = Some("veryslow".into());
    let mut job = compile(&g, &RenderOptions { output: out.clone(), settings, range: None, scale_div: 1 }, None).unwrap();
    job.program = t.ffmpeg.clone();
    let cancel = CancelToken::new();
    let c2 = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        c2.cancel();
    });
    let r = run_job(&t, &job, "x", "export", &cancel, &dir.path().join("tmp"), &mut |_| {});
    assert!(matches!(r, Err(Error::Canceled)), "{r:?}");
    assert!(!out.exists());
}

#[test]
fn failed_ffmpeg_surfaces_log_and_message() {
    let Built { eng, dir, .. } = build();
    let t = tools();
    let g = render_graph::build(&eng.project).unwrap();
    let out = dir.path().join("no_such_dir/x.mp4");
    let mut job = compile(&g, &RenderOptions { output: out, settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, None).unwrap();
    job.program = t.ffmpeg.clone();
    let mut last = None;
    let r = run_job(&t, &job, "f", "export", &CancelToken::new(), &dir.path().join("tmp"), &mut |s| last = Some(s));
    assert!(r.is_err());
    assert!(matches!(last, Some(JobState::Failed { .. })));
}

#[test]
fn waveform_and_thumbnails_are_real_and_cached() {
    let dir = tempfile::tempdir().unwrap();
    let a = fixture(dir.path(), "a.mp4", "green", "320x240", "25", 440, 3);
    let cache = dir.path().join("cache");
    let w = analysis::waveform(&tools(), &a, &cache, "k1").unwrap();
    assert!((w.peaks.len() as i64 - 300).abs() <= 8, "{}", w.peaks.len());
    assert!(w.peaks.iter().skip(5).take(100).all(|p| *p > 0.05), "sine must show up in the peaks");
    assert!(cache.join("k1.waveform.json").exists());
    assert_eq!(analysis::waveform(&tools(), &a, &cache, "k1").unwrap(), w);
    let th = analysis::thumbnails(&tools(), &a, &cache, "k1", 1, 48).unwrap();
    assert_eq!(th.len(), 3);
    assert!(std::fs::metadata(&th[0]).unwrap().len() > 100);
}

#[test]
fn corrupt_media_is_reported_not_fatal() {
    let dir = tempfile::tempdir().unwrap();
    let bad = dir.path().join("bad.mp4");
    std::fs::write(&bad, b"this is not media").unwrap();
    let mut eng = Engine::new("t", ProjectSettings::default(), tools());
    assert!(eng.import_media(&bad).is_err());
    assert!(eng.import_media(&dir.path().join("missing.mp4")).is_err());
    assert!(eng.project.media.is_empty());
}

fn single_clip_project(dir: &Path, color: &str) -> (Engine, String) {
    let src = fixture(dir, "src.mp4", color, "320x240", "25", 440, 2);
    let mut eng = Engine::new("fx", ProjectSettings { width: 320, height: 240, fps: secs(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(&src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: secs(0), source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
    let clip = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    (eng, clip)
}

#[test]
fn effects_and_opacity_change_the_rendered_pixels() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, clip) = single_clip_project(dir.path(), "red");
    let plain = dir.path().join("plain.mp4");
    export(&eng, &plain, "h264_mp4");
    let p0 = pixel_at(&plain, 1.0);
    assert!(p0.0 > 180 && p0.1 < 60, "baseline red {p0:?}");

    // saturation 0 -> grey (r≈g≈b)
    let mut o = std::collections::BTreeMap::new();
    o.insert("amount".to_string(), 0.0);
    eng.dispatch(Command::AddEffect { clip: clip.clone(), effect: "saturation".into(), params: o, index: None }).unwrap();
    let grey = dir.path().join("grey.mp4");
    export(&eng, &grey, "h264_mp4");
    let g = pixel_at(&grey, 1.0);
    assert!((g.0 as i32 - g.1 as i32).abs() < 25 && (g.1 as i32 - g.2 as i32).abs() < 25, "expected grey, got {g:?}");

    // disabling the effect restores red (stack toggle is honoured)
    let fx = eng.project.active().unwrap().tracks[0].clips[0].effects[0].id.clone();
    eng.dispatch(Command::SetEffectEnabled { clip: clip.clone(), effect_id: fx, enabled: false }).unwrap();
    let back = dir.path().join("back.mp4");
    export(&eng, &back, "h264_mp4");
    assert!(pixel_at(&back, 1.0).0 > 180);

    // opacity 0.5 over the black canvas halves the brightness
    eng.dispatch(Command::SetClipOpacity { clip: clip.clone(), opacity: 0.5 }).unwrap();
    let half = dir.path().join("half.mp4");
    export(&eng, &half, "h264_mp4");
    let h = pixel_at(&half, 1.0);
    assert!(h.0 > 60 && h.0 < 170 && h.1 < 40, "expected dim red, got {h:?}");
}

#[test]
fn brightness_minus_one_darkens_white_to_black() {
    // eq=brightness only moves luma, so use a chroma-neutral source for an exact black.
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, clip) = single_clip_project(dir.path(), "white");
    let mut o = std::collections::BTreeMap::new();
    o.insert("amount".to_string(), -1.0);
    eng.dispatch(Command::AddEffect { clip, effect: "brightness".into(), params: o, index: None }).unwrap();
    let out = dir.path().join("dark.mp4");
    export(&eng, &out, "h264_mp4");
    let d = pixel_at(&out, 1.0);
    assert!(d.0 < 40 && d.1 < 40 && d.2 < 40, "expected black, got {d:?}");
}

#[test]
fn every_registered_effect_renders_in_real_ffmpeg() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, clip) = single_clip_project(dir.path(), "green");
    for def in ffworks_core::effects::registry() {
        eng.dispatch(Command::AddEffect { clip: clip.clone(), effect: def.id.into(), params: Default::default(), index: None }).unwrap();
    }
    let out = dir.path().join("all.mp4");
    export(&eng, &out, "h264_mp4"); // panics with FFmpeg's message if any filter string is rejected
    assert!(probe(&tools(), &out).unwrap().video[0].width == 320);
}

#[test]
fn missing_filter_is_reported_before_running() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, clip) = single_clip_project(dir.path(), "red");
    eng.dispatch(Command::AddEffect { clip, effect: "blur".into(), params: Default::default(), index: None }).unwrap();
    let mut caps = Capabilities::discover(&tools()).unwrap();
    caps.filters.remove("gblur");
    let g = render_graph::build(&eng.project).unwrap();
    let r = compile(&g, &RenderOptions { output: dir.path().join("o.mp4"), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, Some(&caps));
    assert!(matches!(r, Err(Error::Validation(m)) if m.contains("gblur")));
}

#[test]
fn processed_preview_shows_effects_is_cached_and_invalidates() {
    use ffworks_core::preview;
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, clip) = single_clip_project(dir.path(), "red");
    let t = tools();
    let cache = dir.path().join("cache");
    let render = |eng: &Engine| preview::render(&t, None, &eng.project, secs(0), secs(2), 2, &cache, &CancelToken::new(), &mut |_| {}).unwrap();

    let plain = render(&eng);
    assert!(!plain.cached);
    let info = probe(&t, &plain.path).unwrap();
    assert_eq!((info.video[0].width, info.video[0].height), (160, 120), "half resolution");
    assert!(pixel_at(&plain.path, 1.0).0 > 150, "unprocessed preview is red");
    assert!(render(&eng).cached, "same project + range reuses the file");

    let mut o = std::collections::BTreeMap::new();
    o.insert("amount".to_string(), 0.0);
    eng.dispatch(Command::AddEffect { clip, effect: "saturation".into(), params: o, index: None }).unwrap();
    let fx = render(&eng);
    assert_ne!(fx.key, plain.key, "an edit must change the key");
    assert!(!fx.cached);
    let g = pixel_at(&fx.path, 1.0);
    assert!((g.0 as i32 - g.1 as i32).abs() < 25, "processed preview must show the effect (grey), got {g:?}");

    // renaming the project does not invalidate
    eng.dispatch(Command::RenameProject { name: "other".into() }).unwrap();
    assert!(render(&eng).cached);
}

#[test]
fn offline_media_is_relinked_by_content_even_when_renamed_and_moved() {
    let dir = tempfile::tempdir().unwrap();
    let a = fixture(dir.path(), "orig.mp4", "red", "320x240", "25", 440, 2);
    let b = fixture(dir.path(), "other.mp4", "blue", "320x240", "25", 880, 2);
    let mut eng = Engine::new("r", ProjectSettings { width: 320, height: 240, fps: secs(25), sample_rate: 48000 }, tools());
    let ma = eng.import_media(&a).unwrap();
    let mb = eng.import_media(&b).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: ma.clone(), track: v, start: secs(0), source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();

    // user moves + renames the file; a same-named decoy with different content also exists elsewhere
    let new_home = dir.path().join("moved/deeper");
    std::fs::create_dir_all(&new_home).unwrap();
    std::fs::rename(&a, new_home.join("renamed copy.mp4")).unwrap();
    let decoy_dir = dir.path().join("decoy");
    std::fs::create_dir_all(&decoy_dir).unwrap();
    std::fs::copy(&b, decoy_dir.join("orig.mp4")).unwrap(); // same name as the missing file, different content
    assert_eq!(eng.offline_media(), vec![ma.clone()]);

    let before = eng.project.clone();
    let (done, rest) = eng.relink_search(&[dir.path().to_path_buf()]).unwrap();
    assert_eq!(done, vec![ma.clone()], "exact content match relinks despite rename");
    assert!(rest.is_empty());
    assert!(eng.offline_media().is_empty());
    let asset = eng.project.media(&ma).unwrap();
    assert!(asset.path.ends_with("renamed copy.mp4"));
    assert_eq!(asset.id, ma, "clip references survive");
    // clip still renders from the new location
    let out = dir.path().join("o.mp4");
    export(&eng, &out, "h264_mp4");
    assert!(pixel_at(&out, 1.0).0 > 150);
    // undo restores the offline state exactly
    eng.undo().unwrap();
    assert_eq!(eng.project, before);
    let _ = mb;
}

#[test]
fn name_only_matches_are_reported_but_never_auto_applied() {
    let dir = tempfile::tempdir().unwrap();
    let a = fixture(dir.path(), "orig.mp4", "red", "320x240", "25", 440, 2);
    let mut eng = Engine::new("r", ProjectSettings::default(), tools());
    eng.import_media(&a).unwrap();
    std::fs::remove_file(&a).unwrap();
    let decoy = dir.path().join("elsewhere");
    std::fs::create_dir_all(&decoy).unwrap();
    fixture(&decoy, "orig.mp4", "blue", "320x240", "25", 880, 3);
    let (done, rest) = eng.relink_search(&[dir.path().to_path_buf()]).unwrap();
    assert!(done.is_empty());
    assert_eq!(rest.len(), 1);
    assert!(!rest[0].1[0].exact && rest[0].1[0].reason.contains("name"));
    assert_eq!(eng.offline_media().len(), 1, "still offline");
}

#[test]
fn relink_refuses_a_file_missing_a_needed_stream() {
    let dir = tempfile::tempdir().unwrap();
    let a = fixture(dir.path(), "a.mp4", "red", "320x240", "25", 440, 2);
    let mut eng = Engine::new("r", ProjectSettings::default(), tools());
    let m = eng.import_media(&a).unwrap();
    let silent = dir.path().join("silent.mp4");
    ffmpeg(&["-f", "lavfi", "-i", "color=c=red:s=320x240:r=25:d=2", "-c:v", "libx264", silent.to_str().unwrap()]);
    assert!(eng.relink_media(&m, &silent).is_err());
    assert!(eng.project.media(&m).unwrap().info.has_audio());
}
