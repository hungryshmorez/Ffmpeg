//! `ffworks` headless CLI (spec §154): everything the editor does to a project through the same command bus, without the GUI.
//!
//!   ffworks caps                                              FFmpeg version and capabilities
//!   ffworks presets                                           export presets this FFmpeg can encode
//!   ffworks probe <media>                                     media info as JSON
//!   ffworks command <project> [preset] [out]                  print the FFmpeg command (Command Inspector)
//!   ffworks render <project> <out> [preset] [--keep]          export a project with progress; `out` may use name
//!                                                               tokens ({project} {date}...); --keep never overwrites
//!   ffworks run <project|new> <commands.json> [--dry-run] [--save <out.ffworks>] [--selected <clip-id>]
//!                                                             apply a JSON list of commands (one undo step each, all or nothing)
//!   ffworks plugin <plugin-folder> [<action> <project|new> [--dry-run] [--save <out.ffworks>] [--selected <clip-id>]
//!                                [--allow-analysis] [--allow-host <host>]... [--allow-folder /guest=/real]...]
//!                                                             list a WebAssembly plugin's actions, or run one as one undo step
//!   ffworks script <project|new> <script.rhai> [--dry-run] [--save <out.ffworks>] [--selected <clip-id>] [--allow-analysis]
//!                                                             run a Rhai script (loops, conditions, variables) as one undo step
//!   ffworks serve <project|new> [--port N] [--token T] [--allow-analysis]
//!                                                             local HTTP API on 127.0.0.1 for the project (see core/src/api.rs); Ctrl-C stops it
//!   ffworks detect <media> <silence|black|freeze> [level] [min-seconds]
//!   ffworks sync <reference-media> <other-media>              how much later the second recording is
//!   ffworks package <project> <folder>                        copy the project and all its media into one folder
//!   ffworks watch <input-dir> <output-dir> [preset] [--once]  convert files as they appear (once they stop growing)
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

/// Transcode one media file to `out` with `preset` (a one-clip project rendered through the normal pipeline).
fn convert_file(tools: &Tools, f: &Path, name: &str, out: &Path, preset: &str) -> ffworks_core::Result<()> {
    let info = ffworks_core::ffprobe::probe(tools, f)?;
    let (w, h, fps) = info.video.first().map(|v| (v.width, v.height, v.fps)).unwrap_or((1920, 1080, None));
    let settings = ProjectSettings { width: w.max(2) & !1, height: h.max(2) & !1, fps: fps.unwrap_or(ffworks_core::time::Fps::new(30, 1)), sample_rate: 48000 };
    let mut eng = Engine::new(name, settings, tools.clone());
    let m = eng.import_media(f)?;
    let track = eng.project.active()?.tracks.iter().find(|t| t.kind == if info.has_video() { ffworks_core::project::TrackKind::Video } else { ffworks_core::project::TrackKind::Audio }).map(|t| t.id.clone()).ok_or_else(|| Error::validation("no suitable track"))?;
    eng.dispatch(Command::PlaceClip { media: m, track, start: ffworks_core::Rational::ZERO, source_in: None, duration: None, with_audio: true, audio_track: None })?;
    render(&eng, tools, out, preset, false)
}

