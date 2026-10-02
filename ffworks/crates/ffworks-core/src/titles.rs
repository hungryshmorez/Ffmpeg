//! Titles: text drawn by FFmpeg's `drawtext` onto a transparent generated canvas. The clip is a normal video clip, so
//! position/scale/rotation, opacity (fades), blend modes, keyframes and effects all work on it unchanged.

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Align {
    Left,
    #[default]
    Center,
    Right,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Title {
    pub text: String,
    /// Font name from `fonts::list()`.
    pub font: String,
    /// Font size as a percentage of the frame height (so previews at lower resolution look the same).
    pub size: f64,
    /// `#RRGGBB`.
    pub color: String,
    pub align: Align,
    /// Outline width (% of frame height; 0 = none) and colour.
    pub outline_width: f64,
    pub outline_color: String,
    /// Drop shadow distance (% of frame height; 0 = none).
    pub shadow: f64,
    /// Background box colour `#RRGGBBAA` (None = no box) and padding (% of frame height).
    pub box_color: Option<String>,
    pub box_pad: f64,
}

impl Title {
    pub fn new(text: &str) -> Title {
        Title { text: text.into(), font: crate::fonts::DEFAULT_FONT_BOLD.into(), size: 9.0, color: "#ffffff".into(), align: Align::Center, outline_width: 0.4, outline_color: "#000000".into(), shadow: 0.0, box_color: None, box_pad: 1.0 }
    }

    pub fn validate(&self) -> Result<()> {
        if self.text.trim().is_empty() {
            return Err(Error::validation("a title needs some text"));
        }
        if self.text.chars().count() > 2000 || self.text.contains('\0') {
            return Err(Error::validation("title text is too long (2000 characters max) or contains a NUL character"));
        }
        if self.font.is_empty() || self.font.len() > 200 {
            return Err(Error::validation("invalid font name"));
        }
        for (what, v, lo, hi) in [("size", self.size, 1.0, 60.0), ("outline width", self.outline_width, 0.0, 6.0), ("shadow", self.shadow, 0.0, 6.0), ("box padding", self.box_pad, 0.0, 20.0)] {
            if !v.is_finite() || v < lo || v > hi {
                return Err(Error::validation(format!("title {what} {v} is outside {lo}..{hi}")));
            }
        }
        check_hex(&self.color, 6)?;
        check_hex(&self.outline_color, 6)?;
        if let Some(b) = &self.box_color {
            check_hex(b, 8)?;
        }
        Ok(())
    }
}

/// `#RRGGBB` (digits = 6) or `#RRGGBBAA` (digits = 8).
pub fn check_hex(s: &str, digits: usize) -> Result<()> {
    let ok = s.len() == digits + 1 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit());
    if ok {
        Ok(())
    } else {
        Err(Error::validation(format!("colour '{s}' must look like #{}", "RRGGBBAA".get(..digits).unwrap_or("RRGGBB"))))
    }
}

/// FFmpeg colour text for `#RRGGBB` / `#RRGGBBAA` (`0xRRGGBB@alpha`).
pub fn ffmpeg_color(hex: &str) -> String {
    let h = &hex[1..];
    if h.len() == 8 {
        let a = u8::from_str_radix(&h[6..8], 16).unwrap_or(255) as f64 / 255.0;
        format!("0x{}@{:.3}", &h[..6], a)
    } else {
        format!("0x{h}")
    }
}

/// Escape a value for use inside a filter graph passed as one argument: first the filter-option level (`\`, `'`, `:`),
/// then the filter-graph level (`\`, `'`, `[`, `]`, `,`, `;`). See "Notes on filtergraph escaping" in the FFmpeg docs.
pub fn escape_filter_value(v: &str) -> String {
    let mut l1 = String::with_capacity(v.len() + 8);
    for c in v.chars() {
        if matches!(c, '\\' | '\'' | ':') {
            l1.push('\\');
        }
        l1.push(c);
    }
    let mut l2 = String::with_capacity(l1.len() + 8);
    for c in l1.chars() {
        if matches!(c, '\\' | '\'' | '[' | ']' | ',' | ';') {
            l2.push('\\');
        }
        l2.push(c);
    }
    l2
}

