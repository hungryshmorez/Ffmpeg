//! frei0r video plugins (glitch0r, pixeliz0r, vertigo...) as effects. FFmpeg's `frei0r` filter loads them by name from
//! the plugin folders (`FREI0R_PATH`, `~/.frei0r-1/lib`, system folders). The parameter tables below were read from the
//! plugins themselves with `scripts/frei0r/dump.py` (frei0r-plugins is GPL-2+; FFWORKS only drives them through
//! FFmpeg as separate files on the user's machine, and ships none of the plugin binaries).
//!
//! Filters whose parameters are numbers, switches, colours (shown as red/green/blue sliders) or positions (x/y sliders) are
//! offered as effects; the few with text parameters are not (they need a text editor). The effects offered are those whose plugin file is
//! actually installed here; effects already saved in a project always resolve, so a project opens on a machine without
//! the plugin and only fails when rendered, with FFmpeg's own "could not find module" message.

use crate::effects::{EffectDef, ParamDef};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

const JSON: &str = include_str!("../assets/frei0r/plugins.json");
pub const PREFIX: &str = "f0:";

#[derive(Debug, Deserialize)]
struct File {
    plugins: Vec<Plugin>,
}
#[derive(Debug, Deserialize)]
pub struct Plugin {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub explanation: String,
    pub params: Vec<Param>,
}
#[derive(Debug, Deserialize)]
pub struct Param {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub explanation: String,
    pub default: Option<f64>,
}

pub fn plugins() -> &'static [Plugin] {
    static P: OnceLock<Vec<Plugin>> = OnceLock::new();
    P.get_or_init(|| serde_json::from_str::<File>(JSON).expect("assets/frei0r/plugins.json is valid").plugins)
}

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

/// Effect parameters for one plugin parameter: a number or switch is one slider, a colour is red/green/blue, a position is x/y.
fn param_defs(i: usize, q: &Param) -> Vec<ParamDef> {
    let one = |id: String, name: String, default: f64, step: f64| ParamDef { id: leak(id), name: leak(name), min: 0.0, max: 1.0, default: default.clamp(0.0, 1.0), step, unit: "", animatable: false };
    match q.ty.as_str() {
        "color" => ["r", "g", "b"].iter().zip(["red", "green", "blue"]).map(|(c, n)| one(format!("p{i}{c}"), format!("{} ({n})", q.name), 0.5, 0.01)).collect(),
        "position" => ["x", "y"].iter().map(|c| one(format!("p{i}{c}"), format!("{} ({c})", q.name), 0.5, 0.01)).collect(),
        ty => vec![one(format!("p{i}"), q.name.clone(), q.default.unwrap_or(0.0), if ty == "bool" { 1.0 } else { 0.01 })],
    }
}

/// Every plugin FFWORKS can drive, installed or not, as effect definitions (ids like `f0:glitch0r`).
fn all_defs() -> &'static Vec<EffectDef> {
    static D: OnceLock<Vec<EffectDef>> = OnceLock::new();
    D.get_or_init(|| {
        plugins()
            .iter()
            .filter(|p| p.kind == "filter" && p.params.iter().all(|q| ["double", "bool", "color", "position"].contains(&q.ty.as_str())))
            .map(|p| EffectDef {
                id: leak(format!("{PREFIX}{}", p.id)),
                name: leak(p.name.clone()),
                kind: "video",
                category: "Frei0r",
                requires: &["frei0r"],
                params: p.params.iter().enumerate().flat_map(|(i, q)| param_defs(i, q)).collect(),
                alpha: false,
            })
            .collect()
    })
}

/// Look up one frei0r effect by its id (installed or not).
pub fn find(id: &str) -> Option<EffectDef> {
    all_defs().iter().find(|d| d.id == id).cloned()
}

struct State {
    extra: Vec<String>,
    installed: BTreeSet<String>,
}
static STATE: RwLock<Option<State>> = RwLock::new(None);

/// Folders FFmpeg's frei0r filter will look in, plus the user's own.
pub fn plugin_dirs(extra: &[String]) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = extra.iter().filter(|s| !s.trim().is_empty()).map(PathBuf::from).collect();
    if let Some(p) = std::env::var_os("FREI0R_PATH") {
        v.extend(std::env::split_paths(&p));
    }
    if let Some(h) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        v.push(PathBuf::from(h).join(".frei0r-1").join("lib"));
    }
    for d in ["/usr/local/lib/frei0r-1", "/usr/lib/frei0r-1", "/usr/lib/x86_64-linux-gnu/frei0r-1", "/usr/lib64/frei0r-1", "/opt/homebrew/lib/frei0r-1"] {
        v.push(PathBuf::from(d));
    }
    v
}

/// Plugin ids (file stems of `*.so` / `*.dll` / `*.dylib`) found in `dirs`.
pub fn scan(dirs: &[PathBuf]) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for d in dirs {
        let Ok(rd) = std::fs::read_dir(d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()).is_some_and(|x| ["so", "dll", "dylib"].contains(&x.to_ascii_lowercase().as_str())) {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    found.insert(stem.to_string());
                }
            }
        }
    }
    found
}