/// `out` with name tokens (`{project}`, `{date}`... see `naming::TOKENS`) in its file name expanded; the date is UTC.
fn expand_out(eng: &Engine, out: &str, preset: &str) -> PathBuf {
    let p = PathBuf::from(out);
    let Some(name) = p.file_name().and_then(|n| n.to_str()).filter(|n| n.contains('{')) else { return p };
    let (stem, ext) = match name.rfind('.') {
        Some(i) => (&name[..i], &name[i..]),
        None => (name, ""),
    };
    let (date, time) = ffworks_core::naming::utc_now();
    let ctx = ffworks_core::naming::NameContext {
        project: eng.project.name.clone(),
        sequence: eng.project.active().map(|s| s.name.clone()).unwrap_or_default(),
        preset: preset.to_string(),
        date,
        time,
        width: eng.project.settings.width,
        height: eng.project.settings.height,
    };
    p.with_file_name(format!("{}{ext}", ffworks_core::naming::expand(stem, &ctx)))
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
            // flags may appear anywhere after the project; positions count the other arguments
            let pos: Vec<String> = args.iter().filter(|a| !a.starts_with("--")).cloned().collect();
            let (out, preset) = if cmd == "render" {
                (pos.get(2).cloned().ok_or_else(|| usage("render <project> <out> [preset] [--keep]"))?, pos.get(3).cloned())
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
                let out = expand_out(&eng, &out, &preset);
                let out = if args.iter().any(|a| a == "--keep") { ffworks_core::naming::next_free(&out) } else { out };
                render(&eng, &tools, &out, &preset, true)?;
                eprintln!("\rdone: {}", out.display());
            }
        }
        Some("run") => {
            let (project, script) = (args.get(1).ok_or_else(|| usage("run <project|new> <commands.json> [--dry-run] [--save out]"))?, args.get(2).ok_or_else(|| usage("run <project|new> <commands.json>"))?);
            let dry = args.iter().any(|a| a == "--dry-run");
            let save = args.iter().position(|a| a == "--save").and_then(|i| args.get(i + 1)).cloned();
            let mut eng = if project == "new" { Engine::new("Untitled", ProjectSettings::default(), tools.clone()) } else { Engine::load(Path::new(project), tools.clone())? };
            let text = std::fs::read_to_string(script).map_err(|e| Error::io(Path::new(script), e))?;
            let selected = args.iter().position(|a| a == "--selected").and_then(|i| args.get(i + 1)).cloned();
            let cmds = ffworks_core::macros::instantiate(&text, selected.as_deref()).map_err(|e| Error::validation(format!("{script}: {e}")))?;
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
        Some("script") => {
            let (project, file) = (args.get(1).ok_or_else(|| usage("script <project|new> <script.rhai> [--dry-run] [--save out]"))?, args.get(2).ok_or_else(|| usage("script <project|new> <script.rhai>"))?);
            let dry = args.iter().any(|a| a == "--dry-run");
            let save = args.iter().position(|a| a == "--save").and_then(|i| args.get(i + 1)).cloned();
            let selected = args.iter().position(|a| a == "--selected").and_then(|i| args.get(i + 1)).cloned();
            let mut eng = if project == "new" { Engine::new("Untitled", ProjectSettings::default(), tools.clone()) } else { Engine::load(Path::new(project), tools.clone())? };
            let source = std::fs::read_to_string(file).map_err(|e| Error::io(Path::new(file), e))?;
            let perms = ffworks_core::script::Permissions { edit: true, analysis: args.iter().any(|a| a == "--allow-analysis") };
            let report = ffworks_core::script::run(&mut eng, &source, selected.as_deref(), perms, &format!("script {file}"))?;
            for line in &report.log {
                println!("{line}");
            }
            println!("script issued {} commands{}", report.commands, if dry { " (dry run, nothing saved)" } else { "" });
            if !dry {
                let target = save.or_else(|| (project != "new").then(|| project.clone())).ok_or_else(|| Error::validation("a new project needs --save <file>"))?;
                eng.save(Path::new(&target))?;
                println!("saved {target}");
            }
        }
        Some("plugin") => {
            let dir = args.get(1).ok_or_else(|| usage("plugin <plugin-folder> [<action> <project|new> [--dry-run] [--save out] [--selected <clip-id>]]"))?;
            let pkg = ffworks_core::plugin::load(Path::new(dir))?;
            let (Some(action), Some(project)) = (args.get(2), args.get(3)) else {
                println!("{} {} - {}", pkg.manifest.name, pkg.manifest.version, pkg.manifest.description);
                let r = &pkg.manifest.permissions;
                println!("asks for: edit={} analysis={} network={:?} folders={:?} wasi={}", r.edit, r.analysis, r.network, r.files, pkg.manifest.wasi);
                for a in &pkg.manifest.actions {
                    println!("  {}  {}", a.id, a.label);
                }
                return Ok(());
            };
            let dry = args.iter().any(|a| a == "--dry-run");
            let save = args.iter().position(|a| a == "--save").and_then(|i| args.get(i + 1)).cloned();
            let selected = args.iter().position(|a| a == "--selected").and_then(|i| args.get(i + 1)).cloned();
            let mut eng = if project == "new" { Engine::new("Untitled", ProjectSettings::default(), tools.clone()) } else { Engine::load(Path::new(project), tools.clone())? };
            // what the plugin may do beyond editing is granted here, per run: --allow-analysis, --allow-host H, --allow-folder /guest=/real
            let mut grants = ffworks_core::plugin::Grants { edit: true, analysis: args.iter().any(|a| a == "--allow-analysis"), ..Default::default() };
            for (i, a) in args.iter().enumerate() {
                match (a.as_str(), args.get(i + 1)) {
                    ("--allow-host", Some(h)) => grants.hosts.push(h.clone()),
                    ("--allow-folder", Some(f)) => {
                        let (guest, real) = f.split_once('=').ok_or_else(|| usage("--allow-folder /guest/path=/real/folder"))?;
                        grants.folders.insert(guest.to_string(), PathBuf::from(real));
                    }
                    _ => {}
                }
            }
            let report = ffworks_core::plugin::run_with(&mut eng, &pkg, action, selected.as_deref(), &grants, &format!("Plugin {}: {action}", pkg.manifest.name))?;
            for line in &report.log {
                println!("{line}");
            }
            println!("plugin issued {} commands{}", report.commands, if dry { " (dry run, nothing saved)" } else { "" });
            if !dry {
                let target = save.or_else(|| (project != "new").then(|| project.clone())).ok_or_else(|| Error::validation("a new project needs --save <file>"))?;
                eng.save(Path::new(&target))?;
                println!("saved {target}");
            }
        }
        Some("serve") => {
            let project = args.get(1).ok_or_else(|| usage("serve <project|new> [--port N] [--token T] [--allow-analysis]"))?;
            let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
            let port: u16 = flag("--port").map(|p| p.parse().map_err(|_| Error::validation("--port must be a number from 0 to 65535"))).transpose()?.unwrap_or(0);
            let token = flag("--token").unwrap_or_else(ffworks_core::api::new_token);
            let eng = if project == "new" { Engine::new("Untitled", ProjectSettings::default(), tools.clone()) } else { Engine::load(Path::new(project), tools.clone())? };
            let engine = std::sync::Arc::new(std::sync::Mutex::new(eng));
            let server = ffworks_core::api::serve(engine, port, token, ffworks_core::api::Allow { analysis: args.iter().any(|a| a == "--allow-analysis") }, None)?;
            println!("listening on {}\ntoken: {}\nexample: curl -H 'Authorization: Bearer {}' {}/v1/status", server.url(), server.token(), server.token(), server.url());
            // runs until the process is stopped
            loop {
                std::thread::park();
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
        Some("watch") => {
            let (input, output) = (args.get(1).ok_or_else(|| usage("watch <input-dir> <output-dir> [preset] [--once]"))?, args.get(2).ok_or_else(|| usage("watch <input-dir> <output-dir> [preset] [--once]"))?);
            let preset = args.get(3).filter(|a| !a.starts_with("--")).cloned().unwrap_or_else(|| "h264_mp4".into());
            let once = args.iter().any(|a| a == "--once");
            let st = ExportSettings::find(&preset)?;
            std::fs::create_dir_all(output).map_err(|e| Error::io(Path::new(output), e))?;
            // a file is converted once it has stopped growing (same size on two scans), then never again this run
            let mut seen: std::collections::HashMap<PathBuf, u64> = Default::default();
            let mut done: std::collections::HashSet<PathBuf> = Default::default();
            println!("watching {input} -> {output} ({preset}); Ctrl+C to stop");
            loop {
                let mut files: Vec<PathBuf> = std::fs::read_dir(input).map_err(|e| Error::io(Path::new(input), e))?.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_file()).collect();
                files.sort();
                let mut pending = false;
                for f in files {
                    if done.contains(&f) {
                        continue;
                    }
                    let size = std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0);
                    if size == 0 || seen.insert(f.clone(), size) != Some(size) {
                        pending = true;
                        continue;
                    }
                    let name = f.file_name().unwrap().to_string_lossy().into_owned();
                    let out = Path::new(output).join(Path::new(&name).with_extension(&st.extension));
                    match convert_file(&tools, &f, &name, &out, &preset) {
                        Ok(()) => println!("ok     {name} -> {}", out.display()),
                        Err(e) => println!("FAILED {name}: {e}"),
                    }
                    done.insert(f);
                }
                if once && !pending {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_secs(if once { 1 } else { 3 }));
            }
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
                let r = convert_file(&tools, &f, &name, &out, &preset);
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
        _ => println!("usage: ffworks <caps|presets|probe|command|render|run|script|plugin|serve|detect|sync|package|batch|watch> ... (see the top of crates/ffworks-cli/src/main.rs)"),
    }
    Ok(())
}
