# Writing an FFWORKS plugin

A plugin is a WebAssembly module run in the [Extism](https://extism.org) sandbox. It reads the project and answers with editing commands; FFWORKS applies them as one undo step. Use a plugin when a script (Rhai, see STATUS.md) is not enough: you want another language, existing libraries, or code you can ship as a binary.

## Folder layout

```
my-plugin/
  plugin.json
  plugin.wasm
```

```json
{
  "name": "My plugin",
  "version": "1.0.0",
  "description": "What it does",
  "wasm": "plugin.wasm",
  "permissions": { "edit": true, "analysis": false },
  "actions": [
    { "id": "grid", "label": "Marker every 10 seconds", "export": "markers" }
  ]
}
```

* `wasm` must be a plain file name inside the folder.
* `permissions` is what the plugin *asks* for. The app decides what it grants; the plugin gets the intersection. `edit: false` plugins cannot change anything.
* Each action calls one wasm export (`export`).

## Calling convention

The export receives JSON text:

```json
{ "api": 1, "selected": "<clip id, or empty>", "project": { ...the project exactly as saved... } }
```

and returns JSON text:

```json
{ "commands": [ { "type": "add_marker", "time": "10", "name": "10 s", "color": null, "note": null } ], "log": ["1 marker"] }
```

A command is the same JSON that command lists, macros, scripts and the local API use (`ffworks command --help`, `crates/ffworks-core/src/commands.rs`). Times are exact rationals as strings (`"10"`, `"3/2"`). To fail with a message, return an error from the export; the text reaches the user.

## Rules

* Nothing changes until your export has returned. Then all commands run as ONE undo step. If any command is refused or fails, none of them are kept.
* Not allowed: reading files (`import_media`, `relink_media`), analysing media unless the manifest asked for `analysis` and the caller allowed it.
* Limits: 10 s per call, 64 MiB of memory, 4 MiB of answer, 2000 commands. A plugin that exceeds time or memory is stopped (`timeout`, `oom`).
* The sandbox has no WASI, no network, no file system and no host functions: the plugin sees only its input.

## Building one in Rust

`plugins/example` is a complete, working example (and the fixture of the plugin tests); `src/lib.rs` uses [`extism-pdk`](https://crates.io/crates/extism-pdk):

```sh
rustup target add wasm32-unknown-unknown
plugins/example/build.sh        # writes plugins/example/plugin.wasm
ffworks plugin plugins/example  # list its actions
ffworks plugin plugins/example markers new --save /tmp/p.ffworks
```

Other languages: any [Extism PDK](https://extism.org/docs/concepts/pdk) (Go, JavaScript, Python, Zig, C#, …) works the same way.

## Installing

Command palette → **Install a plugin from a folder…** copies `plugin.json` and the wasm file into `<app data>/plugins/<name>/` (installing again replaces it). Each action then shows up as **Plugin <name>: <label>**.
