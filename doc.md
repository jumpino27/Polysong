# Polysong — Architecture & Design Document

> A local-first, modular, open-source music player that ingests songs from **Suno**, **YouTube**, and **local files** into a single library, with playlists and a full-window visualizer mode.

*Working name: **Polysong**. Replace freely.*

Document version: **0.1 — initial design**
Target stack: **Tauri 2.x + Rust + SQLite + (React or Solid) + Web Audio API**

---

## 1. Goals & Non-Goals

### Goals
- **One library, three sources.** Local files, YouTube URLs, and Suno songs become first-class items in the same library.
- **Local-first.** Everything (audio files, DB, cover art, config) lives under a single user-controlled folder. No accounts, no cloud, no telemetry.
- **Single binary, runs from a shell.** `polysong` launches a Tauri window. No external services to set up.
- **Modular by design.** Each feature is a crate (Rust) or component (frontend). Sources are pluggable behind a trait.
- **Full-window mode with visualizer.** Hide the chrome, dim the lights, watch the music dance.
- **Editable metadata + playlists.** All persisted in a local SQLite file the user can back up.

### Non-Goals (v1)
- Streaming without download. Polysong is download-and-play, not a real-time streamer.
- Mobile. Tauri 2 supports it, but desktop ships first.
- DRM-protected content. Spotify, Apple Music, Tidal — out of scope.
- Cloud sync. Out of scope for v1; the schema leaves room for it.

---

## 2. Legal & Ethical Notes (read before coding)

This matters because the project touches three different content sources with three different rules. Treat this as engineering constraints, not legal advice.

- **Local files.** The user owns their library; no concerns.
- **Suno.** Per Suno's ToS, users on Pro/Premier plans own the songs they generate and can download them (WAV available only via `suno.com`). Polysong's Suno ingestor should default to **the signed-in user's own library** via cookies/session. Downloading arbitrary public Suno tracks via the `og:audio` meta tag (the technique used by some yt-dlp PRs) works mechanically but is a gray area — **gate it behind an "advanced" toggle** and a clear in-app disclaimer that the user is responsible for respecting the original creator's rights.
- **YouTube.** Downloading is restricted by YouTube's ToS regardless of the technical capability of yt-dlp. Polysong should not market itself as a YouTube ripper; the feature exists for content the user has the right to download (Creative Commons, public domain, their own uploads, content their region/jurisdiction permits for personal use). Surface this via a one-time consent dialog on first YouTube ingest.

These warnings should appear **in the README, in the app's first-run dialog, and in the source ingestor docs.**

---

## 3. Technology Choices

