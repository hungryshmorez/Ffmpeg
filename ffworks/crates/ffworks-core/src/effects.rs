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
    /// "video" or "audio": which kind of clip the effect applies to.
    pub kind: &'static str,
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

/// All effects offered on this machine: the built-in ones plus the frei0r plugins that are installed.
pub fn registry() -> Vec<EffectDef> {
    let mut v = builtin_registry();
    v.extend(crate::frei0r::offered());
    v.extend(crate::ladspa::offered());
    v
}

fn builtin_registry() -> Vec<EffectDef> {
    let e = |id, name, category, requires: &'static [&'static str], params| EffectDef { id, name, kind: "video", category, requires, params, alpha: false };
    let au = |id, name, category, requires: &'static [&'static str], params| EffectDef { id, name, kind: "audio", category, requires, params, alpha: false };
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
        e("lens_correction", "Lens correction (barrel / pincushion)", "Transform", &["lenscorrection"], vec![p("k1", "Quadratic term k1", -1.0, 1.0, 0.2, 0.01, ""), p("k2", "Double-quadratic term k2", -1.0, 1.0, 0.0, 0.01, "")]),
        e("temperature", "Colour temperature", "Color", &["colortemperature"], vec![p("kelvin", "Temperature", 1000.0, 40000.0, 4500.0, 100.0, "K")]),
        e("vibrance", "Vibrance", "Color", &["vibrance"], vec![p("intensity", "Intensity", -2.0, 2.0, 0.6, 0.05, "")]),
        e("exposure", "Exposure", "Color", &["exposure"], vec![p("stops", "Exposure", -3.0, 3.0, 0.5, 0.05, "EV")]),
        e("denoise_video", "Denoise (spatial + temporal)", "Restoration", &["hqdn3d"], vec![p("strength", "Strength", 0.0, 20.0, 4.0, 0.5, "")]),
        e("deflicker", "Remove flicker", "Restoration", &["deflicker"], vec![p("size", "Frames averaged", 2.0, 129.0, 5.0, 1.0, "")]),
        e("swap_uv", "Swap colour channels U/V (colour glitch)", "Glitch", &["swapuv"], vec![]),
        e("rgb_rotate", "Rotate colour channels (R→G→B)", "Glitch", &["colorchannelmixer"], vec![p("steps", "Steps (1 or 2)", 1.0, 2.0, 1.0, 1.0, "")]),
        e("frame_diff", "Frame difference (motion edges)", "Glitch", &["tblend"], vec![]),
        e("frame_shuffle", "Frame shuffle (time glitch)", "Glitch", &["random"], vec![p("frames", "Frames shuffled together", 2.0, 60.0, 12.0, 1.0, ""), p("seed", "Seed", 0.0, 9999.0, 1.0, 1.0, "")]),
        e("flip_h", "Flip horizontal", "Transform", &["hflip"], vec![]),
        e("flip_v", "Flip vertical", "Transform", &["vflip"], vec![]),
        au("eq", "Equalizer (3-band)", "EQ", &["bass", "equalizer", "treble"], vec![p("low", "Low shelf 120 Hz", -18.0, 18.0, 0.0, 0.5, "dB"), p("mid", "Mid", -18.0, 18.0, 0.0, 0.5, "dB"), p("mid_freq", "Mid frequency", 200.0, 5000.0, 1000.0, 10.0, "Hz"), p("high", "High shelf 8 kHz", -18.0, 18.0, 0.0, 0.5, "dB")]),
        au("highpass", "High-pass filter", "EQ", &["highpass"], vec![p("freq", "Cutoff", 20.0, 2000.0, 80.0, 1.0, "Hz")]),
        au("lowpass", "Low-pass filter", "EQ", &["lowpass"], vec![p("freq", "Cutoff", 1000.0, 20000.0, 12000.0, 50.0, "Hz")]),
        au("compressor", "Compressor", "Dynamics", &["acompressor"], vec![p("threshold", "Threshold", -60.0, 0.0, -18.0, 0.5, "dB"), p("ratio", "Ratio", 1.0, 20.0, 4.0, 0.1, ":1"), p("attack", "Attack", 1.0, 200.0, 20.0, 1.0, "ms"), p("release", "Release", 20.0, 1000.0, 250.0, 5.0, "ms"), p("makeup", "Make-up gain", 0.0, 24.0, 0.0, 0.5, "dB")]),
        au("limiter", "Limiter", "Dynamics", &["alimiter"], vec![p("ceiling", "Ceiling", -24.0, 0.0, -1.0, 0.5, "dB")]),
        au("echo", "Echo", "Time", &["aecho"], vec![p("delay", "Delay", 20.0, 2000.0, 300.0, 10.0, "ms"), p("decay", "Decay", 0.0, 0.9, 0.4, 0.05, "")]),
        au("denoise", "Noise reduction (FFT)", "Restoration", &["afftdn"], vec![p("amount", "Reduction", 0.0, 40.0, 12.0, 0.5, "dB")]),
        au("normalizer", "Dynamic normalizer", "Dynamics", &["dynaudnorm"], vec![]),
        au("mono", "Mono downmix", "Channels", &["pan"], vec![]),
        e("pixelate", "Pixelate", "Stylize", &["pixelize"], vec![p("size", "Block size", 2.0, 200.0, 16.0, 1.0, "px")]),
        e("grayscale", "Black & white", "Color", &["hue"], vec![]),
        e("sepia", "Sepia", "Color", &["colorchannelmixer"], vec![]),
        e("negate", "Invert colours", "Color", &["negate"], vec![]),
        e("lut", "Colour lookup table (LUT)", "Color", &["lut3d"], vec![]),
        e("posterize", "Posterize", "Stylize", &["lutrgb"], vec![p("bits", "Bits per channel", 1.0, 7.0, 3.0, 1.0, "")]),
        e("edges", "Edge detect", "Stylize", &["edgedetect"], vec![]),
        e("rgb_split", "RGB split (glitch)", "Glitch", &["rgbashift"], vec![p("amount", "Shift", 0.0, 60.0, 8.0, 1.0, "px")]),
        e("trails", "Motion trails", "Glitch", &["tmix"], vec![p("frames", "Frames mixed", 2.0, 30.0, 6.0, 1.0, "")]),
        e("shuffle_pixels", "Pixel shuffle (scramble blocks)", "Glitch", &["shufflepixels"], vec![p("size", "Block size", 2.0, 200.0, 24.0, 1.0, "px"), p("seed", "Seed", 0.0, 9999.0, 1.0, 1.0, "")]),
        e("pixel_sort", "Pixel sort", "Glitch", &[], vec![
            p("direction", "Direction (0 across, 1 down)", 0.0, 1.0, 0.0, 1.0, ""),
            p("key", "Sort by (0 brightness, 1 hue, 2 saturation, 3 value, 4 red, 5 green, 6 blue)", 0.0, 6.0, 0.0, 1.0, ""),
            p("mode", "Which pixels (0 brightness range, 1 whole lines, 2 random blocks)", 0.0, 2.0, 0.0, 1.0, ""),
            pa("low", "Range from brightness", 0.0, 1.0, 0.25, 0.01, ""),
            pa("high", "Range up to brightness", 0.0, 1.0, 0.8, 0.01, ""),
            pa("length", "Block length", 2.0, 2000.0, 120.0, 1.0, "px"),
            pa("variation", "Block length variation", 0.0, 1.0, 0.5, 0.05, ""),
            p("reverse", "Order (0 dark to light, 1 light to dark)", 0.0, 1.0, 0.0, 1.0, ""),
            pa("mix", "Amount", 0.0, 1.0, 1.0, 0.01, ""),
            p("seed", "Seed", 0.0, 9999.0, 1.0, 1.0, ""),
            p("flicker", "New blocks every frame (0 off, 1 on)", 0.0, 1.0, 0.0, 1.0, ""),
            pa("angle", "Angle (turns the direction, degrees)", -90.0, 90.0, 0.0, 1.0, "°"),
            p("mask", "Only inside a shape (0 everywhere, 1 rectangle, 2 ellipse, 3 a picture: white sorts, black stays)", 0.0, 3.0, 0.0, 1.0, ""),
            pa("mask_x", "Shape centre across", 0.0, 1.0, 0.5, 0.01, ""),
            pa("mask_y", "Shape centre down", 0.0, 1.0, 0.5, 0.01, ""),
            pa("mask_w", "Shape width", 0.0, 1.0, 0.5, 0.01, ""),
            pa("mask_h", "Shape height", 0.0, 1.0, 0.5, 0.01, ""),
            pa("mask_feather", "Soft edge", 0.0, 400.0, 0.0, 1.0, "px"),
            p("mask_invert", "Sort outside the shape or picture instead (0 no, 1 yes)", 0.0, 1.0, 0.0, 1.0, ""),
        ]),
        e("chroma_shift", "Chroma shift (colour bleed)", "Glitch", &["chromashift"], vec![p("amount", "Shift", -40.0, 40.0, 8.0, 1.0, "px")]),
        e("scroll", "Scroll (wrap around)", "Glitch", &["scroll"], vec![p("speed", "Horizontal speed", -0.1, 0.1, 0.02, 0.005, "/frame")]),
        e("ghost", "Ghosting (slow update)", "Glitch", &["lagfun"], vec![p("decay", "Decay", 0.5, 0.99, 0.95, 0.01, "")]),
        e("deband", "Remove banding", "Restoration", &["deband"], vec![]),
        e("deinterlace", "Deinterlace", "Restoration", &["kerndeint"], vec![]),
        EffectDef { id: "chroma_key", name: "Chroma key", kind: "video", category: "Keying", requires: &["chromakey"], params: vec![p("colour", "Key colour (0 green, 1 blue, 2 red)", 0.0, 2.0, 0.0, 1.0, ""), p("similarity", "Similarity", 0.01, 0.6, 0.15, 0.01, ""), p("blend", "Edge blend", 0.0, 0.5, 0.05, 0.01, "")], alpha: true },
        au("phaser", "Phaser", "Modulation", &["aphaser"], vec![p("speed", "Speed", 0.1, 2.0, 0.5, 0.05, "Hz"), p("decay", "Decay", 0.1, 0.9, 0.4, 0.05, "")]),
        au("chorus", "Chorus", "Modulation", &["chorus"], vec![p("speed", "Speed", 0.1, 5.0, 0.5, 0.1, "Hz"), p("depth", "Depth", 0.1, 5.0, 2.0, 0.1, "ms")]),
        au("flanger", "Flanger", "Modulation", &["flanger"], vec![p("delay", "Delay", 0.0, 30.0, 3.0, 0.5, "ms"), p("speed", "Speed", 0.1, 10.0, 0.5, 0.1, "Hz")]),
        au("tremolo", "Tremolo", "Modulation", &["tremolo"], vec![p("freq", "Rate", 0.1, 20.0, 5.0, 0.1, "Hz"), p("depth", "Depth", 0.0, 1.0, 0.5, 0.05, "")]),
        au("vibrato", "Vibrato", "Modulation", &["vibrato"], vec![p("freq", "Rate", 0.1, 20.0, 5.0, 0.1, "Hz"), p("depth", "Depth", 0.0, 1.0, 0.5, 0.05, "")]),
        au("gate", "Noise gate", "Dynamics", &["agate"], vec![p("threshold", "Threshold", -80.0, 0.0, -40.0, 0.5, "dB"), p("ratio", "Ratio", 1.0, 20.0, 4.0, 0.5, ":1")]),
        au("declick", "De-click", "Restoration", &["adeclick"], vec![]),
        au("declip", "De-clip", "Restoration", &["adeclip"], vec![]),
        au("bandpass", "Band-pass filter", "EQ", &["bandpass"], vec![p("freq", "Centre", 100.0, 10000.0, 1000.0, 10.0, "Hz"), p("width", "Width", 20.0, 5000.0, 500.0, 10.0, "Hz")]),
        au("volume", "Volume", "Dynamics", &["volume"], vec![p("gain", "Gain", -60.0, 24.0, 0.0, 0.5, "dB")]),
        au("bitcrush", "Bit crusher", "Glitch", &["acrusher"], vec![p("bits", "Bits", 1.0, 16.0, 8.0, 1.0, ""), p("samples", "Sample hold", 1.0, 100.0, 4.0, 1.0, "")]),
        au("softclip", "Soft clip (saturation)", "Dynamics", &["asoftclip"], vec![]),
        au("widen", "Stereo widen", "Channels", &["stereowiden"], vec![p("delay", "Delay", 1.0, 100.0, 20.0, 1.0, "ms")]),
        EffectDef { id: GRAPH_EFFECT, name: "Custom filter graph", kind: "video", category: "Custom", requires: &[], params: vec![], alpha: false },
        EffectDef {
            id: "crop",
            name: "Crop",
            kind: "video",
            category: "Transform",
            requires: &["drawbox"],
            params: vec![p("left", "Left", 0.0, 95.0, 0.0, 0.5, "%"), p("top", "Top", 0.0, 95.0, 0.0, 0.5, "%"), p("right", "Right", 0.0, 95.0, 0.0, 0.5, "%"), p("bottom", "Bottom", 0.0, 95.0, 0.0, 0.5, "%")],
            alpha: true,
        },
    ]
}

