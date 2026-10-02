//! Scopes draw real pictures: different pictures give different scopes, the spectrogram shows where the energy is.
use ffworks_core::process::Tools;
use ffworks_core::scopes::{render, Scope};
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}

fn raw(png: &std::path::Path) -> Vec<u8> {
    let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-i"]).arg(png).args(["-f", "rawvideo", "-pix_fmt", "gray", "-"]).output().unwrap();
    o.stdout
}

fn dims(png: &std::path::Path) -> (u32, u32) {
    let i = ffworks_core::ffprobe::probe(&tools(), png).unwrap();
    (i.video[0].width, i.video[0].height)
}

#[test]
fn video_scopes_differ_per_picture_and_the_spectrogram_peaks_at_the_tone() {
    let dir = tempfile::tempdir().unwrap();
    let mk = |name: &str, colour: &str| {
        let p = dir.path().join(name);
        let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", &format!("color=c={colour}:s=320x240:r=25:d=1"), "-f", "lavfi", "-i", "sine=f=2000:r=44100:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]).arg(&p).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        p
    };
    let (red, blue) = (mk("red.mp4", "red"), mk("blue.mp4", "blue"));
    let cache = dir.path().join("cache");
    for scope in [Scope::Waveform, Scope::Vectorscope, Scope::Histogram] {
        let a = render(&tools(), &red, 0.5, scope, &cache, "red").unwrap();
        let b = render(&tools(), &blue, 0.5, scope, &cache, "blue").unwrap();
        assert_ne!(raw(&a), raw(&b), "{scope:?} tells red and blue apart");
        assert!(dims(&a).0 >= 256 && dims(&a).1 >= 200, "{scope:?} {:?}", dims(&a));
        // cached: same path again
        assert_eq!(render(&tools(), &red, 0.5, scope, &cache, "red").unwrap(), a);
    }
    let sp = render(&tools(), &red, 0.0, Scope::Spectrogram, &cache, "red").unwrap();
    let (w, h) = dims(&sp);
    let px = raw(&sp);
    // 2 kHz of 22.05 kHz is about 9% of the way up from the bottom: the brightest row sits there
    let row_sum = |y: usize| -> u64 { (0..w as usize).map(|x| px[y * w as usize + x] as u64).sum() };
    let best = (0..h as usize).max_by_key(|y| row_sum(*y)).unwrap();
    let from_bottom = 1.0 - best as f64 / h as f64;
    assert!((from_bottom - 2000.0 / 22050.0).abs() < 0.04, "peak at {from_bottom}");
    // a file without audio has no spectrogram; negative time refused
    let silent = dir.path().join("v.mp4");
    assert!(Proc::new(tools().ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-pix_fmt", "yuv420p"]).arg(&silent).status().unwrap().success());
    assert!(render(&tools(), &silent, 0.0, Scope::Spectrogram, &cache, "silent").is_err());
    assert!(render(&tools(), &red, -1.0, Scope::Waveform, &cache, "x").is_err());
}
