//! FFWORKS engine. GUI-free by design so the editor, tests and a future headless CLI share it.
pub mod analysis;
pub mod brand;
pub mod commands;
pub mod effects;
pub mod engine;
pub mod error;
pub mod ffmpeg;
pub mod ffprobe;
pub mod jobs;
pub mod migrate;
pub mod patch;
pub mod preview;
pub mod process;
pub mod project;
pub mod recovery;
pub mod relink;
pub mod render_graph;
pub mod settings;
pub mod time;

pub use commands::{Command, Edge};
pub use engine::Engine;
pub use error::{Error, Result};
pub use time::Rational;
