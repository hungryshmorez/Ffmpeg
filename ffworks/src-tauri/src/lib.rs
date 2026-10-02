//! Thin Tauri shell. Every editing operation is a `ffworks_core::Command`; this file only
//! marshals IPC, owns the engine mutex, and forwards job events to the webview.

use ffworks_core::analysis;
use ffworks_core::commands::Command;
use ffworks_core::engine::{prepare_asset, Engine};
use ffworks_core::ffmpeg::{compile, ExportSettings, FfmpegJob, RenderOptions};
use ffworks_core::jobs::{CancelToken, JobLog};
use ffworks_core::queue::{JobQueue, JobSnapshot, PRIORITY_BACKGROUND, PRIORITY_EXPORT};
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::{Project, ProjectSettings};
use ffworks_core::{render_graph, Rational};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    engine: Mutex<Engine>,
    queue: JobQueue,
    caps: Mutex<Option<Capabilities>>,
    cache_dir: PathBuf,
    recovery_dir: PathBuf,
    settings_file: PathBuf,
    bundled_dir: Option<PathBuf>,
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
    /// Content hash the processed preview must match to be considered current.
    render_hash: String,
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
        render_hash: ffworks_core::preview::project_hash(&e.project).unwrap_or_default(),
    }
}

fn s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn allow_media(app: &AppHandle, e: &Engine) {
    let scope = app.asset_protocol_scope();
    for m in e.project.media.iter().filter(|m| !m.is_generated()) {
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
    ffworks_core::recovery::clear(&state.recovery_dir);
    allow_media(&app, &e);
    Ok(view(&e))
}

#[tauri::command]
fn open_project(app: AppHandle, state: State<AppState>, path: String) -> Result<StateView, String> {
    let mut e = state.engine.lock().unwrap();
    *e = Engine::load(Path::new(&path), e.tools.clone()).map_err(s)?;
    ffworks_core::recovery::clear(&state.recovery_dir);
    allow_media(&app, &e);
    Ok(view(&e))
}

#[tauri::command]
fn save_project(state: State<AppState>, path: Option<String>) -> Result<StateView, String> {
    let mut e = state.engine.lock().unwrap();
    let target = path.map(PathBuf::from).or_else(|| e.path().map(Path::to_path_buf)).ok_or("no file chosen")?;
    e.save(&target).map_err(s)?;
    ffworks_core::recovery::clear(&state.recovery_dir);
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
    if m.is_generated() {
        return Err("generated media (titles, solid colours) has no file to analyse".into());
    }
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewInfo {
    path: String,
    start: Rational,
    end: Rational,
    render_hash: String,
    cached: bool,
    scale_div: u32,
}

/// Render (or reuse) a processed preview of `[start, end)` using the same compiler as export.
#[tauri::command]
async fn render_preview(app: AppHandle, state: State<'_, AppState>, start: String, end: String, scale_div: u32) -> Result<PreviewInfo, String> {
    let (project, tools) = {
        let e = state.engine.lock().unwrap();
        (e.project.clone(), e.tools.clone())
    };
    let caps = caps(&state);
    let cache = state.cache_dir.clone();
    let (start, end) = (start.parse::<Rational>()?, end.parse::<Rational>()?);
    let render_hash = ffworks_core::preview::project_hash(&project).map_err(s)?;
    let r = tauri::async_runtime::spawn_blocking(move || ffworks_core::preview::render(&tools, caps.as_ref(), &project, start, end, scale_div, &cache, &CancelToken::new(), &mut |_| {}))
        .await
        .map_err(s)?
        .map_err(s)?;
    let _ = app.asset_protocol_scope().allow_directory(&state.cache_dir, true);
    Ok(PreviewInfo { path: r.path.to_string_lossy().into_owned(), start: r.start, end: r.end, render_hash, cached: r.cached, scale_div })
}

/// Autosave left behind by an abnormal exit, if any.
#[tauri::command]
fn find_recovery(state: State<AppState>) -> Option<ffworks_core::recovery::RecoveryInfo> {
    ffworks_core::recovery::find(&state.recovery_dir)
}

#[tauri::command]
fn recover_project(app: AppHandle, state: State<AppState>) -> Result<StateView, String> {
    let info = ffworks_core::recovery::find(&state.recovery_dir).ok_or("no recovery data found")?;
    let mut e = state.engine.lock().unwrap();
    *e = ffworks_core::recovery::load(&info, e.tools.clone()).map_err(s)?;
    // keep the autosave until the user saves: a second crash must not lose the recovered work
    allow_media(&app, &e);
    Ok(view(&e))
}

#[tauri::command]
fn discard_recovery(state: State<AppState>) {
    ffworks_core::recovery::clear(&state.recovery_dir);
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> ffworks_core::settings::Settings {
    ffworks_core::settings::Settings::load(&state.settings_file)
}

/// Validate the chosen FFmpeg/FFprobe by running them, then persist and apply. Nothing is saved if validation fails.
#[tauri::command]
fn set_settings(state: State<AppState>, ffmpeg_path: Option<String>, ffprobe_path: Option<String>) -> Result<serde_json::Value, String> {
    let mut new = ffworks_core::settings::Settings::load(&state.settings_file);
    new.ffmpeg_path = ffmpeg_path;
    new.ffprobe_path = ffprobe_path;
    new.active_engine = None;
    let tools = new.tools_with_bundled(state.bundled_dir.as_deref());
    let (ff, pr) = ffworks_core::settings::validate_tools(&tools).map_err(s)?;
    new.save(&state.settings_file).map_err(s)?;
    state.queue.set_tools(tools.clone());
    state.engine.lock().unwrap().tools = tools;
    *state.caps.lock().unwrap() = None;
    Ok(serde_json::json!({ "ffmpeg": ff, "ffprobe": pr }))
}

#[tauri::command]
async fn relink_search(app: AppHandle, dir: String) -> Result<serde_json::Value, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = app2.state::<AppState>();
        let mut e = st.engine.lock().unwrap();
        let (done, rest) = e.relink_search(&[PathBuf::from(dir)]).map_err(s)?;
        allow_media(&app2, &e);
        Ok(serde_json::json!({ "state": view(&e), "relinked": done, "unresolved": rest.into_iter().map(|(id, c)| serde_json::json!({ "mediaId": id, "candidates": c })).collect::<Vec<_>>() }))
    })
    .await
    .map_err(s)?
}

