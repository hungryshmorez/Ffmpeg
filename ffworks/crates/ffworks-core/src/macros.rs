//! Macros: a recorded list of commands that can be replayed on another clip. Clip ids are specific to one project, so
//! when a recording is saved the first clip it touches is replaced by the placeholder `$selected`; replaying substitutes
//! whichever clip the user (or the CLI's `--selected`) names.

use crate::commands::Command;
use crate::error::{Error, Result};
use serde_json::Value;

pub const PLACEHOLDER: &str = "$selected";

fn first_clip(v: &Value) -> Option<String> {
    match v {
        Value::Object(m) => {
            if let Some(Value::String(c)) = m.get("clip") {
                return Some(c.clone());
            }
            m.values().find_map(first_clip)
        }
        Value::Array(a) => a.iter().find_map(first_clip),
        _ => None,
    }
}

fn replace(v: &mut Value, from: &str, to: &str) {
    match v {
        Value::String(s) if s == from => *s = to.to_string(),
        Value::Array(a) => a.iter_mut().for_each(|x| replace(x, from, to)),
        Value::Object(m) => m.values_mut().for_each(|x| replace(x, from, to)),
        _ => {}
    }
}

/// The recorded commands as JSON with the first clip they touch replaced by `$selected`. Errors when no command names a clip
/// (such a recording has nothing to replay on).
pub fn parameterise(commands: &[Command]) -> Result<Value> {
    let mut v = serde_json::to_value(commands)?;
    let first = first_clip(&v).ok_or_else(|| Error::validation("this recording does not touch any clip, so it cannot be replayed on a selected clip"))?;
    replace(&mut v, &first, PLACEHOLDER);
    Ok(v)
}

/// Parse a macro/script, substituting `selected` for `$selected`. A script that uses the placeholder needs a clip.
pub fn instantiate(script: &str, selected: Option<&str>) -> Result<Vec<Command>> {
    let mut v: Value = serde_json::from_str(script).map_err(|e| Error::validation(format!("not a JSON list of commands: {e}")))?;
    if script.contains(PLACEHOLDER) {
        let sel = selected.ok_or_else(|| Error::validation("this macro works on a clip: select one first"))?;
        replace(&mut v, PLACEHOLDER, sel);
    }
    serde_json::from_value(v).map_err(|e| Error::validation(format!("not a valid command list: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec() -> Vec<Command> {
        vec![
            Command::AddEffect { clip: "clp_a".into(), effect: "blur".into(), params: Default::default(), index: None },
            Command::SetClipGain { clip: "clp_a".into(), gain_db: -3.0, relative: false },
            Command::AddMarker { time: crate::Rational::from_int(1), name: "m".into(), color: None, note: None },
        ]
    }

    #[test]
    fn the_first_clip_becomes_the_placeholder_everywhere_and_comes_back_as_any_clip() {
        let v = parameterise(&rec()).unwrap();
        let text = v.to_string();
        assert!(!text.contains("clp_a") && text.matches("$selected").count() == 2);
        let back = instantiate(&text, Some("clp_zzz")).unwrap();
        assert_eq!(back[0], Command::AddEffect { clip: "clp_zzz".into(), effect: "blur".into(), params: Default::default(), index: None });
        assert!(matches!(&back[1], Command::SetClipGain { clip, .. } if clip == "clp_zzz"));
        assert!(instantiate(&text, None).is_err(), "needs a clip");
    }

    #[test]
    fn recordings_without_a_clip_are_refused_and_plain_scripts_need_no_clip() {
        assert!(parameterise(&rec()[2..]).is_err());
        let plain = serde_json::to_string(&rec()[2..]).unwrap();
        assert_eq!(instantiate(&plain, None).unwrap().len(), 1);
        assert!(instantiate("{", None).is_err());
    }
}
