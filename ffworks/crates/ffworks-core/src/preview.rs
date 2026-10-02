//! Processed preview renders (spec §15, §156, §182). A preview is the *same* render graph and compiler
//! as export, at reduced resolution over a time range, cached on disk by a content hash of everything
//! that influences the picture. Any project change yields a new key, so a stale preview can never be
//! mistaken for the current one.

use crate::error::{Error, Result};
use crate::ffmpeg::{compile, ExportSettings, RenderOptions};
use crate::jobs::{run_job, CancelToken, JobState};
use crate::process::{Capabilities, Tools};
use crate::project::Project;
use crate::render_graph;
use crate::time::Rational;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Fast, small H.264 used only for previews.
fn preview_settings() -> ExportSettings {
    ExportSettings {
        id: "preview".into(),
        name: "Preview".into(),
        extension: "mp4".into(),
        video_codec: Some("libx264".into()),
        crf: Some(30),
        encoder_preset: Some("ultrafast".into()),
        pix_fmt: Some("yuv420p".into()),
        audio_codec: Some("aac".into()),
        audio_bitrate: Some("96k".into()),
        extra: vec!["-movflags".into(), "+faststart".into()],
    }
}

/// Hash of everything in the project that influences the picture/sound. Display-only fields
/// (project name) are excluded so renaming does not invalidate previews.
pub fn project_hash(p: &Project) -> Result<String> {
    let mut v = serde_json::to_value(p)?;
    if let Some(o) = v.as_object_mut() {
        o.remove("name");
    }
    let hex = format!("{:x}", Sha256::digest(serde_json::to_vec(&v)?));
    Ok(hex[..24].to_string())
}

/// Cache key: project hash + range + quality.
pub fn project_key(p: &Project, start: Rational, end: Rational, scale_div: u32) -> Result<String> {
    let hex = format!("{:x}", Sha256::digest(format!("{}|{start}|{end}|{scale_div}", project_hash(p)?).as_bytes()));
    Ok(hex[..24].to_string())
}

pub struct PreviewResult {
    pub path: PathBuf,
    pub key: String,
    pub start: Rational,
    pub end: Rational,
    pub cached: bool,
}

/// Render (or reuse) a preview of `[start, end)` at `1/scale_div` resolution.
#[allow(clippy::too_many_arguments)]
pub fn render(
    tools: &Tools,
    caps: Option<&Capabilities>,
    project: &Project,
    start: Rational,
    end: Rational,
    scale_div: u32,
    cache_dir: &Path,
    cancel: &CancelToken,
    on_state: &mut dyn FnMut(JobState),
) -> Result<PreviewResult> {
    let g = render_graph::build(project)?;
    let end = end.min(g.duration);
    if end <= start {
        return Err(Error::validation("nothing to preview in that range"));
    }
    let key = project_key(project, start, end, scale_div)?;
    let dir = cache_dir.join("previews");
    std::fs::create_dir_all(&dir).map_err(|e| Error::io(&dir, e))?;
    let out = dir.join(format!("{key}.mp4"));
    if out.exists() {
        return Ok(PreviewResult { path: out, key, start, end, cached: true });
    }
    let mut job = compile(&g, &RenderOptions { output: out.clone(), settings: preview_settings(), range: Some((start, end)), scale_div }, caps)?;
    job.program = tools.ffmpeg.clone();
    run_job(tools, &job, &format!("preview_{key}"), "preview", cancel, &cache_dir.join("tmp"), on_state)?;
    Ok(PreviewResult { path: out, key, start, end, cached: false })
}
