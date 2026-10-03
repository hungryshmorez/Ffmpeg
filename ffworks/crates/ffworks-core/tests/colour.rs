//! Colour management: footage tagged BT.601 / BT.2020 / HDR is converted to the project's Rec.709, and exports are tagged
//! Rec.709. Real FFmpeg renders; pictures are measured, and a control shows the error the conversion removes.
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile_project, ExportSettings, RenderOptions};
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::ProjectSettings;
use ffworks_core::Rational;
use std::path::{Path, PathBuf};
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}
fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

/// A 2 s clip of one RGB colour, encoded with `matrix` and labelled with the three tags (`-` leaves a tag unset).
fn footage(dir: &Path, name: &str, rgb: &str, matrix: &str, tags: (&str, &str, &str)) -> PathBuf {
    let p = dir.join(name);
    let mut cmd = Proc::new(tools().ffmpeg);
    cmd.args(["-v", "error", "-y", "-f", "lavfi", "-i"])
        .arg(format!("color=c={rgb}:s=160x120:r=25:d=2"))
        .args(["-vf", &format!("format=rgb24,scale=out_color_matrix={matrix}:out_range=tv,format=yuv420p"), "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p"]);
    for (opt, v) in [("-colorspace", tags.0), ("-color_trc", tags.1), ("-color_primaries", tags.2)] {
        if v != "-" {
            cmd.args([opt, v]);
        }
    }
    let out = cmd.arg(&p).output().unwrap();
    assert!(out.status.success(), "fixture: {}", String::from_utf8_lossy(&out.stderr));
    p
}

fn one_clip(src: &Path) -> Engine {
    let mut eng = Engine::new("c", ProjectSettings { width: 160, height: 120, fps: secs(25), sample_rate: 48000 }, tools());
    let m = eng.import_media(src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: secs(0), source_in: None, duration: None, with_audio: false, audio_track: None }).unwrap();
    eng
}