#[tauri::command]
async fn relink_media(app: AppHandle, state: State<'_, AppState>, media_id: String, path: String) -> Result<StateView, String> {
    let tools = state.engine.lock().unwrap().tools.clone();
    let mut asset = tauri::async_runtime::spawn_blocking(move || prepare_asset(&tools, Path::new(&path))).await.map_err(s)?.map_err(s)?;
    asset.id = media_id;
    let mut e = state.engine.lock().unwrap();
    e.dispatch(Command::RelinkMedia { asset }).map_err(s)?;
    allow_media(&app, &e);
    Ok(view(&e))
}

#[tauri::command]
async fn get_beats(state: State<'_, AppState>, media_id: String) -> Result<ffworks_core::beats::BeatAnalysis, String> {
    let (tools, path, key) = media_for(&state, &media_id)?;
    let cache = state.cache_dir.clone();
    tauri::async_runtime::spawn_blocking(move || ffworks_core::beats::detect(&tools, &path, &cache, &key)).await.map_err(s)?.map_err(s)
}

#[tauri::command]
async fn detect_scenes(state: State<'_, AppState>, media_id: String, threshold: f64) -> Result<ffworks_core::scenes::SceneAnalysis, String> {
    let (tools, path, key) = media_for(&state, &media_id)?;
    let duration = state.engine.lock().unwrap().project.media(&media_id).map_err(s)?.info.duration.as_f64();
    let cache = state.cache_dir.clone();
    tauri::async_runtime::spawn_blocking(move || ffworks_core::scenes::detect(&tools, &path, duration, &cache, &key, threshold)).await.map_err(s)?.map_err(s)
}

