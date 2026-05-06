/**
 * Polysong — local-first music workstation.
 *
 * Composition. The shell is a three-column workstation grid: a slim left rail
 * with the Polysong wordmark, source filters with live counts, and a playlist
 * tray; a center workspace whose sticky toolbar carries panel toggles, search,
 * the ingest action, theme, and settings; a right rail that opens with a live
 * audio visualizer card, a segmented mode picker, a "Selected" detail block
 * that surfaces Suno style descriptions as a quoted callout, and the ingest
 * job queue. A full-width player bar pins to the bottom across all three
 * columns. The library header announces the page with a single h1 — "Tracks
 * from local files, YouTube, and Suno in one queue." Below it sits a dense,
 * tactile track list whose Suno rows wear their style description as a first-
 * class chip. Both side rails collapse via animated grid-column transitions
 * so closed panels do not leave empty gutters. Fullscreen mode swaps the
 * entire shell for an edge-to-edge visualizer overlay whose controls fade
 * after a brief idle and reappear on mouse movement.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Disc3,
  Eye,
  EyeOff,
  FileAudio,
  ListMusic,
  Maximize2,
  Minimize2,
  Moon,
  Pause,
  Play,
  Plus,
  Search,
  Settings,
  Sparkles,
  Sun,
  Upload,
  X,
} from 'lucide-react'
import './App.css'
import { Button } from './components/Button'
import { Modal } from './components/Modal'
import { ProgressBar } from './components/ProgressBar'
import { TrackRow } from './components/TrackRow'
import { BarsVisualizer } from './features/visualizer/BarsVisualizer'
import { WaveformVisualizer } from './features/visualizer/WaveformVisualizer'
import { audioEngine } from './features/player/audioEngine'
import { formatDuration } from './lib/format'
import { api } from './lib/tauri'
import type { AppSettings, AudioSource, IngestJob, Playlist, Track, TrackFilter, VisualizerMode } from './types'

const defaultSettings: AppSettings = {
  theme: 'dark',
  audioRoot: 'songs',
  youtubeConsent: false,
  sunoAdvancedEnabled: false,
  maxConcurrentDownloads: 2,
}

const SOURCES: ReadonlyArray<AudioSource | 'all'> = ['all', 'suno', 'youtube', 'local']

function App() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [libraryTracks, setLibraryTracks] = useState<Track[]>([])
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [jobs, setJobs] = useState<IngestJob[]>([])
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [source, setSource] = useState<AudioSource | 'all'>('all')
  const [search, setSearch] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [activeTrack, setActiveTrack] = useState<Track | null>(null)
  const [expandedTrack, setExpandedTrack] = useState<number | null>(1)
  const [leftPanelOpen, setLeftPanelOpen] = useState(true)
  const [rightPanelOpen, setRightPanelOpen] = useState(true)
  const [ingestOpen, setIngestOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [visualizerMode, setVisualizerMode] = useState<VisualizerMode>('bars')
  const [fullscreen, setFullscreen] = useState(false)
  const [overlayVisible, setOverlayVisible] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(0.82)

  const refresh = useCallback(async () => {
    const filter: TrackFilter = {
      source: source === 'all' ? null : source,
      search: search || null,
      favoritesOnly,
    }
    const libraryFilter: TrackFilter = {
      source: null,
      search: search || null,
      favoritesOnly,
    }
    const [nextTracks, nextLibraryTracks, nextPlaylists, nextJobs, nextSettings] = await Promise.all([
      api.listTracks(filter),
      api.listTracks(libraryFilter),
      api.listPlaylists(),
      api.listIngestJobs(),
      api.getSettings(),
    ])
    setTracks(nextTracks)
    setLibraryTracks(nextLibraryTracks)
    setPlaylists(nextPlaylists)
    setJobs(nextJobs)
    setSettings(nextSettings)
    setActiveTrack((current) => current ?? nextTracks[0] ?? null)
  }, [favoritesOnly, search, source])

  useEffect(() => {
    const handle = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(handle)
  }, [refresh])

  useEffect(() => {
    const unsubscribe = audioEngine.subscribe(() => setPlaying(audioEngine.isPlaying))
    return () => {
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  useEffect(() => {
    if (!fullscreen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  useEffect(() => {
    if (!fullscreen) return
    const timeout = window.setTimeout(() => setOverlayVisible(false), 2400)
    return () => window.clearTimeout(timeout)
  }, [fullscreen, overlayVisible])

  const totals = useMemo(
    () => ({
      suno: libraryTracks.filter((track) => track.source === 'suno').length,
      youtube: libraryTracks.filter((track) => track.source === 'youtube').length,
      local: libraryTracks.filter((track) => track.source === 'local').length,
    }),
    [libraryTracks],
  )

  const totalDurationMs = useMemo(
    () => libraryTracks.reduce((sum, track) => sum + (track.durationMs ?? 0), 0),
    [libraryTracks],
  )

  const selectAndPlay = async (track: Track) => {
    setActiveTrack(track)
    audioEngine.load(track)
    await audioEngine.play()
  }

  const togglePlay = async () => {
    if (!activeTrack) return
    if (audioEngine.currentTrack?.id !== activeTrack.id) audioEngine.load(activeTrack)
    if (audioEngine.isPlaying) audioEngine.pause()
    else await audioEngine.play()
  }

  const updateSettings = async (patch: Partial<AppSettings>) => {
    const next = await api.updateSettings(patch)
    setSettings(next)
  }

  const renderVisualizer = () => {
    if (visualizerMode === 'waveform') return <WaveformVisualizer />
    return <BarsVisualizer compact={!fullscreen} />
  }

  if (fullscreen) {
    return (
      <main
        className="fullscreen-view"
        onMouseMove={() => setOverlayVisible(true)}
        onClick={() => setOverlayVisible(true)}
      >
        {renderVisualizer()}
        <div className={`fullscreen-overlay ${overlayVisible ? 'visible' : ''}`}>
          <div className="fullscreen-overlay-top">
            <span className="eyebrow">Now playing — Polysong</span>
            <Button icon={<Minimize2 size={17} />} onClick={() => setFullscreen(false)}>
              Exit fullscreen
            </Button>
          </div>
          <div />
          <div className="fullscreen-overlay-bottom">
            <div className="fullscreen-overlay-text">
              <h1>{activeTrack?.title ?? 'No track selected'}</h1>
              {activeTrack?.styleDescription ? (
                <p className="style-line">
                  <Sparkles size={18} />
                  <span>{activeTrack.styleDescription}</span>
                </p>
              ) : (
                <p className="style-line">
                  <span>{activeTrack?.artist ?? 'Load a track from the library to begin.'}</span>
                </p>
              )}
            </div>
            <div className="fullscreen-controls">
              <Button
                icon={playing ? <Pause size={18} /> : <Play size={18} />}
                variant="primary"
                onClick={togglePlay}
              >
                {playing ? 'Pause' : 'Play'}
              </Button>
              <Button icon={<X size={18} />} onClick={() => setFullscreen(false)} aria-label="Exit fullscreen" />
            </div>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main
      className="app-shell"
      data-left={leftPanelOpen ? 'open' : 'closed'}
      data-right={rightPanelOpen ? 'open' : 'closed'}
    >
      <aside className={`sidebar left ${leftPanelOpen ? 'open' : 'closed'}`} aria-label="Sources and playlists">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            <Disc3 size={20} strokeWidth={2.4} />
          </div>
          <div className="brand-name">
            <strong>Polysong</strong>
            <span>local-first lab</span>
          </div>
        </div>

        <section aria-labelledby="sources-heading">
          <div className="rail-heading">
            <h2 id="sources-heading">Sources</h2>
            <span className="rail-heading-count">{tracks.length}</span>
          </div>
          <nav className="source-nav" aria-label="Filter by source">
            {SOURCES.map((value) => (
              <button
                key={value}
                type="button"
                data-source={value}
                className={source === value ? 'selected' : ''}
                onClick={() => setSource(value)}
                aria-pressed={source === value}
              >
                <span className="src-dot" aria-hidden />
                <span className="src-label">{value === 'all' ? 'All sources' : value}</span>
                <span className="src-count">{value === 'all' ? libraryTracks.length : totals[value]}</span>
              </button>
            ))}
          </nav>
        </section>

        <section className="playlist-panel" aria-labelledby="playlists-heading">
          <div className="rail-heading">
            <h2 id="playlists-heading">Playlists</h2>
            <Button
              icon={<Plus size={15} />}
              variant="quiet"
              aria-label="Create playlist"
              onClick={() => void api.createPlaylist('New playlist').then(refresh)}
            />
          </div>
          <div className="playlist-list">
            {playlists.length === 0 && <p className="playlist-empty">No playlists yet.</p>}
            {playlists.map((playlist) => (
              <button className="playlist-item" type="button" key={playlist.id}>
                <ListMusic size={15} />
                <span>{playlist.name}</span>
                <em>{playlist.trackCount}</em>
              </button>
            ))}
          </div>
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar" role="toolbar" aria-label="Library controls">
          <Button
            icon={leftPanelOpen ? <ChevronLeft size={17} /> : <ChevronRight size={17} />}
            variant="ghost"
            aria-label={leftPanelOpen ? 'Collapse source panel' : 'Expand source panel'}
            onClick={() => setLeftPanelOpen((value) => !value)}
          />
          <label className="search">
            <Search size={16} />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search title, artist, album, or Suno style"
              aria-label="Search library"
            />
          </label>
          <Button icon={<Upload size={16} />} variant="primary" onClick={() => setIngestOpen(true)}>
            Ingest
          </Button>
          <span className="topbar-divider" aria-hidden />
          <Button
            icon={settings.theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
            variant="ghost"
            aria-label={settings.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
            onClick={() => updateSettings({ theme: settings.theme === 'light' ? 'dark' : 'light' })}
          />
          <Button
            icon={<Settings size={16} />}
            variant="ghost"
            aria-label="Open settings"
            onClick={() => setSettingsOpen(true)}
          />
          <Button
            icon={rightPanelOpen ? <EyeOff size={16} /> : <Eye size={16} />}
            variant="ghost"
            aria-label={rightPanelOpen ? 'Hide detail panel' : 'Show detail panel'}
            onClick={() => setRightPanelOpen((value) => !value)}
          />
        </header>

        <section className="library-header">
          <div className="library-header-text">
            <span className="eyebrow">Unified library</span>
            <h1>
              Tracks from local files, YouTube, and Suno in <em>one queue</em>.
            </h1>
            <div className="library-header-meta">
              <span><strong>{libraryTracks.length}</strong> tracks</span>
              <span><strong>{totals.suno}</strong> Suno</span>
              <span><strong>{totals.youtube}</strong> YouTube</span>
              <span><strong>{totals.local}</strong> local</span>
              <span><strong>{formatDuration(totalDurationMs)}</strong> total</span>
            </div>
          </div>
          <div className="library-header-controls">
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={favoritesOnly}
                onChange={(event) => setFavoritesOnly(event.target.checked)}
              />
              Favorites only
            </label>
          </div>
        </section>

        <section className="track-list" aria-label="Tracks">
          {tracks.length === 0 && (
            <p className="track-list-empty">No tracks match. Adjust filters or queue an ingest.</p>
          )}
          {tracks.map((track) => (
            <TrackRow
              key={track.id}
              track={track}
              active={activeTrack?.id === track.id}
              expanded={expandedTrack === track.id}
              onPlay={() => void selectAndPlay(track)}
              onToggleFavorite={() => void api.updateTrackMetadata(track.id, { favorite: !track.favorite }).then(refresh)}
              onToggleExpanded={() => setExpandedTrack((current) => (current === track.id ? null : track.id))}
              onDelete={() => void api.deleteTrack(track.id).then(refresh)}
            />
          ))}
        </section>
      </section>

      <aside
        className={`sidebar right ${rightPanelOpen ? 'open' : 'closed'}`}
        aria-label="Visualizer and now playing"
      >
        <section aria-labelledby="visualizer-heading">
          <div className="rail-heading-block">
            <h2 id="visualizer-heading">Visualizer</h2>
            <Button icon={<Maximize2 size={14} />} variant="ghost" onClick={() => setFullscreen(true)}>
              Full
            </Button>
          </div>
          <div className="visualizer-card">{renderVisualizer()}</div>
          <div className="segmented" role="tablist" aria-label="Visualizer mode">
            {(['bars', 'waveform', 'radial'] as VisualizerMode[]).map((mode) => (
              <button
                key={mode}
                role="tab"
                aria-selected={visualizerMode === mode}
                disabled={mode === 'radial'}
                className={visualizerMode === mode ? 'selected' : ''}
                type="button"
                onClick={() => setVisualizerMode(mode)}
              >
                {mode === 'radial' ? 'radial · soon' : mode}
              </button>
            ))}
          </div>
        </section>

        <section className="now-playing-detail" aria-labelledby="selected-heading">
          <div className="eyebrow">
            <span id="selected-heading">Selected</span>
            {activeTrack && <span>{formatDuration(activeTrack.durationMs)}</span>}
          </div>
          <h2>{activeTrack?.title ?? 'No track loaded'}</h2>
          <p className="artist-line">
            {activeTrack?.artist ?? 'Choose a track to load the audio engine.'}
          </p>
          {activeTrack?.styleDescription && (
            <div className="style-quote">
              <Sparkles size={15} />
              <span>{activeTrack.styleDescription}</span>
            </div>
          )}
        </section>

        <section className="queue-panel" aria-labelledby="queue-heading">
          <div className="rail-heading">
            <h2 id="queue-heading">Ingest queue</h2>
            <span className="rail-heading-count">{jobs.length}</span>
          </div>
          {jobs.length === 0 && <p className="queue-empty">No jobs yet — queue one with the Ingest button.</p>}
          {jobs.map((job) => (
            <div className="job" key={job.id}>
              <span className="job-source">{job.source}</span>
              <strong className="job-status" data-status={job.status}>
                {job.status}
              </strong>
              <ProgressBar value={job.progress} />
            </div>
          ))}
        </section>
      </aside>

      <footer className="player-bar" aria-label="Player">
        <div className="player-meta">
          <div className={`mini-cover ${playing ? 'playing' : ''}`} aria-hidden>
            <Disc3 size={20} strokeWidth={2.2} />
          </div>
          <div className="player-meta-text">
            <span className="now">{playing ? 'Now playing' : 'Idle'}</span>
            <strong>{activeTrack?.title ?? 'No track loaded'}</strong>
            <span>
              {activeTrack
                ? `${activeTrack.artist ?? 'Unknown'} · ${formatDuration(activeTrack.durationMs)}`
                : 'Pick a track to load the engine'}
            </span>
          </div>
        </div>
        <Button
          icon={playing ? <Pause size={18} /> : <Play size={18} />}
          variant="primary"
          onClick={togglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? 'Pause' : 'Play'}
        </Button>
        <span className="topbar-divider" aria-hidden />
        <label className="player-volume">
          <span className="muted" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', letterSpacing: '0.16em', textTransform: 'uppercase' }}>
            VOL
          </span>
          <input
            className="volume"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            style={{ ['--volume-pct' as string]: `${Math.round(volume * 100)}%` }}
            onChange={(event) => {
              const next = Number(event.target.value)
              setVolume(next)
              audioEngine.setVolume(next)
            }}
            aria-label="Volume"
          />
        </label>
      </footer>

      <IngestDialog
        open={ingestOpen}
        settings={settings}
        onClose={() => setIngestOpen(false)}
        onSettings={updateSettings}
        onDone={() => {
          setIngestOpen(false)
          void refresh()
        }}
      />
      <SettingsDialog open={settingsOpen} settings={settings} onClose={() => setSettingsOpen(false)} onUpdate={updateSettings} />
    </main>
  )
}

function IngestDialog({
  open,
  settings,
  onClose,
  onSettings,
  onDone,
}: {
  open: boolean
  settings: AppSettings
  onClose: () => void
  onSettings: (patch: Partial<AppSettings>) => Promise<void>
  onDone: () => void
}) {
  const [source, setSource] = useState<AudioSource>('suno')
  const [input, setInput] = useState('https://suno.com/s/x05KvNFq7Tn5KqyR')
  const [file, setFile] = useState<File | null>(null)
  const needsYoutubeConsent = source === 'youtube' && !settings.youtubeConsent
  const needsSunoConsent = source === 'suno' && !settings.sunoAdvancedEnabled
  const cannotSubmit = source === 'local' ? !file : !input.trim() || needsYoutubeConsent || needsSunoConsent

  const submit = async () => {
    if (source === 'local') {
      if (!file) return
      await api.uploadLocal(file)
      onDone()
      return
    }

    await api.ingestUrl({
      source,
      input,
      advancedPublicSuno: settings.sunoAdvancedEnabled,
      consentAccepted: source === 'youtube' ? settings.youtubeConsent : source === 'suno' ? settings.sunoAdvancedEnabled : true,
    })
    onDone()
  }

  const sourceTitle =
    source === 'suno' ? 'Suno import — advanced public URL mode' : source === 'youtube' ? 'YouTube import — rights confirmation required' : 'Local import'
  const sourceCopy =
    source === 'suno'
      ? 'Paste a Suno song, short link, or playlist. Playlist imports expand into one downloaded track per clip with style, prompt, cover, and duration metadata when available.'
      : source === 'youtube'
        ? 'Only import audio you own or have explicit rights to download. Polysong does not host or transmit copyrighted media on your behalf.'
        : 'Choose an audio file from this machine. The backend copies it into songs/local and extracts embedded metadata and cover art when ffmpeg is available.'

  return (
    <Modal title="Queue an ingest" eyebrow="Ingest pipeline" open={open} onClose={onClose}>
      <div className="form-stack">
        <div className="ingest-source-picker" role="tablist" aria-label="Ingest source">
          {(['local', 'youtube', 'suno'] as AudioSource[]).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={source === value}
              className={source === value ? 'selected' : ''}
              onClick={() => setSource(value)}
            >
              {value === 'local' && <FileAudio size={15} />}
              {value === 'youtube' && <Play size={15} />}
              {value === 'suno' && <Sparkles size={15} />}
              <span>{value === 'local' ? 'Upload' : value}</span>
            </button>
          ))}
        </div>
        {source === 'local' && (
          <label className="file-drop">
            <FileAudio size={18} />
            <span>{file ? file.name : 'Choose local audio'}</span>
            <input
              type="file"
              accept="audio/*,.mp3,.m4a,.flac,.wav,.ogg,.opus"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
        )}
        <label className={source === 'local' ? 'url-field hidden' : 'url-field'}>
          {source === 'suno' ? 'Suno song or playlist URL' : source === 'youtube' ? 'YouTube URL' : 'Optional local note'}
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="https://… or /Music/…"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <div className="notice" data-tone={source === 'youtube' ? 'warn' : source === 'suno' ? 'advanced' : undefined}>
          <strong>{sourceTitle}</strong>
          <p>{sourceCopy}</p>
        </div>
        {source === 'youtube' && (
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={settings.youtubeConsent}
              onChange={(event) => void onSettings({ youtubeConsent: event.target.checked })}
            />
            I have the rights to import this YouTube audio.
          </label>
        )}
        {source === 'suno' && (
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={settings.sunoAdvancedEnabled}
              onChange={(event) => void onSettings({ sunoAdvancedEnabled: event.target.checked })}
            />
            Enable advanced public Suno URL mode for content I may import.
          </label>
        )}
        <div className="modal-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={<Upload size={16} />}
            disabled={cannotSubmit}
            onClick={submit}
          >
            {source === 'local' ? 'Upload track' : 'Queue ingest'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function SettingsDialog({
  open,
  settings,
  onClose,
  onUpdate,
}: {
  open: boolean
  settings: AppSettings
  onClose: () => void
  onUpdate: (patch: Partial<AppSettings>) => Promise<void>
}) {
  return (
    <Modal title="Workspace settings" eyebrow="Polysong" open={open} onClose={onClose}>
      <div className="form-stack">
        <label>
          Theme
          <select value={settings.theme} onChange={(event) => void onUpdate({ theme: event.target.value as AppSettings['theme'] })}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </label>
        <label>
          Concurrent downloads
          <input
            type="number"
            min="1"
            max="6"
            value={settings.maxConcurrentDownloads}
            onChange={(event) => void onUpdate({ maxConcurrentDownloads: Number(event.target.value) })}
          />
        </label>
        <label className="checkbox-line">
          <input
            type="checkbox"
            checked={settings.sunoAdvancedEnabled}
            onChange={(event) => void onUpdate({ sunoAdvancedEnabled: event.target.checked })}
          />
          Suno public URL advanced mode
        </label>
        <div className="notice">
          <strong>Audio root</strong>
          <p>
            <code style={{ fontFamily: 'var(--font-mono)' }}>{settings.audioRoot}</code>. Imports are assigned to `songs/suno`, `songs/youtube`, or `songs/local` under the app data directory.
          </p>
        </div>
        <div className="modal-footer">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export default App
