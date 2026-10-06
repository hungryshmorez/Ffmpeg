//! Colour lookup tables: a real .cube file changes the exported pixels, no file means no change, a missing or wrong file is
//! refused with the reason, and the choice undoes, saves, packages, and cannot be made by scripts.
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile_project, ExportSettings, RenderOptions};
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::ProjectSettings;
use ffworks_core::Rational;
use std::path::Path;
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}
fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

/// A size-2 cube that turns every colour into its opposite: output = 1 - input (red varies fastest in the table).
const INVERT_CUBE: &str = "TITLE \"invert\"\nLUT_3D_SIZE 2\n1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0\n";

fn cube(dir: &Path, name: &str) -> String {
    let p = dir.join(name);
    std::fs::write(&p, INVERT_CUBE).unwrap();
    p.to_string_lossy().into_owned()
}

/// A red solid with a LUT effect on it. Returns the engine, the clip and the effect id.
fn project() -> (Engine, String, String) {
    let mut eng = Engine::new("lut", ProjectSettings { width: 160, height: 120, fps: secs(25), sample_rate: 48000 }, tools());
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::AddSolid { track: v, start: secs(0), duration: secs(1), color: "#ff0000".into() }).unwrap();
    let clip = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    eng.dispatch(Command::AddEffect { clip: clip.clone(), effect: "lut".into(), params: Default::default(), index: None }).unwrap();
    let fx = eng.project.active().unwrap().tracks[0].clips[0].effects[0].id.clone();
    (eng, clip, fx)
}

fn set_file(eng: &mut Engine, clip: &str, fx: &str, path: Option<&str>) -> ffworks_core::Result<()> {
    eng.dispatch(Command::SetEffectFile { clip: clip.into(), effect_id: fx.into(), path: path.map(String::from) }).map(|_| ())
}

/// RGB of the centre pixel of the first frame of an export of the project.
fn centre_pixel(eng: &Engine, out: &Path) -> ffworks_core::Result<[u8; 3]> {
    let t = tools();
    let caps = Capabilities::discover(&t).unwrap();
    let mut job = compile_project(&eng.project, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find("ffv1_mkv").unwrap(), range: None, scale_div: 1 }, Some(&caps))?;
    job.program = t.ffmpeg.clone();
    run_job(&t, &job, "lut", "export", &CancelToken::new(), &out.parent().unwrap().join("tmp"), &mut |_| {}).map_err(|e| ffworks_core::Error::validation(e.to_string()))?;
    let o = Proc::new(t.ffmpeg).args(["-v", "error", "-i"]).arg(out).args(["-frames:v", "1", "-vf", "format=rgb24", "-f", "rawvideo", "-"]).output().unwrap();
    assert_eq!(o.stdout.len(), 160 * 120 * 3);
    let at = (60 * 160 + 80) * 3;
    Ok([o.stdout[at], o.stdout[at + 1], o.stdout[at + 2]])
}

#[test]
fn a_cube_file_changes_the_exported_colours_and_no_file_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, clip, fx) = project();
    let plain = centre_pixel(&eng, &dir.path().join("plain.mkv")).unwrap();
    assert!(plain[0] > 200 && plain[1] < 60 && plain[2] < 60, "a LUT effect with no file leaves the red alone: {plain:?}");

    set_file(&mut eng, &clip, &fx, Some(&cube(dir.path(), "invert.cube"))).unwrap();
    let inverted = centre_pixel(&eng, &dir.path().join("lut.mkv")).unwrap();
    assert!(inverted[0] < 60 && inverted[1] > 200 && inverted[2] > 200, "red through the invert table is cyan: {inverted:?}");

    set_file(&mut eng, &clip, &fx, None).unwrap();
    assert_eq!(centre_pixel(&eng, &dir.path().join("none.mkv")).unwrap(), plain, "choosing none again restores the original");
}

