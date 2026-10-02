//! User-built filter graphs (the node editor's data model). A graph is a DAG of FFmpeg filters between a fixed `in`
//! node (the clip's picture at that point of its effect stack) and a fixed `out` node. It is validated here and
//! compiled to filtergraph statements that the render graph splices into a clip's chain.
//!
//! This is a denylist, not a sandbox: filters and options that read or write files, load plugins or talk to the
//! network are refused, but FFmpeg itself is not isolated from the user's machine.

use crate::error::{Error, Result};
use crate::titles::escape_filter_value;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const IN: &str = "in";
pub const OUT: &str = "out";
pub const MAX_NODES: usize = 64;
pub const MAX_EDGES: usize = 128;

/// Filters refused because they read/write files, load plugins or models, or open network connections.
pub const DENIED_FILTERS: &[&str] = &[
    "movie", "amovie", "sendcmd", "asendcmd", "zmq", "azmq", "subtitles", "ass", "ladspa", "lv2", "frei0r", "dnn_processing", "libplacebo", "lensfun",
    "vidstabdetect", "vidstabtransform", "signature", "ssim", "psnr", "msad", "sofalizer", "haldclut", "lut3d", "ametadata", "metadata", "openclsrc",
    "program_opencl", "hwupload", "hwdownload", "hwmap",
];
/// Option names refused on any filter (file paths and output files).
pub const DENIED_OPTIONS: &[&str] = &["filename", "file", "textfile", "fontfile", "psfile", "stats_file", "result", "model", "custom_shader_path", "shader_path", "initfile", "f_file"];

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct GNode {
    pub id: String,
    /// FFmpeg filter name; empty for the `in` and `out` nodes.
    #[serde(default)]
    pub filter: String,
    /// `key=value` options in the order given.
    #[serde(default)]
    pub options: Vec<(String, String)>,
    /// Editor position only.
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct GEdge {
    pub from: String,
    #[serde(default)]
    pub from_pad: usize,
    pub to: String,
    #[serde(default)]
    pub to_pad: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct FilterGraph {
    pub nodes: Vec<GNode>,
    pub edges: Vec<GEdge>,
}

fn name_ok(s: &str) -> bool {
    s.chars().next().is_some_and(|c| c.is_ascii_lowercase()) && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}
fn key_ok(s: &str) -> bool {
    s.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

impl FilterGraph {
    /// `in` wired straight to `out`: changes nothing.
    pub fn passthrough() -> FilterGraph {
        FilterGraph {
            nodes: vec![GNode { id: IN.into(), x: 0.0, y: 0.0, ..Default::default() }, GNode { id: OUT.into(), x: 400.0, y: 0.0, ..Default::default() }],
            edges: vec![GEdge { from: IN.into(), from_pad: 0, to: OUT.into(), to_pad: 0 }],
        }
    }

    pub fn validate(&self) -> Result<()> {
        let bad = |m: String| Err(Error::validation(format!("filter graph: {m}")));
        if self.nodes.len() > MAX_NODES || self.edges.len() > MAX_EDGES {
            return bad(format!("too large (max {MAX_NODES} nodes, {MAX_EDGES} connections)"));
        }
        let mut ids = BTreeSet::new();
        for n in &self.nodes {
            if !ids.insert(n.id.as_str()) {
                return bad(format!("duplicate node id '{}'", n.id));
            }
            if n.id == IN || n.id == OUT {
                if !n.filter.is_empty() || !n.options.is_empty() {
                    return bad(format!("'{}' is a fixed node and cannot hold a filter", n.id));
                }
                continue;
            }
            if !n.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') || n.id.is_empty() {
                return bad(format!("bad node id '{}'", n.id));
            }
            if !name_ok(&n.filter) {
                return bad(format!("node '{}' has an invalid filter name '{}'", n.id, n.filter));
            }
            if DENIED_FILTERS.contains(&n.filter.as_str()) {
                return bad(format!("filter '{}' is not allowed (it reads files, loads plugins or uses the network)", n.filter));
            }
            for (k, v) in &n.options {
                if !key_ok(k) {
                    return bad(format!("node '{}' has an invalid option name '{k}'", n.id));
                }
                if DENIED_OPTIONS.contains(&k.as_str()) {
                    return bad(format!("option '{k}' is not allowed (it names a file)"));
                }
                if v.len() > 2000 || v.contains('\0') || v.contains('\n') {
                    return bad(format!("option '{k}' on '{}' has an invalid value", n.id));
                }
            }
        }
        if !ids.contains(IN) || !ids.contains(OUT) {
            return bad("needs an 'in' and an 'out' node".into());
        }
        let mut into: BTreeMap<(&str, usize), usize> = BTreeMap::new();
        let mut from: BTreeMap<(&str, usize), usize> = BTreeMap::new();
        for e in &self.edges {
            if !ids.contains(e.from.as_str()) || !ids.contains(e.to.as_str()) {
                return bad(format!("connection {}→{} names a missing node", e.from, e.to));
            }
            if e.from == OUT || e.to == IN {
                return bad("'in' has only an output and 'out' only an input".into());
            }
            if e.from == e.to {
                return bad(format!("node '{}' is connected to itself", e.from));
            }
            if e.from == IN && e.from_pad != 0 || e.to == OUT && e.to_pad != 0 {
                return bad("'in' and 'out' have a single pad".into());
            }
            *into.entry((e.to.as_str(), e.to_pad)).or_default() += 1;
            *from.entry((e.from.as_str(), e.from_pad)).or_default() += 1;
        }
        if into.values().any(|&n| n > 1) {
            return bad("an input pad has more than one connection".into());
        }
        if let Some(((n, p), _)) = from.iter().find(|(_, &c)| c > 1) {
            return bad(format!("output {p} of '{n}' feeds more than one node; add a split filter to duplicate a picture"));
        }
        // pads must be numbered without gaps
        for n in &self.nodes {
            for (m, what) in [(&into, "input"), (&from, "output")] {
                let pads: Vec<usize> = m.keys().filter(|(id, _)| *id == n.id).map(|(_, p)| *p).collect();
                if let Some(max) = pads.iter().max() {
                    if pads.len() != max + 1 {
                        return bad(format!("'{}' skips an {what} pad (pads must be used in order from 0)", n.id));
                    }
                }
            }
            if n.id != OUT && !from.contains_key(&(n.id.as_str(), 0)) {
                return bad(format!("'{}' has nothing connected to its output", n.id));
            }
        }
        if !into.contains_key(&(OUT, 0)) {
            return bad("'out' has nothing connected".into());
        }
        self.topo_order().map(|_| ())
    }

    /// Node ids in dependency order, or an error when the graph has a cycle.
    pub fn topo_order(&self) -> Result<Vec<&GNode>> {
        let mut indeg: BTreeMap<&str, usize> = self.nodes.iter().map(|n| (n.id.as_str(), 0)).collect();
        for e in &self.edges {
            if let Some(d) = indeg.get_mut(e.to.as_str()) {
                *d += 1;
            }
        }
        let mut ready: Vec<&str> = self.nodes.iter().map(|n| n.id.as_str()).filter(|i| indeg[i] == 0).collect();
        let mut order = vec![];
        while let Some(id) = ready.pop() {
            order.push(self.nodes.iter().find(|n| n.id == id).unwrap());
            for e in self.edges.iter().filter(|e| e.from == id) {
                let d = indeg.get_mut(e.to.as_str()).unwrap();
                *d -= 1;
                if *d == 0 {
                    ready.push(e.to.as_str());
                }
            }
        }
        if order.len() != self.nodes.len() {
            return Err(Error::validation("filter graph: connections form a loop"));
        }
        Ok(order)
    }

    /// FFmpeg filter names the graph needs.
    pub fn requires(&self) -> Vec<String> {
        let mut v: Vec<String> = self.nodes.iter().filter(|n| !n.filter.is_empty()).map(|n| n.filter.clone()).collect();
        v.sort();
        v.dedup();
        v
    }

    /// Filtergraph statements joined by `;`, reading `[input]` and writing `[output]`. `tag` makes inner labels unique.
    pub fn compile(&self, tag: &str, input: &str, output: &str) -> Result<String> {
        self.validate()?;
        let label = |e: &GEdge, i: usize| -> String {
            if e.from == IN {
                input.to_string()
            } else if e.to == OUT {
                output.to_string()
            } else {
                format!("{tag}e{i}")
            }
        };
        let mut stmts = vec![];
        if self.edges.iter().any(|e| e.from == IN && e.to == OUT) {
            stmts.push(format!("[{input}]null[{output}]"));
        }
        for n in self.topo_order()?.into_iter().filter(|n| n.id != IN && n.id != OUT) {
            let mut ins: Vec<(usize, String)> = self.edges.iter().enumerate().filter(|(_, e)| e.to == n.id).map(|(i, e)| (e.to_pad, label(e, i))).collect();
            ins.sort();
            let mut outs: Vec<(usize, String)> = self.edges.iter().enumerate().filter(|(_, e)| e.from == n.id).map(|(i, e)| (e.from_pad, label(e, i))).collect();
            outs.sort();
            let opts: Vec<String> = n.options.iter().map(|(k, v)| format!("{k}={}", escape_filter_value(v))).collect();
            let body = if opts.is_empty() { n.filter.clone() } else { format!("{}={}", n.filter, opts.join(":")) };
            let wrap = |v: &[(usize, String)]| v.iter().map(|(_, l)| format!("[{l}]")).collect::<String>();
            stmts.push(format!("{}{body}{}", wrap(&ins), wrap(&outs)));
        }
        Ok(stmts.join(";"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, filter: &str, opts: &[(&str, &str)]) -> GNode {
        GNode { id: id.into(), filter: filter.into(), options: opts.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), x: 0.0, y: 0.0 }
    }
    fn edge(from: &str, fp: usize, to: &str, tp: usize) -> GEdge {
        GEdge { from: from.into(), from_pad: fp, to: to.into(), to_pad: tp }
    }
    fn base() -> FilterGraph {
        let mut g = FilterGraph::passthrough();
        g.edges.clear();
        g
    }

    #[test]
    fn passthrough_compiles_to_null() {
        assert_eq!(FilterGraph::passthrough().compile("g", "a", "b").unwrap(), "[a]null[b]");
    }

    #[test]
    fn chain_compiles_in_order() {
        let mut g = base();
        g.nodes.push(node("n1", "hue", &[("s", "0")]));
        g.nodes.push(node("n2", "negate", &[]));
        g.edges = vec![edge("in", 0, "n1", 0), edge("n1", 0, "n2", 0), edge("n2", 0, "out", 0)];
        assert_eq!(g.compile("g", "a", "b").unwrap(), "[a]hue=s=0[ge1];[ge1]negate[b]");
    }

    #[test]
    fn split_and_merge_compiles() {
        let mut g = base();
        g.nodes.push(node("sp", "split", &[]));
        g.nodes.push(node("ng", "negate", &[]));
        g.nodes.push(node("bl", "blend", &[("all_expr", "A*0.5+B*0.5")]));
        g.edges = vec![edge("in", 0, "sp", 0), edge("sp", 0, "bl", 0), edge("sp", 1, "ng", 0), edge("ng", 0, "bl", 1), edge("bl", 0, "out", 0)];
        let c = g.compile("g", "a", "b").unwrap();
        assert!(c.contains("[a]split[ge1][ge2]"), "{c}");
        assert!(c.contains("[ge1][ge3]blend=all_expr=A*0.5+B*0.5[b]"), "{c}");
    }

    #[test]
    fn option_values_are_escaped() {
        let mut g = base();
        g.nodes.push(node("n", "geq", &[("lum", "if(gt(X,1),1:2,0)")]));
        g.edges = vec![edge("in", 0, "n", 0), edge("n", 0, "out", 0)];
        let c = g.compile("g", "a", "b").unwrap();
        assert!(c.contains(r"lum=if(gt(X\,1)\,1\\:2\,0)"), "{c}");
        assert!(!c.contains(";["), "no injected statement: {c}");
    }

    #[test]
    fn rejects_bad_graphs() {
        let mut g = base();
        g.nodes.push(node("a", "negate", &[]));
        g.nodes.push(node("b", "negate", &[]));
        g.edges = vec![edge("in", 0, "a", 0), edge("a", 0, "b", 0), edge("b", 0, "a", 0), edge("b", 0, "out", 0)];
        assert!(g.validate().is_err()); // b feeds two nodes and loops

        let mut cyc = base();
        cyc.nodes.push(node("a", "negate", &[]));
        cyc.nodes.push(node("b", "negate", &[]));
        cyc.edges = vec![edge("in", 0, "a", 0), edge("a", 0, "b", 0), edge("b", 0, "a", 1), edge("a", 1, "out", 0)];
        assert!(cyc.validate().is_err());

        let mut denied = base();
        denied.nodes.push(node("m", "movie", &[("filename", "/etc/passwd")]));
        denied.edges = vec![edge("m", 0, "out", 0)];
        assert!(denied.validate().unwrap_err().to_string().contains("not allowed"));

        let mut file_opt = base();
        file_opt.nodes.push(node("t", "drawtext", &[("textfile", "/etc/passwd")]));
        file_opt.edges = vec![edge("in", 0, "t", 0), edge("t", 0, "out", 0)];
        assert!(file_opt.validate().unwrap_err().to_string().contains("textfile"));

        let mut dup_out = base();
        dup_out.nodes.push(node("a", "negate", &[]));
        dup_out.nodes.push(node("b", "negate", &[]));
        dup_out.edges = vec![edge("in", 0, "a", 0), edge("in", 0, "b", 0), edge("a", 0, "out", 0)];
        assert!(dup_out.validate().is_err());

        let mut inject = base();
        inject.nodes.push(node("x", "negate;movie", &[]));
        inject.edges = vec![edge("in", 0, "x", 0), edge("x", 0, "out", 0)];
        assert!(inject.validate().is_err());

        let mut dangling = base();
        dangling.nodes.push(node("x", "negate", &[]));
        dangling.edges = vec![edge("in", 0, "out", 0)];
        assert!(dangling.validate().is_err());
    }

    #[test]
    fn requires_lists_filters() {
        let mut g = base();
        g.nodes.push(node("n1", "hue", &[]));
        g.nodes.push(node("n2", "hue", &[]));
        assert_eq!(g.requires(), vec!["hue".to_string()]);
    }
}
