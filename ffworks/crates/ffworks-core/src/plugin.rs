//! Plugins: WebAssembly modules run in the [Extism](https://extism.org) sandbox (BSD-3-Clause) that read the project and answer
//! with editing commands. They can be written in any language that compiles to wasm (Rust, Go, JS, Zig, C#, …) with an Extism
//! plugin kit.
//!
//! **Layout.** A plugin is a folder with `plugin.json` and its `.wasm` file:
//!
//! ```json
//! { "name": "Markers", "version": "1.0.0", "description": "…", "wasm": "plugin.wasm",
//!   "permissions": { "edit": true, "analysis": false },
//!   "actions": [ { "id": "markers", "label": "Marker every 10 s", "export": "markers" } ] }
//! ```
//!
//! **Calling convention.** An action calls the wasm export named by `export` with a JSON input
//! `{"api":1, "selected": "<clip id or empty>", "project": <the project as saved>}` and expects JSON back:
//! `{"commands": [<command>, …], "log": ["…"]}`. A command is the same JSON the command lists, macros, scripts and the local API
//! use. Nothing the plugin does touches the project until it has returned; then its commands are applied as ONE undo step, all
//! or nothing, through the same checks scripts have ([`crate::script::Permissions`]).
//!
//! **Sandbox.** By default a plugin sees only its input: no network, no files, no host functions. Memory, run time, output
//! size and the number of commands are capped. The manifest *asks* for permissions; the caller decides what is granted, and the
//! plugin gets the intersection (a plugin that did not ask for `analysis` never gets it). Beyond editing and analysis a plugin
//! can ask for:
//!
//! * `network`: host names it may call over HTTP(S) with the Extism HTTP API (`"hosts"` it lists; only those the caller also
//!   grants are reachable, and responses are capped at [`MAX_HTTP_RESPONSE`] bytes);
//! * `files`: guest paths (`"/data"`) it wants mapped to a folder; the caller grants a real folder for each, and the plugin
//!   sees only that folder (read **and** write: Extism cannot make it read-only);
//! * `wasi: true` in the manifest: the WASI system interface (clock, randomness, stdio, and files only through the folders above)
//!   for modules built with a WASI toolchain (Go, JS, Python, Rust `wasm32-wasip1`);
//! * `config`: fixed key/value settings the plugin reads with the Extism config API.

use crate::commands::Command;
use crate::engine::Engine;
use crate::error::{Error, Result};
use crate::script::{vet, Permissions, Refusal};
use extism::{Manifest, Plugin as Instance, Wasm};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

/// Version of the calling convention above.
pub const API_VERSION: u32 = 1;
/// Longest one call may run.
pub const MAX_RUNTIME: Duration = Duration::from_secs(10);
/// Most memory a plugin may use, in 64 KiB wasm pages (64 MiB).
pub const MAX_PAGES: u32 = 1024;
/// Most bytes a plugin may answer with.
pub const MAX_OUTPUT: usize = 4 * 1024 * 1024;
/// Most commands one call may return.
pub const MAX_COMMANDS: usize = 2000;
/// Most bytes one HTTP response to a plugin may hold.
pub const MAX_HTTP_RESPONSE: u64 = 8 * 1024 * 1024;
/// Most bytes of variables a plugin may keep between calls.
pub const MAX_VARS: u64 = 1024 * 1024;
/// Largest `.wasm` accepted.
pub const MAX_WASM: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Requested {
    #[serde(default)]
    pub edit: bool,
    #[serde(default)]
    pub analysis: bool,
    /// Host names the plugin wants to reach over HTTP(S).
    #[serde(default)]
    pub network: Vec<String>,
    /// Guest paths (like `/data`) the plugin wants mapped to a folder of the user's.
    #[serde(default)]
    pub files: Vec<String>,
}

/// What the caller allows a plugin to do. The plugin gets the intersection with what its manifest asked for.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Grants {
    pub edit: bool,
    pub analysis: bool,
    /// Hosts that may be called.
    pub hosts: Vec<String>,
    /// For each guest path, the real folder it is mapped to.
    pub folders: BTreeMap<String, PathBuf>,
}

impl Grants {
    /// Edit only (what the palette grants by default).
    pub fn edit_only() -> Grants {
        Grants { edit: true, ..Default::default() }
    }
}