#[tauri::command]
async fn measure_loudness(state: State<'_, AppState>, media_id: String) -> Result<ffworks_core::loudness::Loudness, String> {
    let (tools, path, key) = media_for(&state, &media_id)?;
    let cache = state.cache_dir.clone();
    tauri::async_runtime::spawn_blocking(move || ffworks_core::loudness::analyze(&tools, &path, &cache, &key)).await.map_err(s)?.map_err(s)
}

/// Transitions this FFmpeg can really do: its native `xfade` list (falling back to the built-in names) plus the bundled GL
/// transitions when its `xfade` accepts custom expressions.
fn available_transitions(state: &AppState) -> Vec<(String, String)> {
    let c = caps(state);
    let mut list: Vec<(String, String)> = match &c {
        Some(c) if !c.xfade_transitions.is_empty() => c
            .xfade_transitions
            .iter()
            .map(|(k, d)| {
                let label = ffworks_core::transitions::KINDS.iter().find(|(n, _)| n == k).map(|(_, l)| l.to_string()).unwrap_or_else(|| {
                    let mut ch = d.chars();
                    ch.next().map(|f| f.to_uppercase().collect::<String>() + ch.as_str()).unwrap_or(d.clone())
                });
                (k.clone(), label)
            })
            .collect(),
        _ => ffworks_core::transitions::KINDS.iter().map(|(k, l)| (k.to_string(), l.to_string())).collect(),
    };
    if c.is_some_and(|c| c.xfade_custom) {
        list.extend(ffworks_core::glx::all().iter().map(|(n, _)| (n.to_string(), format!("{} (slow to render)", ffworks_core::glx::label(n)))));
    }
    list
}

#[tauri::command]
fn list_transitions(state: State<AppState>) -> Vec<(String, String)> {
    available_transitions(&state)
}

#[tauri::command]
fn list_effects() -> Vec<ffworks_core::effects::EffectDef> {
    ffworks_core::effects::registry()
}

/// Proxy state of every media item (proxies are a cache next to the thumbnails, never part of the project).
#[tauri::command]
fn proxy_status(state: State<AppState>) -> Vec<ffworks_core::proxy::ProxyStatus> {
    let e = state.engine.lock().unwrap();
    e.project.media.iter().map(|m| ffworks_core::proxy::status(&state.cache_dir, m)).collect()
}

/// Queue a proxy render for one media item (background priority); progress arrives as `job-state` events with
/// operation `proxy:<media id>`.
#[tauri::command]
fn create_proxy(app: AppHandle, state: State<AppState>, media_id: String) -> Result<String, String> {
    let m = state.engine.lock().unwrap().project.media(&media_id).map_err(s)?.clone();
    let out = ffworks_core::proxy::proxy_path(&state.cache_dir, &m);
    let job = ffworks_core::proxy::build_job(&m, &out, caps(&state).as_ref()).map_err(s)?;
    let _ = app.asset_protocol_scope().allow_directory(&state.cache_dir, true);
    Ok(state.queue.submit(job, &format!("proxy:{media_id}"), PRIORITY_BACKGROUND))
}

/// Delete every proxy file (they are regenerated on demand).
#[tauri::command]
fn clear_proxies(state: State<AppState>) -> Result<u64, String> {
    let dir = state.cache_dir.join("proxies");
    let bytes = std::fs::read_dir(&dir).map(|r| r.filter_map(|e| e.ok()).filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum()).unwrap_or(0);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(s)?;
    }
    Ok(bytes)
}

