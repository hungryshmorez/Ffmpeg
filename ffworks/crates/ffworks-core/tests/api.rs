//! The local API: real HTTP over loopback against an in-process server, with the safety rules checked one by one.
use ffworks_core::api::{new_token, serve, Allow, ApiServer};
use ffworks_core::engine::Engine;
use ffworks_core::process::Tools;
use ffworks_core::project::ProjectSettings;
use ffworks_core::Rational;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

struct Rig {
    engine: Arc<Mutex<Engine>>,
    server: ApiServer,
    changes: Arc<AtomicUsize>,
}

fn rig_with(allow: Allow) -> Rig {
    let eng = Engine::new("api", ProjectSettings { width: 320, height: 240, fps: Rational::from_int(25), sample_rate: 48000 }, Tools::discover(None, None));
    let engine = Arc::new(Mutex::new(eng));
    let changes = Arc::new(AtomicUsize::new(0));
    let c = Arc::clone(&changes);
    let server = serve(Arc::clone(&engine), 0, new_token(), allow, Some(Arc::new(move || { c.fetch_add(1, Ordering::SeqCst); }))).unwrap();
    Rig { engine, server, changes }
}
fn rig() -> Rig {
    rig_with(Allow::default())
}

/// One raw HTTP/1.1 request; returns (status, JSON body).
fn call(r: &Rig, method: &str, path: &str, body: Option<&str>, extra: &[(&str, &str)], token: Option<&str>, host: Option<&str>) -> (u16, Value) {
    let mut s = TcpStream::connect(r.server.addr()).unwrap();
    let host = host.map(String::from).unwrap_or_else(|| r.server.addr().to_string());
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    if let Some(t) = token {
        req += &format!("Authorization: Bearer {t}\r\n");
    }
    for (k, v) in extra {
        req += &format!("{k}: {v}\r\n");
    }
    let body = body.unwrap_or("");
    req += &format!("Content-Length: {}\r\n\r\n{body}", body.len());
    s.write_all(req.as_bytes()).unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    let status: u16 = out.split_whitespace().nth(1).unwrap().parse().unwrap();
    let json = out.split("\r\n\r\n").nth(1).map(|b| serde_json::from_str(b).unwrap_or(Value::Null)).unwrap_or(Value::Null);
    (status, json)
}
fn ok(r: &Rig, method: &str, path: &str, body: Option<&str>) -> (u16, Value) {
    call(r, method, path, body, &[], Some(r.server.token()), None)
}

fn first_track(r: &Rig) -> String {
    r.engine.lock().unwrap().project.active().unwrap().tracks[0].id.clone()
}

#[test]
fn it_listens_on_loopback_only() {
    let r = rig();
    assert!(r.server.addr().ip().is_loopback());
    assert!(r.server.url().starts_with("http://127.0.0.1:"));
}

#[test]
fn every_request_needs_the_token() {
    let r = rig();
    assert_eq!(call(&r, "GET", "/v1/status", None, &[], None, None).0, 401, "no token");
    assert_eq!(call(&r, "GET", "/v1/status", None, &[], Some("wrong-wrong-wrong-wrong"), None).0, 401, "wrong token");
    let (s, v) = ok(&r, "GET", "/v1/status", None);
    assert_eq!(s, 200);
    assert_eq!(v["project"], "api");
}

#[test]
fn web_pages_and_rebinding_hosts_are_refused_even_with_the_token() {
    let r = rig();
    let t = Some(r.server.token());
    assert_eq!(call(&r, "GET", "/v1/status", None, &[("Origin", "https://evil.example")], t, None).0, 403, "a web page");
    assert_eq!(call(&r, "GET", "/v1/status", None, &[], t, Some("evil.example")).0, 403, "a rebound host name");
    assert_eq!(call(&r, "GET", "/v1/status", None, &[], t, Some(&format!("localhost:{}", r.server.addr().port()))).0, 200, "localhost is fine");
}

#[test]
fn a_command_edits_the_project_and_the_editor_is_told() {
    let r = rig();
    let track = first_track(&r);
    let cmd = json!({ "type": "add_solid", "track": track, "start": "0", "duration": "2", "color": "#ff0000" }).to_string();
    let (s, v) = ok(&r, "POST", "/v1/command", Some(&cmd));
    assert_eq!((s, &v["ok"]), (200, &json!(true)), "{v}");
    assert_eq!(v["undo"], "Add solid colour");
    assert_eq!(r.engine.lock().unwrap().project.active().unwrap().tracks[0].clips.len(), 1);
    assert_eq!(r.changes.load(Ordering::SeqCst), 1);
    let (_, p) = ok(&r, "GET", "/v1/project", None);
    assert_eq!(p["sequences"][0]["tracks"][0]["clips"].as_array().unwrap().len(), 1, "the project endpoint shows it");
    // a failing read does not count as a change
    ok(&r, "GET", "/v1/status", None);
    assert_eq!(r.changes.load(Ordering::SeqCst), 1);
}

