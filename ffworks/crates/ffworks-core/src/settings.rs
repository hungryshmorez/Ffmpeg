//! Persistent application settings (not part of any project). Resolution order for tools:
//! saved setting > `FFWORKS_FFMPEG`/`FFWORKS_FFPROBE` > bundled copy shipped with the installer > `PATH`.
//! Binaries are never downloaded at runtime (spec §95); the Windows installer bundles a pinned build fetched and checksum-verified in CI.

use crate::error::{Error, Result};
use crate::process::Tools;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    pub ffmpeg_path: Option<String>,
    pub ffprobe_path: Option<String>,
    #[serde(default)]
    pub favourites: Favourites,
    /// Registered FFmpeg builds (the user may install several: full/essentials, GPL/LGPL, a GPU-enabled one...).
    #[serde(default)]
    pub engines: Vec<crate::engines::EngineEntry>,
    /// Id of the registered build used for everything unless an export names another; when unset, `ffmpeg_path` etc. apply.
    #[serde(default)]
    pub active_engine: Option<String>,
    /// Extra folders holding frei0r plugins (glitch0r, pixeliz0r...), searched before the standard ones.
    #[serde(default)]
    pub frei0r_dirs: Vec<String>,
    /// Named effect stacks saved from a clip ("My glitch look") that can be applied to any clip of the same kind.
    #[serde(default)]
    pub effect_presets: std::collections::BTreeMap<String, EffectPreset>,
}

/// One effect inside a preset: the effect id and its parameter values.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PresetEffect {
    pub effect: String,
    #[serde(default)]
    pub params: std::collections::BTreeMap<String, f64>,
}

/// A saved effect stack. `kind` is "video" or "audio": which clips it can be applied to.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct EffectPreset {
    pub kind: String,
    pub effects: Vec<PresetEffect>,
}

pub const MAX_PRESETS: usize = 100;

impl EffectPreset {
    /// Check every effect exists, belongs to `kind`, and has parameters inside their ranges. Custom filter graphs are not saved
    /// (their node graph is part of the project, not a parameter list).
    pub fn validate(&self, name: &str) -> Result<()> {
        let n = name.trim();
        if n.is_empty() || n.chars().count() > 60 {
            return Err(Error::validation("preset names must be 1-60 characters"));
        }
        if self.kind != "video" && self.kind != "audio" {
            return Err(Error::validation("preset kind must be video or audio"));
        }
        if self.effects.is_empty() || self.effects.len() > 30 {
            return Err(Error::validation("a preset needs 1-30 effects"));
        }
        for fx in &self.effects {
            let def = crate::effects::find(&fx.effect)?;
            if fx.effect == crate::effects::GRAPH_EFFECT {
                return Err(Error::validation("custom filter graphs cannot be saved as presets"));
            }
            if def.kind != self.kind {
                return Err(Error::validation(format!("'{}' is a {} effect, not {}", def.name, def.kind, self.kind)));
            }
            for (k, v) in &fx.params {
                crate::effects::check_param(&def, k, *v)?;
            }
        }
        Ok(())
    }
}

/// A set of favourite effects and transitions (ids as listed by the effect registry / FFmpeg's transition names).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct FavGroup {
    #[serde(default)]
    pub effects: Vec<String>,
    #[serde(default)]
    pub transitions: Vec<String>,
}

/// The starred items plus any number of named groups ("Glitchy", "Clean"...). Random buttons and demo mode can draw from
/// everything, the starred set, or one named group.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Favourites {
    #[serde(default)]
    pub starred: FavGroup,
    #[serde(default)]
    pub groups: std::collections::BTreeMap<String, FavGroup>,
}

pub const POOL_ALL: &str = "all";
pub const POOL_STARRED: &str = "favourites";

impl Favourites {
    /// Reject unknown effect ids and malformed names; drop duplicates (keeping order).
    pub fn normalised(mut self) -> Result<Favourites> {
        let known: std::collections::BTreeSet<&str> = crate::effects::registry().iter().map(|d| d.id).collect();
        let clean = |g: &mut FavGroup| -> Result<()> {
            for e in &g.effects {
                if !known.contains(e.as_str()) || e == crate::effects::GRAPH_EFFECT {
                    return Err(Error::validation(format!("'{e}' is not an effect that can be a favourite")));
                }
            }
            for t in &g.transitions {
                crate::transitions::check_kind(t)?;
            }
            let dedup = |v: &mut Vec<String>| {
                let mut seen = std::collections::BTreeSet::new();
                v.retain(|x| seen.insert(x.clone()));
            };
            dedup(&mut g.effects);
            dedup(&mut g.transitions);
            Ok(())
        };
        clean(&mut self.starred)?;
        for (name, g) in self.groups.iter_mut() {
            let n = name.trim();
            if n.is_empty() || n.chars().count() > 40 || n == POOL_ALL || n == POOL_STARRED {
                return Err(Error::validation(format!("'{name}' is not a usable group name")));
            }
            clean(g)?;
        }
        Ok(self)
    }