/// Every filter in the installed FFmpeg, for the filter browser.
#[tauri::command]
fn list_filters(state: State<AppState>) -> Result<Vec<ffworks_core::filterdb::FilterInfo>, String> {
    let tools = state.engine.lock().unwrap().tools.clone();
    tools.list_filters().map_err(|e| e.to_string())
}

/// Options, pads and defaults of one filter, parsed from `ffmpeg -h filter=NAME`.
#[tauri::command]
fn filter_help(state: State<AppState>, name: String) -> Result<ffworks_core::filterdb::FilterHelp, String> {
    let tools = state.engine.lock().unwrap().tools.clone();
    tools.filter_help(&name).map_err(|e| e.to_string())
}

/// Every registered FFmpeg build with what it really supports, plus which one is active.
#[tauri::command]
async fn list_engines(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let st = ffworks_core::settings::Settings::load(&state.settings_file);
    let active = st.active_engine.clone();
    let current = state.engine.lock().unwrap().tools.clone();
    let infos = tauri::async_runtime::spawn_blocking(move || {
        let mut list: Vec<ffworks_core::engines::EngineInfo> = st.engines.iter().map(ffworks_core::engines::probe_engine).collect();
        // the build in use when none of the registered ones is chosen (bundled copy, FFWORKS_FFMPEG or PATH)
        if st.active_engine.as_deref().is_none_or(|a| !st.engines.iter().any(|e| e.id == a)) {
            let entry = ffworks_core::engines::EngineEntry { id: "default".into(), name: "Default (bundled / PATH)".into(), ffmpeg_path: current.ffmpeg.display().to_string(), ffprobe_path: Some(current.ffprobe.display().to_string()) };
            list.insert(0, ffworks_core::engines::probe_engine(&entry));
        }
        list
    })
    .await
    .map_err(s)?;
    Ok(serde_json::json!({ "engines": infos, "active": active.unwrap_or_else(|| "default".into()) }))
}

/// Find ffmpeg builds under a folder (for people who keep several installs side by side).
#[tauri::command]
async fn scan_engines(dir: String) -> Result<Vec<ffworks_core::engines::Found>, String> {
    tauri::async_runtime::spawn_blocking(move || ffworks_core::engines::scan(std::path::Path::new(&dir), 5)).await.map_err(s)
}

/// Register a build after running it to prove it is FFmpeg; nothing is saved when that fails.
#[tauri::command]
async fn add_engine(state: State<'_, AppState>, name: String, ffmpeg_path: String, ffprobe_path: Option<String>) -> Result<ffworks_core::engines::EngineInfo, String> {
    let entry = ffworks_core::engines::EngineEntry { id: ffworks_core::engines::new_id(), name: name.trim().to_string(), ffmpeg_path: ffmpeg_path.trim().to_string(), ffprobe_path: ffprobe_path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) };
    if entry.name.is_empty() || entry.ffmpeg_path.is_empty() {
        return Err("give the build a name and the path of its ffmpeg".into());
    }
    let file = state.settings_file.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let info = ffworks_core::engines::probe_engine(&entry);
        if !info.ok {
            return Err(info.error.unwrap_or_else(|| "this does not work as FFmpeg".into()));
        }
        let mut st = ffworks_core::settings::Settings::load(&file);
        if st.engines.iter().any(|e| e.ffmpeg_path == entry.ffmpeg_path) {
            return Err("that ffmpeg is already registered".into());
        }
        st.engines.push(entry);
        st.save(&file).map_err(s)?;
        Ok(info)
    })
    .await
    .map_err(s)?
}

#[tauri::command]
fn remove_engine(state: State<AppState>, id: String) -> Result<(), String> {
    let mut st = ffworks_core::settings::Settings::load(&state.settings_file);
    st.engines.retain(|e| e.id != id);
    let was_active = st.active_engine.as_deref() == Some(id.as_str());
    if was_active {
        st.active_engine = None;
    }
    st.save(&state.settings_file).map_err(s)?;
    if was_active {
        apply_tools(&state, &st)?;
    }
    Ok(())
}

