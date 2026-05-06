# Polysong

Polysong is a local-first desktop music library scaffold built with Tauri 2, Rust, SQLite, React, and the Web Audio API. It unifies local files, YouTube URLs, and Suno songs into one library with playlists, ingest jobs, light/dark themes, and a full-window visualizer.

Imported audio is assigned under the app data folder as `songs/suno/`, `songs/youtube/`, or `songs/local/`. Cover images are saved under `songs/covers/`. The database is created empty; it does not seed demo tracks.

Ingest behavior in this scaffold:

- Local paths are copied into `songs/local/`; `ffprobe` is used for title/artist/album/duration when available, and `ffmpeg` attempts to extract embedded cover art.
- YouTube URLs are normalized to a single video id and downloaded with `--no-playlist` so radio/list parameters do not accidentally expand. Metadata and thumbnails come from `yt-dlp`; if `yt-dlp` is not on `PATH`, Polysong bootstraps a local Python module copy under the app data `tools/yt-dlp/` folder when Python is available.
- Suno `/song/{id}`, `/s/{short}`, and `/playlist/{id}` URLs are supported. Short links resolve through Suno redirect, playlists expand through Suno's public playlist API, and tracks download audio plus cover art from the returned metadata.

## Run

```powershell
pnpm install
pnpm build
cargo check --workspace
pnpm tauri:dev
```

The browser development fallback also works without the Tauri shell:

```powershell
pnpm dev
```

## Legal and ethical notes

Polysong is for content you own or have the right to download and keep locally.

- Local files are imported from user-selected paths.
- Suno ingestion is intended for the signed-in user's own generated songs. Public Suno URL import should remain behind an advanced consent toggle.
- YouTube ingestion is for content the user has rights to download, such as their own uploads, Creative Commons material, public-domain recordings, or cases allowed by local law.

The app surfaces this guidance in onboarding and source-specific ingest UI. Backend source modules keep public/Suno advanced behavior explicit rather than silent.
