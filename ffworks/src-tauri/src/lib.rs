//! Thin Tauri shell. Every editing operation is a `ffworks_core::Command`; this file only
//! marshals IPC, owns the engine mutex, and forwards job events to the webview.

use ffworks_core::analysis;
use ffworks_core::commands::Command;
use ffworks_core::engine::{prepare_asset, Engine};
use ffworks_core::ffmpeg::{compile, ExportSettings, FfmpegJob, RenderOptions};
use ffworks_core::jobs::{run_job, CancelToken, JobLog, JobState};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::{Project, ProjectSettings};
use ffworks_core::{render_graph, Rational};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

struct JobEntry {
    cancel: CancelToken,
    log: Option<JobLog>,
}

struct AppState {
    engine: Mutex<Engine>,
    jobs: Mutex<HashMap<String, JobEntry>>,
    caps: Mutex<Option<Capabilities>>,
    cache_dir: PathBuf,
    temp_dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateView {
    app_name: &'static str,
    project: Project,
    dirty: bool,
    path: Option<String>,
    undo_label: Option<String>,
    redo_label: Option<String>,
    history: Vec<String>,
    duration: Rational,
    offline_media: Vec<String>,
}

fn view(e: &Engine) -> StateView {
    StateView {
        app_name: ffworks_core::brand::APP_NAME,
        project: e.project.clone(),
        dirty: e.is_dirty(),
        path: e.path().map(|p| p.to_string_lossy().into_owned()),
        undo_label: e.undo_label().map(String::from),
        redo_label: e.redo_label().map(String::from),
        history: e.history(),
        duration: e.project.active().map(|s| s.duration()).unwrap_or_default(),
        offline_media: e.offline_media(),
    }
}

fn s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn allow_media(app: &AppHandle, e: &Engine) {
    let scope = app.asset_protocol_scope();
    for m in &e.project.media {
        let _ = scope.allow_file(&m.path);
    }
}

#[tauri::command]
fn get_state(state: State<AppState>) -> StateView {
    view(&state.engine.lock().unwrap())
}

#[tauri::command]
fn new_project(app: AppHandle, state: State<AppState>, name: String) -> Result<StateView, String> {
    let mut e = state.engine.lock().unwrap();
    *e = Engine::new(&name, ProjectSettings::default(), e.tools.clone());
    allow_media(&app, &e);
    Ok(view(&e))
}

#[tauri::command]
fn open_project(app: AppHandle, state: State<AppState>, path: String) -> Result<StateView, String> {
    let mut e = state.engine.lock().unwrap();
    *e = Engine::load(Path::new(&path), e.tools.clone()).map_err(s)?;
    allow_media(&app, &e);
    Ok(view(&e))
}

#[tauri::command]
fn save_project(state: State<AppState>, path: Option<String>) -> Result<StateView, String> {
    let mut e = state.engine.lock().unwrap();
    let target = path.map(PathBuf::from).or_else(|| e.path().map(Path::to_path_buf)).ok_or("no file chosen")?;
    e.save(&target).map_err(s)?;
    Ok(view(&e))
}

/// Probe runs outside the engine lock so a slow FFprobe never freezes state queries.
#[tauri::command]
async fn import_media(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>) -> Result<serde_json::Value, String> {
    let tools = state.engine.lock().unwrap().tools.clone();
    let results = tauri::async_runtime::spawn_blocking(move || paths.into_iter().map(|p| (p.clone(), prepare_asset(&tools, Path::new(&p)))).collect::<Vec<_>>())
        .await
        .map_err(s)?;
    let mut errors = vec![];
    let mut e = state.engine.lock().unwrap();
    for (path, r) in results {
        match r.and_then(|a| e.import_asset(a)) {
            Ok(_) => {}
            Err(err) => errors.push(format!("{path}: {err}")),
        }
    }
    allow_media(&app, &e);
    Ok(serde_json::json!({ "state": view(&e), "errors": errors }))
}

#[tauri::command]
fn dispatch(state: State<AppState>, command: Command) -> Result<StateView, String> {
    let mut e = state.engine.lock().unwrap();
    e.dispatch(command).map_err(s)?;
    Ok(view(&e))
}

#[tauri::command]
fn undo(state: State<AppState>) -> Result<StateView, String> {
    let mut e = state.engine.lock().unwrap();
    e.undo().map_err(s)?;
    Ok(view(&e))
}

#[tauri::command]
fn redo(state: State<AppState>) -> Result<StateView, String> {
    let mut e = state.engine.lock().unwrap();
    e.redo().map_err(s)?;
    Ok(view(&e))
}

fn media_for(state: &AppState, media_id: &str) -> Result<(Tools, PathBuf, String), String> {
    let e = state.engine.lock().unwrap();
    let m = e.project.media(media_id).map_err(s)?;
    let key = m.fingerprint.clone().unwrap_or_else(|| m.id.clone());
    Ok((e.tools.clone(), PathBuf::from(&m.path), key))
}

#[tauri::command]
async fn get_waveform(state: State<'_, AppState>, media_id: String) -> Result<analysis::Waveform, String> {
    let (tools, path, key) = media_for(&state, &media_id)?;
    let cache = state.cache_dir.clone();
    tauri::async_runtime::spawn_blocking(move || analysis::waveform(&tools, &path, &cache, &key)).await.map_err(s)?.map_err(s)
}

#[tauri::command]
async fn get_thumbnails(app: AppHandle, state: State<'_, AppState>, media_id: String) -> Result<Vec<String>, String> {
    let (tools, path, key) = media_for(&state, &media_id)?;
    let cache = state.cache_dir.clone();
    let files = tauri::async_runtime::spawn_blocking(move || analysis::thumbnails(&tools, &path, &cache, &key, 1, 54)).await.map_err(s)?.map_err(s)?;
    let scope = app.asset_protocol_scope();
    let _ = scope.allow_directory(&state.cache_dir, true);
    Ok(files.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

#[tauri::command]
fn list_export_presets() -> Vec<ExportSettings> {
    ExportSettings::builtin()
}

fn caps(state: &AppState) -> Option<Capabilities> {
    let mut c = state.caps.lock().unwrap();
    if c.is_none() {
        let tools = state.engine.lock().unwrap().tools.clone();
        *c = Capabilities::discover(&tools).ok();
    }
    c.clone()
}

fn build_job(state: &AppState, preset: &str, output: &str, range: Option<(String, String)>, scale_div: u32) -> Result<FfmpegJob, String> {
    let (project, tools) = {
        let e = state.engine.lock().unwrap();
        (e.project.clone(), e.tools.clone())
    };
    let range = match range {
        Some((a, b)) => Some((a.parse::<Rational>()?, b.parse::<Rational>()?)),
        None => None,
    };
    let g = render_graph::build(&project).map_err(s)?;
    let mut job = compile(&g, &RenderOptions { output: PathBuf::from(output), settings: ExportSettings::find(preset).map_err(s)?, range, scale_div }, caps(state).as_ref()).map_err(s)?;
    job.program = tools.ffmpeg;
    Ok(job)
}

/// Command Inspector: show exactly what would run (spec §52).
#[tauri::command]
fn preview_command(state: State<AppState>, preset: String, output: String) -> Result<String, String> {
    Ok(build_job(&state, &preset, &output, None, 1)?.display())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JobEvent {
    job_id: String,
    operation: String,
    output: String,
    #[serde(flatten)]
    state: JobState,
}

#[tauri::command]
fn start_export(app: AppHandle, state: State<AppState>, preset: String, output: String) -> Result<String, String> {
    let job = build_job(&state, &preset, &output, None, 1)?;
    let tools = state.engine.lock().unwrap().tools.clone();
    let job_id = format!("job_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let cancel = CancelToken::new();
    state.jobs.lock().unwrap().insert(job_id.clone(), JobEntry { cancel: cancel.clone(), log: None });
    let temp = state.temp_dir.clone();
    let (id2, out2, app2) = (job_id.clone(), output.clone(), app.clone());
    std::thread::spawn(move || {
        let emit = |st: JobState| {
            let _ = app2.emit("job-state", JobEvent { job_id: id2.clone(), operation: "export".into(), output: out2.clone(), state: st });
        };
        let result = run_job(&tools, &job, &id2, "export", &cancel, &temp, &mut |st| emit(st));
        if let Ok(log) = result {
            if let Some(j) = app2.state::<AppState>().jobs.lock().unwrap().get_mut(&id2) {
                j.log = Some(log);
            }
        }
    });
    Ok(job_id)
}

#[tauri::command]
fn cancel_job(state: State<AppState>, job_id: String) {
    if let Some(j) = state.jobs.lock().unwrap().get(&job_id) {
        j.cancel.cancel();
    }
}

/// Post-export FFprobe check (spec §166): reports what the file actually contains.
#[tauri::command]
async fn verify_output(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let tools = state.engine.lock().unwrap().tools.clone();
    let expected = state.engine.lock().unwrap().project.active().map(|q| q.duration()).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let info = ffworks_core::ffprobe::probe(&tools, Path::new(&path)).map_err(s)?;
        let mut lines = vec![format!("FFprobe: {} · {:.2}s (timeline {:.2}s)", info.container, info.duration.as_f64(), expected.as_f64())];
        for v in &info.video {
            lines.push(format!("video {} {}×{}{}", v.codec, v.width, v.height, v.fps.map(|f| format!(" @ {:.3} fps", f.as_f64())).unwrap_or_default()));
        }
        for a in &info.audio {
            lines.push(format!("audio {} {} Hz, {} ch", a.codec, a.sample_rate, a.channels));
        }
        if (info.duration.as_f64() - expected.as_f64()).abs() > 0.25 {
            lines.push("WARNING: output duration differs from the timeline by more than 0.25 s".into());
        }
        Ok::<_, String>(lines.join("\n"))
    })
    .await
    .map_err(s)?
}

#[tauri::command]
fn get_diagnostics(state: State<AppState>) -> serde_json::Value {
    let tools = state.engine.lock().unwrap().tools.clone();
    match caps(&state) {
        Some(c) => serde_json::json!({
            "ffmpeg": c.version, "ffmpegPath": tools.ffmpeg, "ffprobePath": tools.ffprobe,
            "filters": c.filters.len(), "encoders": c.encoders.len(), "hwaccels": c.hwaccels,
            "x264": c.has_encoder("libx264"), "vp9": c.has_encoder("libvpx-vp9"),
        }),
        None => serde_json::json!({ "error": format!("FFmpeg not found or not runnable (looked for {}). Set FFWORKS_FFMPEG / FFWORKS_FFPROBE or install FFmpeg on PATH.", tools.ffmpeg.display()) }),
    }
}

/// Test-only (feature `uitest`): receives the result of the in-webview UI test.
#[cfg(feature = "uitest")]
#[tauri::command]
fn uitest_report(report: String) {
    if let Ok(p) = std::env::var("FFWORKS_UITEST_OUT") {
        let _ = std::fs::write(p, report);
    }
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let base = app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir().join("ffworks"));
            let tools = Tools::discover(None, None);
            app.manage(AppState {
                engine: Mutex::new(Engine::new("Untitled", ProjectSettings::default(), tools)),
                jobs: Mutex::new(HashMap::new()),
                caps: Mutex::new(None),
                cache_dir: base.join("analysis"),
                temp_dir: base.join("tmp"),
            });
            #[cfg(feature = "uitest")]
            if let Ok(script_path) = std::env::var("FFWORKS_UITEST_SCRIPT") {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if let (Some(w), Ok(js)) = (handle.get_webview_window("main"), std::fs::read_to_string(script_path)) {
                        let _ = w.eval(&js);
                    }
                });
            }
            Ok(())
        })
        ;
    #[cfg(feature = "uitest")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_state, new_project, open_project, save_project, import_media, dispatch, undo, redo, get_waveform, get_thumbnails,
            list_export_presets, preview_command, start_export, cancel_job, verify_output, get_diagnostics, uitest_report
    ]);
    #[cfg(not(feature = "uitest"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_state, new_project, open_project, save_project, import_media, dispatch, undo, redo, get_waveform, get_thumbnails,
            list_export_presets, preview_command, start_export, cancel_job, verify_output, get_diagnostics
    ]);
    builder
        .run(tauri::generate_context!())
        .expect("error while running FFWORKS");
}
