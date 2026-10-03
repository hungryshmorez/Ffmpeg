//! Background job queue (spec §60, §104). Jobs wait in priority order (higher first, FIFO within a priority), run on worker
//! threads with a concurrency limit, can be canceled while queued or running, and keep their full FFmpeg log whether they
//! succeed, fail or are canceled. Nothing here touches the UI; a listener callback reports every state change.

use crate::error::{Error, Result};
use crate::ffmpeg::FfmpegJob;
use crate::jobs::{run_job_logged, CancelToken, JobLog, JobState};
use crate::process::Tools;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const PRIORITY_BACKGROUND: i32 = 0;
pub const PRIORITY_EXPORT: i32 = 10;

/// An export that had not finished when the journal was last written (the app closed or crashed). It can be queued again.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedJob {
    pub operation: String,
    pub priority: i32,
    pub enqueued_unix: u64,
    /// True when it was rendering (not just waiting) at the time; it starts again from the beginning.
    pub was_running: bool,
    pub job: FfmpegJob,
}

/// Unfinished jobs recorded in `path` by an earlier session (empty when there is none or it is unreadable).
pub fn read_journal(path: &std::path::Path) -> Vec<SavedJob> {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub job_id: String,
    pub operation: String,
    pub output: String,
    pub priority: i32,
    #[serde(flatten)]
    pub state: JobState,
    pub enqueued_unix: u64,
}

struct Record {
    snap: JobSnapshot,
    /// The FFmpeg job to run; None for a task (see [`JobQueue::run_task`]), which runs on its own thread.
    job: Option<FfmpegJob>,
    cancel: CancelToken,
    log: Option<JobLog>,
    seq: u64,
}

struct Inner {
    jobs: Vec<Record>,
    next_seq: u64,
    shutdown: bool,
}

type Listener = Box<dyn Fn(&JobSnapshot) + Send + Sync>;

struct Shared {
    inner: Mutex<Inner>,
    cv: Condvar,
    listener: Mutex<Option<Listener>>,
    tools: Mutex<Tools>,
    temp_dir: PathBuf,
    /// Where unfinished jobs of the journalled operations are recorded after every change.
    journal: Mutex<Option<(PathBuf, Vec<String>)>>,
}

