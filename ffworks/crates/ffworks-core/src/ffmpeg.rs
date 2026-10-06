//! FFmpeg argument compiler: RenderGraph + export settings -> a structured `FfmpegJob`.
//! No shell strings anywhere; arguments are an argv vector (spec §3, §52, §98).

use crate::error::{Error, Result};
use crate::process::{Capabilities, FilterFileStyle};
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
            ExportSettings { id: "h264_nvenc".into(), name: "H.264 MP4 (NVIDIA GPU)".into(), extension: "mp4".into(), video_codec: Some("h264_nvenc".into()), crf: None, encoder_preset: Some("p5".into()), pix_fmt: Some("yuv420p".into()), audio_codec: Some("aac".into()), audio_bitrate: Some("192k".into()), extra: s(&["-rc", "vbr", "-cq", "23", "-b:v", "0", "-movflags", "+faststart"]) },
            ExportSettings { id: "hevc_nvenc".into(), name: "H.265 MP4 (NVIDIA GPU)".into(), extension: "mp4".into(), video_codec: Some("hevc_nvenc".into()), crf: None, encoder_preset: Some("p5".into()), pix_fmt: Some("yuv420p".into()), audio_codec: Some("aac".into()), audio_bitrate: Some("192k".into()), extra: s(&["-rc", "vbr", "-cq", "25", "-b:v", "0", "-tag:v", "hvc1", "-movflags", "+faststart"]) },
            ExportSettings { id: "h264_qsv".into(), name: "H.264 MP4 (Intel Quick Sync)".into(), extension: "mp4".into(), video_codec: Some("h264_qsv".into()), crf: None, encoder_preset: None, pix_fmt: Some("nv12".into()), audio_codec: Some("aac".into()), audio_bitrate: Some("192k".into()), extra: s(&["-global_quality", "23", "-movflags", "+faststart"]) },
            ExportSettings { id: "h264_amf".into(), name: "H.264 MP4 (AMD GPU)".into(), extension: "mp4".into(), video_codec: Some("h264_amf".into()), crf: None, encoder_preset: None, pix_fmt: Some("yuv420p".into()), audio_codec: Some("aac".into()), audio_bitrate: Some("192k".into()), extra: s(&["-rc", "cqp", "-qp_i", "22", "-qp_p", "24", "-movflags", "+faststart"]) },
            // Datamosh: keyframes are encoded often and then every one after the first is thrown away at the muxer (`noise` bitstream
            // filter), so later frames keep applying their motion to the OLD picture: the classic smeared, melting look.
            ExportSettings { id: "datamosh_mp4".into(), name: "Datamosh MP4 (drops keyframes: smeared glitch look)".into(), extension: "mp4".into(), video_codec: Some("libx264".into()), crf: Some(23), encoder_preset: Some("fast".into()), pix_fmt: Some("yuv420p".into()), audio_codec: Some("aac".into()), audio_bitrate: Some("160k".into()), extra: s(&["-g", "15", "-keyint_min", "15", "-sc_threshold", "0", "-bf", "0", "-bsf:v", "noise=drop=key*gt(n\\,0)", "-movflags", "+faststart"]) },
            ExportSettings { id: "vp9_webm".into(), name: "VP9 WebM".into(), extension: "webm".into(), video_codec: Some("libvpx-vp9".into()), crf: Some(32), encoder_preset: None, pix_fmt: Some("yuv420p".into()), audio_codec: Some("libopus".into()), audio_bitrate: Some("128k".into()), extra: s(&["-b:v", "0", "-row-mt", "1"]) },
            ExportSettings { id: "h265_mp4".into(), name: "H.265 / HEVC MP4".into(), extension: "mp4".into(), video_codec: Some("libx265".into()), crf: Some(24), encoder_preset: Some("medium".into()), pix_fmt: Some("yuv420p".into()), audio_codec: Some("aac".into()), audio_bitrate: Some("192k".into()), extra: s(&["-tag:v", "hvc1", "-movflags", "+faststart"]) },
            // HDR10: SDR (Rec.709) material is mapped to PQ / BT.2020 (see `colormgmt::HDR10_FRAMES`); the mastering display is the usual P3-D65 1000-nit one, MaxCLL/MaxFALL are not measured so they are left out
            ExportSettings { id: "hdr10_mp4".into(), name: "HDR10 MP4 (H.265 10-bit, SDR mapped to PQ)".into(), extension: "mp4".into(), video_codec: Some("libx265".into()), crf: Some(20), encoder_preset: Some("medium".into()), pix_fmt: Some("yuv420p10le".into()), audio_codec: Some("aac".into()), audio_bitrate: Some("192k".into()), extra: s(&["-tag:v", "hvc1", "-x265-params", "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,10)", "-movflags", "+faststart"]) },
            ExportSettings { id: "av1_mp4".into(), name: "AV1 MP4 (SVT-AV1)".into(), extension: "mp4".into(), video_codec: Some("libsvtav1".into()), crf: Some(34), encoder_preset: Some("8".into()), pix_fmt: Some("yuv420p".into()), audio_codec: Some("aac".into()), audio_bitrate: Some("160k".into()), extra: s(&["-movflags", "+faststart"]) },
            ExportSettings { id: "prores_mov".into(), name: "ProRes 422 HQ MOV".into(), extension: "mov".into(), video_codec: Some("prores_ks".into()), crf: None, encoder_preset: None, pix_fmt: Some("yuv422p10le".into()), audio_codec: Some("pcm_s16le".into()), audio_bitrate: None, extra: s(&["-profile:v", "3"]) },
            ExportSettings { id: "dnxhr_mov".into(), name: "DNxHR HQ MOV".into(), extension: "mov".into(), video_codec: Some("dnxhd".into()), crf: None, encoder_preset: None, pix_fmt: Some("yuv422p".into()), audio_codec: Some("pcm_s16le".into()), audio_bitrate: None, extra: s(&["-profile:v", "dnxhr_hq"]) },
            ExportSettings { id: "ffv1_mkv".into(), name: "FFV1 lossless MKV".into(), extension: "mkv".into(), video_codec: Some("ffv1".into()), crf: None, encoder_preset: None, pix_fmt: None, audio_codec: Some("flac".into()), audio_bitrate: None, extra: s(&["-level", "3", "-coder", "1"]) },
            ExportSettings { id: "png_sequence".into(), name: "PNG image sequence (name_00001.png …)".into(), extension: "png".into(), video_codec: Some("png".into()), crf: None, encoder_preset: None, pix_fmt: Some("rgb24".into()), audio_codec: None, audio_bitrate: None, extra: vec![] },
            ExportSettings { id: "gif".into(), name: "Animated GIF (no audio)".into(), extension: "gif".into(), video_codec: Some("gif".into()), crf: None, encoder_preset: None, pix_fmt: None, audio_codec: None, audio_bitrate: None, extra: s(&["-loop", "0"]) },
            ExportSettings { id: "flac".into(), name: "FLAC (audio only)".into(), extension: "flac".into(), video_codec: None, crf: None, encoder_preset: None, pix_fmt: None, audio_codec: Some("flac".into()), audio_bitrate: None, extra: vec![] },
            ExportSettings { id: crate::quick::PRESET.into(), name: "Quick export, no re-encode (single untouched clip, MKV)".into(), extension: "mkv".into(), video_codec: None, crf: None, encoder_preset: None, pix_fmt: None, audio_codec: None, audio_bitrate: None, extra: vec![] },
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

