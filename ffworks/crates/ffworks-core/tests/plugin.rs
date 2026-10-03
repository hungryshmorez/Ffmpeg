//! Plugins: sandboxed WebAssembly modules (Extism) that answer with editing commands. The fixture is the example plugin in
//! `plugins/example` (its committed `plugin.wasm` is built from `src/lib.rs` by `build.sh`); it also holds the misbehaving
//! actions used here. Pure engine work (solid clips), no FFmpeg needed.
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::plugin::{discover, load, run, run_with, Grants, PluginPackage};
use ffworks_core::process::Tools;
use ffworks_core::project::ProjectSettings;
use ffworks_core::script::Permissions;
use ffworks_core::Rational;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn example_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/example")
}

fn example() -> PluginPackage {
    load(&example_dir()).unwrap()
}

/// One 35 s solid on V1. Returns the engine and the clip id.
fn project() -> (Engine, String) {
    let mut eng = Engine::new("p", ProjectSettings { width: 320, height: 240, fps: Rational::from_int(25), sample_rate: 48000 }, Tools::discover(None, None));
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::AddSolid { track: v, start: Rational::from_int(0), duration: Rational::from_int(35), color: "#336699".into() }).unwrap();
    let id = eng.project.active().unwrap().tracks[0].clips[0].id.clone();
    (eng, id)
}

fn snapshot(eng: &Engine) -> String {
    serde_json::to_string(&eng.project).unwrap()
}

fn marker_times(eng: &Engine) -> Vec<String> {
    eng.project.active().unwrap().markers.iter().map(|m| m.time.to_string()).collect()
}

fn run_action(eng: &mut Engine, id: &str, selected: Option<&str>, granted: Permissions) -> ffworks_core::error::Result<ffworks_core::plugin::Report> {
    run(eng, &example(), id, selected, granted, &format!("Plugin {id}"))
}

#[test]
fn the_example_plugin_loads_and_is_found_by_discovery() {
    let pkg = example();
    assert_eq!(pkg.manifest.name, "Example plugin");
    assert!(pkg.manifest.actions.iter().any(|a| a.id == "markers" && a.export == "markers"));
    assert!(pkg.manifest.permissions.edit && !pkg.manifest.permissions.analysis);
    let found = discover(&example_dir().join(".."));
    assert!(found.iter().any(|p| p.as_ref().is_ok_and(|p| p.manifest.name == "Example plugin")), "discovery finds the plugin folder");
}

#[test]
fn a_plugin_reads_the_project_and_its_commands_are_one_undo_step() {
    let (mut eng, _) = project();
    let before = snapshot(&eng);
    let history = eng.history().len();
    let report = run_action(&mut eng, "markers", None, Permissions::EDIT).unwrap();
    assert_eq!(report.commands, 3, "35 s: markers at 10, 20, 30");
    assert_eq!(report.log, ["3 markers"]);
    assert_eq!(marker_times(&eng), ["10", "20", "30"]);
    assert_eq!(eng.history().len(), history + 1, "one undo step");
    assert_eq!(eng.undo_label(), Some("Plugin markers"));
    eng.undo().unwrap();
    assert_eq!(snapshot(&eng), before);
    eng.redo().unwrap();
    assert_eq!(marker_times(&eng), ["10", "20", "30"]);
}

#[test]
fn the_selected_clip_reaches_the_plugin() {
    let (mut eng, clip) = project();
    run_action(&mut eng, "half-opacity", Some(&clip), Permissions::EDIT).unwrap();
    assert_eq!(eng.project.active().unwrap().find_clip(&clip).unwrap().1.opacity, 0.5);
    let before = snapshot(&eng);
    let err = run_action(&mut eng, "half-opacity", None, Permissions::EDIT).unwrap_err().to_string();
    assert!(err.contains("select a clip first"), "the plugin's own message comes through: {err}");
    assert_eq!(snapshot(&eng), before);
}