pub fn find(id: &str) -> Result<EffectDef> {
    // frei0r effects always resolve (so saved projects load anywhere); `registry()` lists only the installed ones
    if let Some(d) = crate::frei0r::find(id).or_else(|| crate::ladspa::find(id)) {
        return Ok(d);
    }
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
    /// Only for the `graph` effect: the user-built node graph.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph: Option<crate::filtergraph::FilterGraph>,
    /// Only for `pixel_sort`: the project media (a picture or a video) whose brightness is the mask when `mask` is 3.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
    /// Only for `lut`: the lookup-table file (`.cube`, `.3dl`, `.dat`, `.m3d`, `.csp`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

/// File types FFmpeg's `lut3d` reads.
pub const LUT_EXTENSIONS: &[&str] = &["cube", "3dl", "dat", "m3d", "csp"];
/// Largest lookup table accepted (bytes).
pub const LUT_MAX_BYTES: u64 = 64 << 20;

/// Effect id of the node-graph effect.
pub const GRAPH_EFFECT: &str = "graph";
/// Marks a filter string that holds whole filtergraph statements (with `@T@`, `@IN@`, `@OUT@` placeholders) rather than one filter.
pub const GRAPH_MARK: char = '\u{1}';

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
        let graph = (effect == GRAPH_EFFECT).then(crate::filtergraph::FilterGraph::passthrough);
        Ok(EffectInstance { id, effect: effect.into(), enabled: true, params, graph, picture: None, file: None })
    }
}

