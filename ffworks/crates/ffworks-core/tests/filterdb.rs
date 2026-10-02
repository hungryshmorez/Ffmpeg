//! Filter browser against the real installed FFmpeg.
use ffworks_core::process::Tools;

fn tools() -> Tools {
    Tools::discover(None, None)
}

#[test]
fn lists_filters_with_known_entries() {
    let l = tools().list_filters().unwrap();
    assert!(l.len() > 100, "only {} filters", l.len());
    let eq = l.iter().find(|f| f.name == "eq").expect("eq");
    assert_eq!(eq.io, "V->V");
    assert!(eq.timeline);
    assert!(l.iter().any(|f| f.name == "volume" && f.io == "A->A"));
    assert!(l.iter().any(|f| f.name == "color" && f.io == "|->V"));
}

#[test]
fn eq_options_parsed_with_defaults_and_choices() {
    let h = tools().filter_help("eq").unwrap();
    assert!(h.description.to_lowercase().contains("brightness"));
    let b = h.options.iter().find(|o| o.name == "brightness").expect("brightness");
    assert_eq!(b.kind, "string");
    assert_eq!(b.default.as_deref(), Some("0.0"));
    assert!(b.dynamic);
    let ev = h.options.iter().find(|o| o.name == "eval").unwrap();
    assert_eq!(ev.default.as_deref(), Some("init"));
    assert_eq!(ev.min.as_deref(), Some("0"));
    assert_eq!(ev.max.as_deref(), Some("1"));
    let names: Vec<_> = ev.choices.iter().map(|c| c.0.as_str()).collect();
    assert_eq!(names, ["init", "frame"]);
    assert_eq!(h.inputs.len(), 1);
    assert!(h.timeline);
}

#[test]
fn two_input_filter_and_unknown_and_bad_name() {
    let t = tools();
    let h = t.filter_help("overlay").unwrap();
    assert_eq!(h.inputs.len(), 2);
    assert!(t.filter_help("definitely_not_a_filter").is_err());
    assert!(t.filter_help("a;b").is_err());
}
