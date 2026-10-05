//! Colour management: the project is Rec.709 SDR, so a clip that is tagged as something else (BT.601 from an SD camera or a
//! DVD, BT.2020, HDR PQ/HLG from a phone) is converted on the way in, and the export is tagged as Rec.709. Without this the
//! picture is rendered with the wrong matrix: skin goes green-ish, reds shift, HDR looks washed out.
//!
//! Only what a file *says* about itself is acted on: untagged or Rec.709 footage passes through untouched, so a project that
//! has none of the above renders exactly as before.

use serde::{Deserialize, Serialize};

use crate::ffprobe::ColorInfo;

/// What a clip needs before it joins the Rec.709 picture.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub enum Conversion {
    /// Rec.709 or untagged: leave it alone.
    #[default]
    None,
    /// Same dynamic range, different matrix/primaries (`colorspace` filter, `iall` names the input standard).
    Matrix(&'static str),
    /// PQ or HLG high dynamic range: tone-mapped to SDR through linear light (`zscale` + `tonemap`).
    Hdr,
    /// HDR whose file says nothing (or the wrong thing): the frames are tagged BT.2020 with this transfer (`smpte2084` or
    /// `arib-std-b67`) first, then tone-mapped like any HDR clip (zscale refuses explicit input options without tags here).
    HdrAs(&'static str),
}

fn tag(v: &Option<String>) -> &str {
    v.as_deref().unwrap_or("unknown")
}

/// What the user says a clip really is, for footage whose tags are missing or wrong (an SD capture tagged as nothing, a phone
/// clip with its HDR tags stripped). Overrides what the file says; `Rec709` forces "no conversion".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColorOverride {
    Rec709,
    /// BT.601 as used for NTSC / 525-line video.
    Bt601Ntsc,
    /// BT.601 as used for PAL / 625-line video.
    Bt601Pal,
    /// BT.2020 wide gamut, SDR transfer.
    Bt2020,
    /// HDR, PQ (HDR10).
    Pq,
    /// HDR, hybrid log-gamma.
    Hlg,
}

impl ColorOverride {
    pub fn conversion(self) -> Conversion {
        match self {
            ColorOverride::Rec709 => Conversion::None,
            ColorOverride::Bt601Ntsc => Conversion::Matrix("bt601-6-525"),
            ColorOverride::Bt601Pal => Conversion::Matrix("bt601-6-625"),
            ColorOverride::Bt2020 => Conversion::Matrix("bt2020"),
            ColorOverride::Pq => Conversion::HdrAs("smpte2084"),
            ColorOverride::Hlg => Conversion::HdrAs("arib-std-b67"),
        }
    }
}

/// Decide from a file's colour tags.
pub fn plan(c: &ColorInfo) -> Conversion {
    let (space, trc, prim) = (tag(&c.color_space), tag(&c.color_transfer), tag(&c.color_primaries));
    if matches!(trc, "smpte2084" | "arib-std-b67") {
        return Conversion::Hdr;
    }
    // the transfer of an SDR tag is close enough to Rec.709's for these; the matrix and primaries are what differ
    if space.starts_with("bt2020") || prim == "bt2020" {
        return Conversion::Matrix("bt2020");
    }
    if matches!(space, "smpte170m") || matches!(prim, "smpte170m") {
        return Conversion::Matrix("bt601-6-525");
    }
    if matches!(space, "bt470bg") || matches!(prim, "bt470bg") {
        return Conversion::Matrix("bt601-6-625");
    }
    Conversion::None
}

/// What a media file needs before it joins the Rec.709 picture: the user's override if there is one, else what its tags say.
pub fn for_media(m: &crate::project::MediaAsset) -> Conversion {
    if m.is_generated() || m.info.still {
        return Conversion::None;
    }
    match m.color_override {
        Some(o) => o.conversion(),
        None => m.info.video.first().map(|v| plan(&v.color)).unwrap_or_default(),
    }
}

impl Conversion {
    /// Short filename-safe name of the conversion, `None` when nothing is converted (used to key cached copies).
    pub fn key(&self) -> Option<String> {
        match self {
            Conversion::None => None,
            Conversion::Matrix(iall) => Some(iall.replace('-', "")),
            Conversion::Hdr => Some("hdr".into()),
            Conversion::HdrAs(t) => Some(format!("hdras{}", t.replace('-', ""))),
        }
    }

