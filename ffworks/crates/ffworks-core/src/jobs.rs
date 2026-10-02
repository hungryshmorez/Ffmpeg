//! Job execution: runs an `FfmpegJob` on a worker thread with real progress, cancellation and a full log
//! (spec §60, §97, §99, §181). Progress comes only from FFmpeg's `-progress` stream; if it is absent the UI shows indeterminate.

use crate::error::{Error, Result};
use crate::ffmpeg::FfmpegJob;
use crate::process::{explain_failure, suppress_console_window, Tools};
use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Rendering { fraction: Option<f64>, fps: Option<f64>, elapsed_secs: f64, eta_secs: Option<f64> },
    Completed,
    Failed { message: String },
    Canceled,
}

/// Everything recorded for one FFmpeg run (spec §97).
#[derive(Clone, Debug, Serialize)]
pub struct JobLog {
    pub job_id: String,
    pub executable: String,
    pub args: Vec<String>,
    pub started_unix: u64,
    pub ended_unix: Option<u64>,
    pub exit_code: Option<i32>,
    pub stderr: String,
    pub operation: String,
}

#[derive(Clone)]
pub struct CancelToken(Arc<AtomicBool>);
impl CancelToken {
    pub fn new() -> Self {
        CancelToken(Arc::new(AtomicBool::new(false)))
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_canceled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}
impl Default for CancelToken {
    fn default() -> Self {
        Self::new()
    }
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Run a job to completion on the *calling* thread (callers put this on a worker). Returns the log.
/// `on_state` receives progress updates.
pub fn run_job(
    tools: &Tools,
    job: &FfmpegJob,
    job_id: &str,
    operation: &str,
    cancel: &CancelToken,
    temp_dir: &std::path::Path,
    on_state: &mut dyn FnMut(JobState),
) -> Result<JobLog> {
    let (result, log) = run_job_logged(tools, job, job_id, operation, cancel, temp_dir, on_state);
    result.map(|()| log.expect("log exists after a successful run"))
}

/// Like [`run_job`], but always returns the log when FFmpeg was started, including for failed and canceled runs.
pub fn run_job_logged(
    tools: &Tools,
    job: &FfmpegJob,
    job_id: &str,
    operation: &str,
    cancel: &CancelToken,
    temp_dir: &std::path::Path,
    on_state: &mut dyn FnMut(JobState),
) -> (Result<()>, Option<JobLog>) {
    run_inner(tools, job, job_id, operation, cancel, temp_dir, on_state)
}

fn run_inner(
    tools: &Tools,
    job: &FfmpegJob,
    job_id: &str,
    operation: &str,
    cancel: &CancelToken,
    temp_dir: &std::path::Path,
    on_state: &mut dyn FnMut(JobState),
) -> (Result<()>, Option<JobLog>) {
    macro_rules! tri {
        ($e:expr) => {
            match $e {
                Ok(v) => v,
                Err(e) => return (Err(e), None),
            }
        };
    }
    tri!(std::fs::create_dir_all(temp_dir).map_err(|e| Error::io(temp_dir, e)));
    // Write the filter graph to a managed temp file (never to a shell). Removed afterwards.
    let script: PathBuf = temp_dir.join(format!("{job_id}.filtergraph"));
    tri!(std::fs::write(&script, &job.filter_graph).map_err(|e| Error::io(&script, e)));
    let args = job.argv(Some(&script));

    // Render to a partial file and rename on success, so a failed/canceled export never leaves a
    // truncated file at the destination and never clobbers a good one.
    let final_out = job.output.clone();
    let partial = partial_path(&final_out);
    let mut args = args;
    if let Some(last) = args.last_mut() {
        *last = partial.to_string_lossy().into_owned();
    }

    let mut log = JobLog {
        job_id: job_id.into(),
        executable: tools.ffmpeg.to_string_lossy().into_owned(),
        args: args.clone(),
        started_unix: unix_now(),
        ended_unix: None,
        exit_code: None,
        stderr: String::new(),
        operation: operation.into(),
    };

    on_state(JobState::Queued);
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    suppress_console_window(&mut cmd);
    let mut child = tri!(cmd.spawn().map_err(|e| Error::ToolUnavailable { tool: tools.ffmpeg.display().to_string(), reason: e.to_string() }));

    // Drain stderr on its own thread so a full pipe can never stall FFmpeg.
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    let err_thread = {
        let mut err = child.stderr.take().expect("piped");
        let buf = Arc::clone(&stderr_buf);
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            while let Ok(n) = err.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let mut b = buf.lock().unwrap();
                b.push_str(&String::from_utf8_lossy(&chunk[..n]));
                if b.len() > 256 * 1024 {
                    let cut = b.len() - 128 * 1024;
                    let cut = (cut..b.len()).find(|i| b.is_char_boundary(*i)).unwrap_or(b.len());
                    b.drain(..cut);
                }
            }
        })
    };

    // Watchdog: kills the child promptly on cancel even while it is silent.
    let child_id = child.id();
    let done = Arc::new(AtomicBool::new(false));
    let watchdog = {
        let (cancel, done) = (cancel.clone(), Arc::clone(&done));
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                if cancel.is_canceled() {
                    kill_pid(child_id);
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        })
    };

    let started = Instant::now();
    let total = job.total_duration.as_f64();
    let stdout = child.stdout.take().expect("piped");
    let mut last_fps: Option<f64> = None;
    for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
        if let Some((k, v)) = line.split_once('=') {
            match k {
                "fps" => last_fps = v.trim().parse().ok().filter(|f: &f64| *f > 0.0),
                "out_time_us" | "out_time_ms" => {
                    // Both keys are microseconds in practice (out_time_ms is a long-standing FFmpeg misnomer).
                    if let Ok(us) = v.trim().parse::<i64>() {
                        if us >= 0 && total > 0.0 {
                            let done_secs = us as f64 / 1_000_000.0;
                            let frac = (done_secs / total).clamp(0.0, 1.0);
                            let elapsed = started.elapsed().as_secs_f64();
                            let eta = if frac > 0.01 { Some(elapsed * (1.0 - frac) / frac) } else { None };
                            on_state(JobState::Rendering { fraction: Some(frac), fps: last_fps, elapsed_secs: elapsed, eta_secs: eta });
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let status = tri!(child.wait().map_err(|e| Error::ToolUnavailable { tool: "ffmpeg".into(), reason: e.to_string() }));
    done.store(true, Ordering::SeqCst);
    let _ = watchdog.join();
    let _ = err_thread.join();
    let _ = std::fs::remove_file(&script);

    log.ended_unix = Some(unix_now());
    log.exit_code = status.code();
    log.stderr = stderr_buf.lock().unwrap().clone();

    if cancel.is_canceled() {
        let _ = std::fs::remove_file(&partial);
        on_state(JobState::Canceled);
        return (Err(Error::Canceled), Some(log));
    }
    if !status.success() {
        let _ = std::fs::remove_file(&partial);
        let msg = explain_failure(&log.stderr);
        on_state(JobState::Failed { message: msg.clone() });
        return (Err(Error::ToolFailed { tool: "ffmpeg".into(), code: status.code(), hint: msg }), Some(log));
    }
    if let Err(e) = std::fs::rename(&partial, &final_out).map_err(|e| Error::io(&final_out, e)) {
        on_state(JobState::Failed { message: e.to_string() });
        return (Err(e), Some(log));
    }
    on_state(JobState::Completed);
    (Ok(()), Some(log))
}

fn partial_path(out: &std::path::Path) -> PathBuf {
    // Keep the real extension last so FFmpeg still infers the muxer from it.
    let stem = out.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "out".into());
    let ext = out.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
    out.with_file_name(format!("{stem}.ffworks-partial.{ext}"))
}

fn kill_pid(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).status();
    }
    #[cfg(windows)]
    {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]);
        suppress_console_window(&mut c);
        let _ = c.status();
    }
}