impl From<Permissions> for Grants {
    fn from(p: Permissions) -> Grants {
        Grants { edit: p.edit, analysis: p.analysis, ..Default::default() }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub id: String,
    pub label: String,
    /// Name of the wasm export to call.
    pub export: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_wasm")]
    pub wasm: String,
    #[serde(default)]
    pub permissions: Requested,
    /// Run with the WASI system interface (needed by modules built with a WASI toolchain).
    #[serde(default)]
    pub wasi: bool,
    /// Fixed settings the plugin reads with the Extism config API.
    #[serde(default)]
    pub config: BTreeMap<String, String>,
    pub actions: Vec<Action>,
}

fn default_wasm() -> String {
    "plugin.wasm".into()
}

/// A plugin read from disk (not yet running).
#[derive(Clone, Debug)]
pub struct PluginPackage {
    pub dir: PathBuf,
    pub manifest: PluginManifest,
    wasm: Vec<u8>,
}

#[derive(Debug, Default)]
pub struct Report {
    /// Lines the plugin logged.
    pub log: Vec<String>,
    /// Editing commands it issued.
    pub commands: usize,
}

#[derive(Deserialize)]
struct Output {
    #[serde(default)]
    commands: Vec<serde_json::Value>,
    #[serde(default)]
    log: Vec<String>,
}

/// Read `dir/plugin.json` and the wasm file next to it. The wasm path must stay inside the folder.
pub fn load(dir: &Path) -> Result<PluginPackage> {
    let manifest_path = dir.join("plugin.json");
    let text = std::fs::read_to_string(&manifest_path).map_err(|e| Error::io(&manifest_path, e))?;
    let manifest: PluginManifest = serde_json::from_str(&text).map_err(|e| Error::validation(format!("{}: {e}", manifest_path.display())))?;
    if manifest.name.trim().is_empty() {
        return Err(Error::validation("a plugin needs a name"));
    }
    if manifest.actions.is_empty() {
        return Err(Error::validation(format!("plugin \"{}\" declares no actions", manifest.name)));
    }
    let rel = Path::new(&manifest.wasm);
    if rel.is_absolute() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(Error::validation(format!("plugin \"{}\": the wasm file must be a plain file name inside the plugin folder", manifest.name)));
    }
    let wasm_path = dir.join(rel);
    let size = std::fs::metadata(&wasm_path).map_err(|e| Error::io(&wasm_path, e))?.len();
    if size > MAX_WASM {
        return Err(Error::validation(format!("{} is too large ({size} bytes; the limit is {MAX_WASM})", wasm_path.display())));
    }
    let wasm = std::fs::read(&wasm_path).map_err(|e| Error::io(&wasm_path, e))?;
    Ok(PluginPackage { dir: dir.to_path_buf(), manifest, wasm })
}

/// Every plugin folder directly inside `root` that loads (broken ones are returned as errors by name so the UI can say why).
pub fn discover(root: &Path) -> Vec<std::result::Result<PluginPackage, (String, String)>> {
    let Ok(rd) = std::fs::read_dir(root) else { return vec![] };
    let mut dirs: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.join("plugin.json").is_file()).collect();
    dirs.sort();
    dirs.into_iter().map(|d| load(&d).map_err(|e| (d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), e.to_string()))).collect()
}

impl PluginPackage {
    /// What the plugin is allowed to do when the caller grants `granted`: only what it asked for, and no more than was granted.
    pub fn effective(&self, granted: Permissions) -> Permissions {
        Permissions { edit: granted.edit && self.manifest.permissions.edit, analysis: granted.analysis && self.manifest.permissions.analysis }
    }

    /// The hosts the plugin may call: asked for by the manifest *and* granted.
    pub fn allowed_hosts(&self, g: &Grants) -> Vec<String> {
        g.hosts.iter().filter(|h| self.manifest.permissions.network.contains(h)).cloned().collect()
    }

    /// The folders the plugin may see: guest paths it asked for, with the real (existing) folder the caller granted for each.
    pub fn allowed_folders(&self, g: &Grants) -> Result<Vec<(String, PathBuf)>> {
        let mut out = vec![];
        for guest in &self.manifest.permissions.files {
            let Some(host) = g.folders.get(guest) else { continue };
            let real = std::fs::canonicalize(host).map_err(|e| Error::io(host, e))?;
            if !real.is_dir() {
                return Err(Error::validation(format!("{} is not a folder (granted to plugin \"{}\" as {guest})", host.display(), self.manifest.name)));
            }
            out.push((guest.clone(), real));
        }
        Ok(out)
    }

