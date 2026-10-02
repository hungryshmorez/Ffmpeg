//! Background job queue (spec §60, §104). Jobs wait in priority order (higher first, FIFO within a priority), run on worker
//! threads with a concurrency limit, can be canceled while queued or running, and keep their full FFmpeg log whether they
//! succeed, fail or are canceled. Nothing here touches the UI; a listener callback reports every state change.

use crate::ffmpeg::FfmpegJob;
use crate::jobs::{run_job_logged, CancelToken, JobLog, JobState};
use crate::process::Tools;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const PRIORITY_BACKGROUND: i32 = 0;
pub const PRIORITY_EXPORT: i32 = 10;

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
    job: FfmpegJob,
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
        let shared = Arc::new(Shared { inner: Mutex::new(Inner { jobs: vec![], next_seq: 0, shutdown: false }), cv: Condvar::new(), listener: Mutex::new(None), tools: Mutex::new(tools), temp_dir });
        for _ in 0..workers.max(1) {
            let s = Arc::clone(&shared);
            std::thread::spawn(move || worker(s));
        }
        JobQueue { shared }
    }

    pub fn set_listener(&self, f: impl Fn(&JobSnapshot) + Send + Sync + 'static) {
        *self.shared.listener.lock().unwrap() = Some(Box::new(f));
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
        g.jobs.push(Record { snap: snap.clone(), job, cancel: CancelToken::new(), log: None, seq });
        drop(g);
        notify(&self.shared, &snap);
        self.shared.cv.notify_one();
        id
    }

    /// Cancel a queued job (it never runs) or a running one (FFmpeg is killed, no output is written). Returns false for unknown/finished jobs.
    pub fn cancel(&self, id: &str) -> bool {
        let mut g = self.shared.inner.lock().unwrap();
        let Some(r) = g.jobs.iter_mut().find(|r| r.snap.job_id == id) else { return false };
        match r.snap.state {
            JobState::Queued => {
                r.snap.state = JobState::Canceled;
                let snap = r.snap.clone();
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
                    .filter(|(_, r)| matches!(r.snap.state, JobState::Queued))
                    .max_by_key(|(_, r)| (r.snap.priority, std::cmp::Reverse(r.seq)))
                    .map(|(i, _)| i);
                if let Some(i) = idx {
                    let r = &mut g.jobs[i];
                    r.snap.state = JobState::Rendering { fraction: None, fps: None, elapsed_secs: 0.0, eta_secs: None };
                    break (r.snap.clone(), r.job.clone(), r.cancel.clone());
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
                match g.jobs.iter_mut().find(|r| r.snap.job_id == id) {
                    Some(r) => {
                        r.snap.state = st;
                        r.snap.clone()
                    }
                    None => return,
                }
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