#[derive(Clone, Debug, Serialize, Deserialize)]
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
    /// Always pass the graph through a file (used by tests to exercise that path on small graphs).
    pub force_file: bool,
    /// Pixel sorts (see `bake`) that must have run before this job starts; `jobs::run_job` runs them first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stages: Vec<crate::bake::BakeStage>,
    /// Compound clips (see `nest`) that must have been rendered before this job starts, inner ones first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nests: Vec<crate::nest::NestStage>,
}

impl FfmpegJob {
    /// Graphs up to this many characters are passed inline (works on every FFmpeg version); larger ones go through a file
    /// to stay below the Windows 32 767-character command-line limit.
    pub const INLINE_LIMIT: usize = 20_000;

    pub fn needs_file(&self) -> bool {
        self.filter_graph.len() > Self::INLINE_LIMIT || self.force_file
    }

    /// Full argv. With `script` the filter graph is read from that file using the syntax `style` names; otherwise it is inlined.
    pub fn argv(&self, script: Option<(&Path, FilterFileStyle)>) -> Vec<String> {
        let mut a = self.pre.clone();
        if self.filter_graph.is_empty() {
            // stream-copy job (see `quick`): nothing to filter
            a.extend(self.post.iter().cloned());
            return a;
        }
        match script {
            Some((p, FilterFileStyle::Legacy)) => {
                a.push("-filter_complex_script".into());
                a.push(p.to_string_lossy().into_owned());
            }
            Some((p, FilterFileStyle::Slash)) => {
                a.push("-/filter_complex".into());
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
pub(crate) fn secs(t: Rational) -> String {
    let s = format!("{:.9}", t.as_f64());
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-" { "0".into() } else { s.to_string() }
}

/// Plain decimal (no exponent) usable inside an FFmpeg expression; negatives are parenthesised.
fn dec(x: f64) -> String {
    let s = format!("{x:.9}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    let s = if s.is_empty() || s == "-" || s == "-0" { "0" } else { s };
    if s.starts_with('-') { format!("({s})") } else { s.to_string() }
}

/// A clip parameter as expression text: the keyframe curve in `var` when animated, else its static value.
fn param_text(seg: &crate::render_graph::VideoSegment, id: &str, static_value: f64, var: &str) -> String {
    if seg.animated(id) {
        format!("({})", crate::keyframes::to_expr(&seg.keyframes[id], var))
    } else {
        dec(static_value)
    }
}

/// Transform (position/scale/rotation about the frame centre) as one `perspective` pass on a transparently padded frame.
/// `perspective` replicates edge pixels outside the source, so a 2px transparent border makes the outside transparent.
/// Its frame counter `in` is 1-based, hence `(in-1)`. Returns None for an identity, non-animated transform.
fn transform_filter(seg: &crate::render_graph::VideoSegment, w: u32, h: u32, fps: crate::time::Fps) -> Option<String> {
    let animated = ["x", "y", "scale", "rotation"].iter().any(|p| seg.animated(p));
    if seg.transform.is_identity() && !animated {
        return None;
    }
    let t = format!("((in-1)*{}/{})", fps.den(), fps.num());
    let (x, y) = (param_text(seg, "x", seg.transform.x, &t), param_text(seg, "y", seg.transform.y, &t));
    let (sc, rot) = (param_text(seg, "scale", seg.transform.scale, &t), param_text(seg, "rotation", seg.transform.rotation, &t));
    let rad = format!("({rot}*PI/180)");
    let (wf, hf) = (w as f64, h as f64);
    let mut coords = vec![];
    for (i, (u, v)) in [(-2.0, -2.0), (wf + 2.0, -2.0), (-2.0, hf + 2.0), (wf + 2.0, hf + 2.0)].into_iter().enumerate() {
        let (dx, dy) = (dec(u - wf / 2.0), dec(v - hf / 2.0));
        coords.push(format!("x{i}='{}+{sc}*({dx}*cos({rad})-{dy}*sin({rad}))+{x}+2'", dec(wf / 2.0)));
        coords.push(format!("y{i}='{}+{sc}*({dx}*sin({rad})+{dy}*cos({rad}))+{y}+2'", dec(hf / 2.0)));
    }
    let eval = if animated { ":eval=frame" } else { "" };
    Some(format!("format=yuva420p,pad={}:{}:2:2:color=black@0,perspective={}:sense=destination:interpolation=linear{eval},crop={w}:{h}:2:2", w + 4, h + 4, coords.join(":")))
}

/// Balance as an FFmpeg `pan` filter: unity on the louder side, the other channel attenuated linearly. None at centre.
fn balance_filter(pan: f64) -> Option<String> {
    if pan == 0.0 {
        return None;
    }
    let (l, r) = if pan > 0.0 { (1.0 - pan, 1.0) } else { (1.0, 1.0 + pan) };
    Some(format!("pan=stereo|c0={}*c0|c1={}*c1", dec(l), dec(r)))
}

/// atempo accepts 0.5..2.0 per instance on older FFmpeg; chain instances for other factors.
fn atempo_chain(speed: f64) -> String {
    let mut parts = vec![];
    let mut s = speed;
    while s > 2.0 {
        parts.push("atempo=2.0".to_string());
        s /= 2.0;
    }
    while s < 0.5 {
        parts.push("atempo=0.5".to_string());
        s /= 0.5;
    }
    parts.push(format!("atempo={}", dec(s)));
    parts.join(",")
}

fn fps_expr(g: &RenderGraph) -> String {
    format!("{}/{}", g.fps.num(), g.fps.den())
}

/// Reversing buffers the clip in memory; refuse above this (bytes of decoded frames at output size).
const MAX_REVERSE_BYTES: f64 = 2.0e9;

pub fn compile(g: &RenderGraph, opts: &RenderOptions, caps: Option<&Capabilities>) -> Result<FfmpegJob> {
    let st = &opts.settings;
    if g.video.iter().flat_map(|v| &v.filters).chain(g.video_transitions.iter().flat_map(|t| t.a.filters.iter().chain(&t.b.filters))).any(|f| crate::bake::is_mark(f)) {
        return Err(Error::validation("this graph holds a pixel sort that has not been baked yet; run it through `bake::prepare` (compile_project and preview do) before compiling"));
    }
    if g.inputs.iter().any(|i| i.nested.is_some() && i.path.is_empty()) {
        return Err(Error::validation("this graph reads a compound clip that has not been planned yet; run it through `nest::prepare` (compile_project and preview do) before compiling"));
    }
    if opts.scale_div == 0 {
        return Err(Error::validation("scale_div must be >= 1"));
    }
    for i in g.inputs.iter().filter(|i| i.generated.is_none()) {
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

    const MAX_INPUTS: usize = 200;
    if g.inputs.len() > MAX_INPUTS {
        return Err(Error::validation(format!(
            "this render needs {} simultaneous source files; the limit is {MAX_INPUTS} (OS file-handle limits). Render a time range, or split the project",
            g.inputs.len()
        )));
    }
    let require = |names: &[String]| -> Result<()> {
        if let Some(caps) = caps {
            for r in names {
                if !caps.has_filter(r) {
                    return Err(Error::validation(format!("FFmpeg filter '{r}' needed by an effect or transition is not available in this build")));
                }
            }
        }
        Ok(())
    };

    for i in &g.inputs {
        if let Some((_, need)) = i.color.filter() {
            require(&need.iter().map(|n| n.to_string()).collect::<Vec<_>>())?;
        }
    }
    let mut f: Vec<String> = vec![];
    if want_video {
        f.push(format!("color=c=black:s={w}x{h}:r={fps}:d={},format=yuv420p[base0]", secs(g.duration)));
        // every input stream is consumed by exactly one chain (see `InputRef::key`)
        let take = |input: usize| -> String { format!("[{input}:v:0]") };
        // Half a *source* frame is subtracted from trim bounds so decimal rounding can never
        // exclude the frame sitting exactly on a boundary.
        let src_half = |input: usize| g.inputs[input].src_fps.map(|f| Rational::new(1, 2).div(f)).unwrap_or_else(|| Rational::new(1, 2).div(g.fps));
        // Scale/pad to the project frame, trim the source range, restart timestamps, then effects. `shift` places the
        // result on the timeline; transition parts stay at 0 and are placed after the blend.
        let vchain = |label: &str, input: usize, source_in: Rational, dur: Rational, shift: Option<Rational>, filters: &[String]| -> String {
            let t0 = (source_in - src_half(input)).max(Rational::ZERO);
            let t1 = source_in + dur - src_half(input);
            let place = shift.map(|st| format!("+{}/TB", secs(st))).unwrap_or_default();
            let mut chain = format!(
                "{label}setpts=PTS-STARTPTS,trim=start={}:end={},setpts=PTS-STARTPTS{place},fps={fps},scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p",
                secs(t0),
                secs(t1),
            );
            if let Some((conv, _)) = g.inputs[input].color.filter() {
                chain.push(',');
                chain.push_str(&conv);
            }
            for fx in filters {
                chain.push(',');
                chain.push_str(fx);
            }
            chain.push_str(",format=yuv420p");
            chain
        };
        enum Item<'a> {
            Seg(&'a crate::render_graph::VideoSegment),
            Tr(&'a crate::render_graph::VideoTransition),
        }
        let mut items: Vec<(usize, Item)> = g.video.iter().map(|s| (s.layer, Item::Seg(s))).chain(g.video_transitions.iter().map(|t| (t.layer, Item::Tr(t)))).collect();
        items.sort_by_key(|(l, _)| *l); // stable: compositing order = track order
        for (n, (_, item)) in items.iter().enumerate() {
            match item {
                Item::Seg(seg) => {
                    require(&seg.requires)?;
                    let speed = seg.speed.as_f64();
                    let span = seg.source_span();
                    let mut chain = String::new();
                    let input = &g.inputs[seg.input];
                    if seg.adjustment {
                        // an adjustment layer works on the picture composited so far: a copy of it is cut to the layer's
                        // span (half a frame early, like source trims), run through the effects, then laid back over
                        let half = Rational::new(1, 2).div(g.fps);
                        f.push(format!("[base{n}]split[adk{n}][adf{n}]"));
                        chain = format!("[adf{n}]trim=start={}:end={},setpts=PTS-STARTPTS", secs((seg.start - half).max(Rational::ZERO)), secs(seg.start + seg.duration - half));
                    } else {
                        // source window (frozen: a single frame), restart timestamps, retime
                        let (t0, t1) = match seg.freeze {
                            // two frames of margin around the held time; `trim=end_frame=1` below keeps just the first
                            Some(fz) => {
                                let a = (fz - src_half(seg.input)).max(Rational::ZERO);
                                (a, a + Rational::new(2, 1).div(g.fps))
                            }
                            None => ((seg.source_in - src_half(seg.input)).max(Rational::ZERO), seg.source_in + span - src_half(seg.input)),
                        };
                        chain.push_str(&format!("{}setpts=PTS-STARTPTS,trim=start={}:end={},setpts=PTS-STARTPTS", take(seg.input), secs(t0), secs(t1)));
                        if seg.freeze.is_none() && seg.speed != Rational::from_int(1) {
                            chain.push_str(&format!(",setpts=PTS/{}", dec(speed)));
                            if seg.smooth {
                                // optical flow: motion-compensated frames fill the gaps the slow-down leaves
                                chain.push_str(&format!(",minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1"));
                            }
                        }
                        if input.generated.is_some() {
                            // generated canvases are already output-sized; keep their alpha
                            chain.push_str(&format!(",fps={fps},format=yuva420p"));
                        } else if input.alpha {
                            // pictures with transparency: even pad offsets (odd ones corrupt the alpha plane in `pad`) and a transparent border
                            chain.push_str(&format!(",fps={fps},scale={w}:{h}:force_original_aspect_ratio=decrease,format=yuva420p,pad={w}:{h}:trunc((ow-iw)/4)*2:trunc((oh-ih)/4)*2:color=black@0,setsar=1"));
                        } else {
                            chain.push_str(&format!(",fps={fps},scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p"));
                            if let Some((conv, _)) = input.color.filter() {
                                chain.push(',');
                                chain.push_str(&conv);
                            }
                        }
                        if let Some((title, font)) = &seg.title {
                            require(&["drawtext".to_string()])?;
                            chain.push(',');
                            chain.push_str(&crate::titles::to_drawtext(title, font, h));
                        }
                        if seg.freeze.is_some() {
                            chain.push_str(&format!(",trim=end_frame=1,tpad=stop_mode=clone:stop_duration={d},trim=end={d},setpts=PTS-STARTPTS", d = secs(seg.duration)));
                        } else {
                            chain.push_str(&format!(",trim=end={},setpts=PTS-STARTPTS", secs(seg.duration)));
                        }
                        if seg.reverse && seg.freeze.is_none() {
                            // `reverse` holds every frame in memory; refuse clips that would not fit
                            let bytes = seg.duration.as_f64() * g.fps.as_f64() * (w as f64) * (h as f64) * 1.5;
                            if bytes > MAX_REVERSE_BYTES {
                                return Err(Error::validation(format!(
                                    "reversing {:.1}s at {w}x{h} needs about {:.1} GB of memory (limit {:.0} GB); reverse a shorter clip or render with a lower preview quality",
                                    seg.duration.as_f64(),
                                    bytes / 1e9,
                                    MAX_REVERSE_BYTES / 1e9
                                )));
                            }
                            chain.push_str(",reverse,setpts=PTS-STARTPTS");
                        }
                    }
                    for (k, fx) in seg.filters.iter().enumerate() {
                        match fx.strip_prefix(crate::effects::GRAPH_MARK) {
                            // a user filter graph: close the chain, emit its statements, continue from its output at project size
                            Some(stmts) => {
                                let (gi, go, tag) = (format!("gi{n}x{k}"), format!("go{n}x{k}"), format!("gt{n}x{k}"));
                                chain.push_str(&format!("[{gi}]"));
                                f.push(std::mem::take(&mut chain));
                                f.push(stmts.replace("@IN@", &gi).replace("@OUT@", &go).replace("@T@", &tag));
                                chain = format!("[{go}]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1");
                            }
                            None => {
                                chain.push(',');
                                chain.push_str(fx);
                            }
                        }
                    }
                    let blended = seg.blend != "normal" && !seg.adjustment;
                    let animated_opacity = seg.animated("opacity");
                    let transform = if seg.adjustment { None } else { transform_filter(seg, w, h, g.fps) };
                    let translucent = seg.opacity < 1.0 || animated_opacity || seg.alpha_fx || transform.is_some() || blended || (!seg.adjustment && (input.generated.is_some() || input.alpha));
                    if animated_opacity {
                        // alpha plane × keyframed opacity, evaluated per frame (T = clip-relative seconds at this point of the chain)
                        chain.push_str(&format!(",format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*({})'", crate::keyframes::to_expr(&seg.keyframes["opacity"], "T")));
                    }
                    if let Some(tf) = transform {
                        chain.push(',');
                        chain.push_str(&tf);
                    }
                    if !animated_opacity && seg.opacity < 1.0 {
                        chain.push_str(&format!(",format=yuva420p,colorchannelmixer=aa={}", seg.opacity));
                    }
                    chain.push_str(if translucent { ",format=yuva420p" } else { ",format=yuv420p" });
                    chain.push_str(&format!(",setpts=PTS+{}/TB[vs{n}]", secs(seg.start)));
                    f.push(chain);
                    let fmt = if translucent { ":format=auto" } else { "" };
                    if !blended {
                        let below = if seg.adjustment { format!("adk{n}") } else { format!("base{n}") };
                        f.push(format!("[{below}][vs{n}]overlay=eof_action=pass:repeatlast=0{fmt}[base{}]", n + 1));
                    } else {
                        require(&["blend".to_string(), "alphamerge".to_string(), "alphaextract".to_string()])?;
                        // Blend the layer with the picture beneath, then composite that result through the layer's own alpha.
                        // The layer is first placed on a full-length transparent canvas so both blend inputs run in step.
                        f.push(format!("color=c=black@0:s={w}x{h}:r={fps}:d={},format=yuva420p[bt{n}]", secs(g.duration)));
                        f.push(format!("[bt{n}][vs{n}]overlay=eof_action=pass:repeatlast=0:format=auto,split[bla{n}][blb{n}]"));
                        f.push(format!("[blb{n}]alphaextract[ba{n}]"));
                        // `blend` operates on the raw planes of its pixel format, so convert to planar RGB first: multiplying YUV planes is not a colour multiply.
                        f.push(format!("[bla{n}]format=gbrp[bly{n}]"));
                        f.push(format!("[base{n}]split[bs1_{n}][bs2_{n}]"));
                        f.push(format!("[bs1_{n}]format=gbrp[bsr{n}]"));
                        f.push(format!("[bsr{n}][bly{n}]blend=all_mode={},format=yuv420p[bm{n}]", seg.blend));
                        f.push(format!("[bm{n}][ba{n}]alphamerge[bmm{n}]"));
                        f.push(format!("[bs2_{n}][bmm{n}]overlay=eof_action=pass:repeatlast=0:format=auto[base{}]", n + 1));
                    }
                }
                Item::Tr(t) => {
                    require(&t.a.requires)?;
                    require(&t.b.requires)?;
                    require(&["xfade".to_string()])?;
                    let gl = crate::glx::expr(&t.kind);
                    if let (Some(caps), Some(_)) = (caps, gl) {
                        if !caps.xfade_custom {
                            return Err(Error::validation(format!("'{}' is a GL transition and needs an FFmpeg whose xfade supports custom expressions", t.kind)));
                        }
                    }
                    if let Some(caps) = caps.filter(|_| gl.is_none()) {
                        if !caps.xfade_transitions.is_empty() && !caps.xfade_transitions.iter().any(|(k, _)| *k == t.kind) {
                            return Err(Error::validation(format!("the installed FFmpeg does not support the '{}' transition (it needs a newer FFmpeg)", t.kind)));
                        }
                    }
                    let (la, lb) = (take(t.a.input), take(t.b.input));
                    f.push(format!("{}[ta{n}]", vchain(&la, t.a.input, t.a.source_in, t.duration, None, &t.a.filters)));
                    f.push(format!("{}[tb{n}]", vchain(&lb, t.b.input, t.b.source_in, t.duration, None, &t.b.filters)));
                    // a bundled GL transition is an `xfade` custom expression (values are escaped for the filter graph)
                    let which = match gl {
                        Some(e) => format!("custom:expr={}", crate::titles::escape_filter_value(e)),
                        None => t.kind.clone(),
                    };
                    f.push(format!("[ta{n}][tb{n}]xfade=transition={which}:duration={}:offset=0,setpts=PTS-STARTPTS+{}/TB,format=yuv420p[vs{n}]", secs(t.duration), secs(t.start)));
                    f.push(format!("[base{n}][vs{n}]overlay=eof_action=pass:repeatlast=0[base{}]", n + 1));
                }
            }
        }
        // newer FFmpeg takes the encoder's colour tags from the frames, not from the -color_* options: tag the frames
        let tag_frames = !matches!(st.video_codec.as_deref(), Some("png" | "gif" | "rawvideo")) && !st.pix_fmt.as_deref().is_some_and(|p| p.starts_with("rgb") || p.starts_with("gbr"));
        let tags = if st.id == crate::colormgmt::HDR10_PRESET {
            require(&["zscale".to_string()])?;
            crate::colormgmt::HDR10_FRAMES
        } else if tag_frames {
            crate::colormgmt::FRAME_TAGS
        } else {
            "null"
        };
        f.push(format!("[base{}]{}[vout]", items.len(), tags));
    }
    if want_audio {
        let sr = g.sample_rate;
        let rate = Rational::from_int(sr as i64);
        let total_samples = g.duration.round_units(rate);
        f.push(format!("anullsrc=r={sr}:cl=stereo,atrim=end_sample={total_samples},asetpts=PTS-STARTPTS[asil]"));
        let mut labels = vec!["[asil]".to_string()];
        let take = |input: usize| -> String { format!("[{input}:a:0]") };
        // Sample-accurate trim of `len` samples starting at `s0`, plus gain.
        let achain = |label: &str, s0: i64, s1: i64, gain_db: f64| -> String {
            let mut chain = format!("{label}aresample={sr},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,atrim=start_sample={s0}:end_sample={s1},asetpts=PTS-STARTPTS");
            if gain_db != 0.0 {
                chain.push_str(&format!(",volume={gain_db:.4}dB"));
            }
            chain
        };
        let delay_of = |start: Rational| {
            let d = start.round_units(rate);
            if d > 0 { format!(",adelay={d}S|{d}S") } else { String::new() }
        };
        for (k, seg) in g.audio.iter().enumerate() {
            let label = take(seg.input);
            let s0 = seg.source_in.round_units(rate);
            let span = seg.duration.mul(seg.speed);
            let s1 = (seg.source_in + span).round_units(rate);
            require(&seg.requires)?;
            let mut chain = achain(&label, s0, s1, 0.0);
            if seg.reverse {
                chain.push_str(",areverse");
            }
            let retimed = seg.speed != Rational::from_int(1);
            if retimed {
                chain.push_str(&format!(",{}", atempo_chain(seg.speed.as_f64())));
                // atempo output length is only approximately span/speed; make it exactly the clip's length
                let n = seg.duration.round_units(rate);
                chain.push_str(&format!(",apad=whole_len={n},atrim=end_sample={n},asetpts=PTS-STARTPTS"));
            }
            for fx in &seg.filters {
                chain.push(',');
                chain.push_str(fx);
            }
            for p in [seg.pan, seg.track_pan] {
                if let Some(b) = balance_filter(p) {
                    chain.push(',');
                    chain.push_str(&b);
                }
            }
            if seg.fade_in > Rational::ZERO {
                chain.push_str(&format!(",afade=t=in:st=0:d={}", secs(seg.fade_in)));
            }
            if seg.fade_out > Rational::ZERO {
                chain.push_str(&format!(",afade=t=out:st={}:d={}", secs(seg.duration - seg.fade_out), secs(seg.fade_out)));
            }
            match &seg.gain_keyframes {
                // volume envelope: dB curve -> linear, evaluated per frame (t = clip-relative seconds here)
                Some(kfs) => chain.push_str(&format!(",volume='pow(10,({}+{})/20)':eval=frame:precision=float", crate::keyframes::to_expr(kfs, "t"), dec(seg.track_gain_db))),
                None => {
                    let total = seg.gain_db + seg.track_gain_db;
                    if total != 0.0 {
                        chain.push_str(&format!(",volume={total:.4}dB"));
                    }
                }
            }
            f.push(format!("{chain}{}[as{k}]", delay_of(seg.start)));
            labels.push(format!("[as{k}]"));
        }
        for (k, t) in g.audio_transitions.iter().enumerate() {
            require(&["acrossfade".to_string()])?;
            // both parts must have exactly the same sample count
            let len = t.duration.round_units(rate);
            let (sa, sb) = (t.a.source_in.round_units(rate), t.b.source_in.round_units(rate));
            let (la, lb) = (take(t.a.input), take(t.b.input));
            f.push(format!("{}[xa{k}]", achain(&la, sa, sa + len, t.a.gain_db)));
            f.push(format!("{}[xb{k}]", achain(&lb, sb, sb + len, t.b.gain_db)));
            f.push(format!("[xa{k}][xb{k}]acrossfade=d={}:c1=tri:c2=tri{}[at{k}]", secs(t.duration), delay_of(t.start)));
            labels.push(format!("[at{k}]"));
        }
        f.push(format!("{}amix=inputs={}:normalize=0:duration=longest:dropout_transition=0,atrim=end_sample={total_samples}[aout]", labels.concat(), labels.len()));
    }

    let mut pre: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats"].iter().map(|s| s.to_string()).collect();
    for i in &g.inputs {
        // Only inputs that the graph references are opened.
        let len = secs(i.need.max(Rational::from_int(1)) + Rational::from_int(1));
        if let Some(color) = &i.generated {
            pre.extend(["-f".into(), "lavfi".into(), "-i".into(), format!("color=c={color}:s={w}x{h}:r={fps}:d={len},format=yuva420p")]);
        } else if i.still {
            // a looped single picture, bounded to what this use needs
            pre.extend(["-loop".into(), "1".into(), "-framerate".into(), fps.clone(), "-t".into(), len, "-i".into(), i.path.clone()]);
        } else if crate::imgseq::is_pattern(&i.path) {
            // numbered pictures played at the rate they were imported with
            let rate = i.src_fps.map(|f| format!("{}/{}", f.num(), f.den())).unwrap_or_else(|| fps.clone());
            pre.extend(["-framerate".into(), rate]);
            if let Some(first) = crate::imgseq::first_index(&i.path) {
                pre.extend(["-start_number".into(), first.to_string()]);
            }
            pre.extend(["-i".into(), i.path.clone()]);
        } else {
            pre.push("-i".into());
            pre.push(i.path.clone());
        }
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
        // the picture is Rec.709 whatever came in (see `colormgmt`): say so, or players guess by resolution
        if !matches!(vc.as_str(), "png" | "gif" | "rawvideo") && !st.pix_fmt.as_deref().is_some_and(|p| p.starts_with("rgb") || p.starts_with("gbr")) {
            let tags = if st.id == crate::colormgmt::HDR10_PRESET { crate::colormgmt::HDR10_OUTPUT_TAGS } else { crate::colormgmt::OUTPUT_TAGS };
            post.extend(tags.map(String::from));
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
    // an image sequence writes numbered files: `out.png` becomes `out_%05d.png`; the job's output is the first frame
    let (out_arg, first_out) = if st.id == "png_sequence" && !crate::imgseq::is_pattern(&opts.output.to_string_lossy()) {
        let stem = opts.output.with_extension("");
        (format!("{}_%05d.png", stem.to_string_lossy()), PathBuf::from(format!("{}_00001.png", stem.to_string_lossy())))
    } else {
        (opts.output.to_string_lossy().into_owned(), opts.output.clone())
    };
    post.push(out_arg);

    // Unreferenced inputs would trigger "does not contain any stream" noise; graph building only adds used inputs.
    Ok(FfmpegJob { program: PathBuf::from("ffmpeg"), pre, filter_graph: f.join(";\n"), post, total_duration: out_dur, output: first_out, force_file: false, stages: vec![], nests: vec![] })
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

/// Compile a project for export: the normal renderer, or the stream-copy path for the quick-export preset.
pub fn compile_project(project: &crate::project::Project, opts: &RenderOptions, caps: Option<&Capabilities>) -> Result<FfmpegJob> {
    if opts.settings.id == crate::quick::PRESET {
        return crate::quick::compile(project, opts);
    }
    let mut g = crate::render_graph::build(project)?;
    // compound clips are rendered first; their files may feed pixel sorts, so they are planned before those
    let nests = crate::nest::prepare(project, &mut g, &crate::bake::cache_dir(), caps)?;
    // pixel sorts are planned here and run by the job before FFmpeg starts. Their files are kept in the content-keyed cache
    // (trimmed to a size limit), so exporting again after an edit elsewhere does not sort the same frames twice
    let stages = crate::bake::prepare(&mut g, opts.range, &crate::bake::cache_dir(), true)?;
    let mut job = compile(&g, opts, caps)?;
    add_chapters(&mut job, project, opts);
    job.stages = stages;
    job.nests = nests;
    Ok(job)
}

/// Timeline markers become chapters of the export when the container can hold them: the metadata file is one more input and
/// `-map_chapters` points at it. A failure to write the file only drops the chapters (the export itself is unaffected).
fn add_chapters(job: &mut FfmpegJob, project: &crate::project::Project, opts: &RenderOptions) {
    if !crate::chapters::supports(&opts.settings.extension) || job.post.iter().any(|a| a == "-f") {
        return;
    }
    let Ok(seq) = project.active() else { return };
    let (start, end) = opts.range.map(|(a, b)| (a, b.min(seq.duration()))).unwrap_or((Rational::ZERO, seq.duration()));
    let Some(text) = crate::chapters::metadata(&seq.markers, start, end) else { return };
    let Ok(path) = crate::chapters::write(&crate::bake::cache_dir(), &text) else { return };
    let index = job.pre.iter().filter(|a| *a == "-i").count();
    job.pre.extend(["-i".to_string(), path.to_string_lossy().into_owned()]);
    let at = job.post.len().saturating_sub(1);
    job.post.splice(at..at, ["-map_chapters".to_string(), index.to_string()]);
}
