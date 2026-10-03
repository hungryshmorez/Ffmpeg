//! Scripting: Rhai programs that edit a project through the command bus. Everything here is pure engine work (solid clips,
//! no media files), so it needs no FFmpeg.
use ffworks_core::commands::Command;
use ffworks_core::engine::Engine;
use ffworks_core::process::Tools;
use ffworks_core::project::ProjectSettings;
use ffworks_core::script::{run, Permissions};
use ffworks_core::Rational;

fn secs(n: i64) -> Rational {
    Rational::from_int(n)
}

/// Solids of 2 s, 6 s and 8 s on V1 at 0, 2 and 8 s. Returns the engine and the clip ids in order.
fn project() -> (Engine, Vec<String>) {
    let mut eng = Engine::new("s", ProjectSettings { width: 320, height: 240, fps: secs(25), sample_rate: 48000 }, Tools::discover(None, None));
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    for (start, dur, color) in [(0, 2, "#ff0000"), (2, 6, "#00ff00"), (8, 8, "#0000ff")] {
        eng.dispatch(Command::AddSolid { track: v.clone(), start: secs(start), duration: secs(dur), color: color.into() }).unwrap();
    }
    let ids = eng.project.active().unwrap().tracks[0].clips.iter().map(|c| c.id.clone()).collect();
    (eng, ids)
}

fn snapshot(eng: &Engine) -> String {
    serde_json::to_string(&eng.project).unwrap()
}

fn effects_of(eng: &Engine, clip: &str) -> Vec<String> {
    eng.project.active().unwrap().find_clip(clip).unwrap().1.effects.iter().map(|e| e.effect.clone()).collect()
}

