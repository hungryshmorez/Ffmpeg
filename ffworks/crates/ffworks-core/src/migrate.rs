//! Schema migration (spec §5). Older projects are upgraded step by step on load and never
//! rejected merely because the schema moved on. Projects from a *newer* FFWORKS are refused
//! rather than silently truncated.

use crate::error::{Error, Result};
use crate::project::SCHEMA_VERSION;
use serde_json::Value;

/// One migration step: upgrades a document from `from` to `from + 1`.
type Step = fn(&mut Value) -> Result<()>;

/// Index `n` upgrades version `n+1` → `n+2`. Version 1 is the first released schema, so the table is empty
/// until schema 2 exists; add the step (and a test fixture of a v1 file) in the same change that bumps SCHEMA_VERSION.
const STEPS: &[Step] = &[];

pub fn migrate(mut doc: Value) -> Result<Value> {
    let found = doc
        .get("schema_version")
        .and_then(Value::as_u64)
        .ok_or_else(|| Error::Project("missing schema_version; not an FFWORKS project".into()))? as u32;
    if found > SCHEMA_VERSION {
        return Err(Error::Project(format!(
            "project uses schema {found}, newer than this build understands ({SCHEMA_VERSION}); update FFWORKS"
        )));
    }
    if found == 0 {
        return Err(Error::Project("schema_version 0 is invalid".into()));
    }
    for v in found..SCHEMA_VERSION {
        STEPS[(v - 1) as usize](&mut doc)?;
        doc["schema_version"] = Value::from(v + 1);
    }
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn current_version_passes_through() {
        let d = json!({"schema_version": SCHEMA_VERSION, "x": 1});
        assert_eq!(migrate(d.clone()).unwrap(), d);
    }
    #[test]
    fn newer_is_refused() {
        assert!(migrate(json!({"schema_version": SCHEMA_VERSION + 1})).is_err());
    }
    #[test]
    fn missing_version_is_refused() {
        assert!(migrate(json!({"name": "x"})).is_err());
    }
}