/// Make a registered build the one used for everything (`None` = back to the default). It is run first; nothing changes on failure.
#[tauri::command]
fn set_active_engine(state: State<AppState>, id: Option<String>) -> Result<String, String> {
    let mut st = ffworks_core::settings::Settings::load(&state.settings_file);
    if let Some(i) = id.as_deref().filter(|i| *i != "default") {
        if !st.engines.iter().any(|e| e.id == i) {
            return Err("that build is not registered".into());
        }
        st.active_engine = Some(i.to_string());
    } else {
        st.active_engine = None;
    }
    let version = apply_tools(&state, &st)?;
    st.save(&state.settings_file).map_err(s)?;
    Ok(version)
}

/// Resolve the settings' tools, prove they run, and switch the queue, engine and capability cache over to them.
fn apply_tools(state: &AppState, st: &ffworks_core::settings::Settings) -> Result<String, String> {
    let tools = st.tools_with_bundled(state.bundled_dir.as_deref());
    let (ff, _) = ffworks_core::settings::validate_tools(&tools).map_err(s)?;
    state.queue.set_tools(tools.clone());
    state.engine.lock().unwrap().tools = tools;
    *state.caps.lock().unwrap() = None;
    Ok(ff)
}

/// Starred effects/transitions and named favourite groups.
#[tauri::command]
fn get_favourites(state: State<AppState>) -> ffworks_core::settings::Favourites {
    ffworks_core::settings::Settings::load(&state.settings_file).favourites
}

#[tauri::command]
fn set_favourites(state: State<AppState>, favourites: ffworks_core::settings::Favourites) -> Result<ffworks_core::settings::Favourites, String> {
    let mut st = ffworks_core::settings::Settings::load(&state.settings_file);
    st.favourites = favourites.normalised().map_err(s)?;
    st.save(&state.settings_file).map_err(s)?;
    Ok(st.favourites)
}

/// Stack `count` random effects on a clip as one undoable step. `pool` is `all`, `favourites` or a named group.
/// The seed (given or fresh) is returned so the same result can be recreated.
#[tauri::command]
fn random_effects(state: State<AppState>, clip: String, count: usize, pool: String, seed: Option<u64>) -> Result<serde_json::Value, String> {
    let favs = ffworks_core::settings::Settings::load(&state.settings_file).favourites;
    let group = favs.pool(&pool).map_err(s)?;
    let mut e = state.engine.lock().unwrap();
    let (_, c) = e.project.active().map_err(s)?.find_clip(&clip).ok_or("clip not found")?;
    let seed = seed.unwrap_or_else(ffworks_core::random::fresh_seed);
    if let Some(g) = group {
        if g.effects.is_empty() {
            return Err(format!("No favourite effects in '{pool}' yet: star some in the effect list first."));
        }
    }
    let cmds = ffworks_core::random::effect_stack(c, count, seed, group.map(|g| g.effects.as_slice())).map_err(s)?;
    let label = format!("Random effects ×{}", cmds.len());
    e.dispatch(Command::Batch { label, commands: cmds }).map_err(s)?;
    Ok(serde_json::json!({ "state": view(&e), "seed": seed }))
}