fn job(eng: &Engine, out: &Path) -> ffworks_core::ffmpeg::FfmpegJob {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let mut job = compile_project(&eng.project, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("h264_mp4").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap_or_else(|e| panic!("compile: {e}"));
    job.program = t.ffmpeg.clone();
    job
}

fn export(eng: &Engine, out: &Path) -> ffworks_core::ffmpeg::FfmpegJob {
    let j = job(eng, out);
    run_job(&tools(), &j, "c", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export failed: {e}"));
    j
}

/// Centre pixel of the first frame, decoded as Rec.709 limited range (what the export claims to be), whatever its tags say.
fn rgb709(video: &Path) -> (i32, i32, i32) {
    let out = Proc::new(tools().ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(video)
        .args(["-frames:v", "1", "-vf", "scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24,crop=2:2:80:60,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .output()
        .unwrap();
    assert_eq!(out.stdout.len(), 3);
    (out.stdout[0] as i32, out.stdout[1] as i32, out.stdout[2] as i32)
}

fn error(got: (i32, i32, i32), want: (i32, i32, i32)) -> i32 {
    (got.0 - want.0).abs().max((got.1 - want.1).abs()).max((got.2 - want.2).abs())
}

fn probe_tag(video: &Path, field: &str) -> String {
    let out = Proc::new("ffprobe").args(["-v", "error", "-select_streams", "v:0", "-show_entries", &format!("stream={field}"), "-of", "csv=p=0"]).arg(video).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn bt601_footage_keeps_its_colours_and_the_same_footage_labelled_wrongly_does_not() {
    let dir = tempfile::tempdir().unwrap();
    let want = (0, 255, 0);
    let sd = footage(dir.path(), "sd.mp4", "lime", "bt601", ("smpte170m", "smpte170m", "smpte170m"));
    let eng = one_clip(&sd);
    let good = dir.path().join("good.mp4");
    let j = export(&eng, &good);
    assert!(j.filter_graph.contains("colorspace=all=bt709:iall=bt601-6-525"), "{}", j.filter_graph);
    let e = error(rgb709(&good), want);
    assert!(e < 12, "converted: {:?} is {e} off {want:?}", rgb709(&good));

    // control: the identical pixels claiming to be Rec.709 are not converted, and come out visibly wrong
    let lie = footage(dir.path(), "lie.mp4", "lime", "bt601", ("bt709", "bt709", "bt709"));
    let eng = one_clip(&lie);
    let bad = dir.path().join("bad.mp4");
    let j = export(&eng, &bad);
    assert!(!j.filter_graph.contains("colorspace="), "a Rec.709 file is left alone");
    assert!(error(rgb709(&bad), want) > 25, "the control must show the error: {:?}", rgb709(&bad));
}

#[test]
fn bt2020_sdr_footage_is_converted_too() {
    let dir = tempfile::tempdir().unwrap();
    // a saturated blue-ish colour, where the BT.2020 primaries differ most from Rec.709
    let wide = footage(dir.path(), "w.mp4", "0x2060ff", "bt2020", ("bt2020nc", "bt709", "bt2020"));
    let eng = one_clip(&wide);
    let out = dir.path().join("o.mp4");
    let j = export(&eng, &out);
    assert!(j.filter_graph.contains("iall=bt2020"), "{}", j.filter_graph);
    // the same pixels claiming to be Rec.709 are not converted
    let lie = footage(dir.path(), "lie.mp4", "0x2060ff", "bt2020", ("bt709", "bt709", "bt709"));
    let bad = dir.path().join("bad.mp4");
    let j2 = export(&one_clip(&lie), &bad);
    assert!(!j2.filter_graph.contains("colorspace="));
    let (a, b) = (rgb709(&out), rgb709(&bad));
    assert!(error(a, b) >= 4, "the conversion must change the picture: converted {a:?}, unconverted {b:?}");
    // and it stays a sane colour: still clearly blue
    assert!(a.2 > 200 && a.0 < 90, "still blue: {a:?}");
}

#[test]
fn every_export_is_tagged_rec709() {
    let dir = tempfile::tempdir().unwrap();
    let plain = footage(dir.path(), "p.mp4", "red", "bt709", ("-", "-", "-"));
    let eng = one_clip(&plain);
    let out = dir.path().join("o.mp4");
    let j = export(&eng, &out);
    assert!(!j.filter_graph.contains("colorspace=") && !j.filter_graph.contains("zscale"), "untagged footage is untouched");
    for (field, want) in [("color_space", "bt709"), ("color_transfer", "bt709"), ("color_primaries", "bt709")] {
        assert_eq!(probe_tag(&out, field), want, "{field}");
    }
}

#[test]
fn hdr_footage_is_tone_mapped_to_sdr_instead_of_looking_washed_out() {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    if !caps.has_filter("zscale") || !caps.has_filter("tonemap") {
        eprintln!("SKIPPED: this FFmpeg has no zscale/tonemap");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    // PQ code of a bright, saturated-free grey: encode a grey that PQ-decodes to about HDR reference white
    let p = dir.path().join("hdr.mp4");
    let out = Proc::new(&t.ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x949494:s=160x120:r=25:d=2", "-vf", "format=yuv420p10le", "-c:v", "libx265", "-crf", "10", "-pix_fmt", "yuv420p10le", "-colorspace", "bt2020nc", "-color_primaries", "bt2020", "-color_trc", "smpte2084"])
        .arg(&p)
        .output()
        .unwrap();
    if !out.status.success() {
        eprintln!("SKIPPED: no libx265 to make the HDR fixture: {}", String::from_utf8_lossy(&out.stderr));
        return;
    }
    assert_eq!(probe_tag(&p, "color_transfer"), "smpte2084", "the fixture really is PQ");
    let eng = one_clip(&p);
    let o = dir.path().join("o.mp4");
    let j = export(&eng, &o);
    assert!(j.filter_graph.contains("tonemap=tonemap=hable"), "{}", j.filter_graph);
    assert_eq!(probe_tag(&o, "color_transfer"), "bt709");
    let (r, g, b) = rgb709(&o);
    // a neutral grey stays neutral, and is a sensible SDR level (not black, not clipped)
    assert!((r - g).abs() < 12 && (g - b).abs() < 12, "grey stays grey: {r},{g},{b}");
    assert!((60..250).contains(&g), "a plausible SDR level: {g}");
}

#[test]
fn a_project_with_no_tagged_footage_compiles_exactly_as_before() {
    let dir = tempfile::tempdir().unwrap();
    let plain = footage(dir.path(), "p.mp4", "blue", "bt709", ("-", "-", "-"));
    let eng = one_clip(&plain);
    let j = job(&eng, &dir.path().join("o.mp4"));
    assert!(!j.filter_graph.contains("colorspace") && !j.filter_graph.contains("zscale") && !j.filter_graph.contains("tonemap"));
}
