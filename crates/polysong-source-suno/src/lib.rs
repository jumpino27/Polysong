use polysong_core::{AudioSource, IngestCandidate, IngestRequest, PolysongError, Result};
use polysong_ingest::IngestSource;
use serde::Deserialize;
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
            .map(|host| host == "suno.com" || host.ends_with(".suno.com"))
            .unwrap_or(false)
    }

    fn prepare(&self, request: &IngestRequest) -> Result<Vec<IngestCandidate>> {
        if !request.consent_accepted || !request.advanced_public_suno {
            return Err(PolysongError::ConsentRequired);
        }

        if let Some(playlist_id) = parse_suno_playlist_id(&request.input) {
            let mut candidates = fetch_playlist(&playlist_id, &request.input)?;
            if request.streaming_only {
                for candidate in candidates.iter_mut() {
                    apply_streaming(candidate);
                }
            }
            return Ok(candidates);
        }

        let source_id = resolve_suno_song_id(&request.input)?;
        let clip = fetch_clip(&source_id)?;
        let mut candidate = clip.into_candidate(Some(request.input.clone()), None);
        if request.streaming_only {
            apply_streaming(&mut candidate);
        }
        Ok(vec![candidate])
    }
}

/// Flip a freshly-built Suno candidate into streaming-only mode: keep all
/// metadata, swap the local `file_path` for a `streaming://` sentinel so it
/// stays unique against `tracks.file_path UNIQUE`, and stash the CDN
/// `download_url` into `stream_url` for playback.
fn apply_streaming(candidate: &mut IngestCandidate) {
    candidate.streaming_only = true;
    candidate.stream_url = candidate.download_url.clone();
    let id = candidate
        .source_id
        .clone()
        .unwrap_or_else(|| format!("suno-{}", candidate.title));
    candidate.file_path = format!("streaming://{id}");
}

fn fetch_clip(source_id: &str) -> Result<SunoClip> {
    let url = format!("https://studio-api.prod.suno.com/api/clip/{source_id}");
    let response = reqwest::blocking::Client::new()
        .get(url)
        .header(reqwest::header::USER_AGENT, "Polysong/0.1")
        .send()
        .map_err(|error| PolysongError::Message(format!("Suno clip request failed: {error}")))?;

    if !response.status().is_success() {
        return Err(PolysongError::Message(format!(
            "Suno clip request returned {}",
            response.status()
        )));
    }

    response
        .json::<SunoClip>()
        .map_err(|error| PolysongError::Message(format!("Suno clip JSON parse failed: {error}")))
}

fn fetch_playlist(playlist_id: &str, input: &str) -> Result<Vec<IngestCandidate>> {
    let url = format!("https://studio-api.prod.suno.com/api/playlist/{playlist_id}");
    let response = reqwest::blocking::Client::new()
        .get(url)
        .header(reqwest::header::USER_AGENT, "Polysong/0.1")
        .send()
        .map_err(|error| {
            PolysongError::Message(format!("Suno playlist request failed: {error}"))
        })?;

    if !response.status().is_success() {
        return Err(PolysongError::Message(format!(
            "Suno playlist request returned {}",
            response.status()
        )));
    }

    let playlist = response.json::<SunoPlaylist>().map_err(|error| {
        PolysongError::Message(format!("Suno playlist JSON parse failed: {error}"))
    })?;

    let playlist_name = playlist.name;
    let candidates = playlist
        .playlist_clips
        .into_iter()
        .map(|item| {
            item.clip
                .into_candidate(Some(input.to_owned()), playlist_name.clone())
        })
        .collect::<Vec<_>>();

    if candidates.is_empty() {
        return Err(PolysongError::Message(
            "Suno playlist did not contain downloadable clips".to_owned(),
        ));
    }

    Ok(candidates)
}

fn resolve_suno_song_id(input: &str) -> Result<String> {
    if let Some(id) = parse_suno_song_id(input) {
        return Ok(id);
    }

    let response = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|error| PolysongError::Message(format!("HTTP client setup failed: {error}")))?
        .get(input)
        .header(reqwest::header::USER_AGENT, "Polysong/0.1")
        .send()
        .map_err(|error| {
            PolysongError::Message(format!("Suno redirect resolution failed: {error}"))
        })?;

    parse_suno_song_id(response.url().as_str()).ok_or_else(|| {
        PolysongError::Message(
            "Suno URL must look like https://suno.com/song/<id>, https://suno.com/s/<id>, or https://suno.com/playlist/<id>"
                .to_owned(),
        )
    })
}

fn parse_suno_song_id(input: &str) -> Option<String> {
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
        ["song", id] => Some((*id).to_owned()),
        _ => None,
    }
}

#[cfg(test)]
fn parse_suno_short_id(input: &str) -> Option<String> {
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
        ["s", id] => Some((*id).to_owned()),
        _ => None,
    }
}

fn parse_suno_playlist_id(input: &str) -> Option<String> {
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
        ["playlist", id] => Some((*id).to_owned()),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
struct SunoPlaylist {
    name: Option<String>,
    playlist_clips: Vec<SunoPlaylistClip>,
}

#[derive(Debug, Deserialize)]
struct SunoPlaylistClip {
    clip: SunoClip,
}

#[derive(Debug, Deserialize)]
struct SunoClip {
    id: String,
    title: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    audio_url: Option<String>,
    image_url: Option<String>,
    image_large_url: Option<String>,
    metadata: Option<SunoMetadata>,
}

impl SunoClip {
    fn into_candidate(
        self,
        original_input: Option<String>,
        album: Option<String>,
    ) -> IngestCandidate {
        let style_description = self
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.tags.clone());
        let suno_prompt = self
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.prompt.clone());
        let duration_ms = self
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.duration)
            .map(|duration| (duration * 1000.0).round() as i64);

        IngestCandidate {
            source: AudioSource::Suno,
            source_id: Some(self.id.clone()),
            title: self.title.unwrap_or_else(|| format!("Suno {}", self.id)),
            artist: self.display_name.or_else(|| Some("Suno".to_owned())),
            album,
            source_url: Some(format!("https://suno.com/song/{}", self.id)),
            original_input,
            file_path: format!("songs/suno/{}.mp3", self.id),
            download_url: self.audio_url,
            cover_url: self.image_large_url.or(self.image_url),
            cover_path: None,
            duration_ms,
            style_description,
            suno_prompt,
            lyrics: None,
            streaming_only: false,
            stream_url: None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct SunoMetadata {
    tags: Option<String>,
    prompt: Option<String>,
    duration: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::{parse_suno_playlist_id, parse_suno_short_id, parse_suno_song_id};

    #[test]
    fn parses_song_short_and_playlist_suno_links() {
        assert_eq!(
            parse_suno_song_id("https://suno.com/song/40e328c3-abc8-4419-b48c-77fb828d8f17"),
            Some("40e328c3-abc8-4419-b48c-77fb828d8f17".to_owned())
        );
        assert_eq!(
            parse_suno_short_id("https://suno.com/s/x05KvNFq7Tn5KqyR"),
            Some("x05KvNFq7Tn5KqyR".to_owned())
        );
        assert_eq!(
            parse_suno_playlist_id(
                "https://suno.com/playlist/daf49e79-0eb6-4c55-876f-91993f0277f3"
            ),
            Some("daf49e79-0eb6-4c55-876f-91993f0277f3".to_owned())
        );
    }
}