/// `drawtext` filter for the title at output size `h` pixels high. `font_path` must already be resolved.
pub fn to_drawtext(t: &Title, font_path: &std::path::Path, h: u32) -> String {
    let px = |pct: f64| (pct / 100.0 * h as f64).round().max(0.0) as i64;
    let size = px(t.size).max(4);
    let margin = "w*0.05";
    let x = match t.align {
        Align::Left => margin.to_string(),
        Align::Center => "(w-text_w)/2".to_string(),
        Align::Right => format!("w-text_w-{margin}"),
    };
    let mut o = vec![
        format!("fontfile={}", escape_filter_value(&font_path.to_string_lossy().replace('\\', "/"))),
        format!("text={}", escape_filter_value(&t.text)),
        // never interpret %{...} sequences in user text
        "expansion=none".to_string(),
        format!("fontsize={size}"),
        format!("fontcolor={}", ffmpeg_color(&t.color)),
        format!("x={}", escape_filter_value(&x)),
        format!("y={}", escape_filter_value("(h-text_h)/2")),
    ];
    if t.text.contains('\n') {
        o.push(format!("text_align={}", match t.align { Align::Left => "left", Align::Center => "center", Align::Right => "right" }));
    }
    if t.outline_width > 0.0 {
        o.push(format!("borderw={}", px(t.outline_width).max(1)));
        o.push(format!("bordercolor={}", ffmpeg_color(&t.outline_color)));
    }
    if t.shadow > 0.0 {
        let d = px(t.shadow).max(1);
        o.push(format!("shadowx={d}"));
        o.push(format!("shadowy={d}"));
        o.push("shadowcolor=0x000000@0.6".to_string());
    }
    if let Some(b) = &t.box_color {
        o.push("box=1".to_string());
        o.push(format!("boxcolor={}", ffmpeg_color(b)));
        o.push(format!("boxborderw={}", px(t.box_pad)));
    }
    format!("drawtext={}", o.join(":"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escaping_covers_both_levels() {
        // the FFmpeg manual's example: "It's 5:00" -> It\\\'s 5\\:00 after both levels
        assert_eq!(escape_filter_value("It's 5:00"), "It\\\\\\'s 5\\\\:00");
        assert_eq!(escape_filter_value("a,b;c[d]"), "a\\,b\\;c\\[d\\]");
        assert_eq!(escape_filter_value("C:/x"), "C\\\\:/x");
    }

    #[test]
    fn validation_and_colours() {
        let mut t = Title::new("Hello");
        assert!(t.validate().is_ok());
        t.text = "   ".into();
        assert!(t.validate().is_err());
        let mut t = Title::new("x");
        t.color = "red".into();
        assert!(t.validate().is_err());
        t.color = "#ff0000".into();
        t.box_color = Some("#000000".into()); // needs alpha digits
        assert!(t.validate().is_err());
        t.box_color = Some("#00000080".into());
        assert!(t.validate().is_ok());
        t.size = 0.0;
        assert!(t.validate().is_err());
        assert_eq!(ffmpeg_color("#ff8000"), "0xff8000");
        assert_eq!(ffmpeg_color("#00000080"), "0x000000@0.502");
    }

    #[test]
    fn drawtext_text_is_never_expanded_and_sizes_follow_frame_height() {
        let t = Title::new("100% %{localtime}");
        let f = to_drawtext(&t, std::path::Path::new("/f/a.ttf"), 1000);
        assert!(f.contains("expansion=none") && f.contains("fontsize=90"), "{f}");
        assert!(f.contains("borderw=4"), "{f}");
        let small = to_drawtext(&t, std::path::Path::new("/f/a.ttf"), 250);
        assert!(small.contains("fontsize=23") || small.contains("fontsize=22"), "{small}");
    }
}
