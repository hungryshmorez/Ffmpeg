//! Subtitle import: SubRip (.srt) and WebVTT (.vtt) files become timed text cues, which the engine turns into title clips.

use crate::error::{Error, Result};
use crate::time::Rational;

#[derive(Clone, Debug, PartialEq)]
pub struct Cue {
    pub start: Rational,
    pub end: Rational,
    pub text: String,
}

/// `HH:MM:SS,mmm` / `HH:MM:SS.mmm` / `MM:SS.mmm` to exact milliseconds.
fn stamp(s: &str) -> Option<Rational> {
    let s = s.trim().replace(',', ".");
    let (hms, ms) = s.split_once('.')?;
    let ms: String = ms.chars().take(3).collect();
    let ms_val: i64 = format!("{ms:0<3}").parse().ok()?;
    let parts: Vec<i64> = hms.split(':').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let secs = match parts.as_slice() {
        [h, m, s] => h * 3600 + m * 60 + s,
        [m, s] => m * 60 + s,
        _ => return None,
    };
    Some(Rational::new(secs * 1000 + ms_val, 1000))
}

/// Parse SRT or WebVTT text. Blocks without a valid time line are ignored; overlapping cues are trimmed so each ends where
/// the next begins (titles share one track). Markup tags such as `<i>` are removed.
pub fn parse(text: &str) -> Result<Vec<Cue>> {
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let mut cues: Vec<Cue> = vec![];
    for block in text.split("\n\n") {
        let lines: Vec<&str> = block.lines().map(str::trim_end).collect();
        let Some(ti) = lines.iter().position(|l| l.contains("-->")) else { continue };
        let (a, b) = lines[ti].split_once("-->").expect("checked");
        // WebVTT may append cue settings after the end time
        let b = b.trim().split_whitespace().next().unwrap_or("");
        let (Some(start), Some(end)) = (stamp(a), stamp(b)) else { continue };
        let body = lines[ti + 1..].join("\n");
        let mut clean = String::new();
        let mut in_tag = false;
        for ch in body.chars() {
            match ch {
                '<' => in_tag = true,
                '>' if in_tag => in_tag = false,
                c if !in_tag => clean.push(c),
                _ => {}
            }
        }
        let clean = clean.trim().to_string();
        if clean.is_empty() || end <= start {
            continue;
        }
        cues.push(Cue { start, end, text: clean });
    }
    if cues.is_empty() {
        return Err(Error::validation("no subtitle cues found (expected SubRip .srt or WebVTT .vtt)"));
    }
    cues.sort_by(|x, y| x.start.cmp(&y.start));
    for i in 0..cues.len() - 1 {
        if cues[i].end > cues[i + 1].start {
            cues[i].end = cues[i + 1].start;
        }
    }
    cues.retain(|c| c.end > c.start);
    Ok(cues)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_srt_with_tags_and_trims_overlaps() {
        let srt = "\u{feff}1\r\n00:00:01,000 --> 00:00:03,500\r\nHello <i>world</i>\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nTwo\r\nlines\r\n\r\n3\r\nnonsense\r\n";
        let c = parse(srt).unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].text, "Hello world");
        assert_eq!(c[0].start, Rational::new(1, 1));
        assert_eq!(c[0].end, Rational::new(3, 1), "trimmed to the next cue");
        assert_eq!(c[1].text, "Two\nlines");
        assert_eq!(c[1].end, Rational::new(4, 1));
    }

    #[test]
    fn parses_webvtt_short_timestamps_and_settings() {
        let vtt = "WEBVTT\n\ncue1\n01:02.250 --> 01:03.000 align:start\nHi\n";
        let c = parse(vtt).unwrap();
        assert_eq!(c[0].start, Rational::new(62250, 1000));
        assert_eq!(c[0].end, Rational::new(63, 1));
    }

    #[test]
    fn rejects_files_without_cues() {
        assert!(parse("hello").is_err());
    }
}
