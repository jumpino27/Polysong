use polysong_core::{
    AppSettings, AudioSource, IngestCandidate, IngestJob, IngestRequest, Playlist, SettingsPatch,
    Track, TrackFilter, TrackId, TrackPatch,
};
use polysong_db::Repository;
use polysong_ingest::IngestRegistry;
use polysong_source_local::LocalSource;
use polysong_source_suno::SunoSource;
use polysong_source_youtube::YoutubeSource;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{Manager, State};

struct AppState {
    repo: Mutex<Repository>,
    registry: IngestRegistry,
    data_dir: PathBuf,
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
        Ok(candidates) => {
            let mut first_track_id = None;
            for mut candidate in candidates {
                materialize_candidate(&state.data_dir, &mut candidate)?;
                let track_id = state
                    .repo
                    .lock()
                    .map_err(lock_err)?
                    .insert_candidate(candidate)
                    .map_err(to_string)?;
                first_track_id.get_or_insert(track_id);
            }
            let repo = state.repo.lock().map_err(lock_err)?;
            repo.complete_job(job_id, first_track_id.unwrap_or_default())
                .map_err(to_string)?;
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
            for folder in ["suno", "youtube", "local", "covers"] {
                std::fs::create_dir_all(data_dir.join("songs").join(folder))?;
            }
            let db_path = data_dir.join("polysong.db");
            let repo = Repository::open(db_path)?;
            let registry = IngestRegistry::new()
                .with_source(LocalSource)
                .with_source(YoutubeSource)
                .with_source(SunoSource);
            app.manage(AppState {
                repo: Mutex::new(repo),
                registry,
                data_dir,
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

fn materialize_candidate(data_dir: &Path, candidate: &mut IngestCandidate) -> Result<(), String> {
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
    if let Some(ffprobe) = find_executable("ffprobe").or_else(|| find_executable("ffprobe.exe")) {
        let output = Command::new(ffprobe)
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
    let Some(ffmpeg) = find_executable("ffmpeg").or_else(|| find_executable("ffmpeg.exe")) else {
        return;
    };
    let cover_rel = cover_relative_path(candidate, "jpg");
    let cover_abs = data_dir.join(cover_rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    if let Some(parent) = cover_abs.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let status = Command::new(ffmpeg)
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
            YtDlpRunner::Binary(path) => Command::new(path),
            YtDlpRunner::PythonModule { python, module_dir } => {
                let mut command = Command::new(python);
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
    if let Some(path) = find_executable("yt-dlp").or_else(|| find_executable("yt-dlp.exe")) {
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
        let status = Command::new(&python)
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
