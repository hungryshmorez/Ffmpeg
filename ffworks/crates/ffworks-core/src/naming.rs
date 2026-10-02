//! Export file names: a template such as `{project}_{preset}_{date}` expanded into a safe file name, and versioning so an
//! export never silently replaces an earlier one (`clip.mp4` → `clip_v2.mp4` → `clip_v3.mp4`).

use std::path::{Path, PathBuf};

/// Values a template can use. `date` is `YYYY-MM-DD`, `time` is `HHMM` (the caller decides local time or UTC).
#[derive(Clone, Debug, Default)]
pub struct NameContext {
    pub project: String,
    pub sequence: String,
    pub preset: String,
    pub date: String,
    pub time: String,
    pub width: u32,
    pub height: u32,
}

pub const TOKENS: &[(&str, &str)] = &[
    ("{project}", "project name"),
    ("{sequence}", "sequence name"),
    ("{preset}", "export preset id"),
    ("{date}", "date, YYYY-MM-DD"),
    ("{time}", "time, HHMM"),
    ("{res}", "resolution, e.g. 1920x1080"),
];

/// The file stem (no extension) for `template`. Unknown `{tokens}` stay as typed; characters Windows or Unix forbid in
/// file names become `_`; an empty result falls back to the project name, then "export".
pub fn expand(template: &str, ctx: &NameContext) -> String {
    let res = format!("{}x{}", ctx.width, ctx.height);
    let raw = template
        .replace("{project}", &ctx.project)
        .replace("{sequence}", &ctx.sequence)
        .replace("{preset}", &ctx.preset)
        .replace("{date}", &ctx.date)
        .replace("{time}", &ctx.time)
        .replace("{res}", &res);
    let clean = sanitize(&raw);
    if !clean.is_empty() {
        return clean;
    }
    let p = sanitize(&ctx.project);
    if p.is_empty() { "export".into() } else { p }
}

/// A single path component that is legal on Windows, macOS and Linux.
pub fn sanitize(s: &str) -> String {
    let mapped: String = s.chars().map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c }).collect();
    // Windows rejects trailing dots/spaces and the reserved device names
    let trimmed = mapped.trim().trim_end_matches(['.', ' ']).to_string();
    let upper = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&upper.as_str()) || (upper.len() == 4 && (upper.starts_with("COM") || upper.starts_with("LPT")) && upper.as_bytes()[3].is_ascii_digit());
    let out = if reserved { format!("_{trimmed}") } else { trimmed };
    out.chars().take(150).collect()
}

/// `path` itself if nothing is there yet, else the first free `<stem>_vN<.ext>` (N ≥ 2). A stem that already ends in
/// `_vN` continues from N, so exporting `clip_v2.mp4` again gives `clip_v3.mp4`, not `clip_v2_v2.mp4`.
/// For numbered image-sequence patterns (`frame_%05d.png`) the check looks for the first frame.
pub fn next_free(path: &Path) -> PathBuf {
    next_free_except(path, &[])
}

/// Like [`next_free`], also treating `reserved` (outputs of exports still queued or running) as taken.
pub fn next_free_except(path: &Path, reserved: &[PathBuf]) -> PathBuf {
    let taken = |p: &Path| taken(p) || reserved.iter().any(|r| r == p);
    if !taken(path) {
        return path.to_path_buf();
    }
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("export");
    let ext = path.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    // keep a sequence pattern at the end of the stem: `shot_%05d` → `shot_v2_%05d`
    let (base, pattern) = match stem.rfind("_%0") {
        Some(i) if stem[i..].ends_with('d') => (&stem[..i], &stem[i..]),
        _ => (stem, ""),
    };
    let (root, mut n) = split_version(base);
    loop {
        n += 1;
        let candidate = dir.join(format!("{root}_v{n}{pattern}{ext}"));
        if !taken(&candidate) {
            return candidate;
        }
    }
}

fn split_version(stem: &str) -> (&str, u32) {
    if let Some(i) = stem.rfind("_v") {
        if let Ok(n) = stem[i + 2..].parse::<u32>() {
            if n >= 2 {
                return (&stem[..i], n);
            }
        }
    }
    (stem, 1)
}

fn taken(path: &Path) -> bool {
    let s = path.to_string_lossy();
    if let Some(i) = s.rfind("%0") {
        // frame_%05d.png → frame_00001.png
        let rest = &s[i + 2..];
        if let Some(d) = rest.find('d') {
            if let Ok(width) = rest[..d].parse::<usize>() {
                let first = format!("{}{:0width$}{}", &s[..i], 1, &rest[d + 1..], width = width);
                return Path::new(&first).exists();
            }
        }
    }
    path.exists()
}

/// Today's date and time in UTC as (`YYYY-MM-DD`, `HHMM`), for callers without a local clock (the CLI).
pub fn utc_now() -> (String, String) {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (format!("{y:04}-{m:02}-{d:02}"), format!("{:02}{:02}", rem / 3600, rem % 3600 / 60))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> NameContext {
        NameContext { project: "My film".into(), sequence: "Main".into(), preset: "h264_mp4".into(), date: "2026-10-02".into(), time: "1905".into(), width: 1920, height: 1080 }
    }

    #[test]
    fn expands_tokens_and_cleans_names() {
        assert_eq!(expand("{project}_{preset}_{date}", &ctx()), "My film_h264_mp4_2026-10-02");
        assert_eq!(expand("{sequence} {res} {time}", &ctx()), "Main 1920x1080 1905");
        assert_eq!(expand("a/b:c*?{unknown}", &ctx()), "a_b_c__{unknown}");
        assert_eq!(expand("  ...  ", &ctx()), "My film");
        assert_eq!(expand("", &NameContext::default()), "export");
        assert_eq!(sanitize("con"), "_con");
        assert_eq!(sanitize("COM1.mp4"), "_COM1.mp4");
        assert_eq!(sanitize("name. "), "name");
    }

    #[test]
    fn versions_never_overwrite() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("clip.mp4");
        assert_eq!(next_free(&p), p);
        std::fs::write(&p, b"x").unwrap();
        let v2 = next_free(&p);
        assert_eq!(v2.file_name().unwrap(), "clip_v2.mp4");
        std::fs::write(&v2, b"x").unwrap();
        assert_eq!(next_free(&p).file_name().unwrap(), "clip_v3.mp4");
        // exporting the v2 name again continues the numbering
        assert_eq!(next_free(&v2).file_name().unwrap(), "clip_v3.mp4");
        // a name reserved by a queued export counts as taken
        assert_eq!(next_free_except(&p, &[d.path().join("clip_v3.mp4")]).file_name().unwrap(), "clip_v4.mp4");
        // a name that merely contains _v is not a version
        let odd = d.path().join("my_video.mp4");
        std::fs::write(&odd, b"x").unwrap();
        assert_eq!(next_free(&odd).file_name().unwrap(), "my_video_v2.mp4");
    }

    #[test]
    fn image_sequences_check_their_first_frame() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("shot_%05d.png");
        assert_eq!(next_free(&p), p);
        std::fs::write(d.path().join("shot_00001.png"), b"x").unwrap();
        assert_eq!(next_free(&p).file_name().unwrap(), "shot_v2_%05d.png");
    }

    #[test]
    fn utc_now_is_well_formed() {
        let (d, t) = utc_now();
        assert_eq!(d.len(), 10);
        assert!(d.starts_with("20"));
        assert_eq!(t.len(), 4);
    }
}
