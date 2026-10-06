//! Example FFWORKS plugin that uses the WASI file interface through a folder the user granted (mapped to `/data`).
use extism_pdk::*;
use serde_json::{json, Value};

#[plugin_fn]
pub fn marks() -> FnResult<String> {
    let text = std::fs::read_to_string("/data/marks.txt").map_err(|e| Error::msg(format!("cannot read /data/marks.txt: {e}")))?;
    let mut cmds: Vec<Value> = vec![];
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let t: f64 = line.parse().map_err(|_| Error::msg(format!("not a time: {line}")))?;
        cmds.push(json!({ "type": "add_marker", "time": format!("{}/100", (t * 100.0).round() as i64), "name": format!("mark {line}"), "color": null, "note": null }));
    }
    std::fs::write("/data/marker-count.txt", format!("{}\n", cmds.len())).map_err(|e| Error::msg(format!("cannot write /data/marker-count.txt: {e}")))?;
    Ok(json!({ "commands": cmds, "log": [format!("{} marks", cmds.len())] }).to_string())
}

/// Tries to read a file the user did not give it.
#[plugin_fn]
pub fn escape() -> FnResult<String> {
    match std::fs::read_to_string("/etc/passwd") {
        Ok(_) => Ok(json!({ "commands": [], "log": ["READ /etc/passwd"] }).to_string()),
        Err(e) => Err(Error::msg(format!("blocked: {e}")).into()),
    }
}
