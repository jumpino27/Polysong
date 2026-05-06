# Polysong YouTube Source

YouTube ingestion exists only for content the user has the right to download, such as their own uploads, Creative Commons works, public-domain material, or situations permitted by local law. The frontend must collect consent before queuing a YouTube URL.

The implementation runs `yt-dlp` with `--no-playlist`, writes audio into `songs/youtube/`, stores thumbnails in `songs/covers/`, and persists an ingest job before work starts so failed downloads remain retryable. If `yt-dlp` is not on `PATH`, the Tauri layer can bootstrap a local Python module copy under app data.