#[derive(Clone)]
pub struct JobQueue {
    shared: Arc<Shared>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl JobQueue {
    /// `workers` is the concurrency limit (renders are CPU/GPU heavy; 1 is the sensible default).
    pub fn new(tools: Tools, temp_dir: PathBuf, workers: usize) -> JobQueue {
        let shared = Arc::new(Shared { inner: Mutex::new(Inner { jobs: vec![], next_seq: 0, shutdown: false }), cv: Condvar::new(), listener: Mutex::new(None), tools: Mutex::new(tools), temp_dir, journal: Mutex::new(None) });
        for _ in 0..workers.max(1) {
            let s = Arc::clone(&shared);
            std::thread::spawn(move || worker(s));
        }
        JobQueue { shared }
    }

    pub fn set_listener(&self, f: impl Fn(&JobSnapshot) + Send + Sync + 'static) {
        *self.shared.listener.lock().unwrap() = Some(Box::new(f));
    }

    /// Record unfinished jobs whose operation is in `operations` (e.g. `["export"]`) in `path` after every change, so they
    /// can be offered again after a crash or close. Read an earlier journal with [`read_journal`] before calling this.
    pub fn set_journal(&self, path: PathBuf, operations: &[&str]) {
        *self.shared.journal.lock().unwrap() = Some((path, operations.iter().map(|s| s.to_string()).collect()));
        write_journal(&self.shared);
    }

    /// Use new tool paths for jobs that have not started yet.
    pub fn set_tools(&self, tools: Tools) {
        *self.shared.tools.lock().unwrap() = tools;
    }

    pub fn submit(&self, job: FfmpegJob, operation: &str, priority: i32) -> String {
        let mut g = self.shared.inner.lock().unwrap();
        let seq = g.next_seq;
        g.next_seq += 1;
        let id = format!("job_{}_{seq}", now());
        let snap = JobSnapshot { job_id: id.clone(), operation: operation.into(), output: job.output.to_string_lossy().into_owned(), priority, state: JobState::Queued, enqueued_unix: now() };
        g.jobs.push(Record { snap: snap.clone(), job: Some(job), cancel: CancelToken::new(), log: None, seq });
        write_journal_locked(&self.shared, &g);
        drop(g);
        notify(&self.shared, &snap);
        self.shared.cv.notify_one();
        id
    }

    /// Run `work` on its own thread beside the render workers and list it in the queue (so it shows progress and can be
    /// canceled like any job). For things the user waits on: previews and analyses must not sit behind a long export, so they do
    /// not take a worker slot. `work` gets the cancel switch and a progress callback; its result comes back on the receiver
    /// *after* the job's final state is visible in [`snapshot`](Self::snapshot). Tasks are never journalled.
    pub fn run_task<T: Send + 'static>(&self, operation: &str, label: &str, work: impl FnOnce(&CancelToken, &mut dyn FnMut(JobState)) -> Result<T> + Send + 'static) -> (String, std::sync::mpsc::Receiver<Result<T>>) {
        let started = std::time::Instant::now();
        let (id, cancel, snap) = {
            let mut g = self.shared.inner.lock().unwrap();
            let seq = g.next_seq;
            g.next_seq += 1;
            let id = format!("job_{}_{seq}", now());
            let state = JobState::Rendering { fraction: None, fps: None, elapsed_secs: 0.0, eta_secs: None };
            let snap = JobSnapshot { job_id: id.clone(), operation: operation.into(), output: label.into(), priority: PRIORITY_EXPORT, state, enqueued_unix: now() };
            let cancel = CancelToken::new();
            g.jobs.push(Record { snap: snap.clone(), job: None, cancel: cancel.clone(), log: None, seq });
            (id, cancel, snap)
        };
        notify(&self.shared, &snap);
        let (tx, rx) = std::sync::mpsc::channel();
        let s = Arc::clone(&self.shared);
        let task_id = id.clone();
        std::thread::spawn(move || {
            let set = |state: JobState| -> Option<JobSnapshot> {
                let mut g = s.inner.lock().unwrap();
                let r = g.jobs.iter_mut().find(|r| r.snap.job_id == task_id)?;
                r.snap.state = state;
                Some(r.snap.clone())
            };
            let result = {
                let mut progress = |st: JobState| {
                    if let JobState::Rendering { fraction, fps, .. } = st {
                        let elapsed = started.elapsed().as_secs_f64();
                        let eta = fraction.filter(|f| *f > 0.01 && *f < 1.0).map(|f| elapsed * (1.0 - f) / f);
                        if let Some(snap) = set(JobState::Rendering { fraction, fps, elapsed_secs: elapsed, eta_secs: eta }) {
                            notify(&s, &snap);
                        }
                    }
                };
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(&cancel, &mut progress))).unwrap_or_else(|_| Err(Error::validation("the task stopped unexpectedly")))
            };
            let state = match &result {
                Ok(_) => JobState::Completed,
                Err(Error::Canceled) => JobState::Canceled,
                Err(e) => JobState::Failed { message: e.to_string() },
            };
            if let Some(snap) = set(state) {
                notify(&s, &snap);
            }
            let _ = tx.send(result);
        });
        (id, rx)
    }

    /// Cancel a queued job (it never runs) or a running one (FFmpeg is killed, no output is written). Returns false for unknown/finished jobs.
    pub fn cancel(&self, id: &str) -> bool {
        let mut g = self.shared.inner.lock().unwrap();
        let Some(r) = g.jobs.iter_mut().find(|r| r.snap.job_id == id) else { return false };
        match r.snap.state {
            JobState::Queued => {
                r.snap.state = JobState::Canceled;
                let snap = r.snap.clone();
                write_journal_locked(&self.shared, &g);
                drop(g);
                notify(&self.shared, &snap);
                true
            }
            JobState::Rendering { .. } => {
                r.cancel.cancel();
                true
            }
            _ => false,
        }
    }

    pub fn snapshot(&self) -> Vec<JobSnapshot> {
        self.shared.inner.lock().unwrap().jobs.iter().map(|r| r.snap.clone()).collect()
    }

    pub fn log(&self, id: &str) -> Option<JobLog> {
        self.shared.inner.lock().unwrap().jobs.iter().find(|r| r.snap.job_id == id).and_then(|r| r.log.clone())
    }

    /// Drop finished (completed/failed/canceled) jobs from the list.
    pub fn clear_finished(&self) {
        self.shared.inner.lock().unwrap().jobs.retain(|r| matches!(r.snap.state, JobState::Queued | JobState::Rendering { .. }));
    }

    /// Number of queued + running jobs.
    pub fn active(&self) -> usize {
        self.shared.inner.lock().unwrap().jobs.iter().filter(|r| matches!(r.snap.state, JobState::Queued | JobState::Rendering { .. })).count()
    }
}

