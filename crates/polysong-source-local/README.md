# Polysong Local Source

Local ingestion handles user-selected files and folders. The scanner should only read paths the user explicitly selects, then copy or link files into `songs/local/` based on settings.

The Tauri materializer uses `ffprobe` for basic title/artist/album/duration metadata and `ffmpeg` to extract embedded cover art into `songs/covers/` when those tools are available.
