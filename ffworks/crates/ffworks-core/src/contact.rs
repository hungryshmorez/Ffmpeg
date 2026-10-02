//! Variation contact sheet: N random effect stacks applied to one clip, one frame of each rendered through the normal
//! preview pipeline and tiled into a single picture, so the user can pick a look by eye. Every variation is reproducible
//! from its seed (`random::effect_stack`), so "apply #4" is just the random-effects command with that seed.

use crate::commands::Command;
use crate::engine::Engine;
use crate::error::{Error, Result};
use crate::jobs::CancelToken;
use crate::process::{suppress_console_window, Capabilities, Tools};
use crate::project::Project;
use crate::time::Rational;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command as Proc, Stdio};

#[derive(Debug, Clone, Serialize)]
pub struct Sheet {
    pub path: PathBuf,
    pub columns: usize,
    pub rows: usize,
    /// One seed per tile, left to right, top to bottom.
    pub seeds: Vec<u64>,
    /// The effect ids each tile got.
    pub effects: Vec<Vec<String>>,
}

#[allow(clippy::too_many_arguments)]
pub fn render_sheet(tools: &Tools, caps: Option<&Capabilities>, project: &Project, clip: &str, count: usize, stack: usize, pool: Option<&[String]>, base_seed: u64, at: Rational, out_dir: &Path) -> Result<Sheet> {
    if !(2..=16).contains(&count) {
        return Err(Error::validation("a contact sheet shows 2 to 16 variations"));
    }
    let (c, cols) = {
        let seq = project.active()?;
        let (_, c) = seq.find_clip(clip).ok_or_else(|| Error::NotFound(format!("clip {clip}")))?;
        if c.kind != crate::project::TrackKind::Video {
            return Err(Error::validation("variations are for video clips"));
        }
        (c.clone(), (count as f64).sqrt().ceil() as usize)
    };
    let rows = count.div_ceil(cols);
    std::fs::create_dir_all(out_dir).map_err(|e| Error::io(out_dir, e))?;
    let (mut seeds, mut effects) = (vec![], vec![]);
    let at = at.max(c.start).min(c.end() - Rational::new(1, 25));
    for i in 0..count {
        let seed = base_seed.wrapping_add(i as u64 * 104_729);
        let cmds = crate::random::effect_stack(&c, stack, seed, pool)?;
        effects.push(cmds.iter().filter_map(|x| if let Command::AddEffect { effect, .. } = x { Some(effect.clone()) } else { None }).collect::<Vec<_>>());
        seeds.push(seed);
        let mut eng = Engine::new("contact", project.settings.clone(), tools.clone());
        eng.project = project.clone();
        eng.dispatch(Command::Batch { label: "variation".into(), commands: cmds })?;
        let r = crate::preview::render(tools, caps, &eng.project, at, at + Rational::new(1, 5), 2, &out_dir.join("previews"), &CancelToken::new(), &mut |_| {})?;
        let png = out_dir.join(format!("tile_{:02}.png", i + 1));
        let mut cmd = Proc::new(&tools.ffmpeg);
        cmd.args(["-v", "error", "-nostdin", "-y", "-i"]).arg(&r.path).args(["-frames:v", "1"]).arg(&png).stdout(Stdio::null()).stderr(Stdio::piped());
        suppress_console_window(&mut cmd);
        let o = cmd.output().map_err(|e| Error::ToolUnavailable { tool: tools.ffmpeg.display().to_string(), reason: e.to_string() })?;
        if !o.status.success() {
            return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: o.status.code(), hint: String::from_utf8_lossy(&o.stderr).lines().last().unwrap_or("").to_string() });
        }
    }
    let sheet = out_dir.join(format!("sheet_{base_seed}_{count}.png"));
    let mut cmd = Proc::new(&tools.ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-y", "-framerate", "1", "-start_number", "1", "-i"]).arg(out_dir.join("tile_%02d.png")).args(["-frames:v", "1", "-vf", &format!("tile={cols}x{rows}:padding=4:color=black")]).arg(&sheet).stdout(Stdio::null()).stderr(Stdio::piped());
    suppress_console_window(&mut cmd);
    let o = cmd.output().map_err(|e| Error::ToolUnavailable { tool: tools.ffmpeg.display().to_string(), reason: e.to_string() })?;
    if !o.status.success() || !sheet.exists() {
        return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: o.status.code(), hint: String::from_utf8_lossy(&o.stderr).lines().last().unwrap_or("").to_string() });
    }
    Ok(Sheet { path: sheet, columns: cols, rows, seeds, effects })
}
