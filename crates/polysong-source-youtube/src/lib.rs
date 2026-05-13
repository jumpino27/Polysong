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

        let (file_path, streaming_only) = if request.streaming_only {
            // Sentinel keeps the unique-file-path constraint happy and lets
            // callers detect a streaming-only row without checking the flag.
            (format!("streaming://{source_id}"), true)
        } else {
            (format!("songs/youtube/{source_id}.mp3"), false)
        };

        Ok(vec![IngestCandidate {
            source: AudioSource::Youtube,
            source_id: Some(source_id.clone()),
            title: format!("YouTube {source_id}"),
            artist: Some("YouTube".to_owned()),
            album: None,
            source_url: Some(canonical_youtube_url(&source_id)),
            original_input: Some(request.input.clone()),
            file_path,
            download_url: None,
            cover_url: None,
            cover_path: None,
            duration_ms: None,
            style_description: None,
            suno_prompt: None,
            lyrics: None,
            streaming_only,
            stream_url: None,
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

/// Returns the `list=` query parameter when the URL points at a real
/// user-curated playlist. Auto-generated radio mixes (list ids beginning
/// with `RD`) are intentionally skipped — they expand to infinite mixes,
/// not finite playlists, and ingesting them is never what the user wants.
pub fn parse_playlist_id(input: &str) -> Option<String> {
    let url = Url::parse(input).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    if !(host.contains("youtube.com") || host.contains("youtu.be")) {
        return None;
    }
    let list_id = url
        .query_pairs()
        .find(|(key, _)| key == "list")
        .map(|(_, value)| value.into_owned())?;
    if list_id.starts_with("RD") {
        return None;
    }
    Some(list_id)
}

pub fn canonical_youtube_url(video_id: &str) -> String {
    format!("https://www.youtube.com/watch?v={video_id}")
}

#[cfg(test)]
mod tests {
    use super::{parse_playlist_id, parse_video_id};

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

    #[test]
    fn detects_real_playlist_and_skips_radio_mix() {
        assert_eq!(
            parse_playlist_id(
                "https://www.youtube.com/watch?v=4l2oNxn3U5A&list=PLFv4HMVcYNE0ujMzn1fqXWnxCxytdj6Ek"
            ),
            Some("PLFv4HMVcYNE0ujMzn1fqXWnxCxytdj6Ek".to_owned())
        );
        assert_eq!(
            parse_playlist_id("https://www.youtube.com/watch?v=abc&list=RDabc"),
            None
        );
        assert_eq!(
            parse_playlist_id("https://www.youtube.com/watch?v=abc"),
            None
        );
    }
}
