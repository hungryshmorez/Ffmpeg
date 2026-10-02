//! Auto-sync on real files: the same noise recorded 1.37 s later (and quieter, with extra noise) is found, and the
//! engine can then place the clip so both line up.
use ffworks_core::audiosync::measure;
use ffworks_core::process::Tools;
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}

#[test]
fn a_delayed_quieter_noisy_copy_is_found_to_the_millisecond() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.wav");
    let b = dir.path().join("b.wav");
    let run = |args: &[&str]| {
        let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-y"]).args(args).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    };
    // 8 s of seeded pink-ish noise with a few clicks, then a 1.37 s-late, half-volume copy with extra hiss
    run(&["-f", "lavfi", "-i", "anoisesrc=d=8:c=pink:r=44100:seed=5:a=0.5", "-ac", "1", a.to_str().unwrap()]);
    run(&["-i", a.to_str().unwrap(), "-f", "lavfi", "-i", "anoisesrc=d=10:c=white:r=44100:seed=9:a=0.05", "-filter_complex", "[0:a]volume=0.5,adelay=1370[d];[d][1:a]amix=inputs=2:duration=longest:normalize=0[o]", "-map", "[o]", "-ac", "1", b.to_str().unwrap()]);
    let r = measure(&tools(), &a, &b).unwrap();
    assert!((r.lag_seconds - 1.37).abs() < 0.002, "{r:?}");
    assert!(r.confidence > 0.2, "{r:?}");
    let back = measure(&tools(), &b, &a).unwrap();
    assert!((back.lag_seconds + 1.37).abs() < 0.002, "{back:?}");
    // a file with no audio is refused with a reason
    let v = dir.path().join("v.mp4");
    run(&["-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-pix_fmt", "yuv420p", v.to_str().unwrap()]);
    assert!(measure(&tools(), &a, &v).is_err());
}
