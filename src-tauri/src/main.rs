#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use polysong_core::{
    AppSettings, AudioSource, IngestCandidate, IngestJob, IngestRequest, Playlist, SettingsPatch,
    Track, TrackFilter, TrackId, TrackPatch,
};
use polysong_db::Repository;
use polysong_ingest::IngestRegistry;
use polysong_source_local::LocalSource;
use polysong_source_suno::SunoSource;
use polysong_source_youtube::{parse_playlist_id as parse_youtube_playlist_id, YoutubeSource};
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

struct AppState {
    repo: Mutex<Repository>,
    registry: IngestRegistry,
    data_dir: PathBuf,
}

impl AppState {
    fn open(data_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&data_dir).map_err(to_string)?;
        for folder in ["suno", "youtube", "local", "covers"] {
            std::fs::create_dir_all(data_dir.join("songs").join(folder)).map_err(to_string)?;
        }
        let db_path = data_dir.join("polysong.db");
        let repo = Repository::open(db_path).map_err(to_string)?;
        let registry = IngestRegistry::new()
            .with_source(LocalSource)
            .with_source(YoutubeSource)
            .with_source(SunoSource);
        Ok(Self {
            repo: Mutex::new(repo),
            registry,
            data_dir,
        })
    }

    fn list_tracks(&self, filter: TrackFilter) -> Result<Vec<Track>, String> {
        self.repo
            .lock()
            .map_err(lock_err)?
            .list_tracks(filter)
            .map_err(to_string)
    }

    fn get_track(&self, id: TrackId) -> Result<Option<Track>, String> {
        self.repo
            .lock()
            .map_err(lock_err)?
            .get_track(id)
            .map_err(to_string)
    }

    fn update_track_metadata(&self, id: TrackId, patch: TrackPatch) -> Result<(), String> {
        self.repo
            .lock()
            .map_err(lock_err)?
            .update_track_metadata(id, patch)
            .map_err(to_string)
    }

    fn delete_track(&self, id: TrackId) -> Result<(), String> {
        let paths = self
            .repo
            .lock()
            .map_err(lock_err)?
            .delete_track(id)
            .map_err(to_string)?;
        // Best-effort delete the audio file and cover image from disk so the
        // user's library and the actual songs/ folder stay in sync. Errors
        // are intentionally swallowed — a missing file (already deleted by
        // the user, or never written for a failed import) shouldn't block
        // the DB delete that has already succeeded.
        if let Some(rel) = paths.file_path {
            // Streaming-only rows use a `streaming://<id>` sentinel as their
            // file_path. There is no on-disk file to remove for those, so we
            // skip the filesystem call entirely (joining the data_dir with the
            // sentinel would just produce a nonexistent path).
            if !rel.starts_with("streaming://") {
                let abs = self
                    .data_dir
                    .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
                let _ = std::fs::remove_file(&abs);
            }
        }
        if let Some(rel) = paths.cover_path {
            let abs = self
                .data_dir
                .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            let _ = std::fs::remove_file(&abs);
        }
        Ok(())
    }

    fn add_track_to_playlist(
        &self,
        playlist_id: polysong_core::PlaylistId,
        track_id: TrackId,
    ) -> Result<(), String> {
        self.repo
            .lock()
            .map_err(lock_err)?
            .add_track_to_playlist(playlist_id, track_id)
            .map_err(to_string)
    }

    fn remove_track_from_playlist(
        &self,
        playlist_id: polysong_core::PlaylistId,
        track_id: TrackId,
    ) -> Result<(), String> {
        self.repo
            .lock()
            .map_err(lock_err)?
            .remove_track_from_playlist(playlist_id, track_id)
            .map_err(to_string)
    }

    fn list_track_playlists(
        &self,
        track_id: TrackId,
    ) -> Result<Vec<polysong_core::PlaylistId>, String> {
        self.repo
            .lock()
            .map_err(lock_err)?
            .list_track_playlists(track_id)
            .map_err(to_string)
    }

    fn list_playlist_members(
        &self,
        playlist_id: polysong_core::PlaylistId,
    ) -> Result<Vec<TrackId>, String> {
        self.repo
            .lock()
            .map_err(lock_err)?
            .list_playlist_members(playlist_id)
            .map_err(to_string)
    }

    fn set_track_playlists(
        &self,
        track_id: TrackId,
        playlist_ids: Vec<polysong_core::PlaylistId>,
    ) -> Result<(), String> {
        self.repo
            .lock()
            .map_err(lock_err)?
            .set_track_playlists(track_id, playlist_ids)
            .map_err(to_string)
    }

    fn attach_to_requested_playlist(
        &self,
        request: &IngestRequest,
        track_id: TrackId,
    ) -> Result<(), String> {
        if let Some(playlist_id) = request.playlist_id {
            self.repo
                .lock()
                .map_err(lock_err)?
                .add_track_to_playlist(playlist_id, track_id)
                .map_err(to_string)?;
        }
        Ok(())
    }

    fn ingest_url(self: &Arc<Self>, request: IngestRequest) -> Result<i64, String> {
        // YouTube playlist URLs (those with a real `list=` id, not radio mixes)
        // fan out into one sub-ingest per video so the user gets every track
        // in the playlist instead of just the linked video.
        if matches!(request.source, AudioSource::Youtube)
            && parse_youtube_playlist_id(&request.input).is_some()
        {
            return self.ingest_youtube_playlist(request);
        }

        // Fast-path dedup: if a track with this exact source URL already
        // exists, apply the streaming-vs-download three-way decision before
        // touching the network or the registry.
        //
        //   * downloaded existing + streaming request  → keep existing (sync)
        //   * existing matches request mode            → keep existing (sync)
        //   * streaming existing + download request    → upgrade in background
        //
        // The two "no work" branches complete the job synchronously so the
        // frontend sees status=ready immediately. The upgrade branch hands off
        // to a background thread so the Tauri command can return the job_id
        // straight away (matching the new async contract).
        if !request.input.trim().is_empty() {
            let existing = {
                let repo = self.repo.lock().map_err(lock_err)?;
                let id = repo
                    .find_track_by_source_url(&request.input)
                    .map_err(to_string)?;
                match id {
                    Some(id) => repo.get_track(id).map_err(to_string)?,
                    None => None,
                }
            };
            if let Some(existing) = existing {
                let existing_id = existing.id;
                let needs_upgrade = existing.streaming_only && !request.streaming_only;
                let job_id = self
                    .repo
                    .lock()
                    .map_err(lock_err)?
                    .queue_ingest(&request)
                    .map_err(to_string)?;
                if needs_upgrade {
                    // Build a synthetic candidate from the existing row and
                    // run the audio download off-thread.
                    let candidate = synthesize_candidate_for_upgrade(&existing)?;
                    let state = Arc::clone(self);
                    let request_for_thread = request.clone();
                    std::thread::spawn(move || {
                        if let Err(error) = state.upgrade_streaming_track_inner(
                            existing_id,
                            candidate,
                            &request_for_thread,
                        ) {
                            let _ = state
                                .repo
                                .lock()
                                .ok()
                                .and_then(|repo| repo.fail_job(job_id, &error).ok());
                            return;
                        }
                        if let Ok(repo) = state.repo.lock() {
                            let _ = repo.complete_job(job_id, existing_id);
                        }
                    });
                } else {
                    // No work needed: complete the job synchronously, attach
                    // to the requested playlist, return.
                    let _ = self
                        .repo
                        .lock()
                        .map_err(lock_err)?
                        .complete_job(job_id, existing_id);
                    self.attach_to_requested_playlist(&request, existing_id)?;
                }
                return Ok(job_id);
            }
        }

        // Fresh ingest path: queue the job synchronously, run the actual
        // network + filesystem work on a background thread.
        let job_id = self
            .repo
            .lock()
            .map_err(lock_err)?
            .queue_ingest(&request)
            .map_err(to_string)?;
        let state = Arc::clone(self);
        std::thread::spawn(move || {
            state.run_ingest_job(job_id, request);
        });
        Ok(job_id)
    }

    fn ingest_youtube_playlist(self: &Arc<Self>, request: IngestRequest) -> Result<i64, String> {
        // Enumerate the playlist synchronously so we can fail fast for empty
        // playlists (the contract: ingest_url returns Err in that case).
        let video_urls = enumerate_youtube_playlist(&self.data_dir, &request.input)?;
        if video_urls.is_empty() {
            return Err("YouTube playlist had no playable videos".to_owned());
        }

        let job_id = self
            .repo
            .lock()
            .map_err(lock_err)?
            .queue_ingest(&request)
            .map_err(to_string)?;

        let state = Arc::clone(self);
        std::thread::spawn(move || {
            state.run_youtube_playlist_job(job_id, request, video_urls);
        });
        Ok(job_id)
    }

    /// Background worker for the non-playlist `ingest_url` path. Walks every
    /// candidate produced by the registry, materializes it, and writes the
    /// result to the DB. For the Suno multi-candidate playlist case this
    /// loop is also where the streaming-vs-download dedup decision runs
    /// (via `reconcile_existing_or_insert`).
    fn run_ingest_job(&self, job_id: i64, request: IngestRequest) {
        let outcome: Result<TrackId, String> = (|| {
            let candidates = self
                .registry
                .prepare(&request)
                .map_err(|error| error.to_string())?;
            let mut first_track_id: Option<TrackId> = None;
            for candidate in candidates {
                let track_id = self.reconcile_existing_or_insert(candidate, &request)?;
                first_track_id.get_or_insert(track_id);
            }
            Ok(first_track_id.unwrap_or_default())
        })();

        match outcome {
            Ok(track_id) => {
                if let Ok(repo) = self.repo.lock() {
                    let _ = repo.complete_job(job_id, track_id);
                }
            }
            Err(error) => {
                if let Ok(repo) = self.repo.lock() {
                    let _ = repo.fail_job(job_id, &error);
                }
            }
        }
    }

    /// Background worker for YouTube playlist fan-out. Each video gets the
    /// same three-way dedup treatment as the fast-path in `ingest_url`.
    fn run_youtube_playlist_job(
        &self,
        job_id: i64,
        request: IngestRequest,
        video_urls: Vec<String>,
    ) {
        let outcome: Result<TrackId, String> = (|| {
            let mut first_track_id: Option<TrackId> = None;
            let total = video_urls.len();
            for (index, video_url) in video_urls.iter().enumerate() {
                // Per-video dedup with mode-aware upgrade.
                let existing = {
                    let repo = self.repo.lock().map_err(lock_err)?;
                    let id = repo.find_track_by_source_url(video_url).map_err(to_string)?;
                    match id {
                        Some(id) => repo.get_track(id).map_err(to_string)?,
                        None => None,
                    }
                };
                if let Some(existing) = existing {
                    let existing_id = existing.id;
                    if existing.streaming_only && !request.streaming_only {
                        // streaming → download: upgrade in place.
                        let candidate = synthesize_candidate_for_upgrade(&existing)?;
                        let upgrade_request = IngestRequest {
                            input: video_url.clone(),
                            playlist_id: None,
                            ..request.clone()
                        };
                        self.upgrade_streaming_track_inner(
                            existing_id,
                            candidate,
                            &upgrade_request,
                        )?;
                    }
                    // For (downloaded + streaming-request) or matching-modes
                    // we keep the existing row as-is.
                    self.attach_to_requested_playlist(&request, existing_id)?;
                    first_track_id.get_or_insert(existing_id);
                } else {
                    let sub_request = IngestRequest {
                        input: video_url.clone(),
                        playlist_id: None,
                        ..request.clone()
                    };
                    let candidates = self
                        .registry
                        .prepare(&sub_request)
                        .map_err(|error| error.to_string())?;
                    for candidate in candidates {
                        let track_id =
                            self.reconcile_existing_or_insert(candidate, &request)?;
                        first_track_id.get_or_insert(track_id);
                    }
                }

                // Best-effort progress: completion alone is enough per the
                // contract, but a per-video progress tick gives the frontend
                // something to render in the meantime.
                if total > 0 {
                    let progress = (index as f64 + 1.0) / total as f64;
                    if let Ok(repo) = self.repo.lock() {
                        let _ = repo.update_job_progress(job_id, progress);
                    }
                }
            }
            Ok(first_track_id.unwrap_or_default())
        })();

        match outcome {
            Ok(track_id) => {
                if let Ok(repo) = self.repo.lock() {
                    let _ = repo.complete_job(job_id, track_id);
                }
            }
            Err(error) => {
                if let Ok(repo) = self.repo.lock() {
                    let _ = repo.fail_job(job_id, &error);
                }
            }
        }
    }

    /// Look up the candidate's source_url, and either upgrade/keep the
    /// existing track or insert a fresh row. Centralizes the
    /// streaming-vs-download three-way decision so the Suno candidate loop,
    /// the per-video YouTube playlist loop, and the single-URL ingest path
    /// all behave identically.
    fn reconcile_existing_or_insert(
        &self,
        mut candidate: IngestCandidate,
        request: &IngestRequest,
    ) -> Result<TrackId, String> {
        let lookup_url = candidate
            .source_url
            .as_deref()
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .map(|url| url.to_owned());

        if let Some(url) = lookup_url {
            let existing = {
                let repo = self.repo.lock().map_err(lock_err)?;
                let id = repo.find_track_by_source_url(&url).map_err(to_string)?;
                match id {
                    Some(id) => repo.get_track(id).map_err(to_string)?,
                    None => None,
                }
            };
            if let Some(existing) = existing {
                let existing_id = existing.id;
                if existing.streaming_only && !candidate.streaming_only {
                    // Upgrade streaming → downloaded in place.
                    materialize_candidate(&self.data_dir, &mut candidate)?;
                    let cover_path = candidate.cover_path.as_deref();
                    self.repo
                        .lock()
                        .map_err(lock_err)?
                        .upgrade_to_downloaded(existing_id, &candidate.file_path, cover_path)
                        .map_err(to_string)?;
                }
                // For (downloaded + streaming-candidate) or matching-modes:
                // download always wins, so we leave the existing row alone.
                self.attach_to_requested_playlist(request, existing_id)?;
                return Ok(existing_id);
            }
        }

        materialize_candidate(&self.data_dir, &mut candidate)?;
        let track_id = self
            .repo
            .lock()
            .map_err(lock_err)?
            .insert_candidate(candidate)
            .map_err(to_string)?;
        self.attach_to_requested_playlist(request, track_id)?;
        Ok(track_id)
    }

    /// Shared between the fast-path upgrade in `ingest_url` and the per-video
    /// upgrade in the YouTube playlist worker. Materializes (downloads) the
    /// given candidate and flips the existing row to a downloaded state.
    fn upgrade_streaming_track_inner(
        &self,
        existing_id: TrackId,
        mut candidate: IngestCandidate,
        request: &IngestRequest,
    ) -> Result<(), String> {
        materialize_candidate(&self.data_dir, &mut candidate)?;
        let cover_path = candidate.cover_path.as_deref();
        self.repo
            .lock()
            .map_err(lock_err)?
            .upgrade_to_downloaded(existing_id, &candidate.file_path, cover_path)
            .map_err(to_string)?;
        self.attach_to_requested_playlist(request, existing_id)?;
        Ok(())
    }

    /// Synchronous (frontend awaits a spinner) on-demand upgrade of a single
    /// streaming-only track to a downloaded one. Distinct from
    /// `upgrade_streaming_track_inner` because the entry point here is the
    /// track id rather than an ingest request.
    fn download_track(&self, track_id: TrackId) -> Result<Track, String> {
        let existing = self
            .repo
            .lock()
            .map_err(lock_err)?
            .get_track(track_id)
            .map_err(to_string)?
            .ok_or_else(|| format!("track {track_id} not found"))?;

        if !existing.streaming_only {
            return Err("Track is already downloaded".to_owned());
        }

        let source_id = existing
            .source_id
            .clone()
            .ok_or_else(|| "track is missing source_id".to_owned())?;
        let source_url = existing
            .source_url
            .clone()
            .ok_or_else(|| "track is missing source_url".to_owned())?;

        let file_path = match existing.source {
            AudioSource::Youtube => format!("songs/youtube/{source_id}.mp3"),
            AudioSource::Suno => format!("songs/suno/{source_id}.mp3"),
            AudioSource::Local => {
                return Err("local tracks cannot be downloaded from streaming".to_owned());
            }
        };

        let mut candidate = IngestCandidate {
            source: existing.source,
            source_id: existing.source_id.clone(),
            title: existing.title.clone(),
            artist: existing.artist.clone(),
            album: existing.album.clone(),
            source_url: Some(source_url.clone()),
            original_input: Some(source_url),
            file_path: file_path.clone(),
            download_url: None,
            cover_url: None,
            cover_path: existing.cover_path.clone(),
            duration_ms: existing.duration_ms,
            style_description: existing.style_description.clone(),
            suno_prompt: existing.suno_prompt.clone(),
            lyrics: existing.lyrics.clone(),
            streaming_only: false,
            stream_url: None,
        };

        // Ensure target directory exists and run the appropriate downloader.
        let destination = self
            .data_dir
            .join(file_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(to_string)?;
        }

        match existing.source {
            AudioSource::Youtube => {
                // enrich_youtube_metadata can refresh title/artist/cover_url;
                // we keep the existing title/artist if it returns empty.
                enrich_youtube_metadata(&mut candidate, &self.data_dir);
                if existing.cover_path.is_none() && candidate.cover_url.is_some() {
                    download_cover(&self.data_dir, &mut candidate)?;
                }
                if !destination.exists()
                    || destination.metadata().map_err(to_string)?.len() == 0
                {
                    download_youtube(&self.data_dir, &candidate, &destination)?;
                }
            }
            AudioSource::Suno => {
                // For Suno we need a fresh audio URL; the easiest way is to
                // re-run the Suno source's `prepare` and pick the candidate
                // whose source_id matches. If that fails for any reason fall
                // back to the existing stream_url (which may still be valid).
                let prepare_request = IngestRequest {
                    source: AudioSource::Suno,
                    input: candidate.source_url.clone().unwrap_or_default(),
                    advanced_public_suno: false,
                    consent_accepted: true,
                    playlist_id: None,
                    streaming_only: false,
                };
                if let Ok(prepared) = self.registry.prepare(&prepare_request) {
                    if let Some(matched) = prepared
                        .into_iter()
                        .find(|c| c.source_id == candidate.source_id)
                    {
                        candidate.download_url = matched.download_url;
                        candidate.cover_url = candidate.cover_url.or(matched.cover_url);
                        if candidate.title.is_empty() {
                            candidate.title = matched.title;
                        }
                        candidate.artist = candidate.artist.or(matched.artist);
                        candidate.duration_ms = candidate.duration_ms.or(matched.duration_ms);
                    }
                }
                if candidate.download_url.is_none() {
                    candidate.download_url = existing.stream_url.clone();
                }
                if existing.cover_path.is_none() && candidate.cover_url.is_some() {
                    download_cover(&self.data_dir, &mut candidate)?;
                }
                if !destination.exists()
                    || destination.metadata().map_err(to_string)?.len() == 0
                {
                    download_http(&candidate, &destination)?;
                }
            }
            AudioSource::Local => unreachable!(),
        }

        let cover_path = candidate.cover_path.as_deref();
        self.repo
            .lock()
            .map_err(lock_err)?
            .upgrade_to_downloaded(track_id, &candidate.file_path, cover_path)
            .map_err(to_string)?;

        self.get_track(track_id)?
            .ok_or_else(|| format!("track {track_id} disappeared after download"))
    }

    fn list_ingest_jobs(&self) -> Result<Vec<IngestJob>, String> {
        self.repo
            .lock()
            .map_err(lock_err)?
            .list_ingest_jobs()
            .map_err(to_string)
    }

    fn list_playlists(&self) -> Result<Vec<Playlist>, String> {
        self.repo
            .lock()
            .map_err(lock_err)?
            .list_playlists()
            .map_err(to_string)
    }

    fn create_playlist(
        &self,
        name: String,
        description: Option<String>,
    ) -> Result<Playlist, String> {
        self.repo
            .lock()
            .map_err(lock_err)?
            .create_playlist(&name, description)
            .map_err(to_string)
    }

    fn get_settings(&self) -> Result<AppSettings, String> {
        self.repo
            .lock()
            .map_err(lock_err)?
            .get_settings()
            .map_err(to_string)
    }

    fn update_settings(&self, patch: SettingsPatch) -> Result<AppSettings, String> {
        self.repo
            .lock()
            .map_err(lock_err)?
            .update_settings(patch)
            .map_err(to_string)
    }

    fn upload_local(
        &self,
        filename: String,
        bytes: Vec<u8>,
        playlist_id: Option<polysong_core::PlaylistId>,
    ) -> Result<i64, String> {
        if bytes.len() < 1024 {
            return Err("uploaded audio was too small".to_owned());
        }
        let file_name = sanitize_filename(&filename)?;
        let extension = Path::new(&file_name)
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .ok_or_else(|| "local upload must include an audio file extension".to_owned())?;
        if !matches!(
            extension.as_str(),
            "mp3" | "m4a" | "flac" | "wav" | "ogg" | "opus"
        ) {
            return Err(format!("unsupported local audio extension: {extension}"));
        }

        let request = IngestRequest {
            source: AudioSource::Local,
            input: file_name.clone(),
            advanced_public_suno: false,
            consent_accepted: true,
            playlist_id,
            streaming_only: false,
        };
        let job_id = self
            .repo
            .lock()
            .map_err(lock_err)?
            .queue_ingest(&request)
            .map_err(to_string)?;

        let source_id = format!("{}", unix_ms());
        let library_file = unique_local_file_path(&self.data_dir, &source_id, &file_name)?;
        let destination = self
            .data_dir
            .join(library_file.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(to_string)?;
        }
        std::fs::write(&destination, bytes).map_err(to_string)?;

        let mut candidate = IngestCandidate {
            source: AudioSource::Local,
            source_id: Some(source_id),
            title: Path::new(&file_name)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("Local track")
                .to_owned(),
            artist: None,
            album: None,
            source_url: None,
            original_input: Some(file_name),
            file_path: library_file,
            download_url: None,
            cover_url: None,
            cover_path: None,
            duration_ms: None,
            style_description: None,
            suno_prompt: None,
            lyrics: None,
            streaming_only: false,
            stream_url: None,
        };
        enrich_local_metadata(&mut candidate, &destination, &self.data_dir);
        let track_id = self
            .repo
            .lock()
            .map_err(lock_err)?
            .insert_candidate(candidate)
            .map_err(to_string)?;
        self.attach_to_requested_playlist(&request, track_id)?;
        self.repo
            .lock()
            .map_err(lock_err)?
            .complete_job(job_id, track_id)
            .map_err(to_string)?;
        Ok(job_id)
    }
}

