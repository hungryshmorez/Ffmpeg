//! Filter browser backend: what filters the installed FFmpeg has and what options each takes, parsed from
//! `ffmpeg -filters` and `ffmpeg -h filter=NAME`. Nothing is hard-coded, so it matches the user's actual build.

use crate::error::{Error, Result};
use crate::process::Tools;
use serde::{Deserialize, Serialize};

/// Media type on a filter pad summary: `V` video, `A` audio, `N` dynamic, `|` source/sink (no pads), `?` other.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FilterInfo {
    pub name: String,
    /// e.g. `V->V`, `AA->A`, `|->V`, `N->N`
    pub io: String,
    pub description: String,
    pub timeline: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FilterOption {
    pub name: String,
    /// `int`, `float`, `string`, `boolean`, `flags`, `duration`, `color`, `rational`, `image_size`, `pix_fmt`, … as FFmpeg reports.
    pub kind: String,
    pub description: String,
    pub default: Option<String>,
    pub min: Option<String>,
    pub max: Option<String>,
    /// Named constants for enum/flags options: `(name, description)`.
    pub choices: Vec<(String, String)>,
    /// Can the value be changed by expression per frame / via commands (flag `T` in FFmpeg's option flags)?
    pub dynamic: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FilterHelp {
    pub name: String,
    pub description: String,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub options: Vec<FilterOption>,
    pub timeline: bool,
}

/// Parse `ffmpeg -filters` rows: `<3 flag chars> <name> <io> <description>`.
pub fn parse_filter_list(out: &str) -> Vec<FilterInfo> {
    let mut v = Vec::new();
    for line in out.lines() {
        let mut p = line.split_whitespace();
        let (Some(flags), Some(name), Some(io)) = (p.next(), p.next(), p.next()) else { continue };
        if flags.len() != 3 || !flags.chars().all(|c| "T.S.C".contains(c)) || !io.contains("->") {
            continue;
        }
        let desc: Vec<&str> = p.collect();
        v.push(FilterInfo { name: name.to_string(), io: io.to_string(), description: desc.join(" "), timeline: flags.starts_with('T') });
    }
    v
}

/// Split `... (from A to B) (default D)` style tails out of an option description.
fn split_tail(desc: &str) -> (String, Option<String>, Option<String>, Option<String>) {
    let mut text = desc.trim().to_string();
    let (mut min, mut max, mut def) = (None, None, None);
    loop {
        let t = text.trim_end();
        if !t.ends_with(')') {
            break;
        }
        let Some(open) = t.rfind('(') else { break };
        let inner = &t[open + 1..t.len() - 1];
        if let Some(r) = inner.strip_prefix("from ") {
            if let Some((a, b)) = r.split_once(" to ") {
                min = Some(a.trim().to_string());
                max = Some(b.trim().to_string());
                text = t[..open].to_string();
                continue;
            }
        }
        if let Some(d) = inner.strip_prefix("default ") {
            def = Some(d.trim().trim_matches('"').to_string());
            text = t[..open].to_string();
            continue;
        }
        break;
    }
    (text.trim().to_string(), min, max, def)
}

/// Parse the output of `ffmpeg -h filter=NAME`.
pub fn parse_filter_help(name: &str, help: &str) -> Result<FilterHelp> {
    let mut lines = help.lines();
    let first = lines.next().unwrap_or("");
    if !first.starts_with("Filter ") {
        return Err(Error::NotFound(format!("filter '{name}'")));
    }
    let mut out = FilterHelp { name: name.to_string(), description: String::new(), inputs: vec![], outputs: vec![], options: vec![], timeline: false };
    #[derive(PartialEq)]
    enum Sec {
        Head,
        In,
        Out,
        Opts,
    }
    let mut sec = Sec::Head;
    for line in lines {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if t == "Inputs:" {
            sec = Sec::In;
            continue;
        }
        if t == "Outputs:" {
            sec = Sec::Out;
            continue;
        }
        if t.ends_with("AVOptions:") {
            sec = Sec::Opts;
            continue;
        }
        if t.contains("support for timeline") {
            out.timeline = true;
            continue;
        }
        match sec {
            Sec::Head => {
                if out.description.is_empty() && !t.contains("threading") {
                    out.description = t.to_string();
                }
            }
            Sec::In | Sec::Out => {
                if t.starts_with('#') {
                    let pad = t.split_once(':').map(|x| x.1.trim().to_string()).unwrap_or_default();
                    if sec == Sec::In { out.inputs.push(pad) } else { out.outputs.push(pad) }
                } else if t.starts_with("dynamic") || t.starts_with("none") {
                    let l = t.to_string();
                    if sec == Sec::In { out.inputs.push(l) } else { out.outputs.push(l) }
                }
            }
            Sec::Opts => {
                let indent = line.len() - line.trim_start().len();
                let mut p = t.split_whitespace();
                let (Some(oname), Some(kind)) = (p.next(), p.next()) else { continue };
                let rest: Vec<&str> = p.collect();
                // `name <kind> <flags> description` for options, `name value <flags> description` for constants
                if indent <= 3 && kind.starts_with('<') {
                    let Some((flags, desc)) = rest.split_first() else { continue };
                    let (text, min, max, def) = split_tail(&desc.join(" "));
                    out.options.push(FilterOption {
                        name: oname.to_string(),
                        kind: kind.trim_matches(|c| c == '<' || c == '>').to_string(),
                        description: text,
                        default: def,
                        min,
                        max,
                        choices: vec![],
                        dynamic: flags.contains('T'),
                    });
                } else if indent > 3 {
                    if let (Some(last), Some((_flags, desc))) = (out.options.last_mut(), rest.split_first()) {
                        last.choices.push((oname.to_string(), desc.join(" ")));
                    }
                }
            }
        }
    }
    Ok(out)
}

impl Tools {
    pub fn list_filters(&self) -> Result<Vec<FilterInfo>> {
        let o = self.run_capture(&self.ffmpeg, &["-hide_banner", "-filters"], None)?;
        Ok(parse_filter_list(&o))
    }

    pub fn filter_help(&self, name: &str) -> Result<FilterHelp> {
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(Error::validation(format!("bad filter name '{name}'")));
        }
        let o = self.run_capture(&self.ffmpeg, &["-hide_banner", "-h", &format!("filter={name}")], None)?;
        parse_filter_help(name, &o)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_list_rows_and_skips_legend() {
        let o = "Filters:\n  T.. = Timeline support\n ... acopy             A->A       Copy the input audio unchanged.\n T.C hue               V->V       Adjust the hue and saturation.\n ... color             |->V       Provide an uniformly colored input.\n";
        let l = parse_filter_list(o);
        assert_eq!(l.len(), 3);
        assert_eq!(l[1].name, "hue");
        assert!(l[1].timeline);
        assert_eq!(l[2].io, "|->V");
    }

    #[test]
    fn splits_range_and_default() {
        let (t, mn, mx, d) = split_tail("set saturation (from -10 to 10) (default 1)");
        assert_eq!((t.as_str(), mn.as_deref(), mx.as_deref(), d.as_deref()), ("set saturation", Some("-10"), Some("10"), Some("1")));
    }

    #[test]
    fn rejects_unknown_filter() {
        assert!(parse_filter_help("nope", "Unknown filter 'nope'.\n").is_err());
    }
}
