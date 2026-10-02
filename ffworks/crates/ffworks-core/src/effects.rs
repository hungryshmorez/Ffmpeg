//! Effect registry (spec §109): every effect declares typed parameter metadata (range, default, step, unit)
//! plus its FFmpeg serialisation rule, so the UI, validation, randomisation and the compiler share one definition.

use crate::error::{Error, Result};
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
}

#[derive(Clone, Debug, Serialize)]
pub struct EffectDef {
    pub id: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    /// FFmpeg filter names this effect needs (checked against the capability registry).
    pub requires: &'static [&'static str],
    pub params: Vec<ParamDef>,
}

const fn p(id: &'static str, name: &'static str, min: f64, max: f64, default: f64, step: f64, unit: &'static str) -> ParamDef {
    ParamDef { id, name, min, max, default, step, unit }
}

pub fn registry() -> Vec<EffectDef> {
    vec![
        EffectDef { id: "brightness", name: "Brightness", category: "Color", requires: &["eq"], params: vec![p("amount", "Amount", -1.0, 1.0, 0.0, 0.01, "")] },
        EffectDef { id: "contrast", name: "Contrast", category: "Color", requires: &["eq"], params: vec![p("amount", "Amount", 0.0, 3.0, 1.0, 0.01, "×")] },
        EffectDef { id: "saturation", name: "Saturation", category: "Color", requires: &["eq"], params: vec![p("amount", "Amount", 0.0, 3.0, 1.0, 0.01, "×")] },
        EffectDef { id: "gamma", name: "Gamma", category: "Color", requires: &["eq"], params: vec![p("amount", "Amount", 0.1, 4.0, 1.0, 0.01, "")] },
        EffectDef { id: "hue", name: "Hue rotate", category: "Color", requires: &["hue"], params: vec![p("degrees", "Degrees", -180.0, 180.0, 0.0, 1.0, "°")] },
        EffectDef { id: "blur", name: "Gaussian blur", category: "Blur", requires: &["gblur"], params: vec![p("sigma", "Sigma", 0.0, 50.0, 4.0, 0.1, "px")] },
        EffectDef { id: "sharpen", name: "Sharpen", category: "Sharpen", requires: &["unsharp"], params: vec![p("amount", "Amount", 0.0, 5.0, 1.0, 0.05, "")] },
        EffectDef { id: "noise", name: "Film grain", category: "Noise", requires: &["noise"], params: vec![p("strength", "Strength", 0.0, 100.0, 20.0, 1.0, ""), p("seed", "Seed", 0.0, 9999.0, 1.0, 1.0, "")] },
        EffectDef { id: "vignette", name: "Vignette", category: "Color", requires: &["vignette"], params: vec![p("angle", "Angle", 0.1, 1.5, 0.6, 0.01, "rad")] },
        EffectDef { id: "flip_h", name: "Flip horizontal", category: "Transform", requires: &["hflip"], params: vec![] },
        EffectDef { id: "flip_v", name: "Flip vertical", category: "Transform", requires: &["vflip"], params: vec![] },
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

/// FFmpeg filter text for an effect instance, or None when it is a no-op / disabled.
pub fn to_filter(inst: &EffectInstance) -> Result<Option<String>> {
    if !inst.enabled {
        return Ok(None);
    }
    let def = find(&inst.effect)?;
    let g = |k: &str| -> Result<f64> {
        let d = def.params.iter().find(|d| d.id == k).ok_or_else(|| Error::validation(format!("effect '{}' has no parameter '{k}'", def.id)))?;
        let v = inst.params.get(k).copied().unwrap_or(d.default);
        check_param(&def, k, v)?;
        Ok(v)
    };
    Ok(Some(match inst.effect.as_str() {
        "brightness" => format!("eq=brightness={}", g("amount")?),
        "contrast" => format!("eq=contrast={}", g("amount")?),
        "saturation" => format!("eq=saturation={}", g("amount")?),
        "gamma" => format!("eq=gamma={}", g("amount")?),
        "hue" => format!("hue=h={}", g("degrees")?),
        "blur" => {
            let s = g("sigma")?;
            if s == 0.0 { return Ok(None); }
            format!("gblur=sigma={s}")
        }
        // unsharp luma amount; 5x5 matrix is FFmpeg's default and works for all sizes
        "sharpen" => format!("unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount={}", g("amount")?),
        // all_seed makes grain deterministic for a given seed (spec §30)
        "noise" => format!("noise=alls={}:allf=t:all_seed={}", g("strength")?.round() as i64, g("seed")?.round() as i64),
        "vignette" => format!("vignette=angle={}", g("angle")?),
        "flip_h" => "hflip".into(),
        "flip_v" => "vflip".into(),
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
        assert_eq!(to_filter(&e).unwrap().unwrap(), "eq=saturation=0.5");
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
        assert!(to_filter(&e).unwrap().is_none());
        e.enabled = true;
        e.params.insert("sigma".into(), 0.0);
        assert!(to_filter(&e).unwrap().is_none());
    }

    #[test]
    fn every_registered_effect_serialises_with_defaults() {
        for d in registry() {
            let e = EffectInstance::new("x".into(), d.id, &BTreeMap::new()).unwrap();
            assert!(to_filter(&e).unwrap().is_some(), "{}", d.id);
        }
    }

    #[test]
    fn grain_is_seeded() {
        let mut o = BTreeMap::new();
        o.insert("seed".into(), 42.0);
        let e = EffectInstance::new("x".into(), "noise", &o).unwrap();
        assert!(to_filter(&e).unwrap().unwrap().contains("all_seed=42"));
    }
}
