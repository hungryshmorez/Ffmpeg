//! Local API: the same command bus the editor uses, over HTTP on this machine, so other programs (a stream deck, a build
//! script, a Python notebook) can edit the open project.
//!
//! Safety, because a web page in the user's browser can also reach `127.0.0.1`:
//! * it listens on the loopback address only, and is off unless the user turns it on;
//! * every request needs `Authorization: Bearer <token>` (a random secret shown to the user, compared in constant time);
//! * requests carrying an `Origin` header (that is, from a web page) are refused, and so is a `Host` that is not this
//!   server's own loopback address (DNS rebinding);
//! * bodies are limited to 1 MiB; scripts run in the same sandbox as everywhere else (no files, network or programs) and
//!   cannot analyse media unless the caller asks and the server was started with analysis allowed.
//!
//! Endpoints (JSON in, JSON out; errors are `{"error": "..."}` with a 4xx status):
//!   GET  /v1/status    version, project name, shown sequence, length, undo/redo labels
//!   GET  /v1/project   the whole project model
//!   POST /v1/command   one command (the same JSON the command lists and macros use)
//!   POST /v1/commands  a list of commands, applied as one undo step, all or nothing
//!   POST /v1/script    {"source": "...", "selected": "<clip id>"}: a Rhai script, one undo step
//!   POST /v1/undo, /v1/redo, /v1/save

use crate::commands::Command;
use crate::engine::Engine;
use crate::error::{Error, Result};
use serde_json::{json, Value};
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tiny_http::{Header, Method, Request, Response, Server};

/// Largest request body accepted.
pub const MAX_BODY: usize = 1 << 20;

/// What the server may do beyond editing.
#[derive(Clone, Copy, Debug, Default)]
pub struct Allow {
    /// Let scripts and commands analyse the project's audio with FFmpeg (follow audio / beats).
    pub analysis: bool,
}

/// Called after every successful change, so a GUI can refresh.
pub type OnChange = Arc<dyn Fn() + Send + Sync>;

/// A running server. Dropping it stops it.
pub struct ApiServer {
    addr: SocketAddr,
    token: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl ApiServer {
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }
    pub fn token(&self) -> &str {
        &self.token
    }
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }
    /// Stop listening and wait until the port is really closed (tiny_http releases its socket on a thread of its own, a moment
    /// after the server is dropped, so the port can briefly still accept connections).
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
            for _ in 0..100 {
                if std::net::TcpStream::connect_timeout(&self.addr, std::time::Duration::from_millis(50)).is_err() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }
}

impl Drop for ApiServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// A fresh random secret (128 bits, hex).
pub fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Start the server on `127.0.0.1:port` (0 picks a free port). `token` is the secret callers must present.
pub fn serve(engine: Arc<Mutex<Engine>>, port: u16, token: String, allow: Allow, on_change: Option<OnChange>) -> Result<ApiServer> {
    if token.len() < 16 {
        return Err(Error::validation("the API token must be at least 16 characters"));
    }
    let server = Server::http(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)).map_err(|e| Error::validation(format!("cannot listen on 127.0.0.1:{port}: {e}")))?;
    let addr = server.server_addr().to_ip().ok_or_else(|| Error::validation("the API server has no address"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let thread = {
        let (stop, token) = (Arc::clone(&stop), token.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match server.recv_timeout(std::time::Duration::from_millis(100)) {
                    Ok(Some(mut req)) => {
                        let (method, url, headers) = (req.method().clone(), req.url().to_string(), headers_of(&req));
                        let body = body_reader(req.as_reader());
                        let (status, body) = handle(&engine, &token, addr, allow, on_change.as_ref(), method, url, headers, &body);
                        reply(req, status, &body);
                    }
                    Ok(None) => {}
                    Err(_) => break,
                }
            }
        })
    };
    Ok(ApiServer { addr, token, stop, thread: Some(thread) })
}

