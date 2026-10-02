//! `ffworks` headless CLI (spec §154). Usage:
//!   ffworks caps
//!   ffworks probe <media>
//!   ffworks command <project.ffworks> [preset] [out]     # print the FFmpeg command (Command Inspector)
//!   ffworks render <project.ffworks> <out> [preset]       # export with progress
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile, ExportSettings, RenderOptions};
use ffworks_core::jobs::{run_job, CancelToken, JobState};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::render_graph;
use std::path::PathBuf;

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn run() -> ffworks_core::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let tools = Tools::discover(None, None);
    match args.first().map(String::as_str) {
        Some("caps") => {
            let c = Capabilities::discover(&tools)?;
            println!("{}\nfilters={} encoders={} decoders={} hwaccels={:?}", c.version, c.filters.len(), c.encoders.len(), c.decoders.len(), c.hwaccels);
        }
        Some("probe") => {
            let path = args.get(1).ok_or_else(|| ffworks_core::Error::validation("usage: ffworks probe <media>"))?;
            let info = ffworks_core::ffprobe::probe(&tools, std::path::Path::new(path))?;
            println!("{}", serde_json::to_string_pretty(&info)?);
        }
        Some(cmd @ ("command" | "render")) => {
            let project = args.get(1).ok_or_else(|| ffworks_core::Error::validation(format!("usage: ffworks {cmd} <project.ffworks> ...")))?;
            let eng = Engine::load(std::path::Path::new(project), tools.clone())?;
            let (out, preset) = if cmd == "render" {
                (args.get(2).cloned().ok_or_else(|| ffworks_core::Error::validation("usage: ffworks render <project> <out> [preset]"))?, args.get(3).cloned())
            } else {
                (args.get(3).cloned().unwrap_or_else(|| "output.mp4".into()), args.get(2).cloned())
            };
            let settings = ExportSettings::find(preset.as_deref().unwrap_or("h264_mp4"))?;
            let caps = Capabilities::discover(&tools).ok();
            let g = render_graph::build(&eng.project)?;
            let mut job = compile(&g, &RenderOptions { output: PathBuf::from(&out), settings, range: None, scale_div: 1 }, caps.as_ref())?;
            job.program = tools.ffmpeg.clone();
            if cmd == "command" {
                println!("{}", job.display());
            } else {
                let tmp = std::env::temp_dir().join("ffworks-cli");
                let mut last = -1.0;
                run_job(&tools, &job, "cli", "render", &CancelToken::new(), &tmp, &mut |s| {
                    if let JobState::Rendering { fraction: Some(f), .. } = s {
                        if f - last >= 0.05 {
                            eprint!("\r{:3.0}%", f * 100.0);
                            last = f;
                        }
                    }
                })?;
                eprintln!("\rdone: {out}");
            }
        }
        _ => println!("usage: ffworks <caps|probe|command|render> ..."),
    }
    Ok(())
}
