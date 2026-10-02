//! FFprobe integration. All colour metadata is preserved (spec §107).

use crate::error::{Error, Result};
use crate::process::Tools;
use crate::time::{parse_fps, Fps, Rational};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
pub struct ColorInfo {
    pub pix_fmt: Option<String>,
    pub color_space: Option<String>,
    pub color_transfer: Option<String>,
    pub color_primaries: Option<String>,
    pub color_range: Option<String>,
    pub bits_per_raw_sample: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct VideoStream {
    pub index: u32,
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub fps: Option<Fps>,
    pub bit_rate: Option<u64>,
    pub color: ColorInfo,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AudioStream {
    pub index: u32,
    pub codec: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub channel_layout: Option<String>,
    pub bit_rate: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
pub struct MediaInfo {
    pub container: String,
    pub duration: Rational,
    pub bit_rate: Option<u64>,
    pub size_bytes: Option<u64>,
    pub video: Vec<VideoStream>,
    pub audio: Vec<AudioStream>,
    pub tags: Vec<(String, String)>,
}

impl MediaInfo {
    pub fn has_video(&self) -> bool {
        !self.video.is_empty()
    }
    pub fn has_audio(&self) -> bool {
        !self.audio.is_empty()
    }
}

#[derive(Deserialize)]
struct RawProbe {
    #[serde(default)]
    streams: Vec<RawStream>,
    format: Option<RawFormat>,
}
#[derive(Deserialize)]
struct RawFormat {
    format_name: Option<String>,
    duration: Option<String>,
    bit_rate: Option<String>,
    size: Option<String>,
    #[serde(default)]
    tags: std::collections::BTreeMap<String, String>,
}
#[derive(Deserialize)]
struct RawStream {
    index: u32,
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    bit_rate: Option<String>,
    pix_fmt: Option<String>,
    color_space: Option<String>,
    color_transfer: Option<String>,
    color_primaries: Option<String>,
    color_range: Option<String>,
    bits_per_raw_sample: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u32>,
    channel_layout: Option<String>,
    duration: Option<String>,
    disposition: Option<RawDisposition>,
}
#[derive(Deserialize)]
struct RawDisposition {
    attached_pic: Option<u8>,
}

/// Parse FFprobe `-show_format -show_streams -of json` output.
pub fn parse_probe_json(json: &str) -> Result<MediaInfo> {
    let raw: RawProbe = serde_json::from_str(json).map_err(|e| Error::Project(format!("bad ffprobe output: {e}")))?;
    let fmt = raw.format.ok_or_else(|| Error::Project("ffprobe returned no format section".into()))?;
    let mut info = MediaInfo {
        container: fmt.format_name.unwrap_or_default(),
        bit_rate: fmt.bit_rate.and_then(|s| s.parse().ok()),
        size_bytes: fmt.size.and_then(|s| s.parse().ok()),
        tags: fmt.tags.into_iter().collect(),
        ..Default::default()
    };
    let mut longest_stream = 0.0f64;
    for s in raw.streams {
        if let Some(d) = s.duration.as_deref().and_then(|d| d.parse::<f64>().ok()) {
            longest_stream = longest_stream.max(d);
        }
        match s.codec_type.as_deref() {
            Some("video") => {
                let still = s.disposition.as_ref().and_then(|d| d.attached_pic).unwrap_or(0) == 1;
                if still {
                    continue; // cover art is not a video track
                }
                let fps = s.avg_frame_rate.as_deref().and_then(parse_fps).or_else(|| s.r_frame_rate.as_deref().and_then(parse_fps));
                info.video.push(VideoStream {
                    index: s.index,
                    codec: s.codec_name.unwrap_or_default(),
                    width: s.width.unwrap_or(0),
                    height: s.height.unwrap_or(0),
                    fps,
                    bit_rate: s.bit_rate.and_then(|b| b.parse().ok()),
                    color: ColorInfo {
                        pix_fmt: s.pix_fmt,
                        color_space: s.color_space,
                        color_transfer: s.color_transfer,
                        color_primaries: s.color_primaries,
                        color_range: s.color_range,
                        bits_per_raw_sample: s.bits_per_raw_sample.and_then(|b| b.parse().ok()),
                    },
                });
            }
            Some("audio") => info.audio.push(AudioStream {
                index: s.index,
                codec: s.codec_name.unwrap_or_default(),
                sample_rate: s.sample_rate.and_then(|r| r.parse().ok()).unwrap_or(0),
                channels: s.channels.unwrap_or(0),
                channel_layout: s.channel_layout,
                bit_rate: s.bit_rate.and_then(|b| b.parse().ok()),
            }),
            _ => {}
        }
    }
    let dur = fmt.duration.and_then(|d| d.parse::<f64>().ok()).unwrap_or(longest_stream);
    info.duration = Rational::from_secs_f64(dur);
    Ok(info)
}

/// Run FFprobe on `path` (structured argv, no shell).
pub fn probe(tools: &Tools, path: &Path) -> Result<MediaInfo> {
    let out = tools.run_capture(
        &tools.ffprobe,
        &["-v", "error", "-show_format", "-show_streams", "-of", "json"],
        Some(path),
    )?;
    parse_probe_json(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_video_and_audio() {
        let j = r#"{"streams":[
          {"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,
           "avg_frame_rate":"30000/1001","pix_fmt":"yuv420p","color_space":"bt709","color_transfer":"bt709","color_primaries":"bt709","color_range":"tv","bits_per_raw_sample":"8"},
          {"index":1,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2,"channel_layout":"stereo"}],
          "format":{"format_name":"mov,mp4","duration":"12.512","bit_rate":"1000","size":"2000","tags":{"title":"x"}}}"#;
        let m = parse_probe_json(j).unwrap();
        assert_eq!(m.video[0].fps, Some(Rational::new(30000, 1001)));
        assert_eq!(m.video[0].color.color_space.as_deref(), Some("bt709"));
        assert_eq!(m.video[0].color.bits_per_raw_sample, Some(8));
        assert_eq!(m.audio[0].sample_rate, 48000);
        assert_eq!(m.duration, Rational::new(12512, 1000));
        assert!(m.has_audio() && m.has_video());
    }

    #[test]
    fn ignores_attached_pictures() {
        let j = r#"{"streams":[{"index":0,"codec_type":"video","codec_name":"mjpeg","width":10,"height":10,"disposition":{"attached_pic":1}}],"format":{"format_name":"mp3","duration":"1.0"}}"#;
        assert!(!parse_probe_json(j).unwrap().has_video());
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_probe_json("not json").is_err());
    }
}