    /// Run one action in the sandbox and return the commands it answered with (nothing is applied).
    fn call(&self, eng: &Engine, action: &Action, selected: Option<&str>, grants: &Grants) -> Result<Output> {
        let project = serde_json::to_value(&eng.project)?;
        let input = serde_json::json!({ "api": API_VERSION, "selected": selected.unwrap_or(""), "project": project });
        let memory = extism_manifest::MemoryOptions::new().with_max_pages(MAX_PAGES).with_max_http_response_bytes(MAX_HTTP_RESPONSE).with_max_var_bytes(MAX_VARS);
        let mut manifest = Manifest::new([Wasm::data(self.wasm.clone())]).with_timeout(MAX_RUNTIME).with_memory_options(memory).with_config(self.manifest.config.clone().into_iter());
        let hosts = self.allowed_hosts(grants);
        manifest = if hosts.is_empty() { manifest.disallow_all_hosts() } else { manifest.with_allowed_hosts(hosts.into_iter()) };
        for (guest, host) in self.allowed_folders(grants)? {
            manifest = manifest.with_allowed_path(host.to_string_lossy().into_owned(), guest);
        }
        let name = &self.manifest.name;
        // no host functions of our own; WASI only when the manifest asks for it
        let mut instance = Instance::new(&manifest, [], self.manifest.wasi).map_err(|e| Error::validation(format!("plugin \"{name}\" could not be loaded: {e}")))?;
        if !instance.function_exists(&action.export) {
            return Err(Error::validation(format!("plugin \"{name}\" has no export named \"{}\"", action.export)));
        }
        let out: &[u8] = instance.call(&action.export, serde_json::to_vec(&input)?).map_err(|e| Error::validation(format!("plugin \"{name}\": {e}")))?;
        if out.len() > MAX_OUTPUT {
            return Err(Error::validation(format!("plugin \"{name}\" answered with {} bytes; the limit is {MAX_OUTPUT}", out.len())));
        }
        serde_json::from_slice(out).map_err(|e| Error::validation(format!("plugin \"{name}\" did not answer with {{\"commands\": [...]}}: {e}")))
    }
}

/// Run `action` of `pkg` against `eng`; its commands become ONE undo step (named after `label`). `granted` is what the caller
/// allows; the plugin gets only what its manifest asked for within that. On any error nothing of it is kept.
pub fn run(eng: &mut Engine, pkg: &PluginPackage, action_id: &str, selected: Option<&str>, granted: Permissions, label: &str) -> Result<Report> {
    run_with(eng, pkg, action_id, selected, &granted.into(), label)
}

/// [`run`] with the full set of grants (network hosts and folders as well as editing and analysis).
pub fn run_with(eng: &mut Engine, pkg: &PluginPackage, action_id: &str, selected: Option<&str>, grants: &Grants, label: &str) -> Result<Report> {
    let name = &pkg.manifest.name;
    let action = pkg.manifest.actions.iter().find(|a| a.id == action_id).ok_or_else(|| Error::validation(format!("plugin \"{name}\" has no action \"{action_id}\"")))?;
    let perms = pkg.effective(Permissions { edit: grants.edit, analysis: grants.analysis });
    let out = pkg.call(eng, action, selected, grants)?;
    if out.commands.len() > MAX_COMMANDS {
        return Err(Error::validation(format!("plugin \"{name}\" returned {} commands; the limit is {MAX_COMMANDS}", out.commands.len())));
    }
    // read everything first: a command that cannot be read or is not allowed rejects the whole answer before any edit
    let mut cmds = Vec::with_capacity(out.commands.len());
    for (i, v) in out.commands.into_iter().enumerate() {
        let cmd: Command = serde_json::from_value(v).map_err(|e| Error::validation(format!("plugin \"{name}\": command {} is not a command: {e}", i + 1)))?;
        match vet(perms, &cmd) {
            Ok(()) => cmds.push(cmd),
            Err(Refusal::ReadOnly) => return Err(Error::validation(format!("plugin \"{name}\" is not allowed to edit the project"))),
            Err(Refusal::ReadsFiles) => return Err(Error::validation(format!("plugin \"{name}\" tried to read a file from disk (import_media / relink_media / animate_from_midi are not allowed)"))),
            Err(Refusal::NeedsAnalysis) => return Err(Error::validation(format!("plugin \"{name}\" tried to analyse the project's media, which it was not given permission to do"))),
        }
    }
    let count = cmds.len();
    let group = eng.begin_group();
    for (i, cmd) in cmds.into_iter().enumerate() {
        if let Err(e) = eng.dispatch(cmd) {
            eng.abort_group(group);
            return Err(Error::validation(format!("plugin \"{name}\": command {} failed: {e}", i + 1)));
        }
    }
    eng.end_group(group, label);
    Ok(Report { log: out.log.into_iter().take(1000).collect(), commands: count })
}

/// Copy the plugin in `src` into its own folder under `root` (named after the plugin; installing it again replaces it), after
/// checking that it loads. Only `plugin.json` and the wasm file are copied.
pub fn install(root: &Path, src: &Path) -> Result<PluginPackage> {
    let pkg = load(src)?;
    let folder: String = pkg.manifest.name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>().trim_matches('-').to_string();
    if folder.is_empty() {
        return Err(Error::validation("the plugin's name needs at least one letter or digit"));
    }
    let dest = root.join(&folder);
    std::fs::create_dir_all(&dest).map_err(|e| Error::io(&dest, e))?;
    std::fs::write(dest.join("plugin.json"), serde_json::to_vec_pretty(&pkg.manifest)?).map_err(|e| Error::io(dest.join("plugin.json"), e))?;
    let wasm = dest.join(&pkg.manifest.wasm);
    std::fs::write(&wasm, &pkg.wasm).map_err(|e| Error::io(&wasm, e))?;
    load(&dest)
}
