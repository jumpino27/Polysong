use polysong_core::{
    AppSettings, IngestJob, IngestRequest, Playlist, SettingsPatch, Track, TrackFilter, TrackId,
    TrackPatch,
};
use polysong_db::Repository;
use polysong_ingest::IngestRegistry;
use polysong_source_local::LocalSource;
use polysong_source_suno::SunoSource;
use polysong_source_youtube::YoutubeSource;
use std::sync::Mutex;
use tauri::{Manager, State};

struct AppState {
    repo: Mutex<Repository>,
    registry: IngestRegistry,
}

#[tauri::command]
fn list_tracks(state: State<AppState>, filter: TrackFilter) -> Result<Vec<Track>, String> {
    state
        .repo
        .lock()
        .map_err(lock_err)?
        .list_tracks(filter)
        .map_err(to_string)
}

#[tauri::command]
fn get_track(state: State<AppState>, id: TrackId) -> Result<Option<Track>, String> {
    state
        .repo
        .lock()
        .map_err(lock_err)?
        .get_track(id)
        .map_err(to_string)
}

#[tauri::command]
fn update_track_metadata(
    state: State<AppState>,
    id: TrackId,
    patch: TrackPatch,
) -> Result<(), String> {
    state
        .repo
        .lock()
        .map_err(lock_err)?
        .update_track_metadata(id, patch)
        .map_err(to_string)
}

#[tauri::command]
fn delete_track(state: State<AppState>, id: TrackId) -> Result<(), String> {
    state
        .repo
        .lock()
        .map_err(lock_err)?
        .delete_track(id)
        .map_err(to_string)
}

#[tauri::command]
fn ingest_url(state: State<AppState>, request: IngestRequest) -> Result<i64, String> {
    let job_id = state
        .repo
        .lock()
        .map_err(lock_err)?
        .queue_ingest(&request)
        .map_err(to_string)?;
    match state.registry.prepare(&request) {
        Ok(candidate) => {
            let repo = state.repo.lock().map_err(lock_err)?;
            let track_id = repo.insert_candidate(candidate).map_err(to_string)?;
            repo.complete_job(job_id, track_id).map_err(to_string)?;
            Ok(job_id)
        }
        Err(error) => {
            let _ = state
                .repo
                .lock()
                .map_err(lock_err)?
                .fail_job(job_id, &error.to_string());
            Err(error.to_string())
        }
    }
}

#[tauri::command]
fn list_ingest_jobs(state: State<AppState>) -> Result<Vec<IngestJob>, String> {
    state
        .repo
        .lock()
        .map_err(lock_err)?
        .list_ingest_jobs()
        .map_err(to_string)
}

#[tauri::command]
fn list_playlists(state: State<AppState>) -> Result<Vec<Playlist>, String> {
    state
        .repo
        .lock()
        .map_err(lock_err)?
        .list_playlists()
        .map_err(to_string)
}

#[tauri::command]
fn create_playlist(
    state: State<AppState>,
    name: String,
    description: Option<String>,
) -> Result<Playlist, String> {
    state
        .repo
        .lock()
        .map_err(lock_err)?
        .create_playlist(&name, description)
        .map_err(to_string)
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Result<AppSettings, String> {
    state
        .repo
        .lock()
        .map_err(lock_err)?
        .get_settings()
        .map_err(to_string)
}

#[tauri::command]
fn update_settings(state: State<AppState>, patch: SettingsPatch) -> Result<AppSettings, String> {
    state
        .repo
        .lock()
        .map_err(lock_err)?
        .update_settings(patch)
        .map_err(to_string)
}

fn main() {
    tracing_subscriber::fmt().init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("polysong.db");
            let repo = Repository::open(db_path)?;
            let registry = IngestRegistry::new()
                .with_source(LocalSource)
                .with_source(YoutubeSource)
                .with_source(SunoSource);
            app.manage(AppState {
                repo: Mutex::new(repo),
                registry,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_tracks,
            get_track,
            update_track_metadata,
            delete_track,
            ingest_url,
            list_ingest_jobs,
            list_playlists,
            create_playlist,
            get_settings,
            update_settings
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
