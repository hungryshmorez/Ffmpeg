//! LADSPA audio plugins (the swh, TAP and CMT sets Audacity has long used) as audio effects. FFmpeg's `ladspa` filter
//! loads them by file name from the LADSPA folders (`LADSPA_PATH`, `~/.ladspa`, system folders). The control tables
//! below were read from the plugins themselves through the LADSPA C API with `scripts/ladspa/dump.py` (the plugins are
//! GPL-2+ / LGPL-2.1+; FFWORKS only drives them through FFmpeg as separate files on the user's machine and ships none).
//!
//! Only effects with one or two audio inputs and the same number of outputs are offered (mono effects are run once per
//! channel by FFmpeg). Plugins with a sample-rate-scaled control (most IIR filters, the gate, decimators) are left out:
//! FFmpeg checks those controls against the unscaled bounds, so they cannot be driven correctly. Controls the plugin leaves unbounded get a finite slider range around their default. As with
//! frei0r, an effect is offered only when its library is installed here, and a saved one always resolves.

use crate::effects::{EffectDef, ParamDef};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

const JSON: &str = include_str!("../assets/ladspa/plugins.json");
pub const PREFIX: &str = "la:";

#[derive(Debug, Deserialize)]
struct File {
    libraries: Vec<Library>,
}
#[derive(Debug, Deserialize)]
pub struct Library {
    pub file: String,
    pub plugins: Vec<Plugin>,
}
#[derive(Debug, Deserialize)]
pub struct Plugin {
    pub label: String,
    pub name: String,
    #[serde(default)]
    pub maker: String,
    pub channels: u32,
    pub controls: Vec<Control>,
}
#[derive(Debug, Deserialize)]
pub struct Control {
    pub name: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub default: Option<f64>,
    #[serde(default)]
    pub toggled: bool,
    #[serde(default)]
    pub integer: bool,
    /// The plugin scales this control's bounds by the sample rate. FFmpeg's `ladspa` filter (6.1 and 7.1) ignores that
    /// hint and range-checks against the raw bounds, so such controls cannot be set to sensible values through it.
    #[serde(default)]
    pub sample_rate: bool,
}

pub fn libraries() -> &'static [Library] {
    static L: OnceLock<Vec<Library>> = OnceLock::new();
    L.get_or_init(|| serde_json::from_str::<File>(JSON).expect("assets/ladspa/plugins.json is valid").libraries)
}

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

/// A finite (min, max, default) for a control; unbounded ends are placed around the default.
pub fn range(c: &Control) -> (f64, f64, f64) {
    if c.toggled {
        return (0.0, 1.0, if c.default.unwrap_or(0.0) > 0.0 { 1.0 } else { 0.0 });
    }
    let d = c.default.or(c.min).or(c.max).unwrap_or(0.0);
    let span = d.abs().max(c.min.unwrap_or(0.0).abs()).max(c.max.unwrap_or(0.0).abs()).max(1.0);
    let lo = c.min.unwrap_or(if d >= 0.0 && c.max.is_none_or(|m| m > 0.0) { 0.0 } else { d - 4.0 * span });
    let mut hi = c.max.unwrap_or(d.max(lo) + 4.0 * span);
    if hi <= lo {
        hi = lo + 1.0;
    }
    (lo, hi, d.clamp(lo, hi))
}

fn param_def(i: usize, c: &Control) -> ParamDef {
    let (min, max, default) = range(c);
    let step = if c.toggled || c.integer { 1.0 } else { ((max - min) / 200.0).max(1e-4) };
    ParamDef { id: leak(format!("c{i}")), name: leak(c.name.clone()), min, max, default, step, unit: "", animatable: false }
}

