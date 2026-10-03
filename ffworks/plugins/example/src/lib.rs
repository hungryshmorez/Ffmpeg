//! Example FFWORKS plugin. Input: {"api":1,"selected":"<clip id>","project":{...}}. Output: {"commands":[...],"log":[...]}.
use extism_pdk::*;
use serde_json::{json, Value};

fn input() -> Result<Value, Error> {
    let text: String = extism_pdk::input()?;
    Ok(serde_json::from_str(&text)?)
}

fn secs(v: &Value) -> f64 {
    let s = v.as_str().unwrap_or("0");
    match s.split_once('/') {
        Some((n, d)) => n.parse::<f64>().unwrap_or(0.0) / d.parse::<f64>().unwrap_or(1.0),
        None => s.parse().unwrap_or(0.0),
    }
}

fn answer(commands: Vec<Value>, log: Vec<String>) -> FnResult<String> {
    Ok(json!({ "commands": commands, "log": log }).to_string())
}

/// A marker every 10 s up to the end of the shown timeline.
#[plugin_fn]
pub fn markers() -> FnResult<String> {
    let p = input()?;
    let active = p["project"]["active_sequence"].as_str().unwrap_or("").to_string();
    let seq = p["project"]["sequences"].as_array().and_then(|s| s.iter().find(|s| s["id"] == active.as_str())).cloned().unwrap_or(Value::Null);
    let mut end = 0.0_f64;
    for t in seq["tracks"].as_array().cloned().unwrap_or_default() {
        for c in t["clips"].as_array().cloned().unwrap_or_default() {
            end = end.max(secs(&c["start"]) + secs(&c["duration"]));
        }
    }
    let mut cmds = vec![];
    let mut at = 10;
    while (at as f64) < end {
        cmds.push(json!({ "type": "add_marker", "time": at.to_string(), "name": format!("{at} s"), "color": null, "note": null }));
        at += 10;
    }
    let n = cmds.len();
    answer(cmds, vec![format!("{n} markers")])
}

/// Opacity 0.5 on the selected clip.
#[plugin_fn]
pub fn half_opacity() -> FnResult<String> {
    let p = input()?;
    let sel = p["selected"].as_str().unwrap_or("");
    if sel.is_empty() {
        return Err(Error::msg("select a clip first").into());
    }
    answer(vec![json!({ "type": "set_clip_opacity", "clip": sel, "opacity": 0.5 })], vec![])
}

#[plugin_fn]
pub fn try_import() -> FnResult<String> {
    let asset = json!({ "id": "x", "name": "x", "path": "/etc/passwd", "fingerprint": null,
        "info": { "container": "", "duration": "1", "bit_rate": null, "size_bytes": null, "video": [], "audio": [], "tags": [], "still": false } });
    answer(vec![json!({ "type": "import_media", "asset": asset })], vec![])
}

#[plugin_fn]
pub fn try_analysis() -> FnResult<String> {
    answer(vec![json!({ "type": "animate_from_audio", "clip": "x", "param": "opacity", "low": 0.0, "high": 1.0 })], vec![])
}

#[plugin_fn]
pub fn half_bad() -> FnResult<String> {
    answer(vec![json!({ "type": "add_marker", "time": "3", "name": "kept?", "color": null, "note": null }), json!({ "type": "remove_marker", "marker": "does-not-exist" })], vec![])
}

#[plugin_fn]
pub fn garbage() -> FnResult<String> {
    Ok("this is not json".to_string())
}

#[plugin_fn]
pub fn spin() -> FnResult<String> {
    let mut x: u64 = 0;
    loop {
        x = x.wrapping_add(1);
        std::hint::black_box(x);
    }
}

#[plugin_fn]
pub fn hog() -> FnResult<String> {
    // 256 MiB: beyond the host's memory cap
    let mut big: Vec<u8> = Vec::new();
    big.resize(256 * 1024 * 1024, 7);
    Ok(format!("{}", big.iter().map(|b| *b as u64).sum::<u64>()))
}

/// GET the address passed as the selection and put a marker at the number of seconds it answers with.
#[plugin_fn]
pub fn fetch_marker() -> FnResult<String> {
    let p = input()?;
    let url = p["selected"].as_str().unwrap_or("").to_string();
    let res = http::request::<()>(&HttpRequest::new(url), None)?;
    let body = String::from_utf8_lossy(&res.body()).trim().to_string();
    let t: f64 = body.parse().map_err(|_| Error::msg(format!("the answer was not a number: {body}")))?;
    answer(vec![json!({ "type": "add_marker", "time": format!("{}/100", (t * 100.0).round() as i64), "name": "from the web", "color": null, "note": null })], vec![format!("status {}", res.status_code())])
}

/// A marker at 1 s named by the plugin's own config.
#[plugin_fn]
pub fn config_marker() -> FnResult<String> {
    let label = config::get("label")?.unwrap_or_else(|| "no label".to_string());
    answer(vec![json!({ "type": "add_marker", "time": "1", "name": label, "color": null, "note": null })], vec![])
}
