//! Effect registry (spec §109): every effect declares typed parameter metadata (range, default, step, unit)
//! plus its FFmpeg serialisation rule, so the UI, validation, randomisation and the compiler share one definition.

use crate::error::{Error, Result};
use crate::keyframes::{self, Keyframe};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ParamDef {
    pub id: &'static str,
    pub name: &'static str,
    pub min: f64,
    pub max: f64,
    pub default: f64,
    pub step: f64,
    pub unit: &'static str,
    /// Whether the FFmpeg filter accepts a per-frame expression for this parameter, so it can be keyframed.
    pub animatable: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct EffectDef {
    pub id: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    /// FFmpeg filter names this effect needs (checked against the capability registry).
    pub requires: &'static [&'static str],
    pub params: Vec<ParamDef>,
    /// True when the effect writes transparency (the clip then composites through an alpha-capable path).
    pub alpha: bool,
}

const fn p(id: &'static str, name: &'static str, min: f64, max: f64, default: f64, step: f64, unit: &'static str) -> ParamDef {
    ParamDef { id, name, min, max, default, step, unit, animatable: false }
}
/// Like [`p`] but keyframable.
const fn pa(id: &'static str, name: &'static str, min: f64, max: f64, default: f64, step: f64, unit: &'static str) -> ParamDef {
    ParamDef { id, name, min, max, default, step, unit, animatable: true }
}

pub fn registry() -> Vec<EffectDef> {
    let e = |id, name, category, requires: &'static [&'static str], params| EffectDef { id, name, category, requires, params, alpha: false };
    vec![
        e("brightness", "Brightness", "Color", &["eq"], vec![pa("amount", "Amount", -1.0, 1.0, 0.0, 0.01, "")]),
        e("contrast", "Contrast", "Color", &["eq"], vec![pa("amount", "Amount", 0.0, 3.0, 1.0, 0.01, "×")]),
        e("saturation", "Saturation", "Color", &["eq"], vec![pa("amount", "Amount", 0.0, 3.0, 1.0, 0.01, "×")]),
        e("gamma", "Gamma", "Color", &["eq"], vec![pa("amount", "Amount", 0.1, 4.0, 1.0, 0.01, "")]),
        e("hue", "Hue rotate", "Color", &["hue"], vec![pa("degrees", "Degrees", -180.0, 180.0, 0.0, 1.0, "°")]),
        e("blur", "Gaussian blur", "Blur", &["gblur"], vec![p("sigma", "Sigma", 0.0, 50.0, 4.0, 0.1, "px")]),
        e("sharpen", "Sharpen", "Sharpen", &["unsharp"], vec![p("amount", "Amount", 0.0, 5.0, 1.0, 0.05, "")]),
        e("noise", "Film grain", "Noise", &["noise"], vec![p("strength", "Strength", 0.0, 100.0, 20.0, 1.0, ""), p("seed", "Seed", 0.0, 9999.0, 1.0, 1.0, "")]),
        e("vignette", "Vignette", "Color", &["vignette"], vec![pa("angle", "Angle", 0.1, 1.5, 0.6, 0.01, "rad")]),
        e("flip_h", "Flip horizontal", "Transform", &["hflip"], vec![]),
        e("flip_v", "Flip vertical", "Transform", &["vflip"], vec![]),
        EffectDef {
            id: "crop",
            name: "Crop",
            category: "Transform",
            requires: &["drawbox"],
            params: vec![p("left", "Left", 0.0, 95.0, 0.0, 0.5, "%"), p("top", "Top", 0.0, 95.0, 0.0, 0.5, "%"), p("right", "Right", 0.0, 95.0, 0.0, 0.5, "%"), p("bottom", "Bottom", 0.0, 95.0, 0.0, 0.5, "%")],
            alpha: true,
        },
    ]
}