/// Add random transitions on up to `count` consecutive cuts starting after `clip`, as one undoable step. Cuts that cannot
/// take one (no media handles, retimed clips...) are skipped and reported.
#[tauri::command]
fn random_transitions(state: State<AppState>, clip: String, count: usize, pool: String, seed: Option<u64>, duration: Option<f64>) -> Result<serde_json::Value, String> {
    let favs = ffworks_core::settings::Settings::load(&state.settings_file).favourites;
    let group = favs.pool(&pool).map_err(s)?;
    let available: Vec<String> = available_transitions(&state).into_iter().map(|(k, _)| k).collect();
    let kinds: Vec<String> = match group {
        Some(g) if g.transitions.is_empty() => return Err(format!("No favourite transitions in '{pool}' yet: star some in the transition list first.")),
        Some(g) => available.into_iter().filter(|k| g.transitions.contains(k)).collect(),
        None => available,
    };
    let mut e = state.engine.lock().unwrap();
    let seed = seed.unwrap_or_else(ffworks_core::random::fresh_seed);
    let dur = ffworks_core::Rational::new((duration.unwrap_or(0.5).clamp(0.1, 5.0) * 1000.0).round() as i64, 1000);
    let plan = ffworks_core::random::transition_stack(&e.project, &clip, count, seed, &kinds, dur).map_err(s)?;
    let applied = plan.commands.len();
    if applied > 0 {
        e.dispatch(Command::Batch { label: format!("Random transitions ×{applied}"), commands: plan.commands }).map_err(s)?;
    }
    Ok(serde_json::json!({ "state": view(&e), "seed": seed, "applied": applied, "skipped": plan.skipped }))
}

/// Structural errors (as Err) and FFmpeg pad-count problems (as the list) for a filter graph being edited.
#[tauri::command]
fn check_filter_graph(state: State<AppState>, graph: ffworks_core::filtergraph::FilterGraph) -> Result<Vec<String>, String> {
    let tools = state.engine.lock().unwrap().tools.clone();
    ffworks_core::filterdb::check_pads(&tools, &graph).map_err(|e| e.to_string())
}

/// Bundled and installed fonts usable for titles.
#[tauri::command]
fn list_fonts() -> Vec<ffworks_core::fonts::FontEntry> {
    ffworks_core::fonts::list()
}

