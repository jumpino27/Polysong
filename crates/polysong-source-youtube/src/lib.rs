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

    fn prepare(&self, request: &IngestRequest) -> Result<Vec<IngestCandidate>> {
        if !request.consent_accepted {
            return Err(PolysongError::ConsentRequired);
        }

        let source_id = parse_video_id(&request.input).ok_or_else(|| {
            PolysongError::Message("YouTube URL must include a video id".to_owned())
        })?;

        Ok(vec![IngestCandidate {
            source: AudioSource::Youtube,
            source_id: Some(source_id.clone()),
            title: format!("YouTube {source_id}"),
            artist: Some("YouTube".to_owned()),
            album: None,
            source_url: Some(canonical_youtube_url(&source_id)),
            original_input: Some(request.input.clone()),
            file_path: format!("songs/youtube/{source_id}.mp3"),
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

fn parse_video_id(input: &str) -> Option<String> {
    let url = Url::parse(input).ok()?;
    if url.host_str()?.contains("youtu.be") {
        return url.path_segments()?.next().map(str::to_owned);
    }

    url.query_pairs()
        .find(|(key, _)| key == "v")
        .map(|(_, value)| value.into_owned())
}

fn canonical_youtube_url(video_id: &str) -> String {
    format!("https://www.youtube.com/watch?v={video_id}")
}

#[cfg(test)]
mod tests {
    use super::parse_video_id;

    #[test]
    fn parses_equivalent_youtube_links() {
        let expected = Some("r_0JjYUe5jo".to_owned());
        assert_eq!(
            parse_video_id(
                "https://www.youtube.com/watch?v=r_0JjYUe5jo&list=RDr_0JjYUe5jo&start_radio=1"
            ),
            expected
        );
        assert_eq!(
            parse_video_id("https://www.youtube.com/watch?v=r_0JjYUe5jo&list=RDr_0JjYUe5jo"),
            expected
        );
        assert_eq!(
            parse_video_id("https://youtu.be/r_0JjYUe5jo?si=iuygMA26CwADVo6D"),
            expected
        );
    }
}
