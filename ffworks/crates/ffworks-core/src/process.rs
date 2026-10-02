//! Structured external-process execution and FFmpeg capability discovery.
//! Nothing here ever builds a shell string: programs are spawned with argv arrays (spec §52, §98).

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

impl Tools {
    /// Resolve tools. Explicit paths win; otherwise `FFWORKS_FFMPEG` / `FFWORKS_FFPROBE`, then PATH.
    /// Binaries are never downloaded silently (spec §95).
    pub fn discover(custom_ffmpeg: Option<&Path>, custom_ffprobe: Option<&Path>) -> Tools {
        let pick = |custom: Option<&Path>, env: &str, default: &str| -> PathBuf {
            custom
                .map(Path::to_path_buf)
                .or_else(|| std::env::var_os(env).map(PathBuf::from))
                .unwrap_or_else(|| PathBuf::from(default))
        };
        Tools {
            ffmpeg: pick(custom_ffmpeg, "FFWORKS_FFMPEG", "ffmpeg"),
            ffprobe: pick(custom_ffprobe, "FFWORKS_FFPROBE", "ffprobe"),
        }
    }

    /// Run `program args... [input]` and capture stdout. `input` is passed as its own argv element,
    /// so spaces / Unicode in paths need no quoting on any platform.
    pub fn run_capture(&self, program: &Path, args: &[&str], input: Option<&Path>) -> Result<String> {
        let mut cmd = Command::new(program);
        cmd.args(args);
        if let Some(i) = input {
            cmd.arg(i);
        }
        suppress_console_window(&mut cmd);
        let out = cmd
            .stdin(Stdio::null())
            .output()
            .map_err(|e| Error::ToolUnavailable { tool: program.display().to_string(), reason: e.to_string() })?;
        if !out.status.success() {
            return Err(Error::ToolFailed {
                tool: program.display().to_string(),
                code: out.status.code(),
                hint: explain_failure(&String::from_utf8_lossy(&out.stderr)),
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

/// On Windows, don't flash a console window for each child process.
#[cfg(windows)]
pub fn suppress_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
pub fn suppress_console_window(_cmd: &mut Command) {}

/// Human-readable explanation of common FFmpeg failures. Raw stderr is always kept separately in the job log.
pub fn explain_failure(stderr: &str) -> String {
    let s = stderr.to_lowercase();
    let hint = if s.contains("no such file or directory") {
        "an input file is missing or the path is wrong"
    } else if s.contains("unknown encoder") || s.contains("encoder") && s.contains("not found") {
        "the selected encoder is not available in this FFmpeg build"
    } else if s.contains("invalid data found when processing input") {
        "the input file is corrupt or not a supported media file"
    } else if s.contains("permission denied") {
        "permission denied: the output location is not writable or the file is open elsewhere"
    } else if s.contains("no space left") {
        "the destination drive is full"
    } else if s.contains("error initializing filter") || s.contains("error parsing filterchain") || s.contains("no such filter") {
        "the generated filter graph was rejected by FFmpeg (see raw log)"
    } else {
        ""
    };
    let tail: Vec<&str> = stderr.lines().rev().take(3).collect();
    let tail = tail.into_iter().rev().collect::<Vec<_>>().join(" | ");
    if hint.is_empty() { tail } else { format!("{hint} — {tail}") }
}

/// How to pass a filter graph from a file. FFmpeg 7.0 deprecated `-filter_complex_script` in favour of `-/filter_complex <file>`,
/// and newer builds (8.x) no longer accept the old option at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterFileStyle {
    /// `-filter_complex_script <file>` (FFmpeg < 7)
    Legacy,
    /// `-/filter_complex <file>` (FFmpeg >= 7, and git/nightly builds)
    Slash,
}

/// Parse the first line of `ffmpeg -version`. Unknown formats (git/nightly builds such as `N-123456-g...`) are treated as new.
pub fn filter_file_style(version_line: &str) -> FilterFileStyle {
    let v = version_line.split_whitespace().nth(2).unwrap_or("");
    let digits: String = v.trim_start_matches(['n', 'N']).chars().take_while(|c| c.is_ascii_digit()).collect();
    match digits.parse::<u32>() {
        Ok(major) if v.starts_with(|c: char| c.is_ascii_digit() || c == 'n') && major < 7 => FilterFileStyle::Legacy,
        _ => FilterFileStyle::Slash,
    }
}

impl Tools {
    /// Detected once per process (the installed FFmpeg does not change while running; a settings change restarts detection on next run).
    pub fn filter_file_style(&self) -> FilterFileStyle {
        use std::sync::Mutex;
        static CACHE: Mutex<Vec<(PathBuf, FilterFileStyle)>> = Mutex::new(Vec::new());
        let mut c = CACHE.lock().unwrap();
        if let Some((_, st)) = c.iter().find(|(p, _)| *p == self.ffmpeg) {
            return *st;
        }
        let st = self.run_capture(&self.ffmpeg, &["-version"], None).map(|o| filter_file_style(o.lines().next().unwrap_or(""))).unwrap_or(FilterFileStyle::Slash);
        c.push((self.ffmpeg.clone(), st));
        st
    }
}

/// What the installed FFmpeg can actually do (spec §21). Never assume a build's capabilities.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Capabilities {
    pub version: String,
    pub filters: BTreeSet<String>,
    pub encoders: BTreeSet<String>,
    pub decoders: BTreeSet<String>,
    pub hwaccels: Vec<String>,
    /// `(name, description)` of the `xfade` transitions this FFmpeg supports.
    #[serde(default)]
    pub xfade_transitions: Vec<(String, String)>,
}

impl Capabilities {
    pub fn has_encoder(&self, name: &str) -> bool {
        self.encoders.contains(name)
    }
    pub fn has_filter(&self, name: &str) -> bool {
        self.filters.contains(name)
    }

    pub fn discover(tools: &Tools) -> Result<Capabilities> {
        let run = |a: &[&str]| tools.run_capture(&tools.ffmpeg, &["-hide_banner"].iter().chain(a.iter()).copied().collect::<Vec<_>>(), None);
        let version = run(&["-version"])?.lines().next().unwrap_or("").to_string();
        Ok(Capabilities {
            version,
            filters: parse_table(&run(&["-filters"])?, 3),
            encoders: parse_table(&run(&["-encoders"])?, 2),
            decoders: parse_table(&run(&["-decoders"])?, 2),
            hwaccels: run(&["-hwaccels"])?
                .lines()
                .skip(1)
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect(),
            xfade_transitions: run(&["-h", "filter=xfade"]).map(|o| parse_xfade(&o)).unwrap_or_default(),
        })
    }
}

/// Parse the `transition` choices out of `ffmpeg -h filter=xfade` (lines like `     fade   0   ..FV....... fade transition`).
pub fn parse_xfade(help: &str) -> Vec<(String, String)> {
    help.lines()
        .filter_map(|l| {
            let rest = l.strip_prefix("     ")?;
            let mut it = rest.split_whitespace();
            let (name, idx, _flags) = (it.next()?, it.next()?, it.next()?);
            idx.parse::<i32>().ok()?;
            if name == "custom" || !name.chars().all(|c| c.is_ascii_lowercase()) {
                return None;
            }
            let desc: Vec<&str> = it.collect();
            let d = desc.join(" ");
            let d = d.strip_suffix(" transition").unwrap_or(&d);
            Some((name.to_string(), d.to_string()))
        })
        .collect()
}

/// Parse `ffmpeg -filters/-encoders/-decoders`. Rows are `<flags> <name> ...`; legend lines look like
/// `A = Audio input/output` and headers have one token. (`-filters` has no `------` separator, `-encoders` does.)
fn parse_table(out: &str, _unused: usize) -> BTreeSet<String> {
    let mut set = BTreeSet::new();
    for line in out.lines() {
        let mut parts = line.split_whitespace();
        let (Some(flags), Some(name)) = (parts.next(), parts.next()) else { continue };
        if name == "=" || !flags.chars().all(|c| ".TSCVAFXDEIBN|".contains(c)) {
            continue;
        }
        set.insert(name.to_string());
    }
    set
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_xfade_transition_list() {
        let h = "xfade AVOptions:\n   transition        <int>        ..FV....... set cross fade transition (from -1 to 57) (default fade)\n     custom          -1           ..FV....... custom transition\n     fade            0            ..FV....... fade transition\n     wipeleft        1            ..FV....... wipe left transition\n   duration          <duration>   ..FV....... set cross fade duration (default 1)\n";
        assert_eq!(parse_xfade(h), vec![("fade".to_string(), "fade".to_string()), ("wipeleft".to_string(), "wipe left".to_string())]);
    }

    #[test]
    fn filter_file_style_by_version() {
        assert_eq!(filter_file_style("ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023"), FilterFileStyle::Legacy);
        assert_eq!(filter_file_style("ffmpeg version 4.4.2 Copyright"), FilterFileStyle::Legacy);
        assert_eq!(filter_file_style("ffmpeg version n6.0 Copyright"), FilterFileStyle::Legacy);
        assert_eq!(filter_file_style("ffmpeg version 7.0 Copyright"), FilterFileStyle::Slash);
        assert_eq!(filter_file_style("ffmpeg version 8.0-essentials_build-www.gyan.dev Copyright"), FilterFileStyle::Slash);
        assert_eq!(filter_file_style("ffmpeg version N-117770-g1234abc Copyright"), FilterFileStyle::Slash);
        assert_eq!(filter_file_style("garbage"), FilterFileStyle::Slash);
    }

    #[test]
    fn parses_encoder_table() {
        let t = "Encoders:\n V..... = Video\n ------\n V....D libx264    libx264 H.264\n A....D aac         AAC\n";
        let s = parse_table(t, 2);
        assert!(s.contains("libx264") && s.contains("aac"));
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn parses_filter_table_without_separator() {
        let t = "Filters:\n  T.. = Timeline support\n  A = Audio input/output\n  | = Source or sink filter\n ... abench            A->A       Benchmark.\n T.C eq                V->V       Adjust.\n ... anoisesrc         |->A       Generate.\n";
        let s = parse_table(t, 3);
        assert_eq!(s.iter().cloned().collect::<Vec<_>>(), vec!["abench", "anoisesrc", "eq"]);
    }

    #[test]
    fn explains_common_failures() {
        assert!(explain_failure("x: No such file or directory").contains("missing"));
        assert!(explain_failure("Unknown encoder 'foo'").contains("encoder"));
    }

    #[test]
    fn missing_tool_is_reported_not_panicked() {
        let t = Tools { ffmpeg: "definitely-not-ffmpeg".into(), ffprobe: "definitely-not-ffprobe".into() };
        assert!(matches!(Capabilities::discover(&t), Err(Error::ToolUnavailable { .. })));
    }
}