pub fn check_param(def: &EffectDef, param: &str, value: f64) -> Result<()> {
    let d = def.params.iter().find(|d| d.id == param).ok_or_else(|| Error::validation(format!("effect '{}' has no parameter '{param}'", def.id)))?;
    if !value.is_finite() || value < d.min || value > d.max {
        return Err(Error::validation(format!("{} {} = {value} is outside {}..{}", def.name, d.name, d.min, d.max)));
    }
    Ok(())
}

fn db_to_lin(db: f64) -> f64 {
    10f64.powf(db / 20.0)
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
        id if id.starts_with(crate::ladspa::PREFIX) => crate::ladspa::filter_text(id, &inst.params).ok_or_else(|| Error::validation(format!("bad LADSPA effect '{id}'")))?,
        id if id.starts_with(crate::frei0r::PREFIX) => crate::frei0r::filter_text(id, &inst.params).ok_or_else(|| Error::validation(format!("bad frei0r effect '{id}'")))?,
        GRAPH_EFFECT => {
            let g = inst.graph.as_ref().ok_or_else(|| Error::validation("graph effect has no graph"))?;
            // a pure pass-through changes nothing
            if g.nodes.len() == 2 && g.edges.len() == 1 {
                g.validate()?;
                return Ok(None);
            }
            format!("{GRAPH_MARK}{}", g.compile("@T@", "@IN@", "@OUT@")?)
        }
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
        "lens_correction" => format!("lenscorrection=k1={}:k2={}", g("k1")?, g("k2")?),
        "temperature" => format!("colortemperature=temperature={}", g("kelvin")?.round() as i64),
        "vibrance" => format!("vibrance=intensity={}", g("intensity")?),
        "exposure" => format!("exposure=exposure={}", g("stops")?),
        "denoise_video" => {
            let a = g("strength")?;
            if a == 0.0 {
                return Ok(None);
            }
            format!("hqdn3d={a}:{a}:{}:{}", a * 1.5, a * 1.5)
        }
        "deflicker" => format!("deflicker=size={}:mode=pm", g("size")?.round() as i64),
        "swap_uv" => "swapuv".into(),
        // red takes green's place, green blue's, blue red's (one step), or the other way round (two)
        "rgb_rotate" => {
            if g("steps")?.round() as i64 == 2 {
                "colorchannelmixer=rr=0:rg=0:rb=1:gr=1:gg=0:gb=0:br=0:bg=1:bb=0".into()
            } else {
                "colorchannelmixer=rr=0:rg=1:rb=0:gr=0:gg=0:gb=1:br=1:bg=0:bb=0".into()
            }
        }
        "frame_diff" => "tblend=all_mode=difference".into(),
        "frame_shuffle" => format!("random=frames={}:seed={}", g("frames")?.round() as i64, g("seed")?.round() as i64),
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
        "eq" => {
            let (lo, mid, hi) = (g("low")?, g("mid")?, g("high")?);
            let mut parts = vec![];
            if lo != 0.0 { parts.push(format!("bass=g={lo}:f=120")); }
            if mid != 0.0 { parts.push(format!("equalizer=f={}:t=q:w=1:g={mid}", g("mid_freq")?)); }
            if hi != 0.0 { parts.push(format!("treble=g={hi}:f=8000")); }
            if parts.is_empty() { return Ok(None); }
            parts.join(",")
        }
        "highpass" => format!("highpass=f={}", g("freq")?),
        "lowpass" => format!("lowpass=f={}", g("freq")?),
        // acompressor takes linear thresholds/make-up; the UI speaks dB
        "compressor" => format!("acompressor=threshold={:.6}:ratio={}:attack={}:release={}:makeup={:.6}", db_to_lin(g("threshold")?), g("ratio")?, g("attack")?, g("release")?, db_to_lin(g("makeup")?)),
        "limiter" => format!("alimiter=limit={:.6}:attack=5:release=50:level=0", db_to_lin(g("ceiling")?)),
        "echo" => format!("aecho=in_gain=0.8:out_gain=0.9:delays={}:decays={}", g("delay")?, g("decay")?),
        "denoise" => {
            let a = g("amount")?;
            if a == 0.0 { return Ok(None); }
            format!("afftdn=nr={a}")
        }
        "normalizer" => "dynaudnorm=f=150:g=15".into(),
        "mono" => "pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1".into(),
        "pixelate" => format!("pixelize=w={0}:h={0}:mode=avg", g("size")?.round() as i64),
        "grayscale" => "hue=s=0".into(),
        "sepia" => "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131:0:0:0:0:1".into(),
        "negate" => "negate".into(),
        // keep the top N bits of each colour channel; the quotes protect the commas inside the expression
        "posterize" => {
            let mask = 256 - (1i64 << (8 - g("bits")?.round() as i64));
            format!("lutrgb=r='bitand(val,{mask})':g='bitand(val,{mask})':b='bitand(val,{mask})'")
        }
        "edges" => "edgedetect=mode=wires:high=0.2:low=0.08".into(),
        "rgb_split" => {
            let a = g("amount")?.round() as i64;
            if a == 0 { return Ok(None); }
            format!("rgbashift=rh={a}:bh=-{a}:edge=smear")
        }
        "trails" => format!("tmix=frames={}", g("frames")?.round() as i64),
        "shuffle_pixels" => {
            let n = g("size")?.round() as i64;
            format!("shufflepixels=direction=forward:mode=horizontal:width={n}:height={n}:seed={}", g("seed")?.round() as i64)
        }
        // not an FFmpeg filter: a marker that `bake` turns into a pre-render stage
        "pixel_sort" => {
            for d in &def.params {
                g(d.id)?;
            }
            // animated parameters travel with the marker as their keyframes; the bake reads them frame by frame
            let anim: std::collections::BTreeMap<String, Vec<keyframes::Keyframe>> = def.params.iter().filter(|d| animated(d.id)).map(|d| (d.id.to_string(), kfs[&key(d.id)].clone())).collect();
            if anim.is_empty() && g("mix")? == 0.0 {
                return Ok(None);
            }
            let mut sort = crate::pixelsort::Params::from_map(&inst.params);
            if !anim.is_empty() {
                sort.base = inst.params.clone();
                sort.anim = anim;
            }
            crate::bake::mark(&sort)
        }
        "lut" => {
            // nothing happens until a file is chosen; a chosen file that has gone missing is an error, not a silent no-op
            let Some(f) = inst.file.as_deref() else { return Ok(None) };
            if !std::path::Path::new(f).is_file() {
                return Err(Error::validation(format!("the LUT file '{f}' is missing")));
            }
            format!("lut3d=file={}:interp=tetrahedral", crate::titles::escape_filter_value(f))
        }
        "chroma_shift" => {
            let a = g("amount")?.round() as i64;
            if a == 0 { return Ok(None); }
            format!("chromashift=cbh={a}:crh={}", -a)
        }
        "scroll" => {
            let v = g("speed")?;
            if v == 0.0 { return Ok(None); }
            format!("scroll=horizontal={v}")
        }
        "ghost" => format!("lagfun=decay={}", g("decay")?),
        "deband" => "deband".into(),
        // kerndeint rather than yadif/bwdif: those change the stream time base, which makes xfade (transitions) refuse the clip
        "deinterlace" => "kerndeint".into(),
        "chroma_key" => {
            let colour = ["0x00ff00", "0x0000ff", "0xff0000"][g("colour")?.round() as usize];
            format!("chromakey=color={colour}:similarity={}:blend={}", g("similarity")?, g("blend")?)
        }
        "phaser" => format!("aphaser=speed={}:decay={}", g("speed")?, g("decay")?),
        "chorus" => format!("chorus=0.6:0.9:40:0.4:{}:{}", g("speed")?, g("depth")?),
        "flanger" => format!("flanger=delay={}:speed={}", g("delay")?, g("speed")?),
        "tremolo" => format!("tremolo=f={}:d={}", g("freq")?, g("depth")?),
        "vibrato" => format!("vibrato=f={}:d={}", g("freq")?, g("depth")?),
        "gate" => format!("agate=threshold={:.6}:ratio={}", db_to_lin(g("threshold")?), g("ratio")?),
        "declick" => "adeclick".into(),
        "declip" => "adeclip".into(),
        "bandpass" => format!("bandpass=f={}:width_type=h:w={}", g("freq")?, g("width")?),
        "volume" => {
            let v = g("gain")?;
            if v == 0.0 { return Ok(None); }
            format!("volume={v}dB")
        }
        "bitcrush" => format!("acrusher=bits={}:samples={}:mix=1:mode=lin", g("bits")?.round() as i64, g("samples")?.round() as i64),
        "softclip" => "asoftclip=type=tanh".into(),
        "widen" => format!("stereowiden=delay={}", g("delay")?),
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
            // crop, eq and volume at their defaults are deliberate no-ops
            assert_eq!(to_filter(&e, &KeyframeMap::new()).unwrap().is_some(), !["crop", "eq", "graph", "volume", "lut"].contains(&d.id), "{}", d.id);
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