#[test]
fn a_plugin_cannot_read_files_and_needs_permission_to_edit_or_analyse() {
    let (mut eng, _) = project();
    let before = snapshot(&eng);
    let err = run_action(&mut eng, "try-import", None, Permissions::EDIT).unwrap_err().to_string();
    assert!(err.contains("read a file from disk"), "{err}");
    // the caller grants analysis, but the manifest never asked for it: still refused
    let err = run_action(&mut eng, "try-analysis", None, Permissions { edit: true, analysis: true }).unwrap_err().to_string();
    assert!(err.contains("not given permission"), "{err}");
    // the caller grants nothing: a dry run
    let err = run_action(&mut eng, "markers", None, Permissions::READ_ONLY).unwrap_err().to_string();
    assert!(err.contains("not allowed to edit"), "{err}");
    assert_eq!(snapshot(&eng), before, "nothing changed");
}

#[test]
fn a_failing_command_takes_back_the_ones_before_it() {
    let (mut eng, _) = project();
    let before = snapshot(&eng);
    let history = eng.history().len();
    let err = run_action(&mut eng, "half-bad", None, Permissions::EDIT).unwrap_err().to_string();
    assert!(err.contains("command 2 failed"), "{err}");
    assert_eq!(snapshot(&eng), before, "the good first command was undone too");
    assert_eq!(eng.history().len(), history);
}

#[test]
fn bad_answers_and_missing_things_are_clear_errors() {
    let (mut eng, _) = project();
    let before = snapshot(&eng);
    let err = run_action(&mut eng, "garbage", None, Permissions::EDIT).unwrap_err().to_string();
    assert!(err.contains("did not answer with"), "{err}");
    let err = run_action(&mut eng, "missing", None, Permissions::EDIT).unwrap_err().to_string();
    assert!(err.contains("no export named \"no_such_export\""), "{err}");
    let err = run_action(&mut eng, "nope", None, Permissions::EDIT).unwrap_err().to_string();
    assert!(err.contains("no action \"nope\""), "{err}");
    assert_eq!(snapshot(&eng), before);
}

#[test]
fn a_plugin_that_never_finishes_is_stopped() {
    let (mut eng, _) = project();
    let started = Instant::now();
    let err = run_action(&mut eng, "spin", None, Permissions::EDIT).unwrap_err().to_string();
    assert!(started.elapsed() < Duration::from_secs(40), "stopped after {:?}", started.elapsed());
    assert!(err.contains("timeout"), "{err}");
}

#[test]
fn a_plugin_that_wants_too_much_memory_is_stopped() {
    let (mut eng, _) = project();
    let err = run_action(&mut eng, "hog", None, Permissions::EDIT).unwrap_err().to_string();
    assert!(err.contains("oom"), "{err}");
}

#[test]
fn a_manifest_cannot_point_outside_its_folder_and_must_have_actions() {
    let dir = tempfile::tempdir().unwrap();
    let write = |json: &str| std::fs::write(dir.path().join("plugin.json"), json).unwrap();
    write(r#"{"name":"x","wasm":"../evil.wasm","actions":[{"id":"a","label":"a","export":"a"}]}"#);
    assert!(load(dir.path()).unwrap_err().to_string().contains("plain file name"));
    write(r#"{"name":"x","wasm":"/etc/evil.wasm","actions":[{"id":"a","label":"a","export":"a"}]}"#);
    assert!(load(dir.path()).unwrap_err().to_string().contains("plain file name"));
    write(r#"{"name":"x","actions":[]}"#);
    assert!(load(dir.path()).unwrap_err().to_string().contains("no actions"));
    write(r#"{"name":"x","actions":[{"id":"a","label":"a","export":"a"}]}"#);
    assert!(load(dir.path()).is_err(), "the wasm file is missing");
}

#[test]
fn installing_copies_the_plugin_and_replaces_an_older_copy() {
    let root = tempfile::tempdir().unwrap();
    let pkg = ffworks_core::plugin::install(root.path(), &example_dir()).unwrap();
    assert_eq!(pkg.dir, root.path().join("example-plugin"));
    assert!(pkg.dir.join("plugin.json").is_file() && pkg.dir.join("plugin.wasm").is_file());
    assert!(!pkg.dir.join("src").exists() && !pkg.dir.join("Cargo.toml").exists(), "only the manifest and the wasm are copied");
    ffworks_core::plugin::install(root.path(), &example_dir()).unwrap();
    assert_eq!(discover(root.path()).len(), 1, "installing again replaces rather than adds");
    // the installed copy runs
    let (mut eng, _) = project();
    run(&mut eng, &pkg, "markers", None, Permissions::EDIT, "Plugin").unwrap();
    assert_eq!(marker_times(&eng), ["10", "20", "30"]);
}

fn wasi_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/example-wasi")
}

/// A local web server that answers every request with `body` and counts them.
fn web_server(body: &'static str) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let url = format!("http://{}/t", server.server_addr().to_ip().unwrap());
    let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let h = hits.clone();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _ = req.respond(tiny_http::Response::from_string(body));
        }
    });
    (url, hits)
}

