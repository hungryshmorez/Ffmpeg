//! Hardware video encoders (NVIDIA NVENC, Intel Quick Sync, AMD AMF). FFmpeg lists these encoders even on machines
//! without the matching GPU, so the only honest test is to encode a few frames and see whether it works.

use crate::process::{suppress_console_window, Tools};
use std::process::{Command, Stdio};

/// Encoders worth trying. Each has an export preset in `ffmpeg::ExportSettings::builtin`.
pub const CANDIDATES: &[&str] = &["h264_nvenc", "hevc_nvenc", "av1_nvenc", "h264_qsv", "hevc_qsv", "h264_amf", "hevc_amf"];

/// True when `encoder` is a hardware encoder this module knows.
pub fn is_hardware(encoder: &str) -> bool {
    CANDIDATES.contains(&encoder)
}

/// Whether `encoder` really encodes on this machine (3 frames of 640x360 to a null sink).
pub fn works(tools: &Tools, encoder: &str) -> bool {
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=black:s=640x360:r=25:d=0.2", "-frames:v", "3", "-pix_fmt", "yuv420p", "-c:v", encoder, "-f", "null", "-"]);
    cmd.stdout(Stdio::null()).stderr(Stdio::null()).stdin(Stdio::null());
    suppress_console_window(&mut cmd);
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

/// The candidate encoders that exist in this build *and* work here.
pub fn usable(tools: &Tools, available: impl Fn(&str) -> bool) -> Vec<String> {
    CANDIDATES.iter().filter(|e| available(e) && works(tools, e)).map(|e| e.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_software_encoder_passes_the_probe_and_a_missing_one_does_not() {
        let t = Tools::discover(None, None);
        assert!(works(&t, "libx264"));
        assert!(!works(&t, "no_such_encoder"));
        assert!(is_hardware("h264_nvenc") && !is_hardware("libx264"));
        // on CI machines without a GPU nothing hardware works; the list is simply empty or a subset of the candidates
        let u = usable(&t, |_| true);
        assert!(u.iter().all(|e| CANDIDATES.contains(&e.as_str())));
    }
}
