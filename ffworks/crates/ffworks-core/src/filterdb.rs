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
        // flag columns (`T`imeline, `S`lice threads, `C`ommand): three on FFmpeg 6/7 but only two (`TS`, `..`) on the Windows
        // build in CI, so accept 2-3 characters of `.`/capitals
        if !(2..=3).contains(&flags.len()) || !flags.chars().all(|c| c == '.' || c.is_ascii_uppercase()) || !io.contains("->") {
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

/// Problems with a graph that only FFmpeg's own pad counts can reveal (unknown filter, missing or extra connections).
/// Empty means every node's connections match what the filter declares. Dynamic-pad filters are not checked.
pub fn check_pads(tools: &Tools, g: &crate::filtergraph::FilterGraph) -> Result<Vec<String>> {
    g.validate()?;
    let mut problems = vec![];
    for n in g.nodes.iter().filter(|n| !n.filter.is_empty()) {
        let help = match tools.filter_help(&n.filter) {
            Ok(h) => h,
            Err(_) => {
                problems.push(format!("'{}': this FFmpeg has no filter called '{}'", n.id, n.filter));
                continue;
            }
        };
        let dynamic = |pads: &[String]| pads.iter().any(|p| p.starts_with("dynamic"));
        let ins = g.edges.iter().filter(|e| e.to == n.id).count();
        let outs = g.edges.iter().filter(|e| e.from == n.id).count();
        if !dynamic(&help.inputs) && ins != help.inputs.len() {
            problems.push(format!("'{}' ({}) takes {} input(s) but {} connected", n.id, n.filter, help.inputs.len(), ins));
        }
        // `split` is the one dynamic-output filter people always use: its count is its `outputs` option (default 2)
        let want_outs = if n.filter == "split" {
            Some(n.options.iter().find(|(k, _)| k == "outputs").and_then(|(_, v)| v.parse::<usize>().ok()).unwrap_or(2))
        } else if dynamic(&help.outputs) {
            None
        } else {
            Some(help.outputs.len())
        };
        if let Some(w) = want_outs.filter(|w| *w != outs) {
            problems.push(format!("'{}' ({}) has {} output(s) but {} connected", n.id, n.filter, w, outs));
        }
    }
    Ok(problems)
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
    fn parses_two_column_flags_and_separator_line() {
        // verbatim from the Windows CI FFmpeg
        let o = "Filters:\r\n  T.. = Timeline support\r\n  .S. = Slice threading\r\n  | = Source or sink filter\r\n  ------\r\n TS aap               AA->A      Apply Affine Projection algorithm to first audio stream.\r\n .. abench            A->A       Benchmark part of a filtergraph.\r\n";
        let l = parse_filter_list(o);
        assert_eq!(l.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["aap", "abench"]);
        assert!(l[0].timeline && !l[1].timeline);
        assert_eq!(l[0].io, "AA->A");
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