    /// The favourites a random pick may use: `all` (no restriction, returns None), `favourites`, or a named group.
    /// Errors when the chosen set is empty so the user is told to star something rather than getting "everything".
    pub fn pool(&self, name: &str) -> Result<Option<&FavGroup>> {
        match name {
            POOL_ALL => Ok(None),
            POOL_STARRED => Ok(Some(&self.starred)),
            other => self.groups.get(other).map(Some).ok_or_else(|| Error::NotFound(format!("favourite group '{other}'"))),
        }
    }
}

impl Settings {
    /// Add or replace a preset (validated). Names are trimmed.
    pub fn put_preset(&mut self, name: &str, preset: EffectPreset) -> Result<()> {
        preset.validate(name)?;
        let n = name.trim().to_string();
        if !self.effect_presets.contains_key(&n) && self.effect_presets.len() >= MAX_PRESETS {
            return Err(Error::validation(format!("at most {MAX_PRESETS} presets; delete one first")));
        }
        self.effect_presets.insert(n, preset);
        Ok(())
    }

    pub fn load(file: &Path) -> Settings {
        std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn save(&self, file: &Path) -> Result<()> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| Error::io(dir, e))?;
        }
        let tmp = file.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?).map_err(|e| Error::io(&tmp, e))?;
        std::fs::rename(&tmp, file).map_err(|e| Error::io(file, e))
    }

    /// Tools of a registered engine (its ffprobe defaults to the one next to its ffmpeg).
    pub fn engine_tools(&self, id: &str) -> Option<Tools> {
        self.engines.iter().find(|e| e.id == id).map(|e| e.tools())
    }

    pub fn tools(&self) -> Tools {
        self.tools_with_bundled(None)
    }

    /// Like [`tools`](Self::tools), but falls back to FFmpeg/FFprobe shipped inside `bundled_dir` (when present)
    /// before looking at `PATH`.
    pub fn tools_with_bundled(&self, bundled_dir: Option<&Path>) -> Tools {
        if let Some(t) = self.active_engine.as_deref().and_then(|id| self.engine_tools(id)) {
            return t;
        }
        let exe = |n: &str| if cfg!(windows) { format!("{n}.exe") } else { n.to_string() };
        let bundled = |n: &str| bundled_dir.map(|d| d.join(exe(n))).filter(|p| p.is_file());
        let blank = |s: &Option<String>| s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(PathBuf::from);
        let pick = |setting: &Option<String>, env: &str, name: &str| -> PathBuf {
            blank(setting).or_else(|| std::env::var_os(env).map(PathBuf::from)).or_else(|| bundled(name)).unwrap_or_else(|| PathBuf::from(name))
        };
        Tools { ffmpeg: pick(&self.ffmpeg_path, "FFWORKS_FFMPEG", "ffmpeg"), ffprobe: pick(&self.ffprobe_path, "FFWORKS_FFPROBE", "ffprobe") }
    }
}

