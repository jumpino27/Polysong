# Polysong YouTube Source

YouTube ingestion exists only for content the user has the right to download, such as their own uploads, Creative Commons works, public-domain material, or situations permitted by local law. The frontend must collect consent before queuing a YouTube URL.

The production implementation should run `yt-dlp` as a restricted Tauri sidecar, write into the app data `songs/youtube/` folder, and persist an ingest job before work starts so failed downloads remain retryable.