#[test]
fn the_file_is_checked_when_chosen_and_when_rendered() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, clip, fx) = project();
    let before = serde_json::to_string(&eng.project).unwrap();
    std::fs::write(dir.path().join("notes.txt"), "x").unwrap();
    std::fs::write(dir.path().join("empty.cube"), "").unwrap();
    for (name, want) in [("notes.txt", "not a lookup table file"), ("empty.cube", "not a usable lookup table"), ("missing.cube", "")] {
        let e = set_file(&mut eng, &clip, &fx, Some(&dir.path().join(name).to_string_lossy())).unwrap_err().to_string();
        assert!(e.contains(want), "{name}: {e}");
    }
    assert_eq!(serde_json::to_string(&eng.project).unwrap(), before, "refusals change nothing");

    // another effect has no file
    eng.dispatch(Command::AddEffect { clip: clip.clone(), effect: "negate".into(), params: Default::default(), index: None }).unwrap();
    let other = eng.project.active().unwrap().tracks[0].clips[0].effects[1].id.clone();
    assert!(set_file(&mut eng, &clip, &other, Some(&cube(dir.path(), "a.cube"))).unwrap_err().to_string().contains("only a colour lookup table"));

    // a table that disappears after it was chosen is an error at render time, not a silent no-op
    let gone = cube(dir.path(), "gone.cube");
    set_file(&mut eng, &clip, &fx, Some(&gone)).unwrap();
    std::fs::remove_file(&gone).unwrap();
    let e = centre_pixel(&eng, &dir.path().join("o.mkv")).unwrap_err().to_string();
    assert!(e.contains("is missing"), "{e}");
}

#[test]
fn the_choice_undoes_saves_and_loads() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, clip, fx) = project();
    let before = serde_json::to_string(&eng.project).unwrap();
    assert!(!before.contains("\"file\""), "nothing is written when there is no file");
    let path = cube(dir.path(), "invert.cube");
    set_file(&mut eng, &clip, &fx, Some(&path)).unwrap();
    let saved = dir.path().join("p.ffworks");
    eng.save(&saved).unwrap();
    let loaded = Engine::load(&saved, tools()).unwrap();
    let want = ffworks_core::engine::absolute_path(Path::new(&path)).unwrap();
    assert_eq!(loaded.project.active().unwrap().tracks[0].clips[0].effects[0].file.as_deref(), Some(want.as_str()));
    eng.undo().unwrap();
    assert_eq!(serde_json::to_string(&eng.project).unwrap(), before);
}

#[test]
fn packaging_copies_the_table_and_the_package_renders_without_the_original() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, clip, fx) = project();
    let path = cube(dir.path(), "invert.cube");
    set_file(&mut eng, &clip, &fx, Some(&path)).unwrap();
    // a second effect on another clip using the same file is copied once
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::AddSolid { track: v, start: secs(1), duration: secs(1), color: "#00ff00".into() }).unwrap();
    let c2 = eng.project.active().unwrap().tracks[0].clips[1].id.clone();
    eng.dispatch(Command::AddEffect { clip: c2.clone(), effect: "lut".into(), params: Default::default(), index: None }).unwrap();
    let fx2 = eng.project.active().unwrap().tracks[0].clips[1].effects[0].id.clone();
    set_file(&mut eng, &c2, &fx2, Some(&path)).unwrap();

    let out = dir.path().join("pack");
    let r = ffworks_core::package::package(&eng.project, &out, "p").unwrap();
    assert_eq!(std::fs::read_dir(out.join("luts")).unwrap().count(), 1, "one copy for both effects");
    assert_eq!(r.files_copied, 1);
    std::fs::remove_file(&path).unwrap();
    let loaded = Engine::load(&r.project_file, tools()).unwrap();
    let packed = loaded.project.active().unwrap().tracks[0].clips[0].effects[0].file.clone().unwrap();
    assert!(packed.contains("luts") && Path::new(&packed).is_file());
    let px = centre_pixel(&loaded, &dir.path().join("packed.mkv")).unwrap();
    assert!(px[0] < 60 && px[1] > 200, "the packaged copy still applies the table: {px:?}");

    // a table that is missing stops packaging with its name
    let (mut e2, c, f) = project();
    let gone = cube(dir.path(), "gone.cube");
    set_file(&mut e2, &c, &f, Some(&gone)).unwrap();
    std::fs::remove_file(&gone).unwrap();
    let err = ffworks_core::package::package(&e2.project, &dir.path().join("pack2"), "x").unwrap_err().to_string();
    assert!(err.contains("lookup table files are missing") && err.contains("gone.cube"), "{err}");
}

#[test]
fn scripts_and_the_api_cannot_choose_files() {
    let dir = tempfile::tempdir().unwrap();
    let (mut eng, _clip, _fx) = project();
    let before = serde_json::to_string(&eng.project).unwrap();
    let src = format!(r#"command(#{{ type: "set_effect_file", clip: clips()[0].id, effect_id: "x", path: "{}" }});"#, cube(dir.path(), "a.cube").replace('\\', "/"));
    let e = ffworks_core::script::run(&mut eng, &src, None, ffworks_core::script::Permissions::EDIT, "s").unwrap_err().to_string();
    assert!(e.contains("cannot read files from disk"), "{e}");
    assert_eq!(serde_json::to_string(&eng.project).unwrap(), before);
}