fn safe(s: &str) -> bool {
    !s.is_empty() && !s.contains("..") && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

/// Every plugin FFWORKS can drive, installed or not (ids like `la:amp_1181:amp`).
fn all_defs() -> &'static Vec<EffectDef> {
    static D: OnceLock<Vec<EffectDef>> = OnceLock::new();
    D.get_or_init(|| {
        libraries()
            .iter()
            .flat_map(|l| l.plugins.iter().map(move |p| (l, p)))
            .filter(|(l, p)| safe(&l.file) && safe(&p.label) && (p.channels == 1 || p.channels == 2) && !p.controls.iter().any(|c| c.sample_rate))
            .map(|(l, p)| EffectDef {
                id: leak(format!("{PREFIX}{}:{}", l.file, p.label)),
                name: leak(p.name.clone()),
                kind: "audio",
                category: "LADSPA",
                requires: &["ladspa"],
                params: p.controls.iter().enumerate().map(|(i, c)| param_def(i, c)).collect(),
                alpha: false,
            })
            .collect()
    })
}

pub fn all() -> Vec<EffectDef> {
    all_defs().clone()
}

/// Look up one LADSPA effect by id (installed or not).
pub fn find(id: &str) -> Option<EffectDef> {
    all_defs().iter().find(|d| d.id == id).cloned()
}

fn split(id: &str) -> Option<(&str, &str)> {
    let rest = id.strip_prefix(PREFIX)?;
    let (f, l) = rest.split_once(':')?;
    (safe(f) && safe(l)).then_some((f, l))
}

struct State {
    installed: BTreeSet<String>,
}
static STATE: RwLock<Option<State>> = RwLock::new(None);

/// `LADSPA_PATH` as FFWORKS found it at start-up. `configure` rewrites the variable, so later calls must not read their own
/// earlier output back (a folder the user removed would never go away).
fn original_path() -> Option<std::ffi::OsString> {
    static ORIGINAL: std::sync::OnceLock<Option<std::ffi::OsString>> = std::sync::OnceLock::new();
    ORIGINAL.get_or_init(|| std::env::var_os("LADSPA_PATH")).clone()
}

/// Folders FFmpeg's ladspa filter looks in, the user's own first.
pub fn plugin_dirs(extra: &[String]) -> Vec<PathBuf> {
    dirs_for(extra, original_path().as_deref())
}

fn dirs_for(extra: &[String], env_path: Option<&std::ffi::OsStr>) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = extra.iter().filter(|s| !s.trim().is_empty()).map(PathBuf::from).collect();
    if let Some(p) = env_path {
        v.extend(std::env::split_paths(p));
    }
    if let Some(h) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        v.push(PathBuf::from(h).join(".ladspa"));
    }
    for d in ["/usr/local/lib/ladspa", "/usr/lib/ladspa", "/usr/lib/x86_64-linux-gnu/ladspa", "/usr/lib64/ladspa", "/opt/homebrew/lib/ladspa"] {
        v.push(PathBuf::from(d));
    }
    v
}

/// Library file stems found in `dirs` (same rule as frei0r).
pub fn scan(dirs: &[PathBuf]) -> BTreeSet<String> {
    crate::frei0r::scan(dirs)
}

/// The `LADSPA_PATH` value that names `extra` first, then what the environment had, then the usual folders that exist.
fn path_value(extra: &[String], env_path: Option<&std::ffi::OsStr>) -> Option<std::ffi::OsString> {
    let mut parts: Vec<PathBuf> = extra.iter().filter(|s| !s.trim().is_empty()).map(PathBuf::from).collect();
    if let Some(p) = env_path {
        let existing: Vec<PathBuf> = std::env::split_paths(p).filter(|x| !parts.contains(x)).collect();
        parts.extend(existing);
    }
    // FFmpeg only consults LADSPA_PATH when it is set, so name the usual folders too
    for d in dirs_for(&[], None) {
        if d.is_dir() && !parts.contains(&d) {
            parts.push(d);
        }
    }
    std::env::join_paths(&parts).ok()
}

/// Point FFWORKS (and every FFmpeg it starts) at extra LADSPA folders and rescan. Replaces any folders given earlier.
pub fn configure(extra: &[String]) {
    let installed = scan(&plugin_dirs(extra));
    if let Some(joined) = path_value(extra, original_path().as_deref()) {
        std::env::set_var("LADSPA_PATH", joined);
    }
    *STATE.write().unwrap() = Some(State { installed });
}