#[test]
fn a_plugin_reaches_the_network_only_for_hosts_it_asked_for_and_was_given() {
    let (url, hits) = web_server("12");
    let (mut eng, _) = project();
    let before = snapshot(&eng);
    let call = |eng: &mut Engine, hosts: &[&str]| run_with(eng, &example(), "fetch-marker", Some(&url), &Grants { edit: true, hosts: hosts.iter().map(|h| h.to_string()).collect(), ..Default::default() }, "Plugin web");
    // nothing granted: the request never leaves
    let err = call(&mut eng, &[]).unwrap_err().to_string();
    assert!(err.contains("Example plugin"), "{err}");
    // a host the plugin never asked for, even though the caller allows it
    assert!(call(&mut eng, &["example.org"]).is_err());
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0, "no request reached the server");
    assert_eq!(snapshot(&eng), before);
    // asked for and granted
    let report = call(&mut eng, &["127.0.0.1"]).unwrap();
    assert_eq!(report.log, ["status 200"]);
    assert_eq!(marker_times(&eng), ["12"]);
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
    let pkg = example();
    assert_eq!(pkg.allowed_hosts(&Grants { hosts: vec!["127.0.0.1".into(), "evil.example".into()], ..Default::default() }), ["127.0.0.1"]);
}

#[test]
fn a_plugin_reads_its_fixed_config() {
    let (mut eng, _) = project();
    run_action(&mut eng, "config-marker", None, Permissions::EDIT).unwrap();
    let m = &eng.project.active().unwrap().markers[0];
    assert_eq!((m.name.as_str(), m.time.to_string().as_str()), ("set in plugin.json", "1"));
}

#[test]
fn a_wasi_plugin_sees_only_the_folder_it_was_given() {
    let pkg = load(&wasi_dir()).unwrap();
    assert!(pkg.manifest.wasi && pkg.manifest.permissions.files == ["/data"]);
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("marks.txt"), "1\n2.48\n\n4\n").unwrap();
    let granted = Grants { edit: true, folders: [("/data".to_string(), dir.path().to_path_buf())].into_iter().collect(), ..Default::default() };
    let (mut eng, _) = project();

    // no folder granted: it cannot read anything
    let err = run_with(&mut eng, &pkg, "marks", None, &Grants::edit_only(), "p").unwrap_err().to_string();
    assert!(err.contains("cannot read /data/marks.txt"), "{err}");
    assert!(eng.project.active().unwrap().markers.is_empty());

    let report = run_with(&mut eng, &pkg, "marks", None, &granted, "p").unwrap();
    assert_eq!(report.log, ["3 marks"]);
    assert_eq!(marker_times(&eng), ["1", "62/25", "4"]);
    assert_eq!(std::fs::read_to_string(dir.path().join("marker-count.txt")).unwrap(), "3\n", "it can write into its folder, and only there");

    // everything else on the machine stays out of reach
    let err = run_with(&mut eng, &pkg, "escape", None, &granted, "p").unwrap_err().to_string();
    assert!(err.contains("blocked"), "{err}");

    // a folder granted under a guest path it never asked for is ignored
    let wrong = Grants { edit: true, folders: [("/other".to_string(), dir.path().to_path_buf())].into_iter().collect(), ..Default::default() };
    assert!(run_with(&mut eng, &pkg, "marks", None, &wrong, "p").is_err());
    // a missing folder is a clear error
    let missing = Grants { edit: true, folders: [("/data".to_string(), dir.path().join("nope"))].into_iter().collect(), ..Default::default() };
    assert!(run_with(&mut eng, &pkg, "marks", None, &missing, "p").is_err());
}
