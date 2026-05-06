use chrono::Utc;
use polysong_core::{
    AppSettings, AudioSource, IngestCandidate, IngestJob, IngestRequest, IngestStatus, JobId,
    Playlist, SettingsPatch, Track, TrackFilter, TrackId, TrackPatch,
};
use rusqlite::{params, Connection, OptionalExtension, Result};
use std::path::Path;

pub struct Repository {
    conn: Connection,
}

impl Repository {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        if let Some(parent) = path.as_ref().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        let repo = Self { conn };
        repo.migrate()?;
        repo.cleanup_placeholder_content()?;
        Ok(repo)
    }

    pub fn in_memory() -> Result<Self> {
        let repo = Self {
            conn: Connection::open_in_memory()?,
        };
        repo.migrate()?;
        repo.cleanup_placeholder_content()?;
        Ok(repo)
    }

    pub fn list_tracks(&self, filter: TrackFilter) -> Result<Vec<Track>> {
        let mut tracks = self.read_tracks()?;
        if let Some(source) = filter.source {
            tracks.retain(|track| track.source == source);
        }
        if filter.favorites_only {
            tracks.retain(|track| track.favorite);
        }
        if let Some(search) = filter.search.filter(|value| !value.trim().is_empty()) {
            let needle = search.to_ascii_lowercase();
            tracks.retain(|track| {
                [
                    Some(track.title.as_str()),
                    track.artist.as_deref(),
                    track.album.as_deref(),
                    track.style_description.as_deref(),
                ]
                .into_iter()
                .flatten()
                .any(|value| value.to_ascii_lowercase().contains(&needle))
            });
        }
        Ok(tracks)
    }

    pub fn get_track(&self, id: TrackId) -> Result<Option<Track>> {
        Ok(self.read_tracks()?.into_iter().find(|track| track.id == id))
    }

    pub fn update_track_metadata(&self, id: TrackId, patch: TrackPatch) -> Result<()> {
        let current = self
            .get_track(id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let title = patch.title.unwrap_or(current.title);
        let artist = patch.artist.unwrap_or(current.artist);
        let album = patch.album.unwrap_or(current.album);
        let favorite = patch.favorite.unwrap_or(current.favorite);
        let style_description = patch.style_description.unwrap_or(current.style_description);
        let suno_prompt = patch.suno_prompt.unwrap_or(current.suno_prompt);
        let lyrics = patch.lyrics.unwrap_or(current.lyrics);

        self.conn.execute(
            "UPDATE tracks SET title = ?1, artist = ?2, album = ?3, favorite = ?4, style_description = ?5, suno_prompt = ?6, lyrics = ?7 WHERE id = ?8",
            params![title, artist, album, favorite as i64, style_description, suno_prompt, lyrics, id],
        )?;
        Ok(())
    }

    pub fn delete_track(&self, id: TrackId) -> Result<()> {
        self.conn
            .execute("DELETE FROM tracks WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn insert_candidate(&self, candidate: IngestCandidate) -> Result<TrackId> {
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO tracks (source, source_id, file_path, title, artist, album, duration_ms, cover_path, source_url, favorite, play_count, added_at, style_description, suno_prompt, lyrics)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, ?6, 0, 0, ?7, ?8, ?9, ?10)",
            params![
                candidate.source.to_string(),
                candidate.source_id,
                candidate.file_path,
                candidate.title,
                candidate.artist,
                candidate.source_url,
                now,
                candidate.style_description,
                candidate.suno_prompt,
                candidate.lyrics
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn queue_ingest(&self, request: &IngestRequest) -> Result<JobId> {
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO ingest_jobs (source, input, status, progress, created_at, updated_at)
             VALUES (?1, ?2, ?3, 0, ?4, ?4)",
            params![
                request.source.to_string(),
                request.input,
                IngestStatus::Queued.to_string(),
                now
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn complete_job(&self, id: JobId, track_id: TrackId) -> Result<()> {
        self.conn.execute(
            "UPDATE ingest_jobs SET status = ?1, progress = 1, track_id = ?2, error = NULL, updated_at = ?3 WHERE id = ?4",
            params![IngestStatus::Ready.to_string(), track_id, now_ms(), id],
        )?;
        Ok(())
    }

    pub fn fail_job(&self, id: JobId, error: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE ingest_jobs SET status = ?1, error = ?2, updated_at = ?3 WHERE id = ?4",
            params![IngestStatus::Failed.to_string(), error, now_ms(), id],
        )?;
        Ok(())
    }

    pub fn list_ingest_jobs(&self) -> Result<Vec<IngestJob>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, source, input, status, progress, track_id, error, created_at, updated_at FROM ingest_jobs ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let source: String = row.get(1)?;
            let status: String = row.get(3)?;
            Ok(IngestJob {
                id: row.get(0)?,
                source: AudioSource::try_from(source.as_str()).map_err(to_sql_err)?,
                input: row.get(2)?,
                status: IngestStatus::try_from(status.as_str()).map_err(to_sql_err)?,
                progress: row.get(4)?,
                track_id: row.get(5)?,
                error: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;
        rows.collect()
    }

    pub fn list_playlists(&self) -> Result<Vec<Playlist>> {
        let mut stmt = self.conn.prepare(
            "SELECT p.id, p.name, p.description, p.created_at, p.updated_at, COUNT(pt.track_id)
             FROM playlists p
             LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
             GROUP BY p.id
             ORDER BY p.updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Playlist {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                track_count: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn create_playlist(&self, name: &str, description: Option<String>) -> Result<Playlist> {
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO playlists (name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![name, description, now],
        )?;
        let id = self.conn.last_insert_rowid();
        Ok(Playlist {
            id,
            name: name.to_owned(),
            description,
            track_count: 0,
            created_at: now,
            updated_at: now,
        })
    }

    pub fn get_settings(&self) -> Result<AppSettings> {
        let value: Option<String> = self
            .conn
            .query_row("SELECT value FROM settings WHERE key = 'app'", [], |row| {
                row.get(0)
            })
            .optional()?;
        Ok(value
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default())
    }

    pub fn update_settings(&self, patch: SettingsPatch) -> Result<AppSettings> {
        let mut settings = self.get_settings()?;
        if let Some(theme) = patch.theme {
            settings.theme = theme;
        }
        if let Some(value) = patch.youtube_consent {
            settings.youtube_consent = value;
        }
        if let Some(value) = patch.suno_advanced_enabled {
            settings.suno_advanced_enabled = value;
        }
        if let Some(value) = patch.max_concurrent_downloads {
            settings.max_concurrent_downloads = value.clamp(1, 6);
        }

        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES ('app', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![serde_json::to_string(&settings).map_err(to_sql_err)?],
        )?;
        Ok(settings)
    }

    fn read_tracks(&self) -> Result<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, source, source_id, file_path, title, artist, album, duration_ms, cover_path, source_url, favorite, play_count, added_at, last_played_at, style_description, suno_prompt, lyrics
             FROM tracks ORDER BY added_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let source: String = row.get(1)?;
            Ok(Track {
                id: row.get(0)?,
                source: AudioSource::try_from(source.as_str()).map_err(to_sql_err)?,
                source_id: row.get(2)?,
                file_path: row.get(3)?,
                title: row.get(4)?,
                artist: row.get(5)?,
                album: row.get(6)?,
                duration_ms: row.get(7)?,
                cover_path: row.get(8)?,
                source_url: row.get(9)?,
                favorite: row.get::<_, i64>(10)? == 1,
                play_count: row.get(11)?,
                added_at: row.get(12)?,
                last_played_at: row.get(13)?,
                style_description: row.get(14)?,
                suno_prompt: row.get(15)?,
                lyrics: row.get(16)?,
            })
        })?;
        rows.collect()
    }

    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS tracks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL CHECK (source IN ('local','youtube','suno')),
                source_id TEXT,
                file_path TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                artist TEXT,
                album TEXT,
                duration_ms INTEGER,
                cover_path TEXT,
                source_url TEXT,
                favorite INTEGER NOT NULL DEFAULT 0,
                play_count INTEGER NOT NULL DEFAULT 0,
                added_at INTEGER NOT NULL,
                last_played_at INTEGER,
                style_description TEXT,
                suno_prompt TEXT,
                lyrics TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_tracks_source ON tracks(source);
            CREATE INDEX IF NOT EXISTS idx_tracks_added_at ON tracks(added_at);
            CREATE TABLE IF NOT EXISTS playlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS playlist_tracks (
                playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                PRIMARY KEY (playlist_id, position)
            );
            CREATE TABLE IF NOT EXISTS ingest_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                input TEXT NOT NULL,
                status TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                track_id INTEGER REFERENCES tracks(id),
                error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            ",
        )
    }

    fn cleanup_placeholder_content(&self) -> Result<()> {
        self.conn.execute(
            "DELETE FROM tracks
             WHERE source_id IN ('demo-suno-01', 'demo-youtube-01')
                OR file_path IN ('audio/suno/demo-suno-01.mp3', 'audio/youtube/demo-youtube-01.mp3', 'audio/local/night-drive.flac')
                OR title IN ('Glass Orchard Engine', 'Public Domain Radio Sweep', 'Night Drive Reference')",
            [],
        )?;
        self.conn.execute(
            "DELETE FROM playlists
             WHERE name IN ('Suno candidates', 'Visualizer checks')
               AND id NOT IN (SELECT DISTINCT playlist_id FROM playlist_tracks)",
            [],
        )?;
        self.conn.execute(
            "UPDATE settings
             SET value = replace(value, '\"audioRoot\":\"audio\"', '\"audioRoot\":\"songs\"')
             WHERE key = 'app' AND value LIKE '%\"audioRoot\":\"audio\"%'",
            [],
        )?;
        Ok(())
    }
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn to_sql_err(error: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}