#[tauri::command]
fn list_tracks(state: State<Arc<AppState>>, filter: TrackFilter) -> Result<Vec<Track>, String> {
    state.list_tracks(filter)
}

#[tauri::command]
fn get_track(state: State<Arc<AppState>>, id: TrackId) -> Result<Option<Track>, String> {
    state.get_track(id)
}

#[tauri::command]
fn update_track_metadata(
    state: State<Arc<AppState>>,
    id: TrackId,
    patch: TrackPatch,
) -> Result<(), String> {
    state.update_track_metadata(id, patch)
}

#[tauri::command]
fn delete_track(state: State<Arc<AppState>>, id: TrackId) -> Result<(), String> {
    state.delete_track(id)
}

#[tauri::command]
fn ingest_url(state: State<Arc<AppState>>, request: IngestRequest) -> Result<i64, String> {
    state.ingest_url(request)
}

#[tauri::command]
async fn download_track(
    state: State<'_, Arc<AppState>>,
    track_id: i64,
) -> Result<Track, String> {
    // The actual download is blocking (network + filesystem). Hand it off to
    // the blocking pool so the async runtime is not stalled, but keep the
    // command itself awaitable so the frontend can `await` + show a spinner.
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.download_track(track_id))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
fn list_ingest_jobs(state: State<Arc<AppState>>) -> Result<Vec<IngestJob>, String> {
    state.list_ingest_jobs()
}