fn headers_of(req: &Request) -> Vec<(String, String)> {
    req.headers().iter().map(|h| (h.field.as_str().as_str().to_ascii_lowercase(), h.value.as_str().to_string())).collect()
}

/// Reads at most [`MAX_BODY`] + 1 bytes, so an oversized body is noticed without being stored.
fn body_reader(r: &mut dyn Read) -> Vec<u8> {
    let mut buf = vec![];
    let _ = r.take(MAX_BODY as u64 + 1).read_to_end(&mut buf);
    buf
}

fn reply(req: Request, status: u16, body: &Value) {
    let json = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).expect("static header");
    let no_store = Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).expect("static header");
    let _ = req.respond(Response::from_string(body.to_string()).with_status_code(status).with_header(json).with_header(no_store));
}

fn err(status: u16, msg: impl std::fmt::Display) -> (u16, Value) {
    (status, json!({ "error": msg.to_string() }))
}

/// Equal-length comparison that does not stop at the first difference.
fn same_secret(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = (a.len() != b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        diff |= a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0);
    }
    diff == 0
}

/// One request → (status, JSON). Separate from the socket so it is easy to test and reason about.
#[allow(clippy::too_many_arguments)]
fn handle(engine: &Arc<Mutex<Engine>>, token: &str, addr: SocketAddr, allow: Allow, on_change: Option<&OnChange>, method: Method, url: String, headers: Vec<(String, String)>, body: &[u8]) -> (u16, Value) {
    let header = |name: &str| headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
    // a web page can send requests to 127.0.0.1: pages always say where they come from, programs do not
    if header("origin").is_some() {
        return err(403, "requests from web pages are not allowed");
    }
    let host_ok = header("host").is_some_and(|h| {
        let h = h.to_ascii_lowercase();
        h == format!("127.0.0.1:{}", addr.port()) || h == format!("localhost:{}", addr.port())
    });
    if !host_ok {
        return err(403, "the Host header must be this server's own address");
    }
    let presented = header("authorization").and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("");
    if !same_secret(presented, token) {
        return err(401, "missing or wrong token: send `Authorization: Bearer <token>`");
    }
    if body.len() > MAX_BODY {
        return err(413, format!("the request body is over {MAX_BODY} bytes"));
    }
    let path = url.split('?').next().unwrap_or("");
    let parse = |body: &[u8]| -> std::result::Result<Value, (u16, Value)> { serde_json::from_slice(body).map_err(|e| err(400, format!("the body is not valid JSON: {e}"))) };
    let mut changed = false;
    let result = match (&method, path) {
        (Method::Get, "/v1/status") => {
            let e = engine.lock().unwrap();
            let seq = e.project.active().ok();
            (200, json!({ "version": env!("CARGO_PKG_VERSION"), "project": e.project.name, "sequence": seq.map(|s| s.name.clone()), "duration": seq.map(|s| s.duration().as_f64()), "undo": e.undo_label(), "redo": e.redo_label() }))
        }
        (Method::Get, "/v1/project") => {
            let e = engine.lock().unwrap();
            (200, serde_json::to_value(&e.project).unwrap_or(Value::Null))
        }
        (Method::Post, "/v1/command") => match parse(body).and_then(|v| serde_json::from_value::<Command>(v).map_err(|e| err(400, format!("not a valid command: {e}")))) {
            Ok(cmd) => match refuse(&cmd, allow) {
                Some(why) => err(403, why),
                None => run(engine, &mut changed, |e| e.dispatch(cmd)),
            },
            Err(e) => e,
        },
        (Method::Post, "/v1/commands") => match parse(body).and_then(|v| serde_json::from_value::<Vec<Command>>(v).map_err(|e| err(400, format!("not a list of valid commands: {e}")))) {
            Ok(cmds) if cmds.is_empty() => err(400, "the list of commands is empty"),
            Ok(cmds) => match cmds.iter().find_map(|c| refuse(c, allow)) {
                Some(why) => err(403, why),
                None => {
                    let n = cmds.len();
                    run(engine, &mut changed, |e| e.dispatch(Command::Batch { label: format!("API ({n} commands)"), commands: cmds }))
                }
            },
            Err(e) => e,
        },
        (Method::Post, "/v1/script") => match parse(body) {
            Ok(v) => {
                let Some(source) = v.get("source").and_then(Value::as_str) else { return err(400, "the body needs a \"source\" string") };
                let selected = v.get("selected").and_then(Value::as_str);
                let perms = crate::script::Permissions { edit: true, analysis: allow.analysis };
                let mut e = engine.lock().unwrap();
                match crate::script::run(&mut e, source, selected, perms, "API script") {
                    Ok(r) => {
                        changed = r.commands > 0;
                        (200, json!({ "ok": true, "log": r.log, "commands": r.commands }))
                    }
                    Err(x) => err(400, x),
                }
            }
            Err(e) => e,
        },
        (Method::Post, "/v1/undo") => run(engine, &mut changed, |e| e.undo()),
        (Method::Post, "/v1/redo") => run(engine, &mut changed, |e| e.redo()),
        (Method::Post, "/v1/save") => {
            let mut e = engine.lock().unwrap();
            match e.path().map(|p| p.to_path_buf()) {
                Some(p) => match e.save(&p) {
                    Ok(()) => (200, json!({ "ok": true, "path": p.to_string_lossy() })),
                    Err(x) => err(400, x),
                },
                None => err(400, "this project has not been saved yet; save it once from the editor"),
            }
        }
        (_, "/v1/status" | "/v1/project" | "/v1/command" | "/v1/commands" | "/v1/script" | "/v1/undo" | "/v1/redo" | "/v1/save") => err(405, "wrong method for this path"),
        _ => err(404, "no such path (see GET /v1/status)"),
    };
    if changed && result.0 == 200 {
        if let Some(f) = on_change {
            f();
        }
    }
    result
}

