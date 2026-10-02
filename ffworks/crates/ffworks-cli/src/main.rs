//! `ffworks` headless CLI (spec §154): everything the editor does to a project through the same command bus, without the GUI.
//!
//!   ffworks caps                                              FFmpeg version and capabilities
//!   ffworks presets                                           export presets this FFmpeg can encode
//!   ffworks probe <media>                                     media info as JSON
//!   ffworks command <project> [preset] [out]                  print the FFmpeg command (Command Inspector)
//!   ffworks render <project> <out> [preset]                   export a project with progress
//!   ffworks run <project|new> <commands.json> [--dry-run] [--save <out.ffworks>]
//!                                                             apply a JSON list of commands (one undo step each, all or nothing)
//!   ffworks detect <media> <silence|black|freeze> [level] [min-seconds]
//!   ffworks sync <reference-media> <other-media>              how much later the second recording is
//!   ffworks package <project> <folder>                        copy the project and all its media into one folder
//!   ffworks batch <input-dir> <output-dir> [preset]           transcode every media file in a folder
use ffworks_core::commands::Command;
use ffworks_core::detect::{detect, Kind};
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile_project, ExportSettings, RenderOptions};
use ffworks_core::jobs::{run_job, CancelToken, JobState};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::ProjectSettings;
use ffworks_core::Error;
use std::path::{Path, PathBuf};

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn usage(s: &str) -> Error {
    Error::validation(format!("usage: ffworks {s}"))
}

/// Run one export of `eng`'s project to `out`, printing progress to stderr.
fn render(eng: &Engine, tools: &Tools, out: &Path, preset: &str, show_progress: bool) -> ffworks_core::Result<()> {
    let caps = Capabilities::discover(tools).ok();
    let mut job = compile_project(&eng.project, &RenderOptions { output: out.to_path_buf(), settings: ExportSettings::find(preset)?, range: None, scale_div: 1 }, caps.as_ref())?;
    job.program = tools.ffmpeg.clone();
    ffworks_core::diskspace::check(&job.output, preset, job.total_duration.as_f64())?;
    let tmp = std::env::temp_dir().join("ffworks-cli");
    let mut last = -1.0;
    run_job(tools, &job, "cli", "render", &CancelToken::new(), &tmp, &mut |s| {
        if let (true, JobState::Rendering { fraction: Some(f), .. }) = (show_progress, s) {
            if f - last >= 0.05 {
                eprint!("\r{:3.0}%", f * 100.0);
                last = f;
            }
        }
    })?;
    Ok(())
}

fn presets_for(tools: &Tools) -> Vec<ExportSettings> {
    let caps = Capabilities::discover(tools).ok();
    ExportSettings::builtin()
        .into_iter()
        .filter(|p| caps.as_ref().is_none_or(|c| p.video_codec.iter().chain(p.audio_codec.iter()).all(|e| c.has_encoder(e) && (!ffworks_core::hwenc::is_hardware(e) || ffworks_core::hwenc::works(tools, e)))))
        .collect()
}

