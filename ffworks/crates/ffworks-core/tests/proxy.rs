//! Proxy generation with real FFmpeg: size, codec, audio, duration, caching by fingerprint, refusals.
use ffworks_core::engine::prepare_asset;
use ffworks_core::ffprobe::probe;
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::proxy;
use std::path::Path;
use std::process::Command;

fn tools() -> Tools {
    Tools::discover(None, None)
}
fn ff(args: &[&str]) {
    let o = Command::new(tools().ffmpeg).args(["-v", "error", "-y"]).args(args).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
}
fn run(dir: &Path, m: &ffworks_core::project::MediaAsset) -> std::path::PathBuf {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let out = proxy::proxy_path(&dir.join("cache"), m);
    let mut job = proxy::build_job(m, &out, Some(&caps)).unwrap();
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "proxy", "proxy", &CancelToken::new(), &dir.join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("proxy failed: {e}"));
    out
}

#[test]
fn proxies_are_540p_h264_with_stereo_aac_and_the_same_duration() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("big.mkv");
    // 1080p mpeg4 + 5.1-ish layout -> must come out as 960x540 H.264 yuv420p + stereo AAC
    ff(&["-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=25:d=2", "-f", "lavfi", "-i", "sine=f=440:r=44100:d=2", "-c:v", "mpeg4", "-q:v", "3", "-c:a", "pcm_s16le", "-shortest", src.to_str().unwrap()]);
    let m = prepare_asset(&tools(), &src).unwrap();
    assert!(proxy::eligible(&m));
    assert!(!proxy::status(&dir.path().join("cache"), &m).ready, "no proxy yet");
    let out = run(dir.path(), &m);
    let st = proxy::status(&dir.path().join("cache"), &m);
    assert!(st.ready && st.bytes.unwrap() > 1000 && st.path.as_deref() == Some(out.to_str().unwrap()));
    let info = probe(&tools(), &out).unwrap();
    let v = &info.video[0];
    assert_eq!((v.width, v.height, v.codec.as_str()), (960, 540, "h264"));
    assert_eq!(v.color.pix_fmt.as_deref(), Some("yuv420p"));
    assert_eq!(v.fps, Some(ffworks_core::Rational::from_int(25)));
    assert_eq!((info.audio[0].codec.as_str(), info.audio[0].channels, info.audio[0].sample_rate), ("aac", 2, 48000));
    assert!((info.duration.as_f64() - m.info.duration.as_f64()).abs() < 0.15, "{} vs {}", info.duration.as_f64(), m.info.duration.as_f64());
    // the original is untouched
    assert!(src.exists());
    // keyframes every ~12 frames: easy scrubbing
    let kf = Command::new(tools().ffprobe).args(["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pict_type", "-of", "csv=p=0"]).arg(&out).output().unwrap();
    let n_i = String::from_utf8_lossy(&kf.stdout).lines().filter(|l| l.trim() == "I").count();
    assert!(n_i >= 4, "expected a keyframe about every 12 frames of 50, got {n_i}");
}

#[test]
fn small_video_without_audio_is_not_upscaled_and_has_no_audio_stream() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("small.mp4");
    ff(&["-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", src.to_str().unwrap()]);
    let m = prepare_asset(&tools(), &src).unwrap();
    let out = run(dir.path(), &m);
    let info = probe(&tools(), &out).unwrap();
    assert_eq!((info.video[0].width, info.video[0].height), (320, 240));
    assert!(info.audio.is_empty());
}

#[test]
fn the_proxy_name_follows_the_content_so_edited_sources_get_a_fresh_one() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.mp4");
    let b = dir.path().join("b.mp4");
    ff(&["-f", "lavfi", "-i", "testsrc2=s=160x120:r=25:d=1", "-c:v", "libx264", a.to_str().unwrap()]);
    ff(&["-f", "lavfi", "-i", "testsrc2=s=160x120:r=25:d=2", "-c:v", "libx264", b.to_str().unwrap()]);
    let (ma, mb) = (prepare_asset(&tools(), &a).unwrap(), prepare_asset(&tools(), &b).unwrap());
    assert_ne!(proxy::proxy_path(dir.path(), &ma), proxy::proxy_path(dir.path(), &mb));
    // the same file imported twice maps to the same proxy
    assert_eq!(proxy::proxy_path(dir.path(), &ma), proxy::proxy_path(dir.path(), &prepare_asset(&tools(), &a).unwrap()));
}

#[test]
fn audio_only_stills_and_generated_media_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("a.wav");
    ff(&["-f", "lavfi", "-i", "sine=f=440:d=1", wav.to_str().unwrap()]);
    let png = dir.path().join("a.png");
    ff(&["-f", "lavfi", "-i", "testsrc2=s=64x64", "-frames:v", "1", png.to_str().unwrap()]);
    for p in [&wav, &png] {
        let m = prepare_asset(&tools(), p).unwrap();
        assert!(!proxy::eligible(&m));
        assert!(proxy::build_job(&m, &dir.path().join("o.mp4"), None).is_err());
        assert!(!proxy::status(dir.path(), &m).eligible);
    }
    let solid = ffworks_core::generators::solid_asset("#ff0000", &ffworks_core::project::ProjectSettings::default()).unwrap();
    assert!(!proxy::eligible(&solid));
}

#[test]
fn a_failed_proxy_leaves_no_partial_file_and_does_not_look_ready() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("v.mp4");
    ff(&["-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=1", "-c:v", "libx264", src.to_str().unwrap()]);
    let mut m = prepare_asset(&tools(), &src).unwrap();
    let t = tools();
    // the source vanishes before the proxy job runs
    let out = proxy::proxy_path(dir.path(), &m);
    let mut job = proxy::build_job(&m, &out, None).unwrap();
    job.program = t.ffmpeg.clone();
    std::fs::remove_file(&src).unwrap();
    assert!(run_job(&t, &job, "proxy", "proxy", &CancelToken::new(), &dir.path().join("tmp"), &mut |_| {}).is_err());
    assert!(!out.exists(), "no output on failure");
    assert!(std::fs::read_dir(out.parent().unwrap()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains("partial")), "no partial file left");
    m.fingerprint = None;
    assert!(!proxy::status(dir.path(), &m).ready);
}