/// Why a command may not come through the API (they read files or run analyses the caller has not been allowed).
fn refuse(cmd: &Command, allow: Allow) -> Option<String> {
    match cmd {
        Command::ImportMedia { .. } | Command::RelinkMedia { .. } | Command::AnimateFromMidi { .. } => Some("import_media / relink_media / animate_from_midi read files from disk and are not available through the API".into()),
        Command::AnimateFromAudio { .. } | Command::AnimateFromBeats { .. } if !allow.analysis => Some("this command analyses the project's audio; start the API with analysis allowed".into()),
        Command::Batch { commands, .. } => commands.iter().find_map(|c| refuse(c, allow)),
        _ => None,
    }
}

fn run(engine: &Arc<Mutex<Engine>>, changed: &mut bool, f: impl FnOnce(&mut Engine) -> Result<()>) -> (u16, Value) {
    let mut e = engine.lock().unwrap();
    match f(&mut e) {
        Ok(()) => {
            *changed = true;
            (200, json!({ "ok": true, "undo": e.undo_label(), "redo": e.redo_label() }))
        }
        Err(x) => err(400, x),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_compare_without_stopping_at_the_first_difference() {
        assert!(same_secret("abcd", "abcd"));
        assert!(!same_secret("abcd", "abce"));
        assert!(!same_secret("abcd", "abc"));
        assert!(!same_secret("", "abc"));
        assert!(same_secret("", ""));
    }

    #[test]
    fn imports_and_unallowed_analysis_are_refused_even_inside_a_batch() {
        let allow = Allow::default();
        let analyse = Command::AnimateFromAudio { clip: "c".into(), param: "opacity".into(), source: None, low: 0.0, high: 1.0, smooth: 0.0, band: None };
        assert!(refuse(&analyse, allow).is_some());
        assert!(refuse(&analyse, Allow { analysis: true }).is_none());
        assert!(refuse(&Command::Batch { label: "x".into(), commands: vec![analyse] }, allow).is_some());
        assert!(refuse(&Command::RenameProject { name: "n".into() }, allow).is_none());
    }
}
