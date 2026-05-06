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

        let source_id = parse_suno_id(&request.input).ok_or_else(|| {
            PolysongError::Message(
                "Suno URL must look like https://suno.com/song/<id> or https://suno.com/s/<id>"
                    .to_owned(),
            )
        })?;
        let source_url = canonical_suno_url(&source_id, &request.input);

        Ok(IngestCandidate {
            source: AudioSource::Suno,
            source_id: Some(source_id.clone()),
            title: format!("Suno {source_id}"),
            artist: Some("Suno".to_owned()),
            source_url: Some(source_url),
            file_path: format!("songs/suno/{source_id}.mp3"),
            style_description: None,
            suno_prompt: None,
            lyrics: None,
        })
    }
}

fn parse_suno_id(input: &str) -> Option<String> {
    let url = Url::parse(input).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    if host != "suno.com" && !host.ends_with(".suno.com") {
        return None;
    }

    let segments = url
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    match segments.as_slice() {
        ["song", id] | ["s", id] => Some((*id).to_owned()),
        [id] if id.len() >= 8 => Some((*id).to_owned()),
        _ => None,
    }
}

fn canonical_suno_url(source_id: &str, input: &str) -> String {
    if input.contains("/s/") {
        format!("https://suno.com/s/{source_id}")
    } else {
        format!("https://suno.com/song/{source_id}")
    }
}

#[cfg(test)]
mod tests {
    use super::parse_suno_id;

    #[test]
    fn parses_song_and_short_suno_links() {
        assert_eq!(
            parse_suno_id("https://suno.com/song/x05KvNFq7Tn5KqyR"),
            Some("x05KvNFq7Tn5KqyR".to_owned())
        );
        assert_eq!(
            parse_suno_id("https://suno.com/s/x05KvNFq7Tn5KqyR"),
            Some("x05KvNFq7Tn5KqyR".to_owned())
        );
    }
}