impl JobQueue {
    /// Stop accepting work and cancel everything in flight (used on app exit and by tests).
    pub fn shutdown(&self) {
        let mut g = self.shared.inner.lock().unwrap();
        g.shutdown = true;
        for r in &g.jobs {
            r.cancel.cancel();
        }
        drop(g);
        self.shared.cv.notify_all();
    }
}

fn notify(s: &Shared, snap: &JobSnapshot) {
    if let Some(l) = s.listener.lock().unwrap().as_ref() {
        l(snap);
    }
}

/// Progress updates do not change what is unfinished; only arrivals and state changes do.
fn changes_journal(st: &JobState) -> bool {
    !matches!(st, JobState::Rendering { fraction: Some(_), .. })
}

fn write_journal(s: &Shared) {
    let g = s.inner.lock().unwrap();
    write_journal_locked(s, &g);
}

/// Write the journal from `g` while the caller still holds the state lock. A state change and its journal entry are one step:
/// anyone who can see "completed" also finds the journal without that job (a reader polling the state used to be able to
/// read the journal in between and see a finished job still listed).
fn write_journal_locked(s: &Shared, g: &Inner) {
    let Some((path, ops)) = s.journal.lock().unwrap().clone() else { return };
    // jobs canceled by shutdown were not finished: keep the journal as it was when shutdown began
    if g.shutdown {
        return;
    }
    let saved: Vec<SavedJob> = g
        .jobs
        .iter()
        .filter(|r| ops.contains(&r.snap.operation) && matches!(r.snap.state, JobState::Queued | JobState::Rendering { .. }))
        .filter_map(|r| r.job.as_ref().map(|job| SavedJob { operation: r.snap.operation.clone(), priority: r.snap.priority, enqueued_unix: r.snap.enqueued_unix, was_running: matches!(r.snap.state, JobState::Rendering { .. }), job: job.clone() }))
        .collect();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // write-then-rename so a crash mid-write never leaves half a journal
    let tmp = path.with_extension("tmp");
    if serde_json::to_vec_pretty(&saved).ok().is_some_and(|b| std::fs::write(&tmp, b).is_ok()) {
        let _ = std::fs::rename(&tmp, &path);
    }
}

fn worker(s: Arc<Shared>) {
    loop {
        // pick the highest-priority queued job, oldest first
        let picked = {
            let mut g = s.inner.lock().unwrap();
            loop {
                if g.shutdown {
                    return;
                }
                let idx = g
                    .jobs
                    .iter()
                    .enumerate()
                    .filter(|(_, r)| matches!(r.snap.state, JobState::Queued) && r.job.is_some())
                    .max_by_key(|(_, r)| (r.snap.priority, std::cmp::Reverse(r.seq)))
                    .map(|(i, _)| i);
                if let Some(i) = idx {
                    let r = &mut g.jobs[i];
                    r.snap.state = JobState::Rendering { fraction: None, fps: None, elapsed_secs: 0.0, eta_secs: None };
                    let picked = (r.snap.clone(), r.job.clone().expect("only jobs with a command are picked"), r.cancel.clone());
                    write_journal_locked(&s, &g);
                    break picked;
                }
                g = s.cv.wait(g).unwrap();
            }
        };
        let (snap, job, cancel) = picked;
        notify(&s, &snap);
        let tools = s.tools.lock().unwrap().clone();
        let mut job = job;
        job.program = tools.ffmpeg.clone();
        let id = snap.job_id.clone();
        let s2 = Arc::clone(&s);
        let mut update = |st: JobState| {
            // the runner's own "Queued" ping is not meaningful here (we are already running)
            let st = if matches!(st, JobState::Queued) { JobState::Rendering { fraction: None, fps: None, elapsed_secs: 0.0, eta_secs: None } } else { st };
            let snap = {
                let mut g = s2.inner.lock().unwrap();
                let snap = match g.jobs.iter_mut().find(|r| r.snap.job_id == id) {
                    Some(r) => {
                        r.snap.state = st;
                        r.snap.clone()
                    }
                    None => return,
                };
                if changes_journal(&snap.state) {
                    write_journal_locked(&s2, &g);
                }
                snap
            };
            notify(&s2, &snap);
        };
        let (_, log) = run_job_logged(&tools, &job, &snap.job_id, &snap.operation, &cancel, &s.temp_dir, &mut update);
        let mut g = s.inner.lock().unwrap();
        if let Some(r) = g.jobs.iter_mut().find(|r| r.snap.job_id == snap.job_id) {
            r.log = log;
        }
    }
}