#[test]
fn undo_and_redo_work_and_errors_explain_themselves() {
    let r = rig();
    let track = first_track(&r);
    ok(&r, "POST", "/v1/command", Some(&json!({ "type": "add_solid", "track": track, "start": "0", "duration": "2", "color": "#00ff00" }).to_string()));
    assert_eq!(ok(&r, "POST", "/v1/undo", None).0, 200);
    assert!(r.engine.lock().unwrap().project.active().unwrap().tracks[0].clips.is_empty());
    assert_eq!(ok(&r, "POST", "/v1/redo", None).0, 200);
    assert_eq!(r.engine.lock().unwrap().project.active().unwrap().tracks[0].clips.len(), 1);
    let (s, v) = ok(&r, "POST", "/v1/command", Some(r#"{"type":"teleport"}"#));
    assert_eq!(s, 400);
    assert!(v["error"].as_str().unwrap().contains("not a valid command"), "{v}");
    let (s, v) = ok(&r, "POST", "/v1/command", Some("{not json"));
    assert_eq!(s, 400);
    assert!(v["error"].as_str().unwrap().contains("JSON"), "{v}");
    let (s, v) = ok(&r, "POST", "/v1/command", Some(&json!({ "type": "add_solid", "track": "nope", "start": "0", "duration": "2", "color": "#00ff00" }).to_string()));
    assert_eq!(s, 400, "{v}");
}

#[test]
fn a_list_of_commands_is_one_undo_step_and_all_or_nothing() {
    let r = rig();
    let track = first_track(&r);
    let good = |c: &str| json!({ "type": "add_solid", "track": track, "start": "0", "duration": "2", "color": c });
    let two = json!([good("#ff0000"), { "type": "add_marker", "time": "1", "name": "m" }]).to_string();
    assert_eq!(ok(&r, "POST", "/v1/commands", Some(&two)).0, 200);
    assert_eq!(r.engine.lock().unwrap().history().len(), 1, "one undo step");
    let before = serde_json::to_string(&r.engine.lock().unwrap().project).unwrap();
    // the second solid overlaps the first, so the whole list fails and the marker is not kept either
    let bad = json!([{ "type": "add_marker", "time": "2", "name": "late" }, good("#0000ff")]).to_string();
    let (s, _) = ok(&r, "POST", "/v1/commands", Some(&bad));
    assert_eq!(s, 400);
    assert_eq!(serde_json::to_string(&r.engine.lock().unwrap().project).unwrap(), before);
    assert_eq!(ok(&r, "POST", "/v1/commands", Some("[]")).0, 400);
}

#[test]
fn scripts_run_in_the_sandbox_and_analysis_needs_permission() {
    let r = rig();
    let (s, v) = ok(&r, "POST", "/v1/script", Some(&json!({ "source": "let t = add_track(\"video\"); add_solid(t, 0, 1, \"#ff00ff\"); print(\"made \" + clips().len());" }).to_string()));
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["log"], json!(["made 1"]));
    assert_eq!(v["commands"], 2);
    let (s, v) = ok(&r, "POST", "/v1/script", Some(&json!({ "source": "let f = read_file(\"/etc/passwd\");" }).to_string()));
    assert_eq!(s, 400, "{v}");
    assert_eq!(ok(&r, "POST", "/v1/script", Some("{}")).0, 400);
    let clip = r.engine.lock().unwrap().project.active().unwrap().tracks.iter().flat_map(|t| t.clips.iter()).next().unwrap().id.clone();
    let analyse = json!({ "type": "animate_from_audio", "clip": clip, "param": "opacity", "low": 0.0, "high": 1.0 }).to_string();
    assert_eq!(ok(&r, "POST", "/v1/command", Some(&analyse)).0, 403, "analysis was not allowed");
    let asset = json!({ "type": "import_media", "asset": {} }).to_string();
    assert!(ok(&r, "POST", "/v1/command", Some(&asset)).0 >= 400);
}

#[test]
fn other_paths_methods_and_oversized_bodies_are_refused() {
    let r = rig();
    assert_eq!(ok(&r, "GET", "/v2/status", None).0, 404);
    assert_eq!(ok(&r, "GET", "/v1/command", None).0, 405);
    assert_eq!(ok(&r, "POST", "/v1/status", None).0, 405);
    let big = format!("{{\"source\": \"{}\"}}", "a".repeat(ffworks_core::api::MAX_BODY + 10));
    assert_eq!(ok(&r, "POST", "/v1/script", Some(&big)).0, 413);
    assert_eq!(ok(&r, "POST", "/v1/save", None).0, 400, "an unsaved project cannot be saved from here");
}

#[test]
fn stopping_closes_the_port() {
    let mut r = rig();
    let addr = r.server.addr();
    r.server.stop();
    assert!(TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)).is_err());
}

#[test]
fn a_short_token_is_refused() {
    let eng = Engine::new("x", ProjectSettings::default(), Tools::discover(None, None));
    assert!(serve(Arc::new(Mutex::new(eng)), 0, "short".into(), Allow::default(), None).is_err());
}
