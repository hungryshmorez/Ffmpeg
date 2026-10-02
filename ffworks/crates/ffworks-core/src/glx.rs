//! GL-Transitions ported to FFmpeg's stock `xfade` as custom expressions. Stock (and the bundled) FFmpeg has no OpenGL
//! `gl-transition` filter, so only shaders that can be written as a per-pixel expression are offered; the rest of the
//! gl-transitions catalogue (textures, loops, multi-pass) is not available and is not faked.
//!
//! The expressions come from the MIT-licensed xfade-easing project (https://github.com/scriptituk/xfade-easing, © 2025
//! Raymond Luckhurst), which ported the MIT-licensed gl-transitions shaders (https://github.com/gl-transitions/gl-transitions);
//! licences are in `assets/glx/`. `assets/glx/transitions.tsv` is `name<TAB>expression`, expressions written for the
//! `yuv420p` planes that FFWORKS's transition path uses (they branch on `PLANE`).

use std::sync::OnceLock;

const DATA: &str = include_str!("../assets/glx/transitions.tsv");

fn table() -> &'static Vec<(&'static str, &'static str)> {
    static T: OnceLock<Vec<(&'static str, &'static str)>> = OnceLock::new();
    T.get_or_init(|| DATA.lines().filter_map(|l| l.split_once('\t')).collect())
}

/// `(name, expression)` for every bundled GL transition, e.g. `gl_angular`.
pub fn all() -> &'static [(&'static str, &'static str)] {
    table()
}

pub fn expr(name: &str) -> Option<&'static str> {
    table().iter().find(|(n, _)| *n == name).map(|(_, e)| *e)
}

pub fn is_gl(name: &str) -> bool {
    name.starts_with("gl_") && expr(name).is_some()
}

/// Display name: `gl_polka_dots` → `GL Polka Dots`.
pub fn label(name: &str) -> String {
    let rest = name.strip_prefix("gl_").unwrap_or(name);
    let words: Vec<String> = rest
        .split('_')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        })
        .collect();
    format!("GL {}", words.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_well_formed() {
        assert!(all().len() >= 40, "{}", all().len());
        for (n, e) in all() {
            assert!(n.starts_with("gl_") && n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'), "{n}");
            assert!(!e.is_empty() && !e.contains('\n') && !e.contains('\t') && !e.contains('\''), "{n}: expression must be one line without quotes");
            assert!(e.contains("P") && (e.contains('A') || e.contains('B')), "{n}: not an xfade expression");
        }
        let mut names: Vec<_> = all().iter().map(|(n, _)| *n).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), all().len(), "duplicate names");
        assert!(is_gl("gl_angular") && !is_gl("fade") && !is_gl("gl_nope"));
    }

    #[test]
    fn labels() {
        assert_eq!(label("gl_angular"), "GL Angular");
        assert_eq!(label("gl_polka_dots_curtain"), "GL Polka Dots Curtain");
    }
}