pub fn find(id: &str) -> Result<EffectDef> {
    registry().into_iter().find(|e| e.id == id).ok_or_else(|| Error::validation(format!("unknown effect '{id}'")))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct EffectInstance {
    pub id: String,
    pub effect: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub params: BTreeMap<String, f64>,
}

fn yes() -> bool {
    true
}

impl EffectInstance {
    /// New instance with defaults, overridden (and validated) by `overrides`.
    pub fn new(id: String, effect: &str, overrides: &BTreeMap<String, f64>) -> Result<EffectInstance> {
        let def = find(effect)?;
        let mut params: BTreeMap<String, f64> = def.params.iter().map(|d| (d.id.to_string(), d.default)).collect();
        for (k, v) in overrides {
            check_param(&def, k, *v)?;
            params.insert(k.clone(), *v);
        }
        Ok(EffectInstance { id, effect: effect.into(), enabled: true, params })
    }
}

pub fn check_param(def: &EffectDef, param: &str, value: f64) -> Result<()> {
    let d = def.params.iter().find(|d| d.id == param).ok_or_else(|| Error::validation(format!("effect '{}' has no parameter '{param}'", def.id)))?;
    if !value.is_finite() || value < d.min || value > d.max {
        return Err(Error::validation(format!("{} {} = {value} is outside {}..{}", def.name, d.name, d.min, d.max)));
    }
    Ok(())
}

/// Keyframes of one clip, keyed by parameter id (`fx:<effect id>:<param>` for effect parameters).
pub type KeyframeMap = BTreeMap<String, Vec<Keyframe>>;

/// FFmpeg filter text for an effect instance, or None when it is a no-op / disabled. Animated parameters become per-frame
/// expressions in the clip-relative time variable `t` (filters run before the clip is placed on the timeline).
pub fn to_filter(inst: &EffectInstance, kfs: &KeyframeMap) -> Result<Option<String>> {
    if !inst.enabled {
        return Ok(None);
    }
    let def = find(&inst.effect)?;
    let key = |k: &str| format!("fx:{}:{k}", inst.id);
    let animated = |k: &str| def.params.iter().any(|d| d.id == k && d.animatable) && kfs.get(&key(k)).is_some_and(|v| !v.is_empty());
    let g = |k: &str| -> Result<f64> {
        let d = def.params.iter().find(|d| d.id == k).ok_or_else(|| Error::validation(format!("effect '{}' has no parameter '{k}'", def.id)))?;
        let v = inst.params.get(k).copied().unwrap_or(d.default);
        check_param(&def, k, v)?;
        Ok(v)
    };
    // numeric text for a static parameter, or a quoted per-frame expression for an animated one
    let val = |k: &str| -> Result<String> {
        if animated(k) {
            Ok(format!("'{}'", keyframes::to_expr(&kfs[&key(k)], "t")))
        } else {
            Ok(g(k)?.to_string())
        }
    };
    let eval = |k: &str| if animated(k) { ":eval=frame" } else { "" };
    Ok(Some(match inst.effect.as_str() {
        "brightness" => format!("eq=brightness={}{}", val("amount")?, eval("amount")),
        "contrast" => format!("eq=contrast={}{}", val("amount")?, eval("amount")),
        "saturation" => format!("eq=saturation={}{}", val("amount")?, eval("amount")),
        "gamma" => format!("eq=gamma={}{}", val("amount")?, eval("amount")),
        "hue" => format!("hue=h={}", val("degrees")?),
        "blur" => {
            let s = g("sigma")?;
            if s == 0.0 { return Ok(None); }
            format!("gblur=sigma={s}")
        }
        // unsharp luma amount; 5x5 matrix is FFmpeg's default and works for all sizes
        "sharpen" => format!("unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount={}", g("amount")?),
        // all_seed makes grain deterministic for a given seed (spec §30)
        "noise" => format!("noise=alls={}:allf=t:all_seed={}", g("strength")?.round() as i64, g("seed")?.round() as i64),
        "vignette" => format!("vignette=angle={}{}", val("angle")?, eval("angle")),
        "flip_h" => "hflip".into(),
        "flip_v" => "vflip".into(),
        "crop" => {
            let (l, t, r, b) = (g("left")? / 100.0, g("top")? / 100.0, g("right")? / 100.0, g("bottom")? / 100.0);
            if l + r >= 0.99 || t + b >= 0.99 {
                return Err(Error::validation("crop removes the whole picture; reduce left+right or top+bottom below 99%"));
            }
            if l == 0.0 && t == 0.0 && r == 0.0 && b == 0.0 {
                return Ok(None);
            }
            // transparent strips (alpha cleared with replace=1); the layer keeps its size and position
            let strip = |x: String, y: String, w: String, h: String| format!("drawbox=x={x}:y={y}:w={w}:h={h}:color=black@0:t=fill:replace=1");
            let mut parts = vec!["format=yuva420p".to_string()];
            if l > 0.0 { parts.push(strip("0".into(), "0".into(), format!("iw*{l}"), "ih".into())); }
            if r > 0.0 { parts.push(strip(format!("iw*(1-{r})"), "0".into(), format!("iw*{r}+1"), "ih".into())); }
            if t > 0.0 { parts.push(strip("0".into(), "0".into(), "iw".into(), format!("ih*{t}"))); }
            if b > 0.0 { parts.push(strip("0".into(), format!("ih*(1-{b})"), "iw".into(), format!("ih*{b}+1"))); }
            parts.join(",")
        }
        other => return Err(Error::validation(format!("effect '{other}' has no FFmpeg mapping"))),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_overrides() {
        let mut o = BTreeMap::new();
        o.insert("amount".into(), 0.5);
        let e = EffectInstance::new("fx1".into(), "saturation", &o).unwrap();
        assert_eq!(e.params["amount"], 0.5);
        assert_eq!(to_filter(&e, &KeyframeMap::new()).unwrap().unwrap(), "eq=saturation=0.5");
    }

    #[test]
    fn rejects_out_of_range_and_unknown() {
        let mut o = BTreeMap::new();
        o.insert("amount".into(), 9.0);
        assert!(EffectInstance::new("x".into(), "saturation", &o).is_err());
        assert!(EffectInstance::new("x".into(), "nope", &BTreeMap::new()).is_err());
        let mut o = BTreeMap::new();
        o.insert("bogus".into(), 1.0);
        assert!(EffectInstance::new("x".into(), "blur", &o).is_err());
        o.insert("bogus".into(), f64::NAN);
        assert!(EffectInstance::new("x".into(), "blur", &o).is_err());
    }

    #[test]
    fn disabled_and_noop_produce_nothing() {
        let mut e = EffectInstance::new("x".into(), "blur", &BTreeMap::new()).unwrap();
        e.enabled = false;
        assert!(to_filter(&e, &KeyframeMap::new()).unwrap().is_none());
        e.enabled = true;
        e.params.insert("sigma".into(), 0.0);
        assert!(to_filter(&e, &KeyframeMap::new()).unwrap().is_none());
    }

    #[test]
    fn every_registered_effect_serialises_with_defaults() {
        for d in registry() {
            let e = EffectInstance::new("x".into(), d.id, &BTreeMap::new()).unwrap();
            // crop with all-zero margins is a deliberate no-op
            assert_eq!(to_filter(&e, &KeyframeMap::new()).unwrap().is_some(), d.id != "crop", "{}", d.id);
        }
    }

    #[test]
    fn grain_is_seeded() {
        let mut o = BTreeMap::new();
        o.insert("seed".into(), 42.0);
        let e = EffectInstance::new("x".into(), "noise", &o).unwrap();
        assert!(to_filter(&e, &KeyframeMap::new()).unwrap().unwrap().contains("all_seed=42"));
    }
}
