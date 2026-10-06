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

#[test]
fn a_recording_that_runs_a_little_slow_is_measured_as_drift_and_the_speed_fixes_it() {
    use ffworks_core::audiosync::measure_drift;
    use ffworks_core::jobs::CancelToken;
    let dir = tempfile::tempdir().unwrap();
    let (a, b, fixed) = (dir.path().join("a.wav"), dir.path().join("b.wav"), dir.path().join("fixed.wav"));
    let run = |args: &[&str]| {
        let o = Proc::new(tools().ffmpeg).args(["-v", "error", "-y"]).args(args).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    };
    // 100 s of noise; the second recording is the same sound 2.5 s late and 0.1 % slower in its clock (events further apart)
    run(&["-f", "lavfi", "-i", "anoisesrc=d=100:c=pink:r=44100:seed=5:a=0.5", "-ac", "1", a.to_str().unwrap()]);
    run(&["-i", a.to_str().unwrap(), "-af", "asetrate=44100*0.999,aresample=44100,adelay=2500", "-ac", "1", b.to_str().unwrap()]);
    let d = measure_drift(&tools(), &a, &b, 90.0, &CancelToken::new()).unwrap();
    assert!((d.lag_start - 2.5).abs() < 0.05, "{d:?}");
    // stretching by 1/0.999 puts events 0.1 % further apart: the lag grows about 0.001 s per second
    assert!((d.drift - 0.001).abs() < 0.0002, "{d:?}");
    assert!((d.speed - 1.001).abs() < 0.0002 && d.confidence > 0.1, "{d:?}");

    // playing the second recording at the measured speed removes the drift
    run(&["-i", b.to_str().unwrap(), "-af", &format!("atempo={}", d.speed), "-ac", "1", fixed.to_str().unwrap()]);
    let after = measure_drift(&tools(), &a, &fixed, 90.0, &CancelToken::new()).unwrap();
    assert!(after.drift.abs() < 0.0002, "after the correction the lag no longer changes: {after:?}");

    // too little overlap is refused with the reason
    let e = measure_drift(&tools(), &a, &b, 20.0, &CancelToken::new()).unwrap_err().to_string();
    assert!(e.contains("at least 60 seconds"), "{e}");
}
