//! The media library index (SQLite): what imports remember, searching it, and finding moved files through it.
use ffworks_core::engine::{fingerprint, prepare_asset};
use ffworks_core::library::{Library, SCHEMA_VERSION};
use ffworks_core::process::Tools;
use std::path::{Path, PathBuf};
use std::process::Command;

fn tools() -> Tools {
    Tools::discover(None, None)
}

fn clip(dir: &Path, name: &str, seconds: u32, freq: u32) -> PathBuf {
    let p = dir.join(name);
    let out = Command::new(tools().ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
        .arg(format!("testsrc=s=160x120:r=10:d={seconds}"))
        .args(["-f", "lavfi", "-i"])
        .arg(format!("sine=f={freq}:d={seconds}"))
        .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
        .arg(&p)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    p
}

#[test]
fn imports_are_remembered_and_searchable_by_every_word() {
    let dir = tempfile::tempdir().unwrap();
    let a = prepare_asset(&tools(), &clip(dir.path(), "Beach Sunset.mp4", 2, 440)).unwrap();
    let b = prepare_asset(&tools(), &clip(dir.path(), "city_night.mp4", 3, 880)).unwrap();
    let lib = Library::open_in_memory().unwrap();
    assert!(lib.is_empty().unwrap());
    lib.record(&a).unwrap();
    lib.record(&b).unwrap();
    lib.record(&a).unwrap();
    assert_eq!(lib.len().unwrap(), 2, "the same path is one entry");

    let hits = lib.search("beach", 10).unwrap();
    assert_eq!(hits.len(), 1);
    let h = &hits[0];
    assert_eq!(h.name, "Beach Sunset.mp4");
    assert!(h.exists && h.has_video && h.has_audio);
    assert_eq!((h.width, h.height), (Some(160), Some(120)));
    assert!((h.duration - 2.0).abs() < 0.3, "{}", h.duration);
    assert_eq!(h.fingerprint, a.fingerprint);
    assert_eq!(lib.search("BEACH sunset", 10).unwrap().len(), 1, "case-insensitive, every word must match");
    assert!(lib.search("beach night", 10).unwrap().is_empty(), "words are ANDed");
    assert_eq!(lib.search("", 10).unwrap().len(), 2, "an empty search lists the recent files");
    assert_eq!(lib.search("mp4", 1).unwrap().len(), 1, "the limit applies");
    assert!(lib.search("100%", 10).unwrap().is_empty(), "a % in the search is a character, not a wildcard");
    assert!(lib.search("_", 10).unwrap().len() == 1, "a _ matches only a real underscore (city_night)");
}

#[test]
fn generated_media_is_not_recorded_and_missing_files_are_flagged_and_forgotten() {
    let dir = tempfile::tempdir().unwrap();
    let path = clip(dir.path(), "gone.mp4", 1, 440);
    let asset = prepare_asset(&tools(), &path).unwrap();
    let lib = Library::open_in_memory().unwrap();
    let mut solid = asset.clone();
    solid.generator = Some(ffworks_core::generators::Generator::Solid { color: "#000000".into() });
    solid.path = "solid:#000000".into();
    lib.record(&solid).unwrap();
    assert!(lib.is_empty().unwrap(), "no file, nothing to remember");
    lib.record(&asset).unwrap();
    std::fs::remove_file(&path).unwrap();
    let hit = &lib.search("gone", 5).unwrap()[0];
    assert!(!hit.exists, "a file that was deleted is flagged");
    assert_eq!(lib.forget_missing().unwrap(), 1);
    assert!(lib.is_empty().unwrap());
}

#[test]
fn the_library_survives_reopening_and_refuses_a_newer_layout() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("sub").join("library.sqlite");
    let asset = prepare_asset(&tools(), &clip(dir.path(), "x.mp4", 1, 440)).unwrap();
    Library::open(&db).unwrap().record(&asset).unwrap();
    assert_eq!(Library::open(&db).unwrap().len().unwrap(), 1, "stored on disk, folder created");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1).unwrap();
    drop(conn);
    let err = Library::open(&db).err().expect("a newer layout is refused").to_string();
    assert!(err.contains("newer FFWORKS"), "{err}");
}

#[test]
fn relinking_looks_first_where_the_file_was_seen_under_another_name() {
    let dir = tempfile::tempdir().unwrap();
    let old_dir = dir.path().join("old");
    let new_dir = dir.path().join("archive");
    std::fs::create_dir_all(&old_dir).unwrap();
    std::fs::create_dir_all(&new_dir).unwrap();
    let original = clip(&old_dir, "interview.mp4", 2, 440);
    let asset = prepare_asset(&tools(), &original).unwrap();
    let lib = Library::open_in_memory().unwrap();
    lib.record(&asset).unwrap();

    // another project imported a copy that lives in the archive under a different name
    let copy = new_dir.join("interview_final.mp4");
    std::fs::copy(&original, &copy).unwrap();
    assert_eq!(fingerprint(&copy).unwrap(), asset.fingerprint.clone().unwrap());
    lib.record(&prepare_asset(&tools(), &copy).unwrap()).unwrap();
    assert_eq!(lib.by_fingerprint(asset.fingerprint.as_deref().unwrap()).unwrap().len(), 2);

    // the original goes away: the library points at the archive, the only place the same content still is
    std::fs::remove_file(&original).unwrap();
    let dirs = lib.likely_dirs(&[&asset]).unwrap();
    assert_eq!(dirs, vec![new_dir.clone()]);
    let found = ffworks_core::relink::find_candidates(&[&asset], &dirs);
    let c = &found[0].1[0];
    assert!(c.exact && c.path == copy, "{c:?}");
}
