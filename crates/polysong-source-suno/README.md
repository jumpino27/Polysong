# Polysong Suno Source

This source is designed for importing the signed-in user's own Suno library first. Public Suno URL ingestion is intentionally treated as advanced mode and requires explicit user consent from the frontend.

The reference backend stores Suno metadata fields such as `source_id`, `source_url`, `title`, `artist_name`, `style_description`, `duration_seconds`, `cover_url`, and `audio_url`. Polysong mirrors the important user-facing fields now, especially `style_description`, `suno_prompt`, and `lyrics`, so generated tracks remain inspectable in the library UI.

Implementation notes for the durable fetcher:

- Canonicalize `suno.com/song/{id}` and short-link inputs before deduplication.
- Prefer the Suno clip API for metadata and use HTML/CDN fallbacks only after that fails.
- Treat style tags as first-class metadata. Prefer tag/style fields over prompt fields when deriving `style_description`.
- Persist upstream audio and cover URLs immediately, then let a worker download and validate durable local copies.
- Validate downloaded audio and image signatures instead of trusting content type alone.

