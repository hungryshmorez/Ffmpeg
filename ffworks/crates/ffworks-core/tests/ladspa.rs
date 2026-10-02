//! LADSPA audio plugins as effects, run by the real FFmpeg when its `ladspa` filter and the plugins are installed.
use ffworks_core::commands::Command;
use ffworks_core::effects;
use ffworks_core::engine::Engine;
use ffworks_core::ffmpeg::{compile, ExportSettings, RenderOptions};
use ffworks_core::jobs::{run_job, CancelToken};
use ffworks_core::ladspa;
use ffworks_core::process::{Capabilities, Tools};
use ffworks_core::project::{ProjectSettings, TrackKind};
use ffworks_core::{render_graph, Rational};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command as Proc;

fn tools() -> Tools {
    Tools::discover(None, None)
}

fn ready() -> bool {
    let caps = Capabilities::discover(&tools()).unwrap();
    if !caps.has_filter("ladspa") || ladspa::offered().is_empty() {
        eprintln!("no ladspa filter or no LADSPA plugins installed here; skipping");
        return false;
    }
    true
}

/// (mean dB, max dB) of the whole file.
fn level(media: &Path) -> (f64, f64) {
    let out = Proc::new(tools().ffmpeg).args(["-nostdin", "-i"]).arg(media).args(["-vn", "-af", "volumedetect", "-f", "null", "-"]).output().unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    let grab = |k: &str| err.lines().find_map(|l| l.split(k).nth(1)).and_then(|v| v.trim().trim_end_matches(" dB").parse().ok()).unwrap_or(-91.0);
    (grab("mean_volume:"), grab("max_volume:"))
}

#[test]
fn offered_effects_are_installed_libraries_and_saved_ones_always_resolve() {
    let inst = ladspa::installed();
    for d in effects::registry().iter().filter(|d| d.id.starts_with(ladspa::PREFIX)) {
        let file = d.id[ladspa::PREFIX.len()..].split(':').next().unwrap();
        assert!(inst.contains(file), "{} offered but not installed", d.id);
        assert_eq!(d.kind, "audio");
    }
    let any = ladspa::all().into_iter().next().unwrap();
    assert!(effects::find(any.id).is_ok());
}

#[test]
fn every_installed_ladspa_effect_runs_on_a_stereo_tone_with_its_default_values() {
    if !ready() {
        return;
    }
    let mut failed = vec![];
    let offered = ladspa::offered();
    for d in &offered {
        let text = ladspa::filter_text(d.id, &BTreeMap::new()).unwrap();
        let out = Proc::new(tools().ffmpeg)
            .args(["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=0.5,aformat=channel_layouts=stereo", "-af"])
            .arg(format!("{text},aformat=sample_fmts=fltp:channel_layouts=stereo"))
            .args(["-f", "null", "-"])
            .output()
            .unwrap();
        if !out.status.success() {
            failed.push(format!("{}: {}", d.id, String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")));
        }
    }
    assert!(failed.is_empty(), "{} of {} failed:\n{}", failed.len(), offered.len(), failed.join("\n"));
}

#[test]
fn a_ladspa_amp_on_a_clip_changes_the_exported_level_and_undoes() {
    if !ready() {
        return;
    }
    let Some(amp) = ladspa::offered().into_iter().find(|d| d.id.ends_with(":amp_mono") || d.id.ends_with(":amp")) else {
        eprintln!("no amp plugin; skipping");
        return;
    };
    let gain = amp.params.iter().find(|p| p.name.to_lowercase().contains("gain")).unwrap_or(&amp.params[0]).clone();
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("t.mp4");
    let st = Proc::new(tools().ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=2", "-f", "lavfi", "-i", "sine=f=440:r=44100:d=2,volume=2"])
        .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest"])
        .arg(&src)
        .status()
        .unwrap();
    assert!(st.success());
    let t = tools();
    let mut eng = Engine::new("la", ProjectSettings { width: 64, height: 64, fps: Rational::from_int(25), sample_rate: 48000 }, t.clone());
    let m = eng.import_media(&src).unwrap();
    let v = eng.project.active().unwrap().tracks[0].id.clone();
    eng.dispatch(Command::PlaceClip { media: m, track: v, start: Rational::from_int(0), source_in: None, duration: None, with_audio: true, audio_track: None }).unwrap();
    let a = eng.project.active().unwrap().tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap().clips[0].id.clone();
    let export = |eng: &Engine, name: &str| {
        let out = dir.path().join(name);
        let caps = Capabilities::discover(&t).unwrap();
        let g = render_graph::build(&eng.project).unwrap();
        let mut job = compile(&g, &RenderOptions { output: out.clone(), settings: ExportSettings::find("wav").unwrap(), range: None, scale_div: 1 }, Some(&caps)).unwrap();
        job.program = t.ffmpeg.clone();
        run_job(&t, &job, "t", "export", &CancelToken::new(), &dir.path().join("tmp"), &mut |_| {}).unwrap_or_else(|e| panic!("export: {e}"));
        level(&out)
    };
    let (base, _) = export(&eng, "base.wav");
    // a quarter of the gain range's linear value or the minimum dB: either way, quieter
    let low = if gain.min < 0.0 { gain.min.max(-20.0) } else { gain.min + (gain.max - gain.min) * 0.05 };
    eng.dispatch(Command::AddEffect { clip: a.clone(), effect: amp.id.to_string(), params: [(gain.id.to_string(), low)].into_iter().collect(), index: None }).unwrap();
    let (quiet, _) = export(&eng, "quiet.wav");
    assert!(quiet < base - 6.0, "{} at {low}: base {base} dB, after {quiet} dB", amp.id);
    eng.undo().unwrap();
    let (back, _) = export(&eng, "back.wav");
    assert!((back - base).abs() < 0.5, "undo restores the level: {base} vs {back}");
}
