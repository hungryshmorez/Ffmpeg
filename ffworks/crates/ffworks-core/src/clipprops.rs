//! Per-clip video properties beyond effects: transform (position/scale/rotation about the frame centre),
//! blend mode, and the registry of clip-level parameters that can be set or keyframed.

use crate::effects;
use crate::error::{Error, Result};
use crate::project::Clip;
use serde::{Deserialize, Serialize};

/// Position is an offset in project pixels from the centred, fit-to-frame position; rotation in degrees (clockwise);
/// scale 1.0 = fitted to the frame. All pivot about the frame centre.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Transform {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rotation: f64,
}

impl Default for Transform {
    fn default() -> Self {
        Transform { x: 0.0, y: 0.0, scale: 1.0, rotation: 0.0 }
    }
}

impl Transform {
    pub fn is_identity(&self) -> bool {
        *self == Transform::default()
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ClipParamDef {
    pub id: &'static str,
    pub name: &'static str,
    pub min: f64,
    pub max: f64,
    pub default: f64,
    pub step: f64,
    pub unit: &'static str,
    /// Can this parameter be keyframed? (Pan is a fixed filter coefficient in FFmpeg, so it cannot.)
    pub animatable: bool,
}

const fn d(id: &'static str, name: &'static str, min: f64, max: f64, default: f64, step: f64, unit: &'static str) -> ClipParamDef {
    ClipParamDef { id, name, min, max, default, step, unit, animatable: true }
}

/// Video clip parameters that live on the clip itself (not in an effect). All can be keyframed.
pub fn video_params() -> Vec<ClipParamDef> {
    vec![
        d("opacity", "Opacity", 0.0, 1.0, 1.0, 0.01, ""),
        d("x", "Position X", -8192.0, 8192.0, 0.0, 1.0, "px"),
        d("y", "Position Y", -8192.0, 8192.0, 0.0, 1.0, "px"),
        d("scale", "Scale", 0.01, 16.0, 1.0, 0.01, "×"),
        d("rotation", "Rotation", -3600.0, 3600.0, 0.0, 0.5, "°"),
    ]
}

/// Audio clip parameters: volume (animatable as an envelope) and balance.
pub fn audio_params() -> Vec<ClipParamDef> {
    vec![d("gain_db", "Volume", -96.0, 24.0, 0.0, 0.1, "dB"), ClipParamDef { animatable: false, ..d("pan", "Pan", -1.0, 1.0, 0.0, 0.01, "") }]
}

/// FFmpeg `blend` modes offered in the UI (all exist in FFmpeg ≥ 4). "normal" uses the plain overlay path.
pub const BLEND_MODES: &[(&str, &str)] = &[
    ("normal", "Normal"),
    ("multiply", "Multiply"),
    ("screen", "Screen"),
    ("overlay", "Overlay"),
    ("darken", "Darken"),
    ("lighten", "Lighten"),
    ("addition", "Add"),
    ("subtract", "Subtract"),
    ("difference", "Difference"),
    ("exclusion", "Exclusion"),
    ("softlight", "Soft light"),
    ("hardlight", "Hard light"),
    ("dodge", "Color dodge"),
    ("burn", "Color burn"),
    ("divide", "Divide"),
    ("hardmix", "Hard mix"),
];

pub fn check_blend(mode: &str) -> Result<()> {
    if BLEND_MODES.iter().any(|(m, _)| *m == mode) {
        Ok(())
    } else {
        Err(Error::validation(format!("unknown blend mode '{mode}'")))
    }
}

/// Resolve a parameter id used by `set_clip_param` / keyframes to `(display name, min, max)`.
/// Ids: a clip parameter (`opacity`, `x`, `y`, `scale`, `rotation`) or `fx:<effect instance id>:<param>`.
/// Effect parameters must be animatable (see `effects::ParamDef::animatable`).
pub fn param_range(clip: &Clip, param: &str, for_keyframes: bool) -> Result<(String, f64, f64)> {
    if let Some(rest) = param.strip_prefix("fx:") {
        let (fx_id, p) = rest.split_once(':').ok_or_else(|| Error::validation(format!("bad parameter id '{param}'")))?;
        let inst = clip.effects.iter().find(|e| e.id == fx_id).ok_or_else(|| Error::NotFound(format!("effect {fx_id}")))?;
        let def = effects::find(&inst.effect)?;
        let pd = def.params.iter().find(|x| x.id == p).ok_or_else(|| Error::validation(format!("effect '{}' has no parameter '{p}'", def.id)))?;
        if for_keyframes && !pd.animatable {
            return Err(Error::validation(format!("{} {} cannot be animated (FFmpeg's filter takes a fixed value)", def.name, pd.name)));
        }
        return Ok((format!("{} {}", def.name, pd.name), pd.min, pd.max));
    }
    let defs = if clip.kind == crate::project::TrackKind::Audio { audio_params() } else { video_params() };
    let d = defs.into_iter().find(|d| d.id == param).ok_or_else(|| Error::validation(format!("unknown parameter '{param}' for a {:?} clip", clip.kind)))?;
    if for_keyframes && !d.animatable {
        return Err(Error::validation(format!("{} cannot be animated (FFmpeg's filter takes a fixed value)", d.name)));
    }
    Ok((d.name.to_string(), d.min, d.max))
}

pub fn check_value(clip: &Clip, param: &str, value: f64, for_keyframes: bool) -> Result<()> {
    let (name, min, max) = param_range(clip, param, for_keyframes)?;
    if !value.is_finite() || value < min || value > max {
        return Err(Error::validation(format!("{name} = {value} is outside {min}..{max}")));
    }
    Ok(())
}

impl Clip {
    /// Current static value of a clip-level video parameter.
    pub fn static_param(&self, id: &str) -> Option<f64> {
        Some(match id {
            "opacity" => self.opacity,
            "x" => self.transform.x,
            "y" => self.transform.y,
            "scale" => self.transform.scale,
            "rotation" => self.transform.rotation,
            "gain_db" => self.gain_db,
            "pan" => self.pan,
            _ => return None,
        })
    }

    pub fn set_static_param(&mut self, id: &str, v: f64) {
        match id {
            "opacity" => self.opacity = v,
            "x" => self.transform.x = v,
            "y" => self.transform.y = v,
            "scale" => self.transform.scale = v,
            "rotation" => self.transform.rotation = v,
            "gain_db" => self.gain_db = v,
            "pan" => self.pan = v,
            _ => {}
        }
    }
}