| Layer | Choice | Why |
|---|---|---|
| Shell / window | **Tauri 2.x** (currently 2.11) | ~600 KB-ish binaries, native WebView, real Rust backend, mature plugin ecosystem, MIT/Apache. |
| Backend language | **Rust (edition 2021)** | Type safety + the audio/decoding/DB ecosystem the project needs. |
| Frontend framework | **React + TypeScript** (or **SolidJS** if you prefer leaner) | Either works; pick what you'll actually ship. The visualizer code is framework-agnostic. |
| Styling | **Tailwind CSS v4** | Fast iteration, no design-system overhead. |
| Database | **SQLite** via **`tauri-plugin-sql`** (sqlx + sqlite feature) | Official plugin, async, has built-in migrations, supports a single `.db` file under the app data directory. |
| Audio decoding | **Symphonia** (transitively, via the WebView's `<audio>` element) | The WebView already decodes MP3/M4A/OGG/FLAC/WAV. We don't reinvent this on the Rust side. |
| Audio playback | **HTML5 `<audio>` in the WebView** | Critical decision — see §6. |
| Audio analysis (visualizer) | **Web Audio API** `AnalyserNode` (FFT) + **Canvas / WebGL** | Free with the WebView, ~60 fps, exactly what visualizers want. |
| Metadata read/write | **`lofty` crate** (Rust) | Reads/writes ID3v2, Vorbis Comments, MP4 atoms, APE, RIFF INFO. The de facto choice. |
| Audio download (YT + Suno fallback) | **`yt-dlp`** as a **Tauri sidecar binary** | 1800+ extractors, actively maintained, would take years to reimplement in Rust. |
| Audio post-processing | **`ffmpeg`** as a sidecar | Format conversion, audio extraction, normalizing. |
| Suno user-library ingest | Direct HTTP via `reqwest` | The user's own session — most reliable path. |
| State management (FE) | **Zustand** (React) or **Solid stores** | Small, good fit for a music app's state. |
| Logging | **`tracing`** + `tracing-subscriber` | Async-aware, structured logs. |

---

## 4. High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                           Tauri WebView                            │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  React/Solid Frontend                                        │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐   │  │
│  │  │ Library  │ │ Playlists│ │ Player   │ │ Visualizer     │   │  │
│  │  │ Browser  │ │ Manager  │ │ Controls │ │ (Web Audio +   │   │  │
│  │  │          │ │          │ │          │ │  Canvas/WebGL) │   │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────────────┘   │  │
│  │  ┌──────────────────────────────────────────────────────────┐│  │
│  │  │ <audio> element (decode + playback + AnalyserNode)       ││  │
│  │  └──────────────────────────────────────────────────────────┘│  │
│  └──────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────┬─────────────────────────────────┘
                                   │ Tauri IPC (invoke/emit)
                                   │ + custom `polysong://` protocol
┌──────────────────────────────────┴─────────────────────────────────┐
│                       Rust Backend (workspace)                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────┐  │
│  │ core        │  │ db          │  │ library     │  │ playback  │  │
│  │ (types,     │  │ (sqlx,      │  │ (scan,      │  │ (cover    │  │
│  │  errors,    │  │  migrations)│  │  metadata,  │  │   art,    │  │
│  │  config)    │  │             │  │  hashing)   │  │   queue)  │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  └───────────┘  │
│  ┌──────────────────── ingest (trait-based) ─────────────────────┐ │
│  │  ┌───────────────┐  ┌───────────────┐  ┌──────────────────┐   │ │
│  │  │ local         │  │ youtube       │  │ suno             │   │ │
│  │  │ (filesystem)  │  │ (yt-dlp)      │  │ (API + yt-dlp)   │   │ │
│  │  └───────────────┘  └───────────────┘  └──────────────────┘   │ │
│  └───────────────────────────────────────────────────────────────┘ │
│  ┌─────────────┐  ┌─────────────┐                                  │
│  │ downloader  │  │ tauri-app   │  ← binary crate                  │
│  │ (sidecars)  │  │ (commands,  │                                  │
│  │             │  │  state)     │                                  │
│  └─────────────┘  └─────────────┘                                  │
└────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
        ┌──────────────────────────────────────────────────┐
        │  ~/.local/share/polysong/    (or platform equiv) │
        │  ├── polysong.db                                 │
        │  ├── audio/                                      │
        │  │   ├── local/        (symlinks or copies)      │
        │  │   ├── youtube/                                │
        │  │   └── suno/                                   │
        │  ├── covers/                                     │
        │  └── logs/                                       │
        └──────────────────────────────────────────────────┘
```

---

## 5. Rust Workspace Layout

The backend is a **Cargo workspace** of small focused crates. This is the modularity the project asks for — every feature lands in its own crate with a narrow public API.

```
polysong/
├── Cargo.toml                  # workspace
├── crates/
│   ├── polysong-core/          # shared types, errors, config
│   ├── polysong-db/            # SQLite schema, migrations, queries
│   ├── polysong-library/       # library scan, dedup, metadata via lofty
│   ├── polysong-ingest/        # IngestSource trait + registry
│   ├── polysong-source-local/  # local filesystem ingestor
│   ├── polysong-source-youtube/# YouTube ingestor (yt-dlp)
│   ├── polysong-source-suno/   # Suno ingestor (HTTP + yt-dlp fallback)
│   ├── polysong-downloader/    # sidecar wrapper (yt-dlp, ffmpeg)
│   └── polysong-playback/      # cover art, queue management, etc.
├── src-tauri/                  # Tauri binary crate
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands/           # one file per feature area
│   │   │   ├── library.rs
│   │   │   ├── playback.rs
│   │   │   ├── playlists.rs
│   │   │   └── ingest.rs
│   │   └── state.rs
│   └── binaries/               # bundled sidecars per platform
│       ├── yt-dlp-x86_64-pc-windows-msvc.exe
│       ├── yt-dlp-x86_64-apple-darwin
│       ├── yt-dlp-aarch64-apple-darwin
│       ├── yt-dlp-x86_64-unknown-linux-gnu
│       └── ffmpeg-... (same matrix)
└── frontend/                   # React/Solid app
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── components/
        ├── features/
        ├── store/
        └── lib/
```

### Crate responsibilities

**`polysong-core`**
The shared vocabulary. Pure types, no I/O.
```rust
pub struct Track { /* id, title, artist, album, duration, source, file_path, ... */ }
pub struct Playlist { /* id, name, tracks: Vec<TrackId>, ... */ }
pub enum SourceKind { Local, YouTube, Suno }
pub enum IngestStatus { Queued, Downloading { progress }, Ready, Failed(String) }
pub struct AppConfig { /* paths, audio quality prefs, etc. */ }
```

**`polysong-db`**
Owns the schema and migrations. Exposes a thin `Repository` API so other crates never see SQL directly.
```rust
pub struct Repository { pool: SqlitePool }
impl Repository {
    pub async fn insert_track(&self, t: NewTrack) -> Result<TrackId>;
    pub async fn list_tracks(&self, filter: TrackFilter) -> Result<Vec<Track>>;
    pub async fn create_playlist(&self, name: &str) -> Result<PlaylistId>;
    pub async fn add_to_playlist(&self, p: PlaylistId, t: TrackId) -> Result<()>;
    // ...
}
```

**`polysong-library`**
Scans folders, hashes files for dedup (`xxhash` over the first N MB is plenty), reads tags via `lofty`, extracts cover art, writes everything into the DB.

**`polysong-ingest`**
Defines the trait that makes the system extensible:
```rust
#[async_trait]
pub trait IngestSource: Send + Sync {
    fn id(&self) -> &'static str;             // "local" | "youtube" | "suno"
    fn supports_url(&self, url: &str) -> bool;
    async fn ingest(
        &self,
        input: IngestInput,
        ctx: &IngestCtx,
    ) -> Result<IngestOutcome>;
}
```
Plus a `Registry` that holds boxed `IngestSource`s and dispatches by URL. **Adding a new source = new crate + register it in `main.rs`.**

**`polysong-source-local`**
The simplest. Takes a path or a list of paths, copies (or symlinks, configurable) into `audio/local/`, then defers to `library` for tagging.

**`polysong-source-youtube`**
Wraps the yt-dlp sidecar. Calls something like:
```
yt-dlp -x --audio-format mp3 --audio-quality 0 \
       --embed-metadata --embed-thumbnail \
       --print-json -o "<audio_dir>/youtube/%(id)s.%(ext)s" <url>
```
Parses the JSON to populate metadata, then registers the file with `library`.

**`polysong-source-suno`**
Two-mode operation:
1. **User library mode** (default): authenticated HTTP requests to Suno's own endpoints to list and pull the user's owned tracks (cookie-based). Reliable because the user owns the content.
2. **Public URL mode** (opt-in, advanced): given a `suno.com/song/<id>` URL, fetches the page and reads `<meta property="og:audio">` to get the CDN URL (this is the technique tracked in [yt-dlp issue #10368](https://github.com/yt-dlp/yt-dlp/issues/10368)). Downloads to `audio/suno/`. Show the legal disclaimer.

**`polysong-downloader`**
Manages the sidecar binaries — discovers them via Tauri's resource resolver, runs them as subprocesses, parses progress (yt-dlp emits structured progress with `--newline` + `--progress-template`), surfaces it as a stream of events.

**`polysong-playback`**
Despite the name, this crate does **not** play audio (the WebView does — see §6). It handles the things that *support* playback: cover-art extraction, queue ordering, scrobbling-ready event emission, gapless metadata.

---

## 6. The Audio Strategy — Critical Decision

There are two ways to play audio in a Tauri app:

**Option A — Native Rust (rodio + cpal + symphonia)**
Pros: full control, can mix many sources, no WebView quirks.
Cons: you must manually pipe FFT data to the frontend for the visualizer (over IPC, 60 times/sec — possible but fragile), audio routing across OSes is its own headache, and you're rebuilding what the WebView already does well.

**Option B — HTML5 `<audio>` in the WebView (recommended)**
Pros:
- Decoding for MP3/M4A/OGG/FLAC/WAV is free and OS-native.
- The **Web Audio API** gives you `AudioContext` → `MediaElementAudioSourceNode` → `AnalyserNode` for the visualizer with ~zero glue.
- Frame-accurate seek, volume, playback-rate, all built in.
- The visualizer runs at 60 fps in the same process as the UI — no IPC bottleneck.
Cons: the WebView is a sandboxed browser, so it can't read arbitrary file paths.

The cons are solved by Tauri's **custom protocol** feature. Register a `polysong://` (or `asset://`, the built-in one) protocol that streams files from the app's data directory with a permission allow-list. The frontend then does `<audio src="polysong://track/abc123.mp3">`.

**This document recommends Option B.** Keep `rodio` in mind only if you later need cross-fading or mixing that goes beyond what `<audio>` gives you.

```
┌────────────────────────────────────────────────────────┐
│  AudioContext                                          │
│   └─ MediaElementAudioSourceNode (wraps <audio>)       │
│       ├─ AnalyserNode  ──► Visualizer canvas/WebGL    │
│       └─ GainNode      ──► destination (speakers)      │
└────────────────────────────────────────────────────────┘
```

---

## 7. Database Schema (v1)

A single SQLite file: `polysong.db`. Migrations live in `polysong-db/migrations/` and run on startup via `tauri-plugin-sql`.

```sql
-- tracks: the central table
CREATE TABLE tracks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source          TEXT    NOT NULL CHECK (source IN ('local','youtube','suno')),
    source_id       TEXT,                               -- yt video id, suno song id, NULL for local
    file_path       TEXT    NOT NULL UNIQUE,            -- relative to audio_root
    title           TEXT,
    artist          TEXT,
    album           TEXT,
    album_artist    TEXT,
    track_no        INTEGER,
    year            INTEGER,
    genre           TEXT,
    duration_ms     INTEGER,
    bitrate_kbps    INTEGER,
    sample_rate     INTEGER,
    channels        INTEGER,
    cover_path      TEXT,                               -- relative path under covers/
    file_hash       TEXT,                               -- xxhash for dedup
    source_url      TEXT,                               -- original URL if applicable
    added_at        INTEGER NOT NULL,                   -- unix epoch ms
    last_played_at  INTEGER,
    play_count      INTEGER NOT NULL DEFAULT 0,
    favorite        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tracks_source     ON tracks(source);
CREATE INDEX idx_tracks_artist     ON tracks(artist);
CREATE INDEX idx_tracks_album      ON tracks(album);
CREATE INDEX idx_tracks_added_at   ON tracks(added_at);

-- playlists
CREATE TABLE playlists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT,
    cover_path  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id    INTEGER NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, position)
);
CREATE INDEX idx_pt_track ON playlist_tracks(track_id);

-- ingest jobs: persisted so a download survives an app restart
CREATE TABLE ingest_jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT    NOT NULL,
    input       TEXT    NOT NULL,                        -- URL or path
    status      TEXT    NOT NULL,                        -- queued|downloading|ready|failed
    progress    REAL    NOT NULL DEFAULT 0,              -- 0..1
    track_id    INTEGER REFERENCES tracks(id),
    error       TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- key/value config (theme, last queue, prefs, ...)
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

**Why playlist_tracks is keyed on `(playlist_id, position)`:** it makes reordering trivial and prevents accidental duplicate slots. Adding the same track twice to a playlist is fine — different positions.

---

## 8. Ingestion Pipeline

The pipeline is the same for every source — only the *fetch* step differs. This is where the modular design pays off.

```
URL or file path
       │
       ▼
┌─────────────────────┐
│ Registry::resolve() │ ──► picks the right IngestSource
└─────────────────────┘
       │
       ▼
┌────────────────────────────────────────────┐
│  IngestSource::ingest(input)               │
│   1. fetch        → audio file on disk     │
│   2. probe        → lofty reads tags       │
│   3. cover_art    → write to covers/       │
│   4. dedup_check  → file_hash vs DB        │
│   5. db_insert    → tracks row created     │
│   6. emit event   → frontend updates UI    │
└────────────────────────────────────────────┘
```

**Progress events.** Each ingestor emits `IngestProgress { job_id, kind, value }` over a Tokio broadcast channel. The Tauri layer relays them to the frontend via `app.emit("ingest:progress", ...)`. The frontend's ingest queue UI subscribes once and renders progress bars per job.

**Failure handling.** Every job is persisted in `ingest_jobs` *before* work starts, so a crash mid-download leaves a `failed` row the user can retry rather than a phantom zero-byte file.

**Concurrency.** A semaphore (default 2) limits concurrent network downloads. Local-folder scans use `rayon` for parallel file reads.

---

## 9. Tauri IPC Surface

Keep the IPC surface narrow — every command is a hole through your sandbox. Group them by feature.

```rust
// commands/library.rs
#[tauri::command] async fn list_tracks(filter: TrackFilter)        -> Result<Vec<Track>>;
#[tauri::command] async fn get_track(id: i64)                      -> Result<Track>;
#[tauri::command] async fn update_track_metadata(id: i64, patch: TrackPatch) -> Result<()>;
#[tauri::command] async fn delete_track(id: i64, delete_file: bool) -> Result<()>;
#[tauri::command] async fn rescan_local_folder(path: String)       -> Result<ScanReport>;

// commands/playlists.rs
#[tauri::command] async fn list_playlists()                                   -> Result<Vec<Playlist>>;
#[tauri::command] async fn create_playlist(name: String, desc: Option<String>) -> Result<Playlist>;
#[tauri::command] async fn add_to_playlist(playlist_id: i64, track_ids: Vec<i64>) -> Result<()>;
#[tauri::command] async fn reorder_playlist(playlist_id: i64, ordering: Vec<i64>) -> Result<()>;
#[tauri::command] async fn delete_playlist(id: i64)                           -> Result<()>;

// commands/ingest.rs
#[tauri::command] async fn ingest_local_paths(paths: Vec<String>)  -> Result<Vec<JobId>>;
#[tauri::command] async fn ingest_url(url: String)                 -> Result<JobId>;
#[tauri::command] async fn list_ingest_jobs()                      -> Result<Vec<IngestJob>>;
#[tauri::command] async fn cancel_ingest_job(id: i64)              -> Result<()>;

// commands/settings.rs
#[tauri::command] async fn get_settings()                          -> Result<AppSettings>;
#[tauri::command] async fn update_settings(patch: SettingsPatch)   -> Result<AppSettings>;
```

Events emitted from Rust → frontend:
- `ingest:progress` — `{ job_id, progress, status }`
- `ingest:complete` — `{ job_id, track_id }`
- `library:updated` — fired after any DB mutation so views can refresh
- `player:position` — optional; the WebView can compute its own position too

---

## 10. Frontend Component Architecture

The frontend mirrors the backend's modularity. Each feature is a folder under `frontend/src/features/`.

```
frontend/src/
├── components/             # shared, dumb components
│   ├── ui/                 # Button, Slider, Modal, ContextMenu, ...
│   ├── TrackRow.tsx
│   ├── CoverArt.tsx
│   └── ProgressBar.tsx
├── features/
│   ├── library/
│   │   ├── LibraryView.tsx         # main grid/list
│   │   ├── SourceFilter.tsx        # All | Local | YouTube | Suno
│   │   ├── SearchBar.tsx
│   │   └── useLibrary.ts           # hook: queries + cache
│   ├── playlists/
│   │   ├── PlaylistSidebar.tsx
│   │   ├── PlaylistView.tsx
│   │   ├── PlaylistEditor.tsx
│   │   └── usePlaylists.ts
│   ├── ingest/
│   │   ├── IngestDialog.tsx        # paste a URL, pick local files
│   │   ├── IngestQueue.tsx         # live progress
│   │   └── useIngest.ts
│   ├── player/
│   │   ├── PlayerBar.tsx           # bottom bar: art, title, controls
│   │   ├── QueueDrawer.tsx
│   │   ├── audioEngine.ts          # the <audio> + Web Audio plumbing
│   │   └── usePlayer.ts            # Zustand store
│   ├── visualizer/
│   │   ├── FullscreenView.tsx
│   │   ├── visualizers/
│   │   │   ├── BarsVisualizer.tsx
│   │   │   ├── WaveformVisualizer.tsx
│   │   │   ├── RadialVisualizer.tsx
│   │   │   └── ShaderVisualizer.tsx   # WebGL/Shadertoy-style
│   │   └── useAnalyser.ts          # exposes Uint8Array of FFT data
│   └── settings/
│       └── SettingsView.tsx
├── lib/
│   ├── tauri.ts                    # typed wrappers around invoke()
│   └── format.ts                   # duration, bytes, etc.
├── store/                          # cross-feature stores if needed
├── App.tsx
└── main.tsx
```

### The audio engine module (`features/player/audioEngine.ts`)

The single source of truth for playback in the frontend.

```ts
class AudioEngine {
  private el = new Audio();
  private ctx = new AudioContext();
  private source = this.ctx.createMediaElementSource(this.el);
  private analyser = this.ctx.createAnalyser();
  private gain = this.ctx.createGain();

  constructor() {
    this.source.connect(this.analyser);
    this.analyser.connect(this.gain);
    this.gain.connect(this.ctx.destination);
    this.analyser.fftSize = 2048;          // 1024 freq bins
    this.analyser.smoothingTimeConstant = 0.85;
  }

  load(track: Track) {
    this.el.src = `polysong://track/${track.id}`; // custom protocol
  }
  play()  { this.ctx.resume(); this.el.play(); }
  pause() { this.el.pause(); }
  seek(s: number)   { this.el.currentTime = s; }
  setVolume(v: number) { this.gain.gain.value = v; }

  // For the visualizer
  getFrequencyData(out: Uint8Array) { this.analyser.getByteFrequencyData(out); }
  getWaveformData(out: Uint8Array)  { this.analyser.getByteTimeDomainData(out); }
}
```

Exactly one instance of this class lives in the app. Every visualizer reads from it.

### The visualizer module

Each visualizer is a React/Solid component that:
1. Receives the shared `AudioEngine` (or an `AnalyserNode` directly).
2. Sets up a `<canvas>` (2D or WebGL).
3. Runs a `requestAnimationFrame` loop calling `getFrequencyData` / `getWaveformData`.
4. Renders.

This means **adding a new visualizer is a single file** under `visualizers/`. The picker UI just enumerates the folder.

Starter visualizers worth shipping in v1:
- **Bars** — classic Winamp-style frequency bars (the easiest, ~30 lines).
- **Waveform** — oscilloscope view of the time-domain signal.
- **Radial** — bars arranged in a circle around the album art.
- **Shader** — a fullscreen fragment shader fed FFT data as a texture (Shadertoy-style — high impact).

### Full-window mode

A single boolean in the player store. When `true`:
- The `PlayerBar` and sidebars hide.
- `FullscreenView` mounts with the active visualizer at 100vw × 100vh, the cover art enlarged or behind, controls fading out after N seconds of mouse inactivity.
- Tauri window can also call `setFullscreen(true)` for borderless mode.
- `ESC` exits.

---

## 11. File / Storage Layout

```
$APP_DATA_DIR/                       # Tauri::path::app_data_dir()
├── polysong.db                      # SQLite
├── audio/
│   ├── local/                       # copies or symlinks (user choice)
│   ├── youtube/<video_id>.mp3
│   └── suno/<song_id>.mp3
├── covers/
│   └── <hash>.jpg                   # extracted cover art
├── logs/
│   └── polysong.log                 # tracing output
└── config.toml                      # human-editable user prefs
```

Where `$APP_DATA_DIR` is:
- **Linux:** `~/.local/share/polysong/`
- **macOS:** `~/Library/Application Support/polysong/`
- **Windows:** `%APPDATA%\polysong\`

A "Show in file manager" button in settings reveals this folder so users always know where their data is.

---

## 12. Build, Run, Distribute

### Dev workflow
```bash
# one-time
cargo install tauri-cli@^2
pnpm install

# dev (hot reload)
pnpm tauri dev

# release build (per-platform installers)
pnpm tauri build
```

### Sidecar bundling
In `tauri.conf.json`:
```json
{
  "bundle": {
    "externalBin": [
      "binaries/yt-dlp",
      "binaries/ffmpeg"
    ]
  }
}
```
At build time, Tauri picks the matching `<name>-<target-triple>` binary. A small `scripts/fetch-sidecars.{sh,ps1}` downloads the per-platform yt-dlp and ffmpeg binaries into `src-tauri/binaries/` before building. CI does the same.

### CI
GitHub Actions matrix on `macos-latest`, `ubuntu-22.04`, `windows-latest` using `tauri-apps/tauri-action`. Output: `.dmg`, `.deb` + `.AppImage`, `.msi` + `.exe`. Add an `auto-update` channel later via `tauri-plugin-updater` if desired.

---

## 13. Security & Permissions

Tauri 2's capability system is opt-in. Be strict:

- Filesystem plugin scoped to `$APP_DATA_DIR` and **the folders the user explicitly picks** as music sources. No `**`-style allow rules.
- Custom `polysong://` protocol allow-list: only paths under `$APP_DATA_DIR/audio/` and `/covers/`.
- `tauri-plugin-shell` is required for sidecars — restrict it to only the sidecar binaries by name.
- No `tauri-plugin-http` exposed to the frontend; all network calls happen in Rust.
- CSP locked down in `tauri.conf.json` — `default-src 'self'`, allow `polysong:` for `media-src` and `img-src`.

---

## 14. Roadmap (suggested)

**Milestone 0 — skeleton (1–2 weekends)**
- Tauri 2 project scaffolded, React + Tailwind, SQLite plugin wired, schema migrating, dummy `list_tracks` returning seed data, `<audio>` element playing a hardcoded file.

**Milestone 1 — local library (1 week)**
- `polysong-source-local` working: pick a folder, scan, lofty tags, cover art, dedup. Library view + filtering by artist/album. Search.

**Milestone 2 — playback + visualizer (1 week)**
- Full audio engine wired via `polysong://` protocol. Player bar with seek/volume. Bars + Waveform visualizers. Full-window mode.

**Milestone 3 — playlists (3–4 days)**
- CRUD playlists, drag-to-reorder, "Add to playlist" context menu, smart playlists later.

**Milestone 4 — YouTube ingest (1 week)**
- yt-dlp sidecar bundling, `ingest_url` command, ingest queue UI with live progress, format selection (mp3/opus/m4a) in settings.

**Milestone 5 — Suno ingest (1–2 weeks)**
- User-library mode first (auth via copying the Suno session cookie into settings — simple, non-magical, honest). Public-URL mode behind an "Advanced" toggle with disclaimer.

**Milestone 6 — polish**
- Keyboard shortcuts, MPRIS/SMTC media keys, more visualizers (radial, shader), tag editor UI, themes, onboarding.

---

## 15. Open Questions / Future Work

- **Gapless playback** — `<audio>` does not natively gap-less. If this matters, switch the audio engine to use the Web Audio API's `AudioBufferSourceNode` with pre-decoded buffers, or fall back to `rodio` server-side.
- **Cross-fade** — same as above; needs custom mixing.
- **Lyrics** — Suno has them; YouTube sometimes; local files via `lofty`. Consider an `Lrc` viewer.
- **Mobile** — Tauri 2 supports Android/iOS, but yt-dlp/ffmpeg as sidecars don't translate cleanly. Mobile would need a different ingestion strategy.
- **Sync** — schema is sync-friendly. Future versions could ship optional libsql/Turso replication if a use case appears.
- **Sources beyond v1** — SoundCloud, Bandcamp, Mixcloud, Internet Archive. Each is a new crate implementing `IngestSource`. The trait already accommodates this with no changes.

---

## 16. Reference Crates & Versions (as of design date)

| Purpose | Crate / Tool | Version |
|---|---|---|
| Tauri runtime | `tauri` | 2.11 |
| Tauri SQL plugin | `tauri-plugin-sql` | 2.x with `sqlite` feature |
| SQL toolkit | `sqlx` | (transitive via tauri-plugin-sql) |
| Audio metadata | `lofty` | latest stable |
| Async runtime | `tokio` | 1.x |
| Serialization | `serde`, `serde_json` | 1.x |
| HTTP (Suno user mode) | `reqwest` | 0.12.x |
| Hashing (dedup) | `xxhash-rust` | latest |
| Logging | `tracing`, `tracing-subscriber` | latest |
| FS scan | `walkdir`, `rayon` | latest |
| Sidecar | `yt-dlp` (binary) | track latest stable channel |
| Sidecar | `ffmpeg` (binary) | latest LTS |
| Frontend bundler | `vite` | latest |
| UI styling | `tailwindcss` | v4 |

---

## 17. License

Recommend **GPLv3** or **AGPLv3** for the application binary (because it bundles GPL-friendly tools like yt-dlp and ffmpeg, and copyleft fits the spirit of the project). Individual crates can be **MIT OR Apache-2.0** so others can vendor them. Symphonia (MPL-2.0) and Lofty (MIT) are both compatible.

---

*End of v0.1 architecture document. Next step: scaffold Milestone 0 and start filling in `polysong-core` + `polysong-db`.*