    /// The filter (without a leading comma) that takes yuv420p frames to Rec.709 SDR yuv420p, and the FFmpeg filters it needs.
    pub fn filter(&self) -> Option<(String, &'static [&'static str])> {
        match self {
            Conversion::None => None,
            Conversion::Matrix(iall) => Some((format!("colorspace=all=bt709:iall={iall}:fast=1,format=yuv420p"), &["colorspace"])),
            Conversion::HdrAs(tin) => Some((format!("setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc={tin}:range=tv,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"), &["zscale", "tonemap"])),
            Conversion::Hdr => Some(("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p".into(), &["zscale", "tonemap"])),
        }
    }
}

/// Filter that marks the frames at the end of the video graph as Rec.709 (limited range). FFmpeg 7.1+ gives the encoder the
/// frames' colour properties and ignores `-color_trc` when they are unset, so the frames themselves have to say it.
pub const FRAME_TAGS: &str = "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv";

/// Output options that tag the encoded video as Rec.709.
pub const OUTPUT_TAGS: [&str; 6] = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];

#[cfg(test)]
mod tests {
    use super::*;

    fn c(space: &str, trc: &str, prim: &str) -> ColorInfo {
        let s = |v: &str| (v != "-").then(|| v.to_string());
        ColorInfo { color_space: s(space), color_transfer: s(trc), color_primaries: s(prim), ..Default::default() }
    }

    #[test]
    fn rec709_and_untagged_footage_is_left_alone() {
        assert_eq!(plan(&c("bt709", "bt709", "bt709")), Conversion::None);
        assert_eq!(plan(&c("-", "-", "-")), Conversion::None);
        assert_eq!(plan(&ColorInfo::default()), Conversion::None);
        assert_eq!(plan(&c("unknown", "unknown", "unknown")), Conversion::None);
        assert_eq!(plan(&c("bt709", "iec61966-2-1", "bt709")), Conversion::None, "sRGB-ish transfer on a 709 matrix is not touched");
    }

    #[test]
    fn standard_definition_and_wide_gamut_tags_get_a_matrix_conversion() {
        assert_eq!(plan(&c("smpte170m", "smpte170m", "smpte170m")), Conversion::Matrix("bt601-6-525"));
        assert_eq!(plan(&c("bt470bg", "bt709", "bt470bg")), Conversion::Matrix("bt601-6-625"));
        assert_eq!(plan(&c("bt2020nc", "bt709", "bt2020")), Conversion::Matrix("bt2020"));
        assert_eq!(plan(&c("bt2020nc", "-", "-")), Conversion::Matrix("bt2020"));
    }

    #[test]
    fn pq_and_hlg_are_tone_mapped_whatever_the_matrix() {
        assert_eq!(plan(&c("bt2020nc", "smpte2084", "bt2020")), Conversion::Hdr);
        assert_eq!(plan(&c("bt2020nc", "arib-std-b67", "bt2020")), Conversion::Hdr);
        assert_eq!(plan(&c("bt709", "smpte2084", "bt709")), Conversion::Hdr);
    }

    #[test]
    fn an_override_replaces_what_the_tags_say() {
        assert_eq!(ColorOverride::Rec709.conversion(), Conversion::None);
        assert_eq!(ColorOverride::Bt601Ntsc.conversion(), Conversion::Matrix("bt601-6-525"));
        assert_eq!(ColorOverride::Bt601Pal.conversion(), Conversion::Matrix("bt601-6-625"));
        assert_eq!(ColorOverride::Bt2020.conversion(), Conversion::Matrix("bt2020"));
        let (f, need) = ColorOverride::Pq.conversion().filter().unwrap();
        assert!(f.starts_with("setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=smpte2084") && need == ["zscale", "tonemap"]);
        let (f, _) = ColorOverride::Hlg.conversion().filter().unwrap();
        assert!(f.contains("color_trc=arib-std-b67"));
        assert_eq!(serde_json::to_string(&ColorOverride::Bt601Pal).unwrap(), "\"bt601_pal\"");
    }

    #[test]
    fn each_conversion_names_the_filters_it_needs() {
        assert!(Conversion::None.filter().is_none());
        let (f, need) = Conversion::Matrix("bt601-6-525").filter().unwrap();
        assert!(f.starts_with("colorspace=all=bt709:iall=bt601-6-525") && f.ends_with("format=yuv420p") && need == ["colorspace"]);
        let (f, need) = Conversion::Hdr.filter().unwrap();
        assert!(f.contains("tonemap=tonemap=hable") && f.ends_with("format=yuv420p") && need == ["zscale", "tonemap"]);
    }
}
