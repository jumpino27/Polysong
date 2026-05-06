use polysong_core::{AudioSource, IngestCandidate, IngestRequest, PolysongError, Result};
use polysong_ingest::IngestSource;
use url::Url;

pub struct YoutubeSource;

impl IngestSource for YoutubeSource {
    fn name(&self) -> &'static str {
        "youtube"
    }

    fn can_handle(&self, input: &str) -> bool {
        Url::parse(input)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .map(|host| host.contains("youtube.com") || host.contains("youtu.be"))
            .unwrap_or(false)
    }

    fn prepare(&self, request: &IngestRequest) -> Result<IngestCandidate> {
        if !request.consent_accepted {
            return Err(PolysongError::ConsentRequired);
        }

        let source_id = parse_video_id(&request.input).ok_or_else(|| {
            PolysongError::Message("YouTube URL must include a video id".to_owned())
        })?;

        Ok(IngestCandidate {
            source: AudioSource::Youtube,
            source_id: Some(source_id.clone()),
            title: "Queued YouTube import".to_owned(),
            artist: Some("YouTube".to_owned()),
            source_url: Some(request.input.clone()),
            file_path: format!("songs/youtube/{source_id}.mp3"),
            style_description: None,
            suno_prompt: None,
            lyrics: None,
        })
    }
}

fn parse_video_id(input: &str) -> Option<String> {
    let url = Url::parse(input).ok()?;
    if url.host_str()?.contains("youtu.be") {
        return url.path_segments()?.next().map(str::to_owned);
    }

    url.query_pairs()
        .find(|(key, _)| key == "v")
        .map(|(_, value)| value.into_owned())
}
