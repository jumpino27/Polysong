use polysong_core::{AudioSource, IngestCandidate, IngestRequest, PolysongError, Result};
use polysong_ingest::IngestSource;
use url::Url;

pub struct SunoSource;

impl IngestSource for SunoSource {
    fn name(&self) -> &'static str {
        "suno"
    }

    fn can_handle(&self, input: &str) -> bool {
        Url::parse(input)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .map(|host| host.contains("suno.com"))
            .unwrap_or(false)
    }

    fn prepare(&self, request: &IngestRequest) -> Result<IngestCandidate> {
        if !request.consent_accepted || !request.advanced_public_suno {
            return Err(PolysongError::ConsentRequired);
        }

        let source_id = parse_suno_id(&request.input).unwrap_or_else(|| "pending-suno".to_owned());

        Ok(IngestCandidate {
            source: AudioSource::Suno,
            source_id: Some(source_id.clone()),
            title: "Queued Suno import".to_owned(),
            artist: Some("Suno".to_owned()),
            source_url: Some(request.input.clone()),
            file_path: format!("audio/suno/{source_id}.mp3"),
            style_description: Some("Style description will be filled from Suno metadata when the authenticated fetcher resolves the song.".to_owned()),
            suno_prompt: None,
            lyrics: None,
        })
    }
}

fn parse_suno_id(input: &str) -> Option<String> {
    let url = Url::parse(input).ok()?;
    url.path_segments()?
        .filter(|segment| !segment.is_empty())
        .next_back()
        .map(str::to_owned)
}