/// Run `-version` on both tools; returns their version lines or the first failure. Used before accepting new settings.
pub fn validate_tools(tools: &Tools) -> Result<(String, String)> {
    let first = |p: &Path, flag: &str| -> Result<String> {
        let out = tools.run_capture(p, &[flag], None)?;
        out.lines().next().map(str::to_string).filter(|l| !l.is_empty()).ok_or_else(|| Error::validation(format!("{} printed no version", p.display())))
    };
    let ff = first(&tools.ffmpeg, "-version")?;
    let pr = first(&tools.ffprobe, "-version")?;
    if !ff.to_lowercase().contains("ffmpeg") {
        return Err(Error::validation(format!("{} does not look like FFmpeg ({ff})", tools.ffmpeg.display())));
    }
    if !pr.to_lowercase().contains("ffprobe") {
        return Err(Error::validation(format!("{} does not look like FFprobe ({pr})", tools.ffprobe.display())));
    }
    Ok((ff, pr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_blank_means_unset() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("s/settings.json");
        assert_eq!(Settings::load(&f), Settings::default());
        let s = Settings { ffmpeg_path: Some("  ".into()), ffprobe_path: Some("/x/ffprobe".into()), ..Default::default() };
        s.save(&f).unwrap();
        assert_eq!(Settings::load(&f), s);
        let t = s.tools();
        assert_eq!(t.ffprobe, PathBuf::from("/x/ffprobe"));
        assert_ne!(t.ffmpeg, PathBuf::from("  "));
    }

    #[test]
    fn bundled_copy_is_used_after_settings_and_env_but_before_path() {
        let d = tempfile::tempdir().unwrap();
        let name = |n: &str| if cfg!(windows) { format!("{n}.exe") } else { n.to_string() };
        std::fs::write(d.path().join(name("ffmpeg")), b"x").unwrap();
        std::fs::write(d.path().join(name("ffprobe")), b"x").unwrap();
        // SAFETY of env use in tests: these variables are only read by this crate's discovery code.
        if std::env::var_os("FFWORKS_FFMPEG").is_none() && std::env::var_os("FFWORKS_FFPROBE").is_none() {
            let t = Settings::default().tools_with_bundled(Some(d.path()));
            assert_eq!(t.ffmpeg, d.path().join(name("ffmpeg")));
            assert_eq!(t.ffprobe, d.path().join(name("ffprobe")));
            // an explicit saved path beats the bundled copy
            let t = Settings { ffmpeg_path: Some("/custom/ffmpeg".into()), ffprobe_path: None, ..Default::default() }.tools_with_bundled(Some(d.path()));
            assert_eq!(t.ffmpeg, PathBuf::from("/custom/ffmpeg"));
            assert_eq!(t.ffprobe, d.path().join(name("ffprobe")));
            // nothing bundled -> plain PATH names
            let empty = tempfile::tempdir().unwrap();
            assert_eq!(Settings::default().tools_with_bundled(Some(empty.path())).ffmpeg, PathBuf::from("ffmpeg"));
        }
    }

    #[test]
    fn rejects_non_ffmpeg_and_missing() {
        let t = Tools { ffmpeg: "definitely-not-here".into(), ffprobe: "definitely-not-here".into() };
        assert!(validate_tools(&t).is_err());
        // `ls --version` runs but is not FFmpeg
        let t = Tools { ffmpeg: "ls".into(), ffprobe: "ls".into() };
        assert!(validate_tools(&t).is_err());
    }
}

#[cfg(test)]
mod fav_tests {
    use super::*;

    fn fav(effects: &[&str], transitions: &[&str]) -> FavGroup {
        FavGroup { effects: effects.iter().map(|s| s.to_string()).collect(), transitions: transitions.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn old_settings_files_load_without_favourites_and_round_trip() {
        let old: Settings = serde_json::from_str(r#"{"ffmpeg_path":"/x/ffmpeg","ffprobe_path":null}"#).unwrap();
        assert_eq!(old.favourites, Favourites::default());
        let mut s = old;
        s.favourites.starred = fav(&["blur"], &["fade"]);
        s.favourites.groups.insert("Glitchy".into(), fav(&["noise"], &["pixelize"]));
        let back: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn normalising_rejects_unknown_ids_and_bad_group_names_and_drops_duplicates() {
        let ok = Favourites { starred: fav(&["blur", "blur", "hue"], &["fade", "fade"]), groups: Default::default() }.normalised().unwrap();
        assert_eq!(ok.starred, fav(&["blur", "hue"], &["fade"]));
        assert!(Favourites { starred: fav(&["nope"], &[]), groups: Default::default() }.normalised().is_err());
        assert!(Favourites { starred: fav(&["graph"], &[]), groups: Default::default() }.normalised().is_err(), "the custom graph effect has no fixed look to favourite");
        assert!(Favourites { starred: fav(&[], &["not-a-transition"]), groups: Default::default() }.normalised().is_err());
        for bad in ["", "   ", "all", "favourites"] {
            let mut g = std::collections::BTreeMap::new();
            g.insert(bad.to_string(), FavGroup::default());
            assert!(Favourites { starred: FavGroup::default(), groups: g }.normalised().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn pool_lookup() {
        let mut f = Favourites::default();
        f.groups.insert("Clean".into(), fav(&["contrast"], &[]));
        assert!(f.pool("all").unwrap().is_none());
        assert!(f.pool("favourites").unwrap().unwrap().effects.is_empty());
        assert_eq!(f.pool("Clean").unwrap().unwrap().effects, vec!["contrast".to_string()]);
        assert!(f.pool("Missing").is_err());
    }
}

#[cfg(test)]
mod preset_tests {
    use super::*;

    fn fx(effect: &str, params: &[(&str, f64)]) -> PresetEffect {
        PresetEffect { effect: effect.into(), params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect() }
    }

    #[test]
    fn presets_are_validated_stored_replaced_and_survive_a_save_load() {
        let mut st = Settings::default();
        let ok = EffectPreset { kind: "video".into(), effects: vec![fx("blur", &[("sigma", 9.0)]), fx("hue", &[("degrees", 40.0)])] };
        st.put_preset("  Dreamy ", ok.clone()).unwrap();
        assert!(st.effect_presets.contains_key("Dreamy"), "name is trimmed");
        let replaced = EffectPreset { kind: "video".into(), effects: vec![fx("negate", &[])] };
        st.put_preset("Dreamy", replaced.clone()).unwrap();
        assert_eq!(st.effect_presets["Dreamy"], replaced);
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("s.json");
        st.save(&f).unwrap();
        assert_eq!(Settings::load(&f).effect_presets["Dreamy"], replaced);
        // refusals
        assert!(st.put_preset("", ok.clone()).is_err());
        assert!(st.put_preset("x", EffectPreset { kind: "video".into(), effects: vec![] }).is_err());
        assert!(st.put_preset("x", EffectPreset { kind: "video".into(), effects: vec![fx("nope", &[])] }).is_err());
        assert!(st.put_preset("x", EffectPreset { kind: "video".into(), effects: vec![fx("blur", &[("sigma", 9999.0)])] }).is_err());
        assert!(st.put_preset("x", EffectPreset { kind: "audio".into(), effects: vec![fx("blur", &[])] }).is_err(), "video effect in an audio preset");
        assert!(st.put_preset("x", EffectPreset { kind: "video".into(), effects: vec![fx("graph", &[])] }).is_err());
    }
}
