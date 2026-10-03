//! Tasks in the job queue (previews and analyses show up there, can be cancelled, and do not wait behind exports) and
//! cancellable FFmpeg helpers.
use ffworks_core::error::Error;
use ffworks_core::jobs::{CancelToken, JobState};
use ffworks_core::process::{run_cancellable, Tools};
use ffworks_core::queue::{read_journal, JobQueue};
use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn queue(dir: &std::path::Path) -> JobQueue {
    JobQueue::new(Tools::discover(None, None), dir.join("tmp"), 1)
}

fn state_of(q: &JobQueue, id: &str) -> JobState {
    q.snapshot().into_iter().find(|j| j.job_id == id).unwrap().state
}

fn wait_for(f: impl Fn() -> bool, secs: u64) -> bool {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

#[test]
fn a_task_is_listed_while_it_runs_and_completed_after_its_result_is_ready() {
    let dir = tempfile::tempdir().unwrap();
    let q = queue(dir.path());
    let (release, hold) = mpsc::channel::<()>();
    let (id, rx) = q.run_task("analysis", "Beats of song.wav", move |_, progress| {
        progress(JobState::Rendering { fraction: Some(0.5), fps: None, elapsed_secs: 0.0, eta_secs: None });
        hold.recv().unwrap();
        Ok(42)
    });
    let listed = q.snapshot().into_iter().find(|j| j.job_id == id).unwrap();
    assert_eq!((listed.operation.as_str(), listed.output.as_str()), ("analysis", "Beats of song.wav"));
    assert!(wait_for(|| matches!(state_of(&q, &id), JobState::Rendering { fraction: Some(f), .. } if f == 0.5), 5), "progress shows in the list");
    assert_eq!(q.active(), 1, "a running task counts as active");
    release.send(()).unwrap();
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap(), 42);
    assert_eq!(state_of(&q, &id), JobState::Completed, "the final state is visible by the time the result arrives");
    assert_eq!(q.active(), 0);
}

#[test]
fn a_task_can_be_cancelled_from_the_queue_and_a_failure_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let q = queue(dir.path());
    let (id, rx) = q.run_task("preview", "Preview 0-10 s", |cancel, _| {
        while !cancel.is_canceled() {
            std::thread::sleep(Duration::from_millis(5));
        }
        Err::<(), _>(Error::Canceled)
    });
    assert!(q.cancel(&id), "a running task can be cancelled");
    assert!(matches!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), Err(Error::Canceled)));
    assert_eq!(state_of(&q, &id), JobState::Canceled);
    assert!(!q.cancel(&id), "a finished task cannot be cancelled again");

    let (id, rx) = q.run_task("analysis", "x", |_, _| Err::<(), _>(Error::validation("no audio stream")));
    assert!(rx.recv_timeout(Duration::from_secs(5)).unwrap().is_err());
    assert!(matches!(state_of(&q, &id), JobState::Failed { message } if message.contains("no audio stream")));

    let (id, rx) = q.run_task("analysis", "x", |_, _| -> Result<(), Error> { panic!("boom") });
    assert!(rx.recv_timeout(Duration::from_secs(5)).unwrap().is_err());
    assert!(matches!(state_of(&q, &id), JobState::Failed { message } if message.contains("stopped unexpectedly")), "a panic ends the task instead of leaving it running");
    q.clear_finished();
    assert!(q.snapshot().is_empty());
}

#[test]
fn tasks_never_enter_the_crash_journal() {
    let dir = tempfile::tempdir().unwrap();
    let q = queue(dir.path());
    let journal = dir.path().join("jobs.json");
    q.set_journal(journal.clone(), &["export", "analysis"]);
    let (release, hold) = mpsc::channel::<()>();
    let (_, rx) = q.run_task("analysis", "x", move |_, _| {
        hold.recv().unwrap();
        Ok(())
    });
    assert!(read_journal(&journal).is_empty(), "a running task is not an unfinished export");
    release.send(()).unwrap();
    rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
}

#[test]
fn shutdown_raises_every_tasks_cancel_switch() {
    let dir = tempfile::tempdir().unwrap();
    let q = queue(dir.path());
    let (_, rx) = q.run_task("analysis", "x", |cancel, _| {
        let end = Instant::now() + Duration::from_secs(10);
        while !cancel.is_canceled() && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(5));
        }
        if cancel.is_canceled() { Err::<(), _>(Error::Canceled) } else { Ok(()) }
    });
    q.shutdown();
    assert!(matches!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), Err(Error::Canceled)));
}

#[test]
fn a_running_ffmpeg_is_killed_when_cancelled() {
    let tools = Tools::discover(None, None);
    let cancel = CancelToken::new();
    let c2 = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        c2.cancel();
    });
    let started = Instant::now();
    // a source that would run for hours
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-f", "lavfi", "-i", "sine=d=100000", "-f", "null", "-"]);
    let r = run_cancellable(&mut cmd, &cancel);
    assert!(matches!(r, Err(Error::Canceled)), "{r:?}");
    assert!(started.elapsed() < Duration::from_secs(10), "stopped after {:?}", started.elapsed());
}

#[test]
fn run_cancellable_returns_output_and_reports_a_missing_program() {
    let tools = Tools::discover(None, None);
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.arg("-version");
    let out = run_cancellable(&mut cmd, &CancelToken::new()).unwrap();
    assert!(out.status.success() && String::from_utf8_lossy(&out.stdout).starts_with("ffmpeg version"));
    let mut missing = Command::new("definitely-not-a-program-ffworks");
    assert!(matches!(run_cancellable(&mut missing, &CancelToken::new()), Err(Error::ToolUnavailable { .. })));
}

#[test]
fn analyses_stop_at_once_when_cancelled_and_leave_no_cache() {
    let dir = tempfile::tempdir().unwrap();
    let tools = Tools::discover(None, None);
    let wav = dir.path().join("a.wav");
    let ok = Command::new(&tools.ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=2", "-ac", "1"]).arg(&wav).status().unwrap();
    assert!(ok.success());
    let raised = CancelToken::new();
    raised.cancel();
    let cache = dir.path().join("cache");
    assert!(matches!(ffworks_core::beats::detect_with(&tools, &wav, &cache, "k", &raised), Err(Error::Canceled)));
    assert!(matches!(ffworks_core::loudness::analyze_with(&tools, &wav, &cache, "k", &raised), Err(Error::Canceled)));
    assert!(matches!(ffworks_core::detect::detect_with(&tools, &wav, 2.0, ffworks_core::detect::Kind::Silence, -35.0, 0.5, &raised), Err(Error::Canceled)));
    assert!(matches!(ffworks_core::audiosync::measure_with(&tools, &wav, &wav, &raised), Err(Error::Canceled)));
    let cached = std::fs::read_dir(&cache).map(|d| d.count()).unwrap_or(0);
    assert_eq!(cached, 0, "a cancelled analysis caches nothing");
    // the same calls with a live token give the same answers as the plain functions
    let live = CancelToken::new();
    let a = ffworks_core::loudness::analyze_with(&tools, &wav, &cache, "k2", &live).unwrap();
    let b = ffworks_core::loudness::analyze(&tools, &wav, &cache, "k3").unwrap();
    assert_eq!(a.integrated_lufs, b.integrated_lufs);
    assert!(a.integrated_lufs.is_some_and(|l| l < 0.0), "a real measurement: {:?}", a.integrated_lufs);
}