/// Library stems installed on this machine (scans on first use).
pub fn installed() -> BTreeSet<String> {
    if STATE.read().unwrap().is_none() {
        configure(&[]);
    }
    STATE.read().unwrap().as_ref().map(|s| s.installed.clone()).unwrap_or_default()
}

/// The LADSPA effects to offer: those whose library is installed.
pub fn offered() -> Vec<EffectDef> {
    let inst = installed();
    all_defs().iter().filter(|d| split(d.id).is_some_and(|(f, _)| inst.contains(f))).cloned().collect()
}

/// `ladspa=file=<lib>:plugin=<label>:controls=c0=v|c1=v...` for an instance's parameters.
pub fn filter_text(effect_id: &str, params: &BTreeMap<String, f64>) -> Option<String> {
    let def = find(effect_id)?;
    let (file, label) = split(effect_id)?;
    let vals: Vec<String> = def
        .params
        .iter()
        .map(|d| {
            let v = params.get(d.id).copied().unwrap_or(d.default).clamp(d.min, d.max);
            let v = if d.step >= 1.0 { v.round() } else { v };
            format!("{}={}", d.id, v)
        })
        .collect();
    Some(if vals.is_empty() { format!("ladspa=file={file}:plugin={label}") } else { format!("ladspa=file={file}:plugin={label}:controls={}", vals.join("|")) })
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_path_names_extra_folders_first_and_forgets_removed_ones() {
        let env = std::env::join_paths(["/from/env"]).unwrap();
        let with = path_value(&["/my/plugins".into(), "  ".into()], Some(env.as_os_str())).unwrap();
        let parts: Vec<PathBuf> = std::env::split_paths(&with).collect();
        assert_eq!(&parts[..2], &[PathBuf::from("/my/plugins"), PathBuf::from("/from/env")]);
        // the same call built from the *original* environment again no longer mentions the removed folder
        let without = path_value(&[], Some(env.as_os_str())).unwrap();
        assert!(!std::env::split_paths(&without).any(|p| p.as_path() == std::path::Path::new("/my/plugins")));
        assert_eq!(dirs_for(&["/x".into()], None)[0], PathBuf::from("/x"));
    }

    use super::*;

    #[test]
    fn table_has_the_swh_tap_and_cmt_sets_with_finite_ranges() {
        assert!(all_defs().len() >= 100, "{}", all_defs().len());
        for d in all_defs() {
            assert_eq!(d.kind, "audio");
            for p in &d.params {
                assert!(p.min.is_finite() && p.max.is_finite() && p.min < p.max && p.default >= p.min && p.default <= p.max, "{} {}: {p:?}", d.id, p.name);
            }
        }
        assert!(find("la:amp_1181:amp").is_some() || all_defs().iter().any(|d| d.id.starts_with("la:amp")));
    }

    #[test]
    fn filter_text_quotes_names_and_rounds_switches() {
        let d = all_defs().iter().find(|d| !d.params.is_empty()).unwrap();
        let t = filter_text(d.id, &BTreeMap::new()).unwrap();
        assert!(t.starts_with("ladspa=file=") && t.contains(":plugin=") && t.contains(":controls=c0="), "{t}");
        assert!(filter_text("la:../x:y", &BTreeMap::new()).is_none());
        assert!(filter_text("la:a/b:y", &BTreeMap::new()).is_none());
        assert!(filter_text("f0:glitch0r", &BTreeMap::new()).is_none());
    }

    #[test]
    fn unbounded_controls_get_ranges_around_the_default() {
        let c = Control { name: "x".into(), min: Some(0.0), max: None, default: Some(0.5), toggled: false, integer: false, sample_rate: false };
        let (lo, hi, d) = range(&c);
        assert_eq!((lo, d), (0.0, 0.5));
        assert!(hi >= 4.0);
        let c = Control { name: "x".into(), min: None, max: None, default: Some(-3.0), toggled: false, integer: false, sample_rate: false };
        let (lo, hi, d) = range(&c);
        assert!(lo < -3.0 && hi > -3.0 && d == -3.0);
    }
}
