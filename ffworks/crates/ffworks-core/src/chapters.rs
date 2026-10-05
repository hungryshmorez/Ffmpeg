//! Timeline markers as chapters in the exported file: written as an FFmpeg metadata file (`;FFMETADATA1`) that the export reads
//! as one more input (`-map_chapters`). Each marker starts a chapter that lasts until the next marker (the last one until the
//! end of the export), so a marker is a chapter *start*, as in every player's chapter list.

use crate::project::Marker;
use crate::time::Rational;
use std::path::{Path, PathBuf};

/// Containers FFmpeg can write chapters into.
pub fn supports(extension: &str) -> bool {
    matches!(extension.to_ascii_lowercase().as_str(), "mp4" | "m4v" | "m4a" | "mov" | "mkv" | "webm")
}

fn escape(s: &str) -> String {
    let mut o = String::new();
    for c in s.chars() {
        match c {
            '=' | ';' | '#' | '\\' => {
                o.push('\\');
                o.push(c);
            }
            '\n' | '\r' => o.push_str("\\\n"),
            c => o.push(c),
        }
    }
    o
}

fn ms(t: Rational) -> i64 {
    (t.as_f64() * 1000.0).round() as i64
}

/// The metadata file text for the markers inside `[start, end)` (times stay on the timeline: FFmpeg itself shifts chapters by the output's `-ss`, so shifting here would shift twice), or `None` when there
/// is nothing to write. A chapter "Start" is added in front when the first marker is later than the export's start. Markers at the same millisecond collapse into the first one.
pub fn metadata(markers: &[Marker], start: Rational, end: Rational) -> Option<String> {
    let inside: Vec<&Marker> = markers.iter().filter(|m| m.time >= start && m.time < end).collect();
    if inside.is_empty() {
        return None;
    }
    // The first chapter always begins where the export begins: FFmpeg offsets every chapter by the file's first chapter start
    // (found by trying), and players such as YouTube want a chapter at 0:00 anyway. A marker at that moment takes the slot.
    let mut starts: Vec<(i64, &str)> = vec![];
    if inside[0].time > start {
        starts.push((ms(start), "Start"));
    }
    for m in inside {
        let at = ms(m.time);
        if starts.last().is_none_or(|(prev, _)| *prev != at) {
            starts.push((at, m.name.as_str()));
        }
    }
    let total = ms(end);
    let mut out = String::from(";FFMETADATA1\n");
    for (i, (at, name)) in starts.iter().enumerate() {
        let stop = starts.get(i + 1).map(|n| n.0).unwrap_or(total).max(*at + 1);
        let title = if name.trim().is_empty() { format!("Chapter {}", i + 1) } else { name.to_string() };
        out.push_str(&format!("[CHAPTER]\nTIMEBASE=1/1000\nSTART={at}\nEND={stop}\ntitle={}\n", escape(&title)));
    }
    Some(out)
}

/// Write the metadata file into `dir` (named by content, so identical exports share it) and return its path.
pub fn write(dir: &Path, text: &str) -> std::io::Result<PathBuf> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    std::fs::create_dir_all(dir)?;
    let p = dir.join(format!("chapters_{:016x}.ffmeta", h.finish()));
    std::fs::write(&p, text)?;
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(t: i64, name: &str) -> Marker {
        Marker { id: format!("m{t}"), time: Rational::from_int(t), name: name.into(), color: "#ff0000".into(), note: String::new() }
    }

    #[test]
    fn each_marker_starts_a_chapter_that_lasts_to_the_next() {
        let t = metadata(&[mk(2, "Intro"), mk(5, ""), mk(8, "End")], Rational::ZERO, Rational::from_int(10)).unwrap();
        assert!(t.starts_with(";FFMETADATA1\n"));
        assert!(t.contains("START=0\nEND=2000\ntitle=Start"), "{t}");
        assert!(t.contains("START=2000\nEND=5000\ntitle=Intro"));
        assert!(t.contains("START=5000\nEND=8000\ntitle=Chapter 3"));
        assert!(t.contains("START=8000\nEND=10000\ntitle=End"));
    }

    #[test]
    fn a_range_keeps_only_its_markers_and_none_means_no_file() {
        let ms_ = [mk(1, "a"), mk(6, "b"), mk(20, "c")];
        let t = metadata(&ms_, Rational::from_int(5), Rational::from_int(10)).unwrap();
        assert!(t.contains("START=5000\nEND=6000\ntitle=Start") && t.contains("START=6000\nEND=10000\ntitle=b") && !t.contains("title=a") && !t.contains("title=c"), "{t}");
        assert!(metadata(&ms_, Rational::from_int(7), Rational::from_int(10)).is_none());
        assert!(metadata(&[], Rational::ZERO, Rational::from_int(10)).is_none());
    }

    #[test]
    fn special_characters_in_names_are_escaped() {
        let t = metadata(&[mk(0, "A=B;C#D\\E")], Rational::ZERO, Rational::from_int(1)).unwrap();
        assert!(t.contains(r"title=A\=B\;C\#D\\E"), "{t}");
    }

    #[test]
    fn only_chapter_capable_containers_are_listed() {
        assert!(supports("MP4") && supports("mkv") && !supports("wav") && !supports("gif"));
    }
}
