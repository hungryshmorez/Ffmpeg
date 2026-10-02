//! Registered FFmpeg builds against the real installed FFmpeg.
use ffworks_core::engines::{probe_engine, scan, EngineEntry};
use ffworks_core::settings::Settings;
use std::path::{Path, PathBuf};

/// Absolute path of a program found on PATH (the tests run with `ffmpeg` on PATH).
fn on_path(name: &str) -> PathBuf {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    std::env::split_paths(&std::env::var_os("PATH").unwrap()).map(|d| d.join(&exe)).find(|p| p.is_file()).unwrap_or_else(|| panic!("{name} on PATH"))
}

/// Make `dest` refer to `src`: a link on Unix, a copy on Windows (where links need privileges).
fn put(src: &Path, dest: &Path) {
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(src, dest).unwrap();
    #[cfg(not(unix))]
    std::fs::copy(src, dest).map(|_| ()).unwrap();
}

fn entry(id: &str, ffmpeg: &Path) -> EngineEntry {
    EngineEntry { id: id.into(), name: id.into(), ffmpeg_path: ffmpeg.display().to_string(), ffprobe_path: None }
}

#[test]
fn a_real_build_is_described_from_what_it_reports() {
    let info = probe_engine(&entry("real", &on_path("ffmpeg")));
    assert!(info.ok, "{:?}", info.error);
    assert!(info.version.to_lowercase().contains("ffmpeg"), "{}", info.version);
    assert!(["GPL", "LGPL", "nonfree"].contains(&info.license.as_str()));
    assert!(info.filters > 100 && info.encoders > 50, "{} filters {} encoders", info.filters, info.encoders);
    assert!(info.notable.iter().any(|n| n == "libx264"), "the CI/test builds have libx264: {:?}", info.notable);
}

#[test]
fn broken_entries_are_reported_not_fatal() {
    let dir = tempfile::tempdir().unwrap();
    let missing = probe_engine(&entry("m", &dir.path().join("nope")));
    assert!(!missing.ok && missing.error.is_some());
    // a file that exists but is not FFmpeg
    let fake = dir.path().join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
    std::fs::write(&fake, b"not a program").unwrap();
    let r = probe_engine(&entry("f", &fake));
    assert!(!r.ok && r.error.is_some());
}

#[test]
fn scan_finds_builds_installed_side_by_side_with_their_ffprobe() {
    let root = tempfile::tempdir().unwrap();
    let (ff, pr) = (on_path("ffmpeg"), on_path("ffprobe"));
    let exe = |n: &str| if cfg!(windows) { format!("{n}.exe") } else { n.to_string() };
    // layout like gyan.dev zips (<name>/bin/) and a flat install
    for (dir, _) in [("ffmpeg-7.1-full_build/bin", ()), ("btbn-gpl", ())] {
        let d = root.path().join(dir);
        put(&ff, &d.join(exe("ffmpeg")));
        put(&pr, &d.join(exe("ffprobe")));
    }
    // an ffmpeg without a sibling ffprobe is not offered
    put(&ff, &root.path().join("orphan").join(exe("ffmpeg")));
    let found = scan(root.path(), 5);
    let names: Vec<_> = found.iter().map(|f| f.suggested_name.as_str()).collect();
    assert_eq!(found.len(), 2, "{names:?}");
    assert!(names.contains(&"ffmpeg-7.1-full_build") && names.contains(&"btbn-gpl"), "{names:?}");
    assert!(scan(root.path(), 0).is_empty(), "depth 0 only looks at the folder itself");
    // on Windows the PATH entry may be a package-manager shim that only works from its own folder, so only prove the
    // found builds run where the copies are plain links
    #[cfg(unix)]
    for f in &found {
        assert!(probe_engine(&EngineEntry { id: "x".into(), name: "x".into(), ffmpeg_path: f.ffmpeg_path.clone(), ffprobe_path: Some(f.ffprobe_path.clone()) }).ok);
    }
}

#[test]
fn active_engine_decides_the_tools_and_survives_save_and_load() {
    let dir = tempfile::tempdir().unwrap();
    let e = entry("one", &dir.path().join("somewhere").join("ffmpeg"));
    let mut s = Settings { ffmpeg_path: Some("/legacy/ffmpeg".into()), ..Default::default() };
    assert_eq!(s.tools_with_bundled(None).ffmpeg, PathBuf::from("/legacy/ffmpeg"));
    s.engines.push(e.clone());
    s.active_engine = Some("one".into());
    assert_eq!(s.tools_with_bundled(None).ffmpeg, PathBuf::from(&e.ffmpeg_path));
    assert_eq!(s.tools_with_bundled(None).ffprobe, dir.path().join("somewhere").join("ffprobe"));
    s.active_engine = Some("gone".into());
    assert_eq!(s.tools_with_bundled(None).ffmpeg, PathBuf::from("/legacy/ffmpeg"), "an unknown active id falls back");
    s.active_engine = Some("one".into());
    let f = dir.path().join("settings.json");
    s.save(&f).unwrap();
    assert_eq!(Settings::load(&f), s);
    // settings files from before engines existed still load
    std::fs::write(&f, r#"{"ffmpeg_path":null,"ffprobe_path":null}"#).unwrap();
    assert!(Settings::load(&f).engines.is_empty());
}