#[tauri::command]
fn list_playlists(state: State<Arc<AppState>>) -> Result<Vec<Playlist>, String> {
    state.list_playlists()
}

#[tauri::command]
fn create_playlist(
    state: State<Arc<AppState>>,
    name: String,
    description: Option<String>,
) -> Result<Playlist, String> {
    state.create_playlist(name, description)
}

#[tauri::command]
fn get_settings(state: State<Arc<AppState>>) -> Result<AppSettings, String> {
    state.get_settings()
}

#[tauri::command]
fn update_settings(
    state: State<Arc<AppState>>,
    patch: SettingsPatch,
) -> Result<AppSettings, String> {
    state.update_settings(patch)
}

#[tauri::command]
fn add_track_to_playlist(
    state: State<Arc<AppState>>,
    playlist_id: polysong_core::PlaylistId,
    track_id: TrackId,
) -> Result<(), String> {
    state.add_track_to_playlist(playlist_id, track_id)
}

#[tauri::command]
fn remove_track_from_playlist(
    state: State<Arc<AppState>>,
    playlist_id: polysong_core::PlaylistId,
    track_id: TrackId,
) -> Result<(), String> {
    state.remove_track_from_playlist(playlist_id, track_id)
}

#[tauri::command]
fn list_track_playlists(
    state: State<Arc<AppState>>,
    track_id: TrackId,
) -> Result<Vec<polysong_core::PlaylistId>, String> {
    state.list_track_playlists(track_id)
}

#[tauri::command]
fn list_playlist_members(
    state: State<Arc<AppState>>,
    playlist_id: polysong_core::PlaylistId,
) -> Result<Vec<TrackId>, String> {
    state.list_playlist_members(playlist_id)
}

