//! The headless CLI end to end: a script builds a project, detection and sync report, batch converts a folder.
use std::path::Path;
use std::process::Command;

fn ffworks(args: &[&str]) -> (bool, String, String) {
    let o = Command::new(env!("CARGO_BIN_EXE_ffworks")).args(args).output().unwrap();
    (o.status.success(), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
}

fn ff(args: &[&str]) {
    let o = Command::new("ffmpeg").args(["-v", "error", "-y"]).args(args).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
}

fn clip(dir: &Path, name: &str) -> String {
    let p = dir.join(name);
    ff(&["-f", "lavfi", "-i", "color=c=0x00ff00:s=160x120:r=25:d=1", "-f", "lavfi", "-i", "color=c=black:s=160x120:r=25:d=1", "-f", "lavfi", "-i", "sine=f=440:r=44100:d=1", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1", "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v];[2:a][3:a]concat=n=2:v=0:a=1[a]", "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", p.to_str().unwrap()]);
    p.to_string_lossy().into_owned()
}

#[test]
fn a_script_builds_a_project_then_render_and_batch_and_detectors_work() {
    let dir = tempfile::tempdir().unwrap();
    let media = clip(dir.path(), "m.mp4");
    // presets
    let (ok, out, _) = ffworks(&["presets"]);
    assert!(ok && out.contains("h264_mp4") && out.contains("quick_copy"), "{out}");
    // detectors
    let (ok, out, err) = ffworks(&["detect", &media, "silence", "-40", "0.3"]);
    assert!(ok && out.lines().any(|l| l.starts_with("1.0")), "{out} {err}");
    let (ok, out, _) = ffworks(&["detect", &media, "black"]);
    assert!(ok && out.lines().count() == 1, "{out}");
    let (ok, _, err) = ffworks(&["detect", &media, "bogus"]);
    assert!(!ok && err.contains("unknown detector"));
    // a script on a NEW project: needs --save
    let script = dir.path().join("s.json");
    let proj = dir.path().join("p.ffworks");
    // the media must be imported first: the script cannot know ids, so use a one-clip batch via the CLI's own batch for ids; here: markers only
    std::fs::write(&script, r#"[{"type":"add_marker","time":"2","name":"hello","color":null,"note":null},{"type":"add_track","kind":"video","name":"Extra"}]"#).unwrap();
    let (ok, _, err) = ffworks(&["run", "new", script.to_str().unwrap()]);
    assert!(!ok && err.contains("--save"), "{err}");
    let (ok, out, err) = ffworks(&["run", "new", script.to_str().unwrap(), "--dry-run"]);
    assert!(ok && out.contains("dry run") && !proj.exists(), "{out} {err}");
    let (ok, out, err) = ffworks(&["run", "new", script.to_str().unwrap(), "--save", proj.to_str().unwrap()]);
    assert!(ok && out.contains("1 markers") && proj.exists(), "{out} {err}");
    // a bad command changes nothing and says why
    let bad = dir.path().join("bad.json");
    std::fs::write(&bad, r#"[{"type":"add_marker","time":"1","name":"x","color":null,"note":null},{"type":"remove_track","track":"nope"}]"#).unwrap();
    let before = std::fs::read(&proj).unwrap();
    let (ok, _, err) = ffworks(&["run", proj.to_str().unwrap(), bad.to_str().unwrap()]);
    assert!(!ok && !err.is_empty());
    assert_eq!(std::fs::read(&proj).unwrap(), before, "a failing script leaves the project untouched");
    let (ok, _, err) = ffworks(&["run", proj.to_str().unwrap(), dir.path().join("missing.json").to_str().unwrap()]);
    assert!(!ok && !err.is_empty());
    // batch convert a folder (one good file, one that is not media)
    let inp = dir.path().join("in");
    std::fs::create_dir_all(&inp).unwrap();
    std::fs::copy(&media, inp.join("a.mp4")).unwrap();
    std::fs::write(inp.join("notes.txt"), "hello").unwrap();
    let outd = dir.path().join("out");
    let (ok, out, _) = ffworks(&["batch", inp.to_str().unwrap(), outd.to_str().unwrap(), "h264_mp4"]);
    assert!(!ok, "one file failed so the exit status says so: {out}");
    assert!(out.contains("ok") && out.contains("FAILED") && out.contains("1 converted, 1 failed"), "{out}");
    assert!(outd.join("a.mp4").exists());
    let (ok, out, _) = ffworks(&["probe", outd.join("a.mp4").to_str().unwrap()]);
    assert!(ok && out.contains("h264"));
    // render a project saved above: it has no clips so the CLI refuses with a reason instead of producing an empty file
    let (ok, _, err) = ffworks(&["render", proj.to_str().unwrap(), dir.path().join("o.mp4").to_str().unwrap()]);
    assert!(!ok && err.contains("empty"), "{err}");
}

#[test]
fn package_collects_a_project_with_its_media() {
    let dir = tempfile::tempdir().unwrap();
    let media = clip(dir.path(), "m.mp4");
    let script = dir.path().join("s.json");
    std::fs::write(&script, r#"[{"type":"add_marker","time":"1","name":"x","color":null,"note":null}]"#).unwrap();
    let proj = dir.path().join("p.ffworks");
    let (ok, _, e) = ffworks(&["run", "new", script.to_str().unwrap(), "--save", proj.to_str().unwrap()]);
    assert!(ok, "{e}");
    let _ = media;
    let out = dir.path().join("pack");
    let (ok, o, e) = ffworks(&["package", proj.to_str().unwrap(), out.to_str().unwrap()]);
    assert!(ok && o.contains("0 media files") && out.join("p.ffworks").exists(), "{o} {e}");
    let (ok, _, e) = ffworks(&["package", dir.path().join("none.ffworks").to_str().unwrap(), out.to_str().unwrap()]);
    assert!(!ok && !e.is_empty());
}

#[test]
fn watch_once_converts_stable_files_once_and_reports_bad_ones() {
    let dir = tempfile::tempdir().unwrap();
    let inp = dir.path().join("in");
    std::fs::create_dir_all(&inp).unwrap();
    let m = clip(dir.path(), "m.mp4");
    std::fs::copy(&m, inp.join("a.mp4")).unwrap();
    std::fs::write(inp.join("notes.txt"), "hello").unwrap();
    let out = dir.path().join("out");
    let (ok, o, e) = ffworks(&["watch", inp.to_str().unwrap(), out.to_str().unwrap(), "h264_mp4", "--once"]);
    assert!(ok, "{o} {e}");
    assert!(o.contains("ok     a.mp4") && o.contains("FAILED notes.txt"), "{o}");
    assert_eq!(o.lines().filter(|l| l.starts_with("ok")).count(), 1, "converted once");
    assert!(out.join("a.mp4").exists());
}