/// Clip-level parameters (transform/opacity), blend modes and keyframe interpolations for the Inspector.
#[tauri::command]
fn list_clip_props() -> serde_json::Value {
    serde_json::json!({
        "params": ffworks_core::clipprops::video_params(),
        "audioParams": ffworks_core::clipprops::audio_params(),
        "blendModes": ffworks_core::clipprops::BLEND_MODES,
        "interps": ffworks_core::keyframes::INTERPS.iter().map(|(i, n)| serde_json::json!({ "id": i, "name": n })).collect::<Vec<_>>(),
    })
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

fn build_job(state: &AppState, preset: &str, output: &str, range: Option<(String, String)>, scale_div: u32, engine: Option<&str>) -> Result<FfmpegJob, String> {
    let (project, mut tools) = {
        let e = state.engine.lock().unwrap();
        (e.project.clone(), e.tools.clone())
    };
    // an export may name another registered build; its own capabilities decide what can be compiled
    let other_caps = match engine.filter(|i| *i != "default") {
        Some(id) => {
            tools = ffworks_core::settings::Settings::load(&state.settings_file).engine_tools(id).ok_or("that build is not registered")?;
            Some(Capabilities::discover(&tools).map_err(s)?)
        }
        None => None,
    };
    let range = match range {
        Some((a, b)) => Some((a.parse::<Rational>()?, b.parse::<Rational>()?)),
        None => None,
    };
    let g = render_graph::build(&project).map_err(s)?;
    let mut job = compile(&g, &RenderOptions { output: PathBuf::from(output), settings: ExportSettings::find(preset).map_err(s)?, range, scale_div }, other_caps.or_else(|| caps(state)).as_ref()).map_err(s)?;
    job.program = tools.ffmpeg;
    Ok(job)
}

/// Command Inspector: show exactly what would run (spec §52).
#[tauri::command]
fn preview_command(state: State<AppState>, preset: String, output: String, engine: Option<String>) -> Result<String, String> {
    Ok(build_job(&state, &preset, &output, None, 1, engine.as_deref())?.display())
}

/// Queue an export. It runs in the background (one at a time by default); progress arrives as `job-state` events.
#[tauri::command]
fn start_export(state: State<AppState>, preset: String, output: String, engine: Option<String>) -> Result<String, String> {
    let job = build_job(&state, &preset, &output, None, 1, engine.as_deref())?;
    Ok(state.queue.submit(job, "export", PRIORITY_EXPORT))
}

#[tauri::command]
fn cancel_job(state: State<AppState>, job_id: String) -> bool {
    state.queue.cancel(&job_id)
}

#[tauri::command]
fn list_jobs(state: State<AppState>) -> Vec<JobSnapshot> {
    state.queue.snapshot()
}

#[tauri::command]
fn get_job_log(state: State<AppState>, job_id: String) -> Option<JobLog> {
    state.queue.log(&job_id)
}

#[tauri::command]
fn clear_finished_jobs(state: State<AppState>) {
    state.queue.clear_finished();
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
            "bundled": state.bundled_dir.as_ref().is_some_and(|d| tools.ffmpeg.starts_with(d)),
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
            let settings_file = app.path().app_config_dir().unwrap_or_else(|_| base.clone()).join("settings.json");
            // Installer builds ship FFmpeg/FFprobe under <resources>/ffmpeg (see tauri.windows.conf.json).
            let bundled_dir = app.path().resource_dir().ok().map(|d| d.join("ffmpeg"));
            let tools = ffworks_core::settings::Settings::load(&settings_file).tools_with_bundled(bundled_dir.as_deref());
            let queue = JobQueue::new(tools.clone(), base.join("tmp"), 1);
            let emitter = app.handle().clone();
            queue.set_listener(move |snap| {
                let _ = emitter.emit("job-state", snap);
            });
            app.manage(AppState {
                engine: Mutex::new(Engine::new("Untitled", ProjectSettings::default(), tools)),
                queue,
                caps: Mutex::new(None),
                cache_dir: base.join("analysis"),
                recovery_dir: base.join("recovery"),
                settings_file,
                bundled_dir,
            });
            // Autosave unsaved work periodically (spec §47). Never touches the saved project file.
            let secs = std::env::var("FFWORKS_AUTOSAVE_SECS").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(20).max(1);
            let h = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(secs));
                let st = h.state::<AppState>();
                let mut e = st.engine.lock().unwrap();
                if let Err(err) = e.autosave(&st.recovery_dir) {
                    eprintln!("autosave failed: {err}");
                }
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
            detect_scenes, measure_loudness, list_transitions, get_beats, get_settings, set_settings, relink_search, relink_media, find_recovery, recover_project, discard_recovery, list_effects, list_clip_props, list_fonts, list_filters, filter_help, list_engines, scan_engines, add_engine, remove_engine, set_active_engine, get_favourites, set_favourites, random_effects, random_transitions, check_filter_graph, proxy_status, create_proxy, clear_proxies, render_preview, list_export_presets, preview_command, start_export, cancel_job, list_jobs, get_job_log, clear_finished_jobs, verify_output, get_diagnostics, uitest_report
    ]);
    #[cfg(not(feature = "uitest"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_state, new_project, open_project, save_project, import_media, dispatch, undo, redo, get_waveform, get_thumbnails,
            detect_scenes, measure_loudness, list_transitions, get_beats, get_settings, set_settings, relink_search, relink_media, find_recovery, recover_project, discard_recovery, list_effects, list_clip_props, list_fonts, list_filters, filter_help, list_engines, scan_engines, add_engine, remove_engine, set_active_engine, get_favourites, set_favourites, random_effects, random_transitions, check_filter_graph, proxy_status, create_proxy, clear_proxies, render_preview, list_export_presets, preview_command, start_export, cancel_job, list_jobs, get_job_log, clear_finished_jobs, verify_output, get_diagnostics
    ]);
    builder
        .run(tauri::generate_context!())
        .expect("error while running FFWORKS");
}
