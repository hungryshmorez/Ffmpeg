//! FFmpeg argument compiler: RenderGraph + export settings -> a structured `FfmpegJob`.
//! No shell strings anywhere; arguments are an argv vector (spec §3, §52, §98).

use crate::error::{Error, Result};
use crate::process::Capabilities;
use crate::render_graph::RenderGraph;
use crate::time::Rational;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ExportSettings {
    pub id: String,
    pub name: String,
    pub extension: String,
    pub video_codec: Option<String>,
    pub crf: Option<u32>,
    pub encoder_preset: Option<String>,
    pub pix_fmt: Option<String>,
    pub audio_codec: Option<String>,
    pub audio_bitrate: Option<String>,
    /// Extra encoder-specific args, e.g. `["-movflags", "+faststart"]`.
    pub extra: Vec<String>,
}

impl ExportSettings {
    pub fn builtin() -> Vec<ExportSettings> {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        vec![
            ExportSettings { id: "h264_mp4".into(), name: "H.264 MP4".into(), extension: "mp4".into(), video_codec: Some("libx264".into()), crf: Some(20), encoder_preset: Some("medium".into()), pix_fmt: Some("yuv420p".into()), audio_codec: Some("aac".into()), audio_bitrate: Some("192k".into()), extra: s(&["-movflags", "+faststart"]) },
            ExportSettings { id: "vp9_webm".into(), name: "VP9 WebM".into(), extension: "webm".into(), video_codec: Some("libvpx-vp9".into()), crf: Some(32), encoder_preset: None, pix_fmt: Some("yuv420p".into()), audio_codec: Some("libopus".into()), audio_bitrate: Some("128k".into()), extra: s(&["-b:v", "0", "-row-mt", "1"]) },
            ExportSettings { id: "wav".into(), name: "WAV (audio only)".into(), extension: "wav".into(), video_codec: None, crf: None, encoder_preset: None, pix_fmt: None, audio_codec: Some("pcm_s16le".into()), audio_bitrate: None, extra: vec![] },
            ExportSettings { id: "mp3".into(), name: "MP3 (audio only)".into(), extension: "mp3".into(), video_codec: None, crf: None, encoder_preset: None, pix_fmt: None, audio_codec: Some("libmp3lame".into()), audio_bitrate: Some("192k".into()), extra: vec![] },
        ]
    }

    pub fn find(id: &str) -> Result<ExportSettings> {
        Self::builtin().into_iter().find(|p| p.id == id).ok_or_else(|| Error::NotFound(format!("export preset '{id}'")))
    }
}

#[derive(Clone, Debug)]
pub struct RenderOptions {
    pub output: PathBuf,
    pub settings: ExportSettings,
    /// Render only `[start, end)` of the timeline.
    pub range: Option<(Rational, Rational)>,
    /// Divide the output resolution by this (preview quality: 1, 2, 4, 8).
    pub scale_div: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct FfmpegJob {
    pub program: PathBuf,
    /// Arguments before `-filter_complex`.
    pub pre: Vec<String>,
    pub filter_graph: String,
    /// Arguments after the filter graph (maps, codecs, output path).
    pub post: Vec<String>,
    /// Timeline length being rendered, used to turn FFmpeg progress into a true percentage.
    pub total_duration: Rational,
    pub output: PathBuf,
}

impl FfmpegJob {
    /// Full argv. If `script` is given the filter graph is read from that file (avoids the Windows
    /// 32k command-line limit on large timelines); otherwise it is inlined.
    pub fn argv(&self, script: Option<&Path>) -> Vec<String> {
        let mut a = self.pre.clone();
        match script {
            Some(p) => {
                a.push("-filter_complex_script".into());
                a.push(p.to_string_lossy().into_owned());
            }
            None => {
                a.push("-filter_complex".into());
                a.push(self.filter_graph.clone());
            }
        }
        a.extend(self.post.iter().cloned());
        a
    }