#[tauri::command]
fn set_track_playlists(
    state: State<Arc<AppState>>,
    track_id: TrackId,
    playlist_ids: Vec<polysong_core::PlaylistId>,
) -> Result<(), String> {
    state.set_track_playlists(track_id, playlist_ids)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackAvailability {
    id: i64,
    available: bool,
    checked_at: i64,
}

#[tauri::command]
async fn check_tracks_availability(
    state: State<'_, Arc<AppState>>,
    track_ids: Vec<i64>,
) -> Result<Vec<TrackAvailability>, String> {
    // Snapshot the (id, url, streaming?) tuples up front so the DB lock is
    // not held across the async HEAD probes.
    let probes: Vec<(i64, Option<String>, bool)> = {
        let repo = state.repo.lock().map_err(lock_err)?;
        track_ids
            .iter()
            .map(|id| match repo.get_track(*id) {
                Ok(Some(track)) => (
                    *id,
                    if track.streaming_only {
                        track.source_url.clone()
                    } else {
                        None
                    },
                    track.streaming_only,
                ),
                _ => (*id, None, false),
            })
            .collect()
    };

    let client = reqwest::Client::builder()
        .user_agent(concat!("Polysong/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(to_string)?;

    let futures = probes.into_iter().map(|(id, url, streaming)| {
        let client = client.clone();
        async move {
            if !streaming {
                // Non-streaming tracks are local files — always "available"
                // from the network's point of view. Frontend decides whether
                // the file is actually present.
                return TrackAvailability {
                    id,
                    available: true,
                    checked_at: unix_ms(),
                };
            }
            let Some(url) = url else {
                return TrackAvailability {
                    id,
                    available: false,
                    checked_at: unix_ms(),
                };
            };
            let available = match client.head(&url).send().await {
                Ok(response) => {
                    let status = response.status().as_u16();
                    (200..400).contains(&status)
                }
                Err(_) => false,
            };
            TrackAvailability {
                id,
                available,
                checked_at: unix_ms(),
            }
        }
    });

    Ok(futures::future::join_all(futures).await)
}

#[tauri::command]
async fn resolve_stream_url(
    state: State<'_, Arc<AppState>>,
    track_id: i64,
) -> Result<String, String> {
    let track = {
        let repo = state.repo.lock().map_err(lock_err)?;
        repo.get_track(track_id)
            .map_err(to_string)?
            .ok_or_else(|| format!("track {track_id} not found"))?
    };

    if !track.streaming_only {
        return Ok(track.file_path);
    }

    match track.source {
        AudioSource::Suno => {
            if let Some(url) = track.stream_url.as_deref() {
                if !url.is_empty() {
                    return Ok(url.to_owned());
                }
            }
            // Re-fetch from Suno using the stored source_id (which mirrors the
            // CDN-bound clip id) and persist the freshly-issued audio URL.
            let source_id = track
                .source_id
                .clone()
                .ok_or_else(|| "Suno track missing source_id".to_owned())?;
            let fetched: Result<String, String> = tauri::async_runtime::spawn_blocking(move || {
                let url = format!("https://studio-api.prod.suno.com/api/clip/{source_id}");
                let response = reqwest::blocking::Client::new()
                    .get(url)
                    .header(reqwest::header::USER_AGENT, "Polysong/0.1")
                    .send()
                    .map_err(|err| err.to_string())?
                    .error_for_status()
                    .map_err(|err| err.to_string())?;
                let value: serde_json::Value =
                    response.json().map_err(|err| err.to_string())?;
                value
                    .get("audio_url")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_owned())
                    .ok_or_else(|| "Suno clip response had no audio_url".to_owned())
            })
            .await
            .map_err(|err| err.to_string())?;
            let audio_url = fetched?;
            {
                let repo = state.repo.lock().map_err(lock_err)?;
                let _ = repo.update_stream_url(track_id, &audio_url);
            }
            Ok(audio_url)
        }
        AudioSource::Youtube => {
            let source_url = track
                .source_url
                .clone()
                .ok_or_else(|| "YouTube track missing source_url".to_owned())?;
            let data_dir = state.data_dir.clone();
            let resolved: Result<String, String> =
                tauri::async_runtime::spawn_blocking(move || {
                    let yt_dlp = ensure_yt_dlp(&data_dir)?;
                    let output = yt_dlp
                        .command()
                        .arg("--no-warnings")
                        .arg("--no-playlist")
                        .arg("-f")
                        .arg("bestaudio")
                        .arg("--get-url")
                        .arg(&source_url)
                        .output()
                        .map_err(|err| err.to_string())?;
                    if !output.status.success() {
                        return Err(format!(
                            "yt-dlp --get-url exited with {}: {}",
                            output.status,
                            String::from_utf8_lossy(&output.stderr).trim()
                        ));
                    }
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    stdout
                        .lines()
                        .map(str::trim)
                        .find(|line| !line.is_empty())
                        .map(|line| line.to_owned())
                        .ok_or_else(|| "yt-dlp --get-url produced no URL".to_owned())
                })
                .await
                .map_err(|err| err.to_string())?;
            resolved
        }
        AudioSource::Local => Ok(track.file_path),
    }
}

fn main() {
    tracing_subscriber::fmt().init();

    if std::env::args().any(|arg| arg == "--backend-server") {
        run_http_backend().expect("failed to run Polysong backend server");
        return;
    }

    tauri::Builder::default()
        .register_uri_scheme_protocol("polysong", |_ctx, request| {
            polysong_media_scheme_response(request)
        })
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = polysong_data_dir()
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
            let state = Arc::new(
                AppState::open(data_dir)
                    .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?,
            );
            start_helper_tool_updater(state.data_dir.clone());
            start_http_backend(state.clone());
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_tracks,
            get_track,
            update_track_metadata,
            delete_track,
            ingest_url,
            download_track,
            list_ingest_jobs,
            list_playlists,
            create_playlist,
            get_settings,
            update_settings,
            add_track_to_playlist,
            remove_track_from_playlist,
            list_track_playlists,
            set_track_playlists,
            list_playlist_members,
            check_tracks_availability,
            resolve_stream_url,
            check_update,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Polysong");
}

fn lock_err<T>(_: std::sync::PoisonError<T>) -> String {
    "application state lock was poisoned".to_owned()
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn check_update() -> Result<UpdateStatus, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_owned();
    let Some(repo) = update_repo() else {
        return Ok(UpdateStatus::disabled(current_version));
    };

    if running_from_source_checkout() {
        return Ok(UpdateStatus::disabled(current_version));
    }

    let release = latest_github_release(&repo)?;
    let installer_url = release
        .assets
        .iter()
        .find(|asset| asset.name.eq_ignore_ascii_case("installed.exe"))
        .map(|asset| asset.browser_download_url.clone());
    let available = installer_url.is_some() && is_newer_version(&release.tag_name, &current_version);

    Ok(UpdateStatus {
        available,
        disabled: false,
        current_version,
        latest_version: Some(release.tag_name),
        installer_url,
    })
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn check_update() -> Result<UpdateStatus, String> {
    Ok(UpdateStatus::disabled(env!("CARGO_PKG_VERSION").to_owned()))
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn install_update() -> Result<(), String> {
    let Some(repo) = update_repo() else {
        return Err("release updater is disabled for this build".to_owned());
    };
    if running_from_source_checkout() {
        return Err("release updater is disabled while running from a source checkout".to_owned());
    }

    let current_version = env!("CARGO_PKG_VERSION");
    let release = latest_github_release(&repo)?;
    if !is_newer_version(&release.tag_name, current_version) {
        return Err("no newer release is available".to_owned());
    }

    let installer = release
        .assets
        .iter()
        .find(|asset| asset.name.eq_ignore_ascii_case("installed.exe"))
        .ok_or_else(|| format!("release {} does not include installed.exe", release.tag_name))?;

    let client = reqwest::blocking::Client::builder()
        .user_agent(format!("Polysong/{current_version}"))
        .build()
        .map_err(to_string)?;
    let download_path = std::env::temp_dir().join(format!(
        "polysong-update-{}.exe",
        sanitize_update_tag(&release.tag_name)
    ));
    let bytes = client
        .get(&installer.browser_download_url)
        .send()
        .map_err(to_string)?
        .error_for_status()
        .map_err(to_string)?
        .bytes()
        .map_err(to_string)?;
    if bytes.len() < 1024 * 1024 {
        return Err(format!(
            "downloaded update installer was unexpectedly small: {} bytes",
            bytes.len()
        ));
    }
    std::fs::write(&download_path, bytes).map_err(to_string)?;

    Command::new(&download_path).spawn().map_err(to_string)?;
    std::process::exit(0);
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn install_update() -> Result<(), String> {
    Err("release updater is only available for installed Windows builds".to_owned())
}

#[cfg(target_os = "windows")]
fn update_repo() -> Option<String> {
    if cfg!(debug_assertions) || std::env::var_os("POLYSONG_DISABLE_APP_UPDATER").is_some() {
        return None;
    }
    let repo = option_env!("POLYSONG_UPDATE_REPO")
        .unwrap_or("jumpino27/Polysong")
        .trim();
    (!repo.is_empty()).then(|| repo.to_owned())
}

#[cfg(target_os = "windows")]
fn latest_github_release(repo: &str) -> Result<GithubRelease, String> {
    let api_url = format!("https://api.github.com/repos/{repo}/releases/latest");
    reqwest::blocking::Client::builder()
        .user_agent(format!("Polysong/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(to_string)?
        .get(api_url)
        .send()
        .map_err(to_string)?
        .error_for_status()
        .map_err(to_string)?
        .json::<GithubRelease>()
        .map_err(to_string)
}

#[cfg(target_os = "windows")]
fn running_from_source_checkout() -> bool {
    std::env::current_dir()
        .map(|dir| dir.join("package.json").exists() && dir.join("src-tauri").is_dir())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn is_newer_version(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(candidate), Some(current)) => candidate > current,
        _ => false,
    }
}

#[cfg(target_os = "windows")]
fn parse_version(version: &str) -> Option<(u64, u64, u64)> {
    let core = version
        .trim()
        .trim_start_matches('v')
        .split(['-', '+'])
        .next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

#[cfg(target_os = "windows")]
fn sanitize_update_tag(tag: &str) -> String {
    tag.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

#[cfg(target_os = "windows")]
#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubReleaseAsset>,
}

#[cfg(target_os = "windows")]
#[derive(Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus {
    available: bool,
    disabled: bool,
    current_version: String,
    latest_version: Option<String>,
    installer_url: Option<String>,
}

impl UpdateStatus {
    fn disabled(current_version: String) -> Self {
        Self {
            available: false,
            disabled: true,
            current_version,
            latest_version: None,
            installer_url: None,
        }
    }
}

fn start_helper_tool_updater(data_dir: PathBuf) {
    #[cfg(target_os = "windows")]
    std::thread::spawn(move || {
        if let Err(error) = update_windows_helper_tools(&data_dir) {
            eprintln!("Polysong helper tool updater skipped: {error}");
        }
    });

    #[cfg(not(target_os = "windows"))]
    let _ = data_dir;
}

#[cfg(target_os = "windows")]
fn update_windows_helper_tools(data_dir: &Path) -> Result<(), String> {
    if running_from_source_checkout() || std::env::var_os("POLYSONG_DISABLE_TOOL_UPDATER").is_some()
    {
        return Ok(());
    }

    const YT_DLP_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
    const FFMPEG_URL: &str = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip";

    let tools_dir = data_dir.join("tools");
    std::fs::create_dir_all(&tools_dir).map_err(to_string)?;

    let client = reqwest::blocking::Client::builder()
        .user_agent(format!("Polysong/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(to_string)?;

    let yt_dlp_asset_id = remote_asset_id(&client, YT_DLP_URL).ok();
    let ffmpeg_asset_id = remote_asset_id(&client, FFMPEG_URL).ok();
    let manifest = serde_json::json!({
        "schema": 1,
        "tools": {
            "ytDlp": {
                "file": "yt-dlp.exe",
                "url": YT_DLP_URL,
                "assetId": yt_dlp_asset_id,
            },
            "ffmpeg": {
                "files": ["ffmpeg.exe", "ffprobe.exe"],
                "url": FFMPEG_URL,
                "assetId": ffmpeg_asset_id,
            },
        },
    });

    let manifest_path = tools_dir.join("installer-tools.manifest.json");
    let existing_manifest = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    let recipe_changed = existing_manifest.as_ref() != Some(&manifest);

    let yt_dlp = tools_dir.join("yt-dlp.exe");
    if recipe_changed || !yt_dlp.exists() {
        download_file(&client, YT_DLP_URL, &yt_dlp)?;
    }

    let ffmpeg = tools_dir.join("ffmpeg.exe");
    let ffprobe = tools_dir.join("ffprobe.exe");
    if recipe_changed || !ffmpeg.exists() || !ffprobe.exists() {
        download_ffmpeg_tools(&client, FFMPEG_URL, &tools_dir)?;
    }

    std::fs::write(
        manifest_path,
        serde_json::to_vec_pretty(&manifest).map_err(to_string)?,
    )
    .map_err(to_string)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn remote_asset_id(client: &reqwest::blocking::Client, url: &str) -> Result<String, String> {
    let response = client
        .head(url)
        .send()
        .map_err(to_string)?
        .error_for_status()
        .map_err(to_string)?;
    let headers = response.headers();
    let mut parts = vec![response.url().to_string()];
    for name in [
        reqwest::header::ETAG,
        reqwest::header::LAST_MODIFIED,
        reqwest::header::CONTENT_LENGTH,
    ] {
        if let Some(value) = headers.get(name).and_then(|value| value.to_str().ok()) {
            parts.push(value.to_owned());
        }
    }
    Ok(parts.join("|"))
}

#[cfg(target_os = "windows")]
fn download_file(
    client: &reqwest::blocking::Client,
    url: &str,
    destination: &Path,
) -> Result<(), String> {
    let bytes = client
        .get(url)
        .send()
        .map_err(to_string)?
        .error_for_status()
        .map_err(to_string)?
        .bytes()
        .map_err(to_string)?;
    if bytes.len() < 1024 * 1024 {
        return Err(format!(
            "downloaded helper tool was unexpectedly small: {} bytes",
            bytes.len()
        ));
    }
    std::fs::write(destination, bytes).map_err(to_string)
}

#[cfg(target_os = "windows")]
fn download_ffmpeg_tools(
    client: &reqwest::blocking::Client,
    url: &str,
    tools_dir: &Path,
) -> Result<(), String> {
    let cache_dir = std::env::temp_dir().join("polysong-helper-tools");
    let zip_path = cache_dir.join("ffmpeg-master-latest-win64-lgpl.zip");
    let extract_dir = cache_dir.join("ffmpeg");
    let _ = std::fs::remove_dir_all(&extract_dir);
    std::fs::create_dir_all(&extract_dir).map_err(to_string)?;
    download_file(client, url, &zip_path)?;

    let status = hidden_command("powershell")
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg("Expand-Archive -LiteralPath $env:POLYSONG_FFMPEG_ZIP -DestinationPath $env:POLYSONG_FFMPEG_EXTRACT -Force")
        .env("POLYSONG_FFMPEG_ZIP", &zip_path)
        .env("POLYSONG_FFMPEG_EXTRACT", &extract_dir)
        .status()
        .map_err(to_string)?;
    if !status.success() {
        return Err(format!("FFmpeg archive extraction failed with {status}"));
    }

    let ffmpeg_source = find_file_recursive(&extract_dir, "ffmpeg.exe")
        .ok_or_else(|| "FFmpeg archive did not contain ffmpeg.exe".to_owned())?;
    let ffprobe_source = find_file_recursive(&extract_dir, "ffprobe.exe")
        .ok_or_else(|| "FFmpeg archive did not contain ffprobe.exe".to_owned())?;
    std::fs::copy(ffmpeg_source, tools_dir.join("ffmpeg.exe")).map_err(to_string)?;
    std::fs::copy(ffprobe_source, tools_dir.join("ffprobe.exe")).map_err(to_string)?;
    let _ = std::fs::remove_dir_all(cache_dir);
    Ok(())
}

#[cfg(target_os = "windows")]
fn find_file_recursive(root: &Path, file_name: &str) -> Option<PathBuf> {
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case(file_name))
        {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_file_recursive(&path, file_name) {
                return Some(found);
            }
        }
    }
    None
}

fn hidden_command<S: AsRef<OsStr>>(program: S) -> Command {
    let mut command = Command::new(program);
    hide_subprocess_window(&mut command);
    command
}

#[cfg(target_os = "windows")]
fn hide_subprocess_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_subprocess_window(_: &mut Command) {}

fn scheme_response(
    status: u16,
    body: Vec<u8>,
    content_type: &'static str,
) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header(tauri::http::header::CONTENT_TYPE, content_type)
        .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .expect("valid scheme response")
}

fn run_http_backend() -> Result<(), String> {
    let data_dir = polysong_data_dir()?;
    let backend = Arc::new(AppState::open(data_dir)?);
    serve_http_backend(backend)
}

fn backend_bind_addr() -> String {
    if let Ok(addr) = std::env::var("POLYSONG_BACKEND_ADDR") {
        let trimmed = addr.trim();
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }

    let port = std::env::var("POLYSONG_BACKEND_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .unwrap_or(4777);
    format!("127.0.0.1:{port}")
}

fn start_http_backend(backend: Arc<AppState>) {
    std::thread::spawn(move || {
        if let Err(error) = serve_http_backend(backend) {
            eprintln!("Polysong HTTP backend not started: {error}");
        }
    });
}

fn serve_http_backend(backend: Arc<AppState>) -> Result<(), String> {
    let bind_addr = backend_bind_addr();
    let server = tiny_http::Server::http(&bind_addr).map_err(to_string)?;
    println!(
        "Polysong backend listening on http://{} with data at {}",
        bind_addr,
        backend.data_dir.display()
    );

    for mut request in server.incoming_requests() {
        let response = handle_http_request(&backend, &mut request);
        let _ = request.respond(response);
    }
    Ok(())
}

fn handle_http_request(
    backend: &Arc<AppState>,
    request: &mut tiny_http::Request,
) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    if request.method() == &tiny_http::Method::Options {
        return http_response(204, Vec::<u8>::new(), "text/plain");
    }

    if request.method() == &tiny_http::Method::Get && request.url().starts_with("/media/") {
        return media_response(backend.as_ref(), request);
    }

    let result = match (request.method(), request.url()) {
        (&tiny_http::Method::Post, "/api/list_tracks") => parse_body::<ListTracksBody>(request)
            .and_then(|body| to_json(backend.list_tracks(body.filter))),
        (&tiny_http::Method::Post, "/api/get_track") => {
            parse_body::<IdBody>(request).and_then(|body| to_json(backend.get_track(body.id)))
        }
        (&tiny_http::Method::Post, "/api/update_track_metadata") => {
            parse_body::<UpdateTrackBody>(request)
                .and_then(|body| to_json(backend.update_track_metadata(body.id, body.patch)))
        }
        (&tiny_http::Method::Post, "/api/delete_track") => {
            parse_body::<IdBody>(request).and_then(|body| to_json(backend.delete_track(body.id)))
        }
        (&tiny_http::Method::Post, "/api/ingest_url") => parse_body::<IngestRequestBody>(request)
            .and_then(|body| to_json(backend.ingest_url(body.request))),
        (&tiny_http::Method::Post, "/api/download_track") => parse_body::<TrackIdBody>(request)
            .and_then(|body| to_json(backend.download_track(body.track_id))),
        (&tiny_http::Method::Post, path) if path.starts_with("/api/upload_local") => {
            let filename = query_value(path, "filename")
                .and_then(percent_decode)
                .ok_or_else(|| "upload_local requires a filename query parameter".to_owned());
            let playlist_id = query_value(path, "playlistId").and_then(|value| value.parse().ok());
            filename
                .and_then(|filename| read_body_bytes(request).map(|bytes| (filename, bytes)))
                .and_then(|(filename, bytes)| {
                    to_json(backend.upload_local(filename, bytes, playlist_id))
                })
        }
        (&tiny_http::Method::Post, "/api/list_ingest_jobs") => to_json(backend.list_ingest_jobs()),
        (&tiny_http::Method::Post, "/api/list_playlists") => to_json(backend.list_playlists()),
        (&tiny_http::Method::Post, "/api/create_playlist") => {
            parse_body::<CreatePlaylistBody>(request)
                .and_then(|body| to_json(backend.create_playlist(body.name, body.description)))
        }
        (&tiny_http::Method::Post, "/api/get_settings") => to_json(backend.get_settings()),
        (&tiny_http::Method::Post, "/api/update_settings") => {
            parse_body::<UpdateSettingsBody>(request)
                .and_then(|body| to_json(backend.update_settings(body.patch)))
        }
        (&tiny_http::Method::Post, "/api/add_track_to_playlist") => {
            parse_body::<PlaylistMembershipBody>(request).and_then(|body| {
                to_json(backend.add_track_to_playlist(body.playlist_id, body.track_id))
            })
        }
        (&tiny_http::Method::Post, "/api/remove_track_from_playlist") => {
            parse_body::<PlaylistMembershipBody>(request).and_then(|body| {
                to_json(backend.remove_track_from_playlist(body.playlist_id, body.track_id))
            })
        }
        (&tiny_http::Method::Post, "/api/list_track_playlists") => parse_body::<TrackIdBody>(request)
            .and_then(|body| to_json(backend.list_track_playlists(body.track_id))),
        (&tiny_http::Method::Post, "/api/set_track_playlists") => {
            parse_body::<SetTrackPlaylistsBody>(request).and_then(|body| {
                to_json(backend.set_track_playlists(body.track_id, body.playlist_ids))
            })
        }
        (&tiny_http::Method::Post, "/api/list_playlist_members") => {
            parse_body::<PlaylistIdBody>(request)
                .and_then(|body| to_json(backend.list_playlist_members(body.playlist_id)))
        }
        _ => Err(format!(
            "unknown route: {} {}",
            request.method(),
            request.url()
        )),
    };

    match result {
        Ok(body) => http_response(200, body, "application/json"),
        Err(error) => {
            let body = serde_json::json!({ "error": error })
                .to_string()
                .into_bytes();
            http_response(500, body, "application/json")
        }
    }
}

fn parse_body<T: for<'de> Deserialize<'de>>(request: &mut tiny_http::Request) -> Result<T, String> {
    let mut body = String::new();
    request
        .as_reader()
        .read_to_string(&mut body)
        .map_err(to_string)?;
    serde_json::from_str(&body).map_err(to_string)
}

fn read_body_bytes(request: &mut tiny_http::Request) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    request
        .as_reader()
        .read_to_end(&mut body)
        .map_err(to_string)?;
    Ok(body)
}

fn to_json<T: serde::Serialize>(result: Result<T, String>) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&result?).map_err(to_string)
}

fn media_response(
    backend: &AppState,
    request: &tiny_http::Request,
) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let url = request.url();
    let Some(encoded_path) = url.strip_prefix("/media/") else {
        return http_response(404, b"not found".to_vec(), "text/plain");
    };
    let Some(relative_path) = percent_decode(encoded_path) else {
        return http_response(400, b"invalid media path".to_vec(), "text/plain");
    };
    let Ok(path) = safe_data_path(&backend.data_dir, &relative_path) else {
        return http_response(403, b"invalid media path".to_vec(), "text/plain");
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return http_response(404, b"media not found".to_vec(), "text/plain");
    };
    let total = bytes.len() as u64;
    let content_type = media_content_type(&path);

    // Parse Range header. Without Range support, browsers either silently
    // refuse to seek past the buffered window or refetch from byte 0 on
    // seek — which makes the scrubber appear to "restart" the song.
    // Returning 206 with the requested byte slice lets the audio element
    // seek anywhere in the file.
    let range_header = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    if let Some(value) = range_header {
        if let Some((start, end)) = parse_byte_range(&value, total) {
            let slice = bytes[start as usize..=end as usize].to_vec();
            let mut response = tiny_http::Response::from_data(slice).with_status_code(206);
            for (name, val) in [
                ("Content-Type", content_type.to_string()),
                (
                    "Content-Range",
                    format!("bytes {}-{}/{}", start, end, total),
                ),
                ("Accept-Ranges", "bytes".to_string()),
                ("Access-Control-Allow-Origin", "*".to_string()),
                (
                    "Access-Control-Allow-Methods",
                    "GET, POST, OPTIONS".to_string(),
                ),
                (
                    "Access-Control-Allow-Headers",
                    "content-type, range".to_string(),
                ),
                (
                    "Access-Control-Expose-Headers",
                    "content-range, accept-ranges, content-length".to_string(),
                ),
                ("Cache-Control", "no-store".to_string()),
            ] {
                if let Ok(header) =
                    tiny_http::Header::from_bytes(name.as_bytes(), val.as_bytes())
                {
                    response.add_header(header);
                }
            }
            return response;
        }
    }

    // No Range header — return the whole file but advertise Accept-Ranges
    // so subsequent seeks issue Range requests instead of refetching from 0.
    let mut response = tiny_http::Response::from_data(bytes).with_status_code(200);
    for (name, val) in [
        ("Content-Type", content_type.to_string()),
        ("Accept-Ranges", "bytes".to_string()),
        ("Access-Control-Allow-Origin", "*".to_string()),
        (
            "Access-Control-Allow-Methods",
            "GET, POST, OPTIONS".to_string(),
        ),
        (
            "Access-Control-Allow-Headers",
            "content-type, range".to_string(),
        ),
        (
            "Access-Control-Expose-Headers",
            "content-range, accept-ranges, content-length".to_string(),
        ),
        ("Cache-Control", "no-store".to_string()),
    ] {
        if let Ok(header) = tiny_http::Header::from_bytes(name.as_bytes(), val.as_bytes()) {
            response.add_header(header);
        }
    }
    response
}

fn polysong_media_scheme_response(
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let path = request.uri().path();
    let Some(encoded_path) = path.strip_prefix("/media/") else {
        return scheme_response(404, b"not found".to_vec(), "text/plain");
    };
    let Some(relative_path) = percent_decode(encoded_path) else {
        return scheme_response(400, b"invalid media path".to_vec(), "text/plain");
    };
    let Ok(data_dir) = polysong_data_dir() else {
        return scheme_response(500, b"data dir unavailable".to_vec(), "text/plain");
    };
    let Ok(path) = safe_data_path(&data_dir, &relative_path) else {
        return scheme_response(403, b"invalid media path".to_vec(), "text/plain");
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return scheme_response(404, b"media not found".to_vec(), "text/plain");
    };

    let total = bytes.len() as u64;
    let content_type = media_content_type(&path);
    let range_header = request
        .headers()
        .get(tauri::http::header::RANGE)
        .and_then(|value| value.to_str().ok());

    if let Some(range_header) = range_header {
        if let Some((start, end)) = parse_byte_range(range_header, total) {
            let slice = bytes[start as usize..=end as usize].to_vec();
            return scheme_media_response(
                206,
                slice,
                content_type,
                Some(format!("bytes {}-{}/{}", start, end, total)),
            );
        }
    }

    scheme_media_response(200, bytes, content_type, None)
}

fn scheme_media_response(
    status: u16,
    body: Vec<u8>,
    content_type: &'static str,
    content_range: Option<String>,
) -> tauri::http::Response<Vec<u8>> {
    let mut builder = tauri::http::Response::builder()
        .status(status)
        .header(tauri::http::header::CONTENT_TYPE, content_type)
        .header(tauri::http::header::ACCEPT_RANGES, "bytes")
        .header(tauri::http::header::CACHE_CONTROL, "no-store")
        .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            tauri::http::header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "content-range, accept-ranges, content-length",
        );
    if let Some(content_range) = content_range {
        builder = builder.header(tauri::http::header::CONTENT_RANGE, content_range);
    }
    builder.body(body).expect("valid media scheme response")
}

/// Parse a byte-range spec like `bytes=START-END`, `bytes=START-`, or
/// `bytes=-N` (suffix). Single ranges only — multipart ranges are not
/// supported here. Returns inclusive (start, end) bounded to `[0, total - 1]`.
fn parse_byte_range(header: &str, total: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let (start_str, end_str) = spec.split_once('-')?;
    if total == 0 {
        return None;
    }
    let last = total - 1;

    if start_str.is_empty() {
        let suffix: u64 = end_str.trim().parse().ok()?;
        if suffix == 0 {
            return None;
        }
        let suffix = suffix.min(total);
        return Some((total - suffix, last));
    }

    let start: u64 = start_str.trim().parse().ok()?;
    if start > last {
        return None;
    }
    let end = if end_str.trim().is_empty() {
        last
    } else {
        end_str.trim().parse::<u64>().ok()?.min(last)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn http_response(
    status: u16,
    body: Vec<u8>,
    content_type: &'static str,
) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let mut response = tiny_http::Response::from_data(body).with_status_code(status);
    for (name, value) in [
        ("Content-Type", content_type),
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "content-type, range"),
        ("Access-Control-Allow-Private-Network", "true"),
    ] {
        response.add_header(
            tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes())
                .expect("valid HTTP header"),
        );
    }
    response
}

