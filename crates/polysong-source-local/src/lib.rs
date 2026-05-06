use polysong_core::{AudioSource, IngestCandidate, IngestRequest, Result};
use polysong_ingest::IngestSource;
use std::path::{Path, PathBuf};

pub struct LocalSource;

impl IngestSource for LocalSource {
    fn name(&self) -> &'static str {
        "local"
    }

    fn can_handle(&self, input: &str) -> bool {
        let path = Path::new(input);
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| {
                matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "mp3" | "m4a" | "flac" | "wav" | "ogg" | "opus"
                )
            })
            .unwrap_or(false)
    }

    fn prepare(&self, request: &IngestRequest) -> Result<Vec<IngestCandidate>> {
        let path = Path::new(&request.input);
        let title = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("Local track")
            .to_owned();

        Ok(vec![IngestCandidate {
            source: AudioSource::Local,
            source_id: None,
            title,
            artist: None,
            album: None,
            source_url: None,
            original_input: Some(request.input.clone()),
            file_path: local_library_path(path),
            download_url: None,
            cover_url: None,
            cover_path: None,
            duration_ms: None,
            style_description: None,
            suno_prompt: None,
            lyrics: None,
        }])
    }
}

fn local_library_path(path: &Path) -> String {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("imported-local-track");
    PathBuf::from("songs")
        .join("local")
        .join(file_name)
        .to_string_lossy()
        .replace('\\', "/")
}