    /// Display form for the Command Inspector (spec §52). Not for execution.
    pub fn display(&self) -> String {
        let q = |s: &str| if s.contains(|c: char| c.is_whitespace() || "[];\"'".contains(c)) { format!("\"{}\"", s.replace('"', "\\\"")) } else { s.to_string() };
        std::iter::once(self.program.to_string_lossy().into_owned()).chain(self.argv(None).iter().map(|s| q(s))).collect::<Vec<_>>().join(" ")
    }
}

/// Decimal seconds with nanosecond resolution for FFmpeg time parameters.
fn secs(t: Rational) -> String {
    let s = format!("{:.9}", t.as_f64());
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-" { "0".into() } else { s.to_string() }
}

fn fps_expr(g: &RenderGraph) -> String {
    format!("{}/{}", g.fps.num(), g.fps.den())
}

pub fn compile(g: &RenderGraph, opts: &RenderOptions, caps: Option<&Capabilities>) -> Result<FfmpegJob> {
    let st = &opts.settings;
    if opts.scale_div == 0 {
        return Err(Error::validation("scale_div must be >= 1"));
    }
    for i in &g.inputs {
        if same_path(Path::new(&i.path), &opts.output) {
            return Err(Error::validation(format!("output path equals source media '{}'; sources are never overwritten", i.path)));
        }
    }
    if let (Some(caps), Some(vc)) = (caps, &st.video_codec) {
        if !caps.has_encoder(vc) {
            return Err(Error::validation(format!("encoder '{vc}' is not available in this FFmpeg build")));
        }
    }
    if let (Some(caps), Some(ac)) = (caps, &st.audio_codec) {
        if !caps.has_encoder(ac) {
            return Err(Error::validation(format!("encoder '{ac}' is not available in this FFmpeg build")));
        }
    }
    let want_video = st.video_codec.is_some();
    let want_audio = st.audio_codec.is_some() && g.has_audio;
    if !want_video && !want_audio {
        return Err(Error::validation("nothing to export: this preset needs audio but the timeline has no audio clips"));
    }
    if g.duration <= Rational::ZERO {
        return Err(Error::validation("the timeline is empty"));
    }
    let (r_start, r_end) = match opts.range {
        Some((a, b)) => {
            if b <= a || a < Rational::ZERO {
                return Err(Error::validation("render range is empty or negative"));
            }
            (a, b.min(g.duration))
        }
        None => (Rational::ZERO, g.duration),
    };
    let out_dur = r_end - r_start;
    let w = (g.width / opts.scale_div).max(2) & !1;
    let h = (g.height / opts.scale_div).max(2) & !1;
    let fps = fps_expr(g);

    // Which inputs are referenced how many times, per stream kind (so we can split them).
    let mut v_uses = vec![0usize; g.inputs.len()];
    let mut a_uses = vec![0usize; g.inputs.len()];
    for s in &g.video {
        v_uses[s.input] += 1;
    }
    for s in &g.audio {
        a_uses[s.input] += 1;
    }

    let mut f: Vec<String> = vec![];
    if want_video {
        for (i, n) in v_uses.iter().enumerate().filter(|(_, n)| **n > 1) {
            let outs: String = (0..*n).map(|k| format!("[v{i}_{k}]")).collect();
            f.push(format!("[{i}:v:0]split={n}{outs}"));
        }
        f.push(format!("color=c=black:s={w}x{h}:r={fps}:d={},format=yuv420p[base0]", secs(g.duration)));
        let mut used = vec![0usize; g.inputs.len()];
        let mut layer_idx = 0;
        for seg in &g.video {
            let label = if v_uses[seg.input] > 1 {
                let k = used[seg.input];
                used[seg.input] += 1;
                format!("[v{}_{k}]", seg.input)
            } else {
                format!("[{}:v:0]", seg.input)
            };
            // Half a *source* frame is subtracted from trim bounds so decimal rounding can never
            // exclude the frame sitting exactly on a boundary.
            let half = g.inputs[seg.input].src_fps.map(|f| Rational::new(1, 2).div(f)).unwrap_or_else(|| Rational::new(1, 2).div(g.fps));
            let t0 = (seg.source_in - half).max(Rational::ZERO);
            let t1 = seg.source_in + seg.duration - half;
            if let Some(caps) = caps {
                for r in &seg.requires {
                    if !caps.has_filter(r) {
                        return Err(Error::validation(format!("FFmpeg filter '{r}' needed by an effect is not available in this build")));
                    }
                }
            }
            // Effects run after scaling so their parameters are relative to the output frame.
            let mut chain = format!(
                "{label}setpts=PTS-STARTPTS,trim=start={}:end={},setpts=PTS-STARTPTS+{}/TB,fps={fps},scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p",
                secs(t0),
                secs(t1),
                secs(seg.start),
            );
            for fx in &seg.filters {
                chain.push(',');
                chain.push_str(fx);
            }
            let translucent = seg.opacity < 1.0;
            if translucent {
                chain.push_str(&format!(",format=yuva420p,colorchannelmixer=aa={}", seg.opacity));
            } else {
                chain.push_str(",format=yuv420p");
            }
            chain.push_str(&format!("[vs{layer_idx}]"));
            f.push(chain);
            let fmt = if translucent { ":format=auto" } else { "" };
            f.push(format!("[base{layer_idx}][vs{layer_idx}]overlay=eof_action=pass:repeatlast=0{fmt}[base{}]", layer_idx + 1));
            layer_idx += 1;
        }
        f.push(format!("[base{layer_idx}]null[vout]"));
    }
    if want_audio {
        let sr = g.sample_rate;
        for (i, n) in a_uses.iter().enumerate().filter(|(_, n)| **n > 1) {
            let outs: String = (0..*n).map(|k| format!("[a{i}_{k}]")).collect();
            f.push(format!("[{i}:a:0]asplit={n}{outs}"));
        }
        let total_samples = g.duration.round_units(Rational::from_int(sr as i64));
        f.push(format!("anullsrc=r={sr}:cl=stereo,atrim=end_sample={total_samples},asetpts=PTS-STARTPTS[asil]"));
        let mut labels = vec!["[asil]".to_string()];
        let mut used = vec![0usize; g.inputs.len()];
        for (k, seg) in g.audio.iter().enumerate() {
            let label = if a_uses[seg.input] > 1 {
                let u = used[seg.input];
                used[seg.input] += 1;
                format!("[a{}_{u}]", seg.input)
            } else {
                format!("[{}:a:0]", seg.input)
            };
            let rate = Rational::from_int(sr as i64);
            let s0 = seg.source_in.round_units(rate);
            let s1 = (seg.source_in + seg.duration).round_units(rate);
            let delay = seg.start.round_units(rate);
            let mut chain = format!("{label}aresample={sr},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,atrim=start_sample={s0}:end_sample={s1},asetpts=PTS-STARTPTS");
            if seg.gain_db != 0.0 {
                chain.push_str(&format!(",volume={:.4}dB", seg.gain_db));
            }
            if delay > 0 {
                chain.push_str(&format!(",adelay={delay}S|{delay}S"));
            }
            chain.push_str(&format!("[as{k}]"));
            f.push(chain);
            labels.push(format!("[as{k}]"));
        }
        f.push(format!("{}amix=inputs={}:normalize=0:duration=longest:dropout_transition=0,atrim=end_sample={total_samples}[aout]", labels.concat(), labels.len()));
    }

    let mut pre: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats"].iter().map(|s| s.to_string()).collect();
    for i in &g.inputs {
        // Only inputs that the graph references are opened.
        pre.push("-i".into());
        pre.push(i.path.clone());
    }
    let mut post: Vec<String> = vec![];
    if want_video {
        post.extend(["-map", "[vout]"].map(String::from));
    }
    if want_audio {
        post.extend(["-map", "[aout]"].map(String::from));
    }
    if let Some(vc) = &st.video_codec {
        post.extend(["-c:v".into(), vc.clone()]);
        if let Some(crf) = st.crf {
            post.extend(["-crf".into(), crf.to_string()]);
        }
        if let Some(p) = &st.encoder_preset {
            post.extend(["-preset".into(), p.clone()]);
        }
        if let Some(p) = &st.pix_fmt {
            post.extend(["-pix_fmt".into(), p.clone()]);
        }
        post.extend(["-r".into(), fps.clone()]);
    }
    if want_audio {
        post.extend(["-c:a".into(), st.audio_codec.clone().unwrap_or_default(), "-ar".into(), g.sample_rate.to_string()]);
        if let Some(b) = &st.audio_bitrate {
            post.extend(["-b:a".into(), b.clone()]);
        }
    }
    post.extend(st.extra.iter().cloned());
    if r_start > Rational::ZERO {
        post.extend(["-ss".into(), secs(r_start)]);
    }
    post.extend(["-t".into(), secs(out_dur)]);
    post.push(opts.output.to_string_lossy().into_owned());

    // Unreferenced inputs would trigger "does not contain any stream" noise; graph building only adds used inputs.
    Ok(FfmpegJob { program: PathBuf::from("ffmpeg"), pre, filter_graph: f.join(";\n"), post, total_duration: out_dur, output: opts.output.clone() })
}

/// Case-insensitive on Windows, exact elsewhere; compares canonical paths when both exist.
fn same_path(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let (a, b) = (canon(a), canon(b));
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}