fn run() -> ffworks_core::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let tools = Tools::discover(None, None);
    match args.first().map(String::as_str) {
        Some("caps") => {
            let c = Capabilities::discover(&tools)?;
            println!("{}\nfilters={} encoders={} decoders={} hwaccels={:?}", c.version, c.filters.len(), c.encoders.len(), c.decoders.len(), c.hwaccels);
        }
        Some("presets") => {
            for p in presets_for(&tools) {
                println!("{:12} .{:5} {}", p.id, p.extension, p.name);
            }
        }
        Some("probe") => {
            let path = args.get(1).ok_or_else(|| usage("probe <media>"))?;
            println!("{}", serde_json::to_string_pretty(&ffworks_core::ffprobe::probe(&tools, Path::new(path))?)?);
        }
        Some(cmd @ ("command" | "render")) => {
            let project = args.get(1).ok_or_else(|| usage(&format!("{cmd} <project.ffworks> ...")))?;
            let eng = Engine::load(Path::new(project), tools.clone())?;
            let (out, preset) = if cmd == "render" {
                (args.get(2).cloned().ok_or_else(|| usage("render <project> <out> [preset]"))?, args.get(3).cloned())
            } else {
                (args.get(3).cloned().unwrap_or_else(|| "output.mp4".into()), args.get(2).cloned())
            };
            let preset = preset.unwrap_or_else(|| "h264_mp4".into());
            if cmd == "command" {
                let caps = Capabilities::discover(&tools).ok();
                let mut job = compile_project(&eng.project, &RenderOptions { output: PathBuf::from(&out), settings: ExportSettings::find(&preset)?, range: None, scale_div: 1 }, caps.as_ref())?;
                job.program = tools.ffmpeg.clone();
                println!("{}", job.display());
            } else {
                render(&eng, &tools, Path::new(&out), &preset, true)?;
                eprintln!("\rdone: {out}");
            }
        }
        Some("run") => {
            let (project, script) = (args.get(1).ok_or_else(|| usage("run <project|new> <commands.json> [--dry-run] [--save out]"))?, args.get(2).ok_or_else(|| usage("run <project|new> <commands.json>"))?);
            let dry = args.iter().any(|a| a == "--dry-run");
            let save = args.iter().position(|a| a == "--save").and_then(|i| args.get(i + 1)).cloned();
            let mut eng = if project == "new" { Engine::new("Untitled", ProjectSettings::default(), tools.clone()) } else { Engine::load(Path::new(project), tools.clone())? };
            let text = std::fs::read_to_string(script).map_err(|e| Error::io(Path::new(script), e))?;
            let cmds: Vec<Command> = serde_json::from_str(&text).map_err(|e| Error::validation(format!("{script}: not a JSON list of commands: {e}")))?;
            // all or nothing: apply as one batch, so a failing command changes nothing
            let label = format!("script ({} commands)", cmds.len());
            let n = cmds.len();
            for c in &cmds {
                println!("{}", c.label());
            }
            eng.dispatch(Command::Batch { label, commands: cmds })?;
            let seq = eng.project.active()?;
            let clips: usize = seq.tracks.iter().map(|t| t.clips.len()).sum();
            println!("applied {n} commands: {} tracks, {clips} clips, {} markers{}", seq.tracks.len(), seq.markers.len(), if dry { " (dry run, nothing saved)" } else { "" });
            if !dry {
                let target = save.or_else(|| (project != "new").then(|| project.clone())).ok_or_else(|| Error::validation("a new project needs --save <file>"))?;
                eng.save(Path::new(&target))?;
                println!("saved {target}");
            }
        }
        Some("detect") => {
            let (media, kind) = (args.get(1).ok_or_else(|| usage("detect <media> <silence|black|freeze>"))?, args.get(2).ok_or_else(|| usage("detect <media> <silence|black|freeze>"))?);
            let kind = match kind.as_str() {
                "silence" => Kind::Silence,
                "black" => Kind::Black,
                "freeze" => Kind::Freeze,
                other => return Err(Error::validation(format!("unknown detector '{other}' (silence, black, freeze)"))),
            };
            let level = args.get(3).and_then(|v| v.parse().ok()).unwrap_or(match kind { Kind::Silence => -35.0, Kind::Black => 0.1, Kind::Freeze => -60.0 });
            let min: f64 = args.get(4).and_then(|v| v.parse().ok()).unwrap_or(0.5);
            let dur = ffworks_core::ffprobe::probe(&tools, Path::new(media))?.duration.as_f64();
            for (a, b) in detect(&tools, Path::new(media), dur, kind, level, min)? {
                println!("{a:.3} {b:.3}");
            }
        }
        Some("sync") => {
            let (a, b) = (args.get(1).ok_or_else(|| usage("sync <reference> <other>"))?, args.get(2).ok_or_else(|| usage("sync <reference> <other>"))?);
            let r = ffworks_core::audiosync::measure(&tools, Path::new(a), Path::new(b))?;
            println!("lag {:.3} s (the second recording is {}) confidence {:.0}%", r.lag_seconds, if r.lag_seconds >= 0.0 { "later" } else { "earlier" }, r.confidence * 100.0);
        }
        Some("package") => {
            let (project, folder) = (args.get(1).ok_or_else(|| usage("package <project> <folder>"))?, args.get(2).ok_or_else(|| usage("package <project> <folder>"))?);
            let eng = Engine::load(Path::new(project), tools.clone())?;
            let name = Path::new(project).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into());
            let r = ffworks_core::package::package(&eng.project, Path::new(folder), &name)?;
            println!("packaged {} ({} media files, {:.1} MB)", r.project_file.display(), r.files_copied, r.bytes as f64 / 1e6);
        }
        Some("batch") => {
            let (input, output) = (args.get(1).ok_or_else(|| usage("batch <input-dir> <output-dir> [preset]"))?, args.get(2).ok_or_else(|| usage("batch <input-dir> <output-dir> [preset]"))?);
            let preset = args.get(3).cloned().unwrap_or_else(|| "h264_mp4".into());
            let st = ExportSettings::find(&preset)?;
            std::fs::create_dir_all(output).map_err(|e| Error::io(Path::new(output), e))?;
            let mut files: Vec<PathBuf> = std::fs::read_dir(input).map_err(|e| Error::io(Path::new(input), e))?.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_file()).collect();
            files.sort();
            let (mut ok, mut failed) = (0, 0);
            for f in files {
                let name = f.file_name().unwrap().to_string_lossy().into_owned();
                let out = Path::new(output).join(Path::new(&name).with_extension(&st.extension));
                let r = (|| -> ffworks_core::Result<()> {
                    let info = ffworks_core::ffprobe::probe(&tools, &f)?;
                    let (w, h, fps) = info.video.first().map(|v| (v.width, v.height, v.fps)).unwrap_or((1920, 1080, None));
                    let settings = ProjectSettings { width: w.max(2) & !1, height: h.max(2) & !1, fps: fps.unwrap_or(ffworks_core::time::Fps::new(30, 1)), sample_rate: 48000 };
                    let mut eng = Engine::new(&name, settings, tools.clone());
                    let m = eng.import_media(&f)?;
                    let track = eng.project.active()?.tracks.iter().find(|t| t.kind == if info.has_video() { ffworks_core::project::TrackKind::Video } else { ffworks_core::project::TrackKind::Audio }).map(|t| t.id.clone()).ok_or_else(|| Error::validation("no suitable track"))?;
                    eng.dispatch(Command::PlaceClip { media: m, track, start: ffworks_core::Rational::ZERO, source_in: None, duration: None, with_audio: true, audio_track: None })?;
                    render(&eng, &tools, &out, &preset, false)
                })();
                match r {
                    Ok(()) => { ok += 1; println!("ok     {name} -> {}", out.display()); }
                    Err(e) => { failed += 1; println!("FAILED {name}: {e}"); }
                }
            }
            println!("{ok} converted, {failed} failed");
            if failed > 0 {
                return Err(Error::validation(format!("{failed} file(s) failed")));
            }
        }
        _ => println!("usage: ffworks <caps|presets|probe|command|render|run|detect|sync|package|batch> ... (see the top of crates/ffworks-cli/src/main.rs)"),
    }
    Ok(())
}
