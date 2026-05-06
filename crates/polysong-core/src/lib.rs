use serde::{Deserialize, Serialize};
use std::fmt;

pub type TrackId = i64;
pub type PlaylistId = i64;
pub type JobId = i64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioSource {
    Local,
    Youtube,
    Suno,
}

impl fmt::Display for AudioSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            AudioSource::Local => "local",
            AudioSource::Youtube => "youtube",
            AudioSource::Suno => "suno",
        };
        f.write_str(value)
    }
}

impl TryFrom<&str> for AudioSource {
    type Error = PolysongError;

    fn try_from(value: &str) -> Result<Self> {
        match value {
            "local" => Ok(AudioSource::Local),
            "youtube" => Ok(AudioSource::Youtube),
            "suno" => Ok(AudioSource::Suno),
            other => Err(PolysongError::InvalidSource(other.to_owned())),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: TrackId,
    pub source: AudioSource,
    pub source_id: Option<String>,
    pub file_path: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<i64>,
    pub cover_path: Option<String>,
    pub source_url: Option<String>,
    pub favorite: bool,
    pub play_count: i64,
    pub added_at: i64,
    pub last_played_at: Option<i64>,
    pub style_description: Option<String>,
    pub suno_prompt: Option<String>,
    pub lyrics: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackPatch {
    pub title: Option<String>,
    pub artist: Option<Option<String>>,
    pub album: Option<Option<String>>,
    pub favorite: Option<bool>,
    pub style_description: Option<Option<String>>,
    pub suno_prompt: Option<Option<String>>,
    pub lyrics: Option<Option<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackFilter {
    pub source: Option<AudioSource>,
    pub search: Option<String>,
    pub favorites_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: PlaylistId,
    pub name: String,
    pub description: Option<String>,
    pub track_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestRequest {
    pub source: AudioSource,
    pub input: String,
    pub advanced_public_suno: bool,
    pub consent_accepted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestCandidate {
    pub source: AudioSource,
    pub source_id: Option<String>,
    pub title: String,
    pub artist: Option<String>,
    pub source_url: Option<String>,
    pub file_path: String,
    pub style_description: Option<String>,
    pub suno_prompt: Option<String>,
    pub lyrics: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IngestStatus {
    Queued,
    Downloading,
    Ready,
    Failed,
    Cancelled,
}

impl fmt::Display for IngestStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            IngestStatus::Queued => "queued",
            IngestStatus::Downloading => "downloading",
            IngestStatus::Ready => "ready",
            IngestStatus::Failed => "failed",
            IngestStatus::Cancelled => "cancelled",
        };
        f.write_str(value)
    }
}

impl TryFrom<&str> for IngestStatus {
    type Error = PolysongError;

    fn try_from(value: &str) -> Result<Self> {
        match value {
            "queued" => Ok(IngestStatus::Queued),
            "downloading" => Ok(IngestStatus::Downloading),
            "ready" => Ok(IngestStatus::Ready),
            "failed" => Ok(IngestStatus::Failed),
            "cancelled" => Ok(IngestStatus::Cancelled),
            other => Err(PolysongError::InvalidStatus(other.to_owned())),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestJob {
    pub id: JobId,
    pub source: AudioSource,
    pub input: String,
    pub status: IngestStatus,
    pub progress: f64,
    pub track_id: Option<TrackId>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: ThemeMode,
    pub audio_root: String,
    pub youtube_consent: bool,
    pub suno_advanced_enabled: bool,
    pub max_concurrent_downloads: u8,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeMode {
    Dark,
    Light,
    System,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: ThemeMode::Dark,
            audio_root: "audio".to_owned(),
            youtube_consent: false,
            suno_advanced_enabled: false,
            max_concurrent_downloads: 2,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub theme: Option<ThemeMode>,
    pub youtube_consent: Option<bool>,
    pub suno_advanced_enabled: Option<bool>,
    pub max_concurrent_downloads: Option<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum PolysongError {
    #[error("invalid audio source: {0}")]
    InvalidSource(String),
    #[error("invalid ingest status: {0}")]
    InvalidStatus(String),
    #[error("the requested source requires a consent toggle first")]
    ConsentRequired,
    #[error("{0}")]
    Message(String),
}

pub type Result<T> = std::result::Result<T, PolysongError>;