#[test]
fn loops_and_conditions_pick_the_clips_and_the_whole_run_is_one_undo_step() {
    let (mut eng, ids) = project();
    let before = snapshot(&eng);
    let history = eng.history().len();
    let report = run(
        &mut eng,
        r#"
        let longer = 0;
        for c in clips() {
            if c.duration > 5.0 {
                add_effect(c.id, "blur", #{ sigma: 8 });
                longer += 1;
            }
        }
        print(`blurred ${longer} clips`);
        "#,
        None,
        Permissions::EDIT,
        "Blur long clips",
    )
    .unwrap();
    assert_eq!((effects_of(&eng, &ids[0]).len(), effects_of(&eng, &ids[1]), effects_of(&eng, &ids[2])), (0, vec!["blur".to_string()], vec!["blur".to_string()]));
    assert_eq!(report.commands, 2);
    assert_eq!(report.log, vec!["blurred 2 clips".to_string()]);
    assert_eq!(eng.history().len(), history + 1, "one undo step for the whole run");
    assert_eq!(eng.undo_label(), Some("Blur long clips"));
    eng.undo().unwrap();
    assert_eq!(snapshot(&eng), before, "undo takes everything back");
    eng.redo().unwrap();
    assert_eq!(effects_of(&eng, &ids[1]), vec!["blur".to_string()], "and redo puts it back");
}

#[test]
fn a_while_loop_can_lay_markers_every_ten_seconds() {
    let (mut eng, _) = project();
    run(&mut eng, r#"let t = 0.0; while t < 16.0 { add_marker(t, `at ${t}`); t += 5.0; }"#, None, Permissions::EDIT, "Markers").unwrap();
    let m: Vec<String> = eng.project.active().unwrap().markers.iter().map(|m| m.name.clone()).collect();
    assert_eq!(m.len(), 4, "{m:?}");
    assert!(m.contains(&"at 10".to_string()) || m.contains(&"at 10.0".to_string()), "{m:?}");
}

#[test]
fn a_script_that_fails_half_way_leaves_nothing_behind() {
    let (mut eng, ids) = project();
    let before = snapshot(&eng);
    let history = eng.history().len();
    let e = run(&mut eng, &format!(r#"add_effect("{}", "blur"); add_effect("{}", "no_such_effect"); add_marker(1, "never");"#, ids[0], ids[1]), None, Permissions::EDIT, "x").unwrap_err().to_string();
    assert!(e.contains("script:") && e.contains("no_such_effect"), "{e}");
    assert_eq!(snapshot(&eng), before, "the first effect was taken back too");
    assert_eq!(eng.history().len(), history);
    // the engine is fully usable afterwards
    eng.dispatch(Command::AddMarker { time: secs(1), name: "after".into(), color: None, note: None }).unwrap();
}

#[test]
fn a_dry_run_can_look_and_print_but_not_edit() {
    let (mut eng, ids) = project();
    let before = snapshot(&eng);
    let r = run(&mut eng, r#"print(`clips: ${clips().len()}, project: ${project().name}, tracks: ${tracks().len()}, media: ${media().len()}`);"#, None, Permissions::READ_ONLY, "x").unwrap();
    assert_eq!(r.log, vec!["clips: 3, project: s, tracks: 2, media: 3".to_string()]);
    let e = run(&mut eng, &format!(r#"add_effect("{}", "blur");"#, ids[0]), None, Permissions::READ_ONLY, "x").unwrap_err().to_string();
    assert!(e.contains("read-only"), "{e}");
    assert_eq!(snapshot(&eng), before);
}

#[test]
fn a_script_has_no_way_to_reach_files_modules_or_other_programs() {
    let (mut eng, _) = project();
    let before = snapshot(&eng);
    for (src, why) in [
        (r#"import "other" as o; o::f();"#, "module"),
        (r#"let f = open("/etc/passwd");"#, "open"),
        (r#"let f = read_file("/etc/passwd");"#, "read_file"),
        (r#"let p = run_program("ls");"#, "run_program"),
    ] {
        let e = run(&mut eng, src, None, Permissions::EDIT, "x").unwrap_err().to_string();
        assert!(e.starts_with("validation failed: script:"), "{why}: {e}");
    }
    // the generic command() cannot import or relink either: that would read a file
    let asset = serde_json::to_string(&eng.project.media[0]).unwrap().replace("null", "()").replace('{', "#{");
    let e = run(&mut eng, &format!(r#"command(#{{ type: "import_media", asset: {asset} }});"#), None, Permissions::EDIT, "x").unwrap_err().to_string();
    assert!(e.contains("cannot read files"), "{e}");
    // analysis needs the permission
    let e = run(&mut eng, r#"command(#{ type: "animate_from_audio", clip: "x", param: "opacity", low: 0.0, high: 1.0 });"#, None, Permissions::EDIT, "x").unwrap_err().to_string();
    assert!(e.contains("analyses"), "{e}");
    assert_eq!(snapshot(&eng), before);
}

#[test]
fn runaway_scripts_are_stopped_and_undone() {
    let (mut eng, _) = project();
    let before = snapshot(&eng);
    let e = run(&mut eng, "loop { }", None, Permissions::EDIT, "x").unwrap_err().to_string();
    assert!(e.to_lowercase().contains("operations"), "{e}");
    let e = run(&mut eng, r#"let t = 0; while true { add_marker(t, "m"); t += 1; }"#, None, Permissions::EDIT, "x").unwrap_err().to_string();
    assert!(e.contains("at most 2000"), "{e}");
    let e = run(&mut eng, "fn f(n) { f(n + 1) } f(0);", None, Permissions::EDIT, "x").unwrap_err().to_string();
    assert!(e.to_lowercase().contains("stack") || e.to_lowercase().contains("depth") || e.to_lowercase().contains("levels"), "{e}");
    let e = run(&mut eng, &"1;".repeat(150_000), None, Permissions::EDIT, "x").unwrap_err().to_string();
    assert!(e.contains("too long"), "{e}");
    assert_eq!(snapshot(&eng), before, "nothing the runaway scripts did is kept");
}

#[test]
fn creating_functions_return_ids_that_later_lines_can_use() {
    let (mut eng, _) = project();
    run(
        &mut eng,
        r##"
        let top = add_track("video");
        let clip = add_solid(top, 0, 4, "#ffffff");
        add_effect(clip, "negate");
        let adj = add_adjustment(add_track("video"), 1, 2);
        add_effect(adj, "grayscale");
        animate_lfo(clip, "opacity", "sine", 0.5, 0.2, 1.0);
        print(`${clip} / ${adj}`);
        "##,
        None,
        Permissions::EDIT,
        "Build",
    )
    .unwrap();
    let seq = eng.project.active().unwrap();
    let with: Vec<_> = seq.tracks.iter().flat_map(|t| &t.clips).filter(|c| !c.effects.is_empty()).collect();
    assert_eq!(with.len(), 2, "the white solid and the adjustment layer");
    assert!(with.iter().any(|c| c.adjustment && c.effects[0].effect == "grayscale"));
    assert!(with.iter().any(|c| !c.adjustment && c.effects[0].effect == "negate" && c.keyframes.contains_key("opacity")));
    assert_eq!(seq.tracks.len(), 4, "V1, A1 and the two new video tracks");
}

#[test]
fn the_generic_command_function_reaches_everything_else_and_explains_mistakes() {
    let (mut eng, ids) = project();
    run(&mut eng, &format!(r#"command(#{{ type: "set_clip_opacity", clip: "{}", opacity: 0.5 }}); command(#{{ type: "add_marker", time: "2/5", name: "frames" }});"#, ids[0]), None, Permissions::EDIT, "x").unwrap();
    assert_eq!(eng.project.active().unwrap().markers[0].time, Rational::new(2, 5));
    let e = run(&mut eng, r#"command(#{ type: "teleport" });"#, None, Permissions::EDIT, "x").unwrap_err().to_string();
    assert!(e.contains("not a valid command"), "{e}");
    let e = run(&mut eng, "let x = ;", None, Permissions::EDIT, "x").unwrap_err().to_string();
    assert!(e.contains("script:") && e.contains("line 1"), "syntax errors say where: {e}");
}

#[test]
fn selected_is_what_the_caller_chose() {
    let (mut eng, ids) = project();
    let r = run(&mut eng, r#"print(selected()); if selected() != "" { add_effect(selected(), "negate"); }"#, Some(&ids[2]), Permissions::EDIT, "x").unwrap();
    assert_eq!(r.log, vec![ids[2].clone()]);
    assert_eq!(effects_of(&eng, &ids[2]), vec!["negate".to_string()]);
    let r = run(&mut eng, r#"print(`[${selected()}]`);"#, None, Permissions::READ_ONLY, "x").unwrap();
    assert_eq!(r.log, vec!["[]".to_string()]);
}

#[test]
fn scripts_can_set_formulas_and_links() {
    let (mut eng, ids) = project();
    run(&mut eng, &format!(r#"animate_expr("{}", "opacity", "0.25 + 0.5 * p");"#, ids[0]), None, Permissions::EDIT, "x").unwrap();
    let c = eng.project.active().unwrap().find_clip(&ids[0]).unwrap().1.clone();
    assert!(c.keyframes["opacity"].len() >= 2);
    run(&mut eng, &format!(r#"link_param("{0}", "x", "opacity", "v * 100");"#, ids[0]), None, Permissions::EDIT, "x").unwrap();
    let c = eng.project.active().unwrap().find_clip(&ids[0]).unwrap().1.clone();
    assert!(c.keyframes["x"].iter().any(|k| k.v > 25.0), "x follows opacity (clamped into its range): {:?}", c.keyframes["x"]);
}
