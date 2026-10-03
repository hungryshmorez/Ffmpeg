//! The media library: a small SQLite index (bundled [SQLite](https://sqlite.org), public domain, through
//! [`rusqlite`](https://github.com/rusqlite/rusqlite), MIT) of every source file that was ever imported into any project on
//! this machine. It answers "where did I put that clip?" without opening projects, and lets relinking look where the file used
//! to be seen instead of scanning a whole disk.
//!
//! The index only *remembers* what imports already learned (path, content fingerprint, size, duration, picture/sound, size of
//! the picture); it never reads media files itself and holds nothing a project does not. Deleting the database loses nothing
//! but the memory. Generated media (solids, titles, compounds) has no file and is never recorded.

use crate::error::{Error, Result};
use crate::project::{MediaAsset, Project};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Version of the table layout (`PRAGMA user_version`). Bump with a migration step in [`Library::migrate`].
pub const SCHEMA_VERSION: i64 = 1;

/// One remembered file.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub fingerprint: Option<String>,
    pub size_bytes: Option<u64>,
    pub duration: f64,
    pub has_video: bool,
    pub has_audio: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub container: String,
    pub first_seen_unix: i64,
    pub last_seen_unix: i64,
    /// Whether the file is there right now (checked when the entry is read, not stored).
    pub exists: bool,
}