fn polysong_data_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("POLYSONG_DATA_DIR").map(PathBuf::from) {
        return Ok(path);
    }

    if let Ok(current_dir) = std::env::current_dir() {
        if current_dir.join("package.json").exists() && current_dir.join("src-tauri").is_dir() {
            return Ok(current_dir);
        }
    }

    if cfg!(target_os = "windows") {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                return Ok(exe_dir.to_path_buf());
            }
        }
    }

    let base = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| "APPDATA is not set".to_owned())?
    } else if cfg!(target_os = "macos") {
        PathBuf::from(std::env::var_os("HOME").ok_or_else(|| "HOME is not set".to_owned())?)
            .join("Library")
            .join("Application Support")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
            })
            .ok_or_else(|| "Neither XDG_DATA_HOME nor HOME is set".to_owned())?
    };
    Ok(base.join("polysong"))
}

fn safe_data_path(data_dir: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative_path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("path must stay inside the Polysong data directory".to_owned());
    }

    let root = data_dir.canonicalize().map_err(to_string)?;
    let target = data_dir
        .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR))
        .canonicalize()
        .map_err(to_string)?;
    if !target.starts_with(root) {
        return Err("path must stay inside the Polysong data directory".to_owned());
    }
    Ok(target)
}

fn query_value<'a>(url: &'a str, key: &str) -> Option<&'a str> {
    let query = url.split_once('?')?.1;
    query.split('&').find_map(|part| {
        let (part_key, value) = part.split_once('=')?;
        (part_key == key).then_some(value)
    })
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
                output.push(u8::from_str_radix(hex, 16).ok()?);
                index += 3;
            }
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(output).ok()
}

