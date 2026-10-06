//! Generated media: assets that have no file, produced by FFmpeg's `lavfi` sources at render time. Solid colours (also the
//! transparent canvas that titles are drawn on). A generated asset lasts "as long as needed" (24 h) like a still image.

use crate::error::{Error, Result};
use crate::ffprobe::{ColorInfo, MediaInfo, VideoStream, STILL_SECONDS};
use crate::project::{MediaAsset, ProjectSettings};
use crate::time::Rational;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Generator {
    /// `#RRGGBB` or `#RRGGBBAA` (alpha 00 = fully transparent).
    Solid { color: String },
    /// A compound clip: the picture and sound of another sequence of this project, rendered to a file when needed.
    Nested { sequence: String },
}

/// Colour of the transparent canvas titles are drawn on.
pub const TRANSPARENT: &str = "#00000000";

impl Generator {
    /// The `lavfi` `color` source colour text (None for generators that are not a `lavfi` source).
    pub fn ffmpeg_color(&self) -> Option<String> {
        match self {
            Generator::Solid { color } => Some(crate::titles::ffmpeg_color(color)),
            Generator::Nested { .. } => None,
        }
    }
}

/// A generated solid-colour asset with a deterministic id (so the same colour reuses one asset).
pub fn solid_asset(color: &str, settings: &ProjectSettings) -> Result<MediaAsset> {
    let color = color.to_lowercase();
    if color.len() == 9 {
        crate::titles::check_hex(&color, 8)?;
    } else {
        crate::titles::check_hex(&color, 6).map_err(|_| Error::validation(format!("colour '{color}' must look like #RRGGBB or #RRGGBBAA")))?;
    }
    let name = if color == TRANSPARENT { "Title canvas".to_string() } else { format!("Solid {color}") };
    Ok(MediaAsset {
        id: format!("gen_solid_{}", &color[1..]),
        name,
        path: format!("generated:solid:{}", &color[1..]),
        fingerprint: None,
        generator: Some(Generator::Solid { color }),
        color_override: None,
        info: MediaInfo {
            container: "generated".into(),
            duration: Rational::from_int(STILL_SECONDS),
            still: true,
            video: vec![VideoStream { index: 0, codec: "generated".into(), width: settings.width, height: settings.height, fps: Some(settings.fps), bit_rate: None, color: ColorInfo::default() }],
            ..Default::default()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solid_assets_are_deterministic_and_validated() {
        let s = ProjectSettings::default();
        let a = solid_asset("#FF8000", &s).unwrap();
        assert_eq!(a.id, "gen_solid_ff8000");
        assert_eq!(a, solid_asset("#ff8000", &s).unwrap());
        assert!(a.info.still && a.info.has_video() && !a.info.has_audio());
        assert!(solid_asset("orange", &s).is_err());
        assert_eq!(solid_asset(TRANSPARENT, &s).unwrap().name, "Title canvas");
        assert_eq!(Generator::Solid { color: "#00000000".into() }.ffmpeg_color().as_deref(), Some("0x000000@0.000"));
        assert_eq!(Generator::Nested { sequence: "seq_x".into() }.ffmpeg_color(), None);
    }
}