/// Tell FFWORKS (and every FFmpeg it starts) where the user keeps frei0r plugins, and rescan. Call at start-up and when the
/// setting changes.
pub fn configure(extra: &[String]) {
    let dirs = plugin_dirs(extra);
    let installed = scan(&dirs);
    // FFmpeg reads FREI0R_PATH: put the user's folders first, keep whatever was already set
    let mut parts: Vec<PathBuf> = extra.iter().filter(|s| !s.trim().is_empty()).map(PathBuf::from).collect();
    if let Some(p) = std::env::var_os("FREI0R_PATH") {
        let existing: Vec<PathBuf> = std::env::split_paths(&p).filter(|x| !parts.contains(x)).collect();
        parts.extend(existing);
    }
    if let Ok(joined) = std::env::join_paths(&parts) {
        // single-threaded start-up / settings change; FFmpeg children inherit it
        std::env::set_var("FREI0R_PATH", joined);
    }
    *STATE.write().unwrap() = Some(State { extra: extra.to_vec(), installed });
}

/// Ids of the plugins installed on this machine (scans the default folders on first use).
pub fn installed() -> BTreeSet<String> {
    if STATE.read().unwrap().is_none() {
        configure(&[]);
    }
    STATE.read().unwrap().as_ref().map(|s| s.installed.clone()).unwrap_or_default()
}

pub fn extra_dirs() -> Vec<String> {
    STATE.read().unwrap().as_ref().map(|s| s.extra.clone()).unwrap_or_default()
}

/// The frei0r effects to offer: filters we can drive whose plugin file is installed.
pub fn offered() -> Vec<EffectDef> {
    let inst = installed();
    all_defs().iter().filter(|d| inst.contains(&d.id[PREFIX.len()..])).cloned().collect()
}

/// `frei0r=filter_name=<plugin>:filter_params=a|b|...` for an effect instance's parameters.
pub fn filter_text(effect_id: &str, params: &BTreeMap<String, f64>) -> Option<String> {
    let def = find(effect_id)?;
    let plugin = effect_id.strip_prefix(PREFIX)?;
    // the name goes into a filter graph and selects a file to load: bare names only, never a path
    if plugin.is_empty() || !plugin.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    let src = plugins().iter().find(|p| p.id == plugin)?;
    let get = |id: &str| def.params.iter().find(|d| d.id == id).map(|d| params.get(id).copied().unwrap_or(d.default)).unwrap_or(0.0);
    let vals: Vec<String> = src
        .params
        .iter()
        .enumerate()
        .map(|(i, q)| match q.ty.as_str() {
            "bool" => (if get(&format!("p{i}")) >= 0.5 { "y" } else { "n" }).to_string(),
            "color" => format!("{}/{}/{}", get(&format!("p{i}r")), get(&format!("p{i}g")), get(&format!("p{i}b"))),
            "position" => format!("{}/{}", get(&format!("p{i}x")), get(&format!("p{i}y"))),
            _ => format!("{}", get(&format!("p{i}"))),
        })
        .collect();
    Some(if vals.is_empty() { format!("frei0r=filter_name={plugin}") } else { format!("frei0r=filter_name={plugin}:filter_params={}", vals.join("|")) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_covers_glitch0r_with_its_four_parameters() {
        let d = find("f0:glitch0r").expect("glitch0r");
        assert_eq!(d.category, "Frei0r");
        assert_eq!(d.params.len(), 4);
        assert_eq!(d.params[0].name, "Glitch frequency");
        assert!(all_defs().len() >= 50, "{}", all_defs().len());
        assert!(all_defs().iter().all(|d| d.params.iter().all(|p| p.min == 0.0 && p.max == 1.0 && p.default >= 0.0 && p.default <= 1.0)));
    }

    #[test]
    fn filter_text_uses_names_not_paths_and_formats_switches() {
        let mut p = BTreeMap::new();
        p.insert("p0".to_string(), 1.0);
        let t = filter_text("f0:glitch0r", &p).unwrap();
        assert!(t.starts_with("frei0r=filter_name=glitch0r:filter_params=1|"), "{t}");
        assert_eq!(t.matches('|').count(), 3);
        assert!(filter_text("f0:../../evil", &BTreeMap::new()).is_none());
        assert!(filter_text("blur", &BTreeMap::new()).is_none());
        // a plugin with a bool parameter renders y/n
        let with_bool = plugins().iter().find(|p| p.kind == "filter" && p.params.iter().all(|q| q.ty == "double" || q.ty == "bool") && p.params.iter().any(|q| q.ty == "bool"));
        if let Some(pl) = with_bool {
            let t = filter_text(&format!("f0:{}", pl.id), &BTreeMap::new()).unwrap();
            assert!(t.contains('y') || t.contains('n'), "{t}");
        }
    }

    #[test]
    fn scan_finds_plugin_files_by_stem() {
        let d = tempfile::tempdir().unwrap();
        for f in ["glitch0r.so", "pixeliz0r.dll", "notes.txt", "vertigo.DLL"] {
            std::fs::write(d.path().join(f), b"x").unwrap();
        }
        let s = scan(&[d.path().to_path_buf()]);
        assert_eq!(s.into_iter().collect::<Vec<_>>(), ["glitch0r", "pixeliz0r", "vertigo"]);
    }
}