pub struct Library {
    conn: Connection,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn db(e: rusqlite::Error) -> Error {
    Error::validation(format!("media library: {e}"))
}

/// `%`, `_` and `\` in what the user typed must match themselves, not act as wildcards.
fn like_pattern(token: &str) -> String {
    let mut out = String::from("%");
    for c in token.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

impl Library {
    /// Open (creating it and its folder when needed) the library at `path`.
    pub fn open(path: &Path) -> Result<Library> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| Error::io(dir, e))?;
        }
        Self::init(Connection::open(path).map_err(db)?)
    }

    pub fn open_in_memory() -> Result<Library> {
        Self::init(Connection::open_in_memory().map_err(db)?)
    }

    fn init(conn: Connection) -> Result<Library> {
        conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(db)?;
        let lib = Library { conn };
        lib.migrate()?;
        Ok(lib)
    }

    fn migrate(&self) -> Result<()> {
        let v: i64 = self.conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(db)?;
        if v > SCHEMA_VERSION {
            return Err(Error::validation(format!("the media library was made by a newer FFWORKS (layout {v}, this one knows {SCHEMA_VERSION})")));
        }
        if v < 1 {
            self.conn
                .execute_batch(
                    "BEGIN;
                     CREATE TABLE media (
                        path TEXT PRIMARY KEY NOT NULL,
                        name TEXT NOT NULL,
                        fingerprint TEXT,
                        size_bytes INTEGER,
                        duration REAL NOT NULL,
                        has_video INTEGER NOT NULL,
                        has_audio INTEGER NOT NULL,
                        width INTEGER,
                        height INTEGER,
                        container TEXT NOT NULL,
                        first_seen INTEGER NOT NULL,
                        last_seen INTEGER NOT NULL
                     );
                     CREATE INDEX media_fingerprint ON media(fingerprint);
                     CREATE INDEX media_last_seen ON media(last_seen DESC);
                     PRAGMA user_version = 1;
                     COMMIT;",
                )
                .map_err(db)?;
        }
        Ok(())
    }

    /// Remember `asset` (updates the entry for the same path). Generated media is ignored.
    pub fn record(&self, asset: &MediaAsset) -> Result<()> {
        if asset.is_generated() {
            return Ok(());
        }
        let name = Path::new(&asset.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| asset.name.clone());
        let video = asset.info.video.first();
        let t = now();
        self.conn
            .execute(
                "INSERT INTO media (path, name, fingerprint, size_bytes, duration, has_video, has_audio, width, height, container, first_seen, last_seen)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
                 ON CONFLICT(path) DO UPDATE SET name = ?2, fingerprint = ?3, size_bytes = ?4, duration = ?5, has_video = ?6, has_audio = ?7,
                    width = ?8, height = ?9, container = ?10, last_seen = ?11",
                params![asset.path, name, asset.fingerprint, asset.info.size_bytes.map(|s| s as i64), asset.info.duration.as_f64().min(1.0e9), asset.info.has_video(), asset.info.has_audio(), video.map(|v| v.width), video.map(|v| v.height), asset.info.container, t],
            )
            .map_err(db)?;
        Ok(())
    }

    /// Remember every file of `project` (used when a project is opened, so the library also learns older projects).
    pub fn record_project(&self, project: &Project) -> Result<usize> {
        // one transaction: a disk sync per file would make a big project take seconds
        self.conn.execute_batch("BEGIN").map_err(db)?;
        let mut n = 0;
        for m in project.media.iter().filter(|m| !m.is_generated()) {
            if let Err(e) = self.record(m) {
                let _ = self.conn.execute_batch("ROLLBACK");
                return Err(e);
            }
            n += 1;
        }
        self.conn.execute_batch("COMMIT").map_err(db)?;
        Ok(n)
    }

    pub fn len(&self) -> Result<usize> {
        self.conn.query_row("SELECT COUNT(*) FROM media", [], |r| r.get::<_, i64>(0)).map(|n| n as usize).map_err(db)
    }

    pub fn is_empty(&self) -> Result<bool> {
        Ok(self.len()? == 0)
    }

    fn entry(r: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
        let path: String = r.get(0)?;
        Ok(Entry {
            exists: Path::new(&path).is_file(),
            path,
            name: r.get(1)?,
            fingerprint: r.get(2)?,
            size_bytes: r.get::<_, Option<i64>>(3)?.map(|s| s as u64),
            duration: r.get(4)?,
            has_video: r.get(5)?,
            has_audio: r.get(6)?,
            width: r.get(7)?,
            height: r.get(8)?,
            container: r.get(9)?,
            first_seen_unix: r.get(10)?,
            last_seen_unix: r.get(11)?,
        })
    }

    const COLUMNS: &'static str = "path, name, fingerprint, size_bytes, duration, has_video, has_audio, width, height, container, first_seen, last_seen";

    /// Files whose name or path contains every word of `query` (case-insensitive), most recently seen first; an empty query lists
    /// the most recent. At most `limit` entries.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<Entry>> {
        let tokens: Vec<String> = query.split_whitespace().map(like_pattern).collect();
        let mut sql = format!("SELECT {} FROM media", Self::COLUMNS);
        for i in 0..tokens.len() {
            sql.push_str(if i == 0 { " WHERE " } else { " AND " });
            sql.push_str(&format!("(name LIKE ?{0} ESCAPE '\\' OR path LIKE ?{0} ESCAPE '\\')", i + 1));
        }
        sql.push_str(&format!(" ORDER BY last_seen DESC, path LIMIT {}", limit.clamp(1, 1000)));
        let mut stmt = self.conn.prepare(&sql).map_err(db)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(tokens.iter()), Self::entry).map_err(db)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(db)
    }

    /// Everything remembered with this content fingerprint (the same file under different names/places).
    pub fn by_fingerprint(&self, fingerprint: &str) -> Result<Vec<Entry>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {} FROM media WHERE fingerprint = ?1 ORDER BY last_seen DESC", Self::COLUMNS)).map_err(db)?;
        let rows = stmt.query_map([fingerprint], Self::entry).map_err(db)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(db)
    }

    /// Folders where a file that looks like one of the `missing` assets (same fingerprint, or same name and size) is known to
    /// exist now: where relinking should look first.
    pub fn likely_dirs(&self, missing: &[&MediaAsset]) -> Result<Vec<PathBuf>> {
        let mut dirs: Vec<PathBuf> = vec![];
        for a in missing {
            let name = Path::new(&a.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let mut found = match &a.fingerprint {
                Some(fp) => self.by_fingerprint(fp)?,
                None => vec![],
            };
            if let Some(size) = a.info.size_bytes {
                let mut stmt = self.conn.prepare(&format!("SELECT {} FROM media WHERE name = ?1 COLLATE NOCASE AND size_bytes = ?2", Self::COLUMNS)).map_err(db)?;
                let rows = stmt.query_map(params![name, size as i64], Self::entry).map_err(db)?;
                found.extend(rows.collect::<std::result::Result<Vec<_>, _>>().map_err(db)?);
            }
            for e in found.into_iter().filter(|e| e.exists) {
                if let Some(dir) = Path::new(&e.path).parent() {
                    if !dirs.iter().any(|d| d == dir) {
                        dirs.push(dir.to_path_buf());
                    }
                }
            }
        }
        Ok(dirs)
    }

    /// Forget entries whose file is gone. Returns how many were removed.
    pub fn forget_missing(&self) -> Result<usize> {
        let mut stmt = self.conn.prepare("SELECT path FROM media").map_err(db)?;
        let paths: Vec<String> = stmt.query_map([], |r| r.get(0)).map_err(db)?.collect::<std::result::Result<_, _>>().map_err(db)?;
        drop(stmt);
        let mut removed = 0;
        for p in paths.iter().filter(|p| !Path::new(p).is_file()) {
            removed += self.conn.execute("DELETE FROM media WHERE path = ?1", [p]).map_err(db)?;
        }
        Ok(removed)
    }
}
