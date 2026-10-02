use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

/// Engine error type. Messages are user-facing and name the exact problem (spec §113).
#[derive(Debug, Error)]
pub enum Error {
    #[error("validation failed: {0}")]
    Validation(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("I/O error on {path}: {source}")]
    Io { path: String, #[source] source: std::io::Error },
    #[error("project file error: {0}")]
    Project(String),
    #[error("{tool} could not be run: {reason}")]
    ToolUnavailable { tool: String, reason: String },
    #[error("{tool} failed (exit code {code:?}): {hint}")]
    ToolFailed { tool: String, code: Option<i32>, hint: String },
    #[error("job was canceled")]
    Canceled,
    #[error("nothing to {0}")]
    NothingTo(&'static str),
}

impl Error {
    pub fn io(path: impl AsRef<std::path::Path>, source: std::io::Error) -> Error {
        Error::Io { path: path.as_ref().display().to_string(), source }
    }
    pub fn validation(msg: impl Into<String>) -> Error {
        Error::Validation(msg.into())
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Project(e.to_string())
    }
}