fn sanitize_filename(filename: &str) -> Result<String, String> {
    let file_name = Path::new(filename)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "file name is required".to_owned())?;
    let cleaned: String = file_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('-').to_owned();
    if cleaned.is_empty() {
        Err("file name is required".to_owned())
    } else {
        Ok(cleaned)
    }
}

fn unique_local_file_path(
    data_dir: &Path,
    source_id: &str,
    file_name: &str,
) -> Result<String, String> {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "file extension is required".to_owned())?;
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("local-track");
    let mut rel = format!("songs/local/{stem}-{source_id}.{extension}");
    let mut counter = 2;
    while data_dir
        .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
        .exists()
    {
        rel = format!("songs/local/{stem}-{source_id}-{counter}.{extension}");
        counter += 1;
    }
    Ok(rel)
}

fn media_content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("wav") => "audio/wav",
        Some("flac") => "audio/flac",
        Some("ogg") | Some("opus") => "audio/ogg",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

fn unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[derive(Deserialize)]
struct ListTracksBody {
    filter: TrackFilter,
}

#[derive(Deserialize)]
struct IdBody {
    id: TrackId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTrackBody {
    id: TrackId,
    patch: TrackPatch,
}

#[derive(Deserialize)]
struct IngestRequestBody {
    request: IngestRequest,
}

#[derive(Deserialize)]
struct CreatePlaylistBody {
    name: String,
    description: Option<String>,
}

#[derive(Deserialize)]
struct UpdateSettingsBody {
    patch: SettingsPatch,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistMembershipBody {
    playlist_id: polysong_core::PlaylistId,
    track_id: TrackId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackIdBody {
    track_id: TrackId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetTrackPlaylistsBody {
    track_id: TrackId,
    playlist_ids: Vec<polysong_core::PlaylistId>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistIdBody {
    playlist_id: polysong_core::PlaylistId,
}

/// Build an `IngestCandidate` from an existing streaming-only track row so
/// the standard `materialize_candidate` pipeline can download its audio. The
/// returned candidate has `streaming_only = false` and a real on-disk
/// `file_path`, plus `original_input` set to the source URL so the YouTube /
/// Suno downloaders have something to fetch.
fn synthesize_candidate_for_upgrade(existing: &Track) -> Result<IngestCandidate, String> {
    let source_id = existing
        .source_id
        .clone()
        .ok_or_else(|| "streaming track missing source_id".to_owned())?;
    let source_url = existing
        .source_url
        .clone()
        .ok_or_else(|| "streaming track missing source_url".to_owned())?;
    let file_path = match existing.source {
        AudioSource::Youtube => format!("songs/youtube/{source_id}.mp3"),
        AudioSource::Suno => format!("songs/suno/{source_id}.mp3"),
        AudioSource::Local => {
            return Err("local tracks cannot be upgraded from streaming".to_owned());
        }
    };
    Ok(IngestCandidate {
        source: existing.source,
        source_id: existing.source_id.clone(),
        title: existing.title.clone(),
        artist: existing.artist.clone(),
        album: existing.album.clone(),
        source_url: Some(source_url.clone()),
        original_input: Some(source_url),
        file_path,
        download_url: existing.stream_url.clone(),
        cover_url: None,
        cover_path: existing.cover_path.clone(),
        duration_ms: existing.duration_ms,
        style_description: existing.style_description.clone(),
        suno_prompt: existing.suno_prompt.clone(),
        lyrics: existing.lyrics.clone(),
        streaming_only: false,
        stream_url: None,
    })
}

fn materialize_candidate(data_dir: &Path, candidate: &mut IngestCandidate) -> Result<(), String> {
    // Streaming-only flow: fetch metadata + cover, but skip the audio
    // download entirely. The candidate keeps a `streaming://<id>` sentinel
    // file_path so the unique-file-path constraint is satisfied and the
    // frontend can recognise non-downloaded rows.
    if candidate.streaming_only {
        match candidate.source {
            AudioSource::Local => {
                return Err("local audio files cannot be streaming-only".to_owned());
            }
            AudioSource::Youtube => {
                enrich_youtube_metadata(candidate, data_dir);
                download_cover(data_dir, candidate)?;
            }
            AudioSource::Suno => {
                download_cover(data_dir, candidate)?;
            }
        }
        return Ok(());
    }

    let destination = data_dir.join(
        candidate
            .file_path
            .replace('/', std::path::MAIN_SEPARATOR_STR),
    );
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(to_string)?;
    }

    match candidate.source {
        AudioSource::Local => {
            let input = candidate
                .original_input
                .clone()
                .ok_or_else(|| "local ingest missing original input path".to_owned())?;
            enrich_local_metadata(candidate, Path::new(&input), data_dir);
            if !destination.exists() || destination.metadata().map_err(to_string)?.len() == 0 {
                std::fs::copy(input, &destination).map_err(to_string)?;
            }
            Ok(())
        }
        AudioSource::Youtube => {
            enrich_youtube_metadata(candidate, data_dir);
            download_cover(data_dir, candidate)?;
            if !destination.exists() || destination.metadata().map_err(to_string)?.len() == 0 {
                download_youtube(data_dir, candidate, &destination)?;
            }
            Ok(())
        }
        AudioSource::Suno => {
            download_cover(data_dir, candidate)?;
            if !destination.exists() || destination.metadata().map_err(to_string)?.len() == 0 {
                download_http(candidate, &destination)?;
            }
            Ok(())
        }
    }
}

fn download_http(candidate: &IngestCandidate, destination: &Path) -> Result<(), String> {
    let url = candidate
        .download_url
        .as_deref()
        .ok_or_else(|| "Suno metadata did not include an audio URL".to_owned())?;
    let bytes = reqwest::blocking::Client::new()
        .get(url)
        .header(reqwest::header::USER_AGENT, "Polysong/0.1")
        .send()
        .map_err(to_string)?
        .error_for_status()
        .map_err(to_string)?
        .bytes()
        .map_err(to_string)?;

    if bytes.len() < 32 * 1024 {
        return Err(format!(
            "downloaded audio from {url} was too small: {} bytes",
            bytes.len()
        ));
    }

    std::fs::write(destination, bytes).map_err(to_string)
}

fn download_youtube(
    data_dir: &Path,
    candidate: &IngestCandidate,
    destination: &Path,
) -> Result<(), String> {
    let yt_dlp = ensure_yt_dlp(data_dir)?;
    let url = candidate
        .original_input
        .as_deref()
        .or(candidate.source_url.as_deref())
        .ok_or_else(|| "YouTube ingest missing source URL".to_owned())?;

    let mut command = yt_dlp.command();
    let status = command
        .arg("--no-playlist")
        .arg("--extract-audio")
        .arg("--audio-format")
        .arg("mp3")
        .arg("--audio-quality")
        .arg("0")
        .arg("--output")
        .arg(destination)
        .arg(url)
        .status()
        .map_err(to_string)?;

    if !status.success() {
        return Err(format!("yt-dlp exited with {status}"));
    }
    if !destination.exists() || destination.metadata().map_err(to_string)?.len() < 32 * 1024 {
        return Err("yt-dlp finished but did not produce a valid audio file".to_owned());
    }
    Ok(())
}

fn enumerate_youtube_playlist(data_dir: &Path, url: &str) -> Result<Vec<String>, String> {
    let yt_dlp = ensure_yt_dlp(data_dir)?;
    let output = yt_dlp
        .command()
        .arg("--flat-playlist")
        .arg("--dump-single-json")
        .arg("--no-warnings")
        .arg(url)
        .output()
        .map_err(to_string)?;
    if !output.status.success() {
        return Err(format!(
            "yt-dlp playlist enumeration exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let parsed: YtDlpPlaylistJson = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("yt-dlp playlist JSON parse failed: {error}"))?;
    Ok(parsed
        .entries
        .into_iter()
        .filter_map(|entry| entry.id.map(|id| format!("https://www.youtube.com/watch?v={id}")))
        .collect())
}

#[derive(serde::Deserialize)]
struct YtDlpPlaylistJson {
    #[serde(default)]
    entries: Vec<YtDlpPlaylistEntry>,
}

#[derive(serde::Deserialize)]
struct YtDlpPlaylistEntry {
    id: Option<String>,
}

fn enrich_youtube_metadata(candidate: &mut IngestCandidate, data_dir: &Path) {
    let Ok(yt_dlp) = ensure_yt_dlp(data_dir) else {
        return;
    };
    let Some(url) = candidate
        .original_input
        .as_deref()
        .or(candidate.source_url.as_deref())
    else {
        return;
    };

    let mut command = yt_dlp.command();
    let output = command
        .arg("--no-playlist")
        .arg("--dump-single-json")
        .arg(url)
        .output();
    let Ok(output) = output else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let Ok(info) = serde_json::from_slice::<YtDlpInfo>(&output.stdout) else {
        return;
    };

    if let Some(title) = info.title {
        candidate.title = title;
    }
    candidate.artist = info.artist.or(info.uploader).or(candidate.artist.take());
    candidate.duration_ms = info
        .duration
        .map(|duration| (duration * 1000.0).round() as i64)
        .or(candidate.duration_ms);
    candidate.cover_url = info.thumbnail.or(candidate.cover_url.take());
}

fn enrich_local_metadata(candidate: &mut IngestCandidate, input: &Path, data_dir: &Path) {
    if let Some(ffprobe) = find_tool(data_dir, &["ffprobe.exe", "ffprobe"]) {
        let output = hidden_command(ffprobe)
            .arg("-v")
            .arg("quiet")
            .arg("-print_format")
            .arg("json")
            .arg("-show_format")
            .arg(input)
            .output();
        if let Ok(output) = output {
            if output.status.success() {
                if let Ok(info) = serde_json::from_slice::<FfprobeInfo>(&output.stdout) {
                    if let Some(tags) = info.format.as_ref().and_then(|format| format.tags.as_ref())
                    {
                        if let Some(title) = tags.title.clone() {
                            candidate.title = title;
                        }
                        candidate.artist = tags.artist.clone().or(candidate.artist.take());
                        candidate.album = tags.album.clone().or(candidate.album.take());
                    }
                    candidate.duration_ms = info
                        .format
                        .and_then(|format| format.duration)
                        .and_then(|duration| duration.parse::<f64>().ok())
                        .map(|duration| (duration * 1000.0).round() as i64)
                        .or(candidate.duration_ms);
                }
            }
        }
    }

    extract_local_cover(candidate, input, data_dir);
}

fn extract_local_cover(candidate: &mut IngestCandidate, input: &Path, data_dir: &Path) {
    let Some(ffmpeg) = find_tool(data_dir, &["ffmpeg.exe", "ffmpeg"]) else {
        return;
    };
    let cover_rel = cover_relative_path(candidate, "jpg");
    let cover_abs = data_dir.join(cover_rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    if let Some(parent) = cover_abs.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let status = hidden_command(ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(input)
        .arg("-an")
        .arg("-vcodec")
        .arg("mjpeg")
        .arg("-frames:v")
        .arg("1")
        .arg(&cover_abs)
        .status();
    if matches!(status, Ok(status) if status.success())
        && cover_abs.exists()
        && cover_abs
            .metadata()
            .map(|metadata| metadata.len())
            .unwrap_or(0)
            > 0
    {
        candidate.cover_path = Some(cover_rel);
    } else {
        let _ = std::fs::remove_file(cover_abs);
    }
}

fn download_cover(data_dir: &Path, candidate: &mut IngestCandidate) -> Result<(), String> {
    let Some(url) = candidate.cover_url.clone() else {
        return Ok(());
    };
    let extension = cover_extension(&url);
    let cover_rel = cover_relative_path(candidate, extension);
    let cover_abs = data_dir.join(cover_rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    if cover_abs.exists() && cover_abs.metadata().map_err(to_string)?.len() > 0 {
        candidate.cover_path = Some(cover_rel);
        return Ok(());
    }
    if let Some(parent) = cover_abs.parent() {
        std::fs::create_dir_all(parent).map_err(to_string)?;
    }

    let bytes = reqwest::blocking::Client::new()
        .get(url)
        .header(reqwest::header::USER_AGENT, "Polysong/0.1")
        .send()
        .map_err(to_string)?
        .error_for_status()
        .map_err(to_string)?
        .bytes()
        .map_err(to_string)?;
    if bytes.len() < 512 {
        return Ok(());
    }
    std::fs::write(&cover_abs, bytes).map_err(to_string)?;
    candidate.cover_path = Some(cover_rel);
    Ok(())
}

fn cover_relative_path(candidate: &IngestCandidate, extension: &str) -> String {
    let id = candidate
        .source_id
        .as_deref()
        .unwrap_or(candidate.title.as_str())
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    format!("songs/covers/{}-{}.{}", candidate.source, id, extension)
}

fn cover_extension(url: &str) -> &str {
    let lower = url.to_ascii_lowercase();
    if lower.contains(".png") {
        "png"
    } else if lower.contains(".webp") {
        "webp"
    } else {
        "jpg"
    }
}

enum YtDlpRunner {
    Binary(PathBuf),
    PythonModule {
        python: PathBuf,
        module_dir: PathBuf,
    },
}

impl YtDlpRunner {
    fn command(&self) -> Command {
        match self {
            YtDlpRunner::Binary(path) => hidden_command(path),
            YtDlpRunner::PythonModule { python, module_dir } => {
                let mut command = hidden_command(python);
                command
                    .arg("-m")
                    .arg("yt_dlp")
                    .env("PYTHONPATH", module_dir);
                command
            }
        }
    }
}

fn ensure_yt_dlp(data_dir: &Path) -> Result<YtDlpRunner, String> {
    if let Some(path) = find_tool(data_dir, &["yt-dlp.exe", "yt-dlp"]) {
        return Ok(YtDlpRunner::Binary(path));
    }

    let tools_dir = data_dir.join("tools").join("yt-dlp");
    let module_dir = tools_dir.join("site");
    let module_marker = module_dir.join("yt_dlp").join("__init__.py");
    let python = find_executable("python")
        .or_else(|| find_executable("python.exe"))
        .ok_or_else(|| {
            "yt-dlp is not on PATH and Python was not found for local bootstrap".to_owned()
        })?;

    if !module_marker.exists() {
        std::fs::create_dir_all(&module_dir).map_err(to_string)?;
        let status = hidden_command(&python)
            .arg("-m")
            .arg("pip")
            .arg("install")
            .arg("--disable-pip-version-check")
            .arg("--quiet")
            .arg("--target")
            .arg(&module_dir)
            .arg("yt-dlp")
            .status()
            .map_err(to_string)?;
        if !status.success() {
            return Err(format!("local yt-dlp bootstrap failed with {status}"));
        }
    }

    Ok(YtDlpRunner::PythonModule { python, module_dir })
}

fn find_tool(data_dir: &Path, names: &[&str]) -> Option<PathBuf> {
    for root in tool_roots(data_dir) {
        for name in names {
            let path = root.join(name);
            if path.is_file() {
                return Some(path);
            }
        }
    }

    names.iter().find_map(|name| find_executable(name))
}

fn tool_roots(data_dir: &Path) -> Vec<PathBuf> {
    let mut roots = vec![data_dir.join("tools")];
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let exe_tools = exe_dir.join("tools");
            if !roots.iter().any(|root| root == &exe_tools) {
                roots.push(exe_tools);
            }
        }
    }
    roots
}

fn find_executable(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|path| path.join(name))
        .find(|path| path.is_file())
}

#[derive(serde::Deserialize)]
struct YtDlpInfo {
    title: Option<String>,
    artist: Option<String>,
    uploader: Option<String>,
    duration: Option<f64>,
    thumbnail: Option<String>,
}

#[derive(serde::Deserialize)]
struct FfprobeInfo {
    format: Option<FfprobeFormat>,
}

#[derive(serde::Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
    tags: Option<FfprobeTags>,
}

#[derive(serde::Deserialize)]
struct FfprobeTags {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
}
