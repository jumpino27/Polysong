import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Disc3,
  Eye,
  EyeOff,
  ListMusic,
  Moon,
  Pause,
  Play,
  Plus,
  Search,
  Settings,
  Sun,
  Upload,
  Waves,
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
import { inferSource } from './lib/mock'
import type { AppSettings, AudioSource, IngestJob, Playlist, Track, VisualizerMode } from './types'

const defaultSettings: AppSettings = {
  theme: 'dark',
  audioRoot: 'audio',
  youtubeConsent: false,
  sunoAdvancedEnabled: false,
  maxConcurrentDownloads: 2,
}

function App() {
  const [tracks, setTracks] = useState<Track[]>([])
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

  const refresh = useCallback(async () => {
    const filter = {
      source: source === 'all' ? null : source,
      search: search || null,
      favoritesOnly,
    }
    const [nextTracks, nextPlaylists, nextJobs, nextSettings] = await Promise.all([
      api.listTracks(filter),
      api.listPlaylists(),
      api.listIngestJobs(),
      api.getSettings(),
    ])
    setTracks(nextTracks)
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
      suno: tracks.filter((track) => track.source === 'suno').length,
      youtube: tracks.filter((track) => track.source === 'youtube').length,
      local: tracks.filter((track) => track.source === 'local').length,
    }),
    [tracks],
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
          <div>
            <p>Now playing</p>
            <h1>{activeTrack?.title ?? 'No track selected'}</h1>
            <span>{activeTrack?.styleDescription ?? activeTrack?.artist ?? 'Load a track from the library'}</span>
          </div>
          <div className="fullscreen-controls">
            <Button icon={playing ? <Pause size={18} /> : <Play size={18} />} variant="primary" onClick={togglePlay}>
              {playing ? 'Pause' : 'Play'}
            </Button>
            <Button icon={<X size={18} />} onClick={() => setFullscreen(false)}>
              Exit
            </Button>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <aside className={`sidebar left ${leftPanelOpen ? 'open' : 'closed'}`}>
        <div className="brand">
          <Disc3 size={24} />
          <div>
            <strong>Polysong</strong>
            <span>local-first library</span>
          </div>
        </div>
        <nav className="source-nav" aria-label="Sources">
          {(['all', 'suno', 'youtube', 'local'] as const).map((value) => (
            <button className={source === value ? 'selected' : ''} type="button" onClick={() => setSource(value)}>
              <span>{value === 'all' ? 'All sources' : value}</span>
              <em>{value === 'all' ? tracks.length : totals[value]}</em>
            </button>
          ))}
        </nav>
        <section className="playlist-panel">
          <div className="panel-heading">
            <h2>Playlists</h2>
            <Button icon={<Plus size={16} />} aria-label="Create playlist" onClick={() => void api.createPlaylist('New playlist').then(refresh)} />
          </div>
          {playlists.map((playlist) => (
            <button className="playlist-item" type="button" key={playlist.id}>
              <ListMusic size={16} />
              <span>{playlist.name}</span>
              <em>{playlist.trackCount}</em>
            </button>
          ))}
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <Button
            icon={leftPanelOpen ? <ChevronLeft size={17} /> : <ChevronRight size={17} />}
            aria-label="Toggle source panel"
            onClick={() => setLeftPanelOpen((value) => !value)}
          />
          <label className="search">
            <Search size={17} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search title, artist, album, or Suno style" />
          </label>
          <Button icon={<Upload size={17} />} variant="primary" onClick={() => setIngestOpen(true)}>
            Ingest
          </Button>
          <Button icon={settings.theme === 'light' ? <Moon size={17} /> : <Sun size={17} />} onClick={() => updateSettings({ theme: settings.theme === 'light' ? 'dark' : 'light' })} />
          <Button icon={<Settings size={17} />} onClick={() => setSettingsOpen(true)} />
          <Button
            icon={rightPanelOpen ? <EyeOff size={17} /> : <Eye size={17} />}
            aria-label="Toggle detail panel"
            onClick={() => setRightPanelOpen((value) => !value)}
          />
        </header>

        <section className="library-header">
          <div>
            <p>Unified music library</p>
            <h1>Tracks from local files, YouTube, and Suno in one queue.</h1>
          </div>
          <label className="checkbox-line">
            <input type="checkbox" checked={favoritesOnly} onChange={(event) => setFavoritesOnly(event.target.checked)} />
            Favorites only
          </label>
        </section>

        <section className="track-list" aria-label="Tracks">
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

      <aside className={`sidebar right ${rightPanelOpen ? 'open' : 'closed'}`}>
        <div className="panel-heading">
          <h2>Visualizer</h2>
          <Button icon={<Waves size={16} />} onClick={() => setFullscreen(true)}>
            Full
          </Button>
        </div>
        <div className="visualizer-card">{renderVisualizer()}</div>
        <div className="segmented">
          {(['bars', 'waveform', 'radial'] as VisualizerMode[]).map((mode) => (
            <button disabled={mode === 'radial'} className={visualizerMode === mode ? 'selected' : ''} type="button" onClick={() => setVisualizerMode(mode)}>
              {mode}
            </button>
          ))}
        </div>
        <section className="now-playing-detail">
          <p>Selected</p>
          <h2>{activeTrack?.title ?? 'No track'}</h2>
          <span>{activeTrack?.artist ?? 'Choose a track to load the audio engine.'}</span>
          {activeTrack?.styleDescription && <blockquote>{activeTrack.styleDescription}</blockquote>}
        </section>
        <section className="queue-panel">
          <h2>Ingest queue</h2>
          {jobs.length === 0 && <p className="muted">No jobs yet.</p>}
          {jobs.map((job) => (
            <div className="job" key={job.id}>
              <span>{job.source}</span>
              <strong>{job.status}</strong>
              <ProgressBar value={job.progress} />
            </div>
          ))}
        </section>
      </aside>

      <footer className="player-bar">
        <div className="player-meta">
          <div className="mini-cover">
            <Disc3 size={19} />
          </div>
          <div>
            <strong>{activeTrack?.title ?? 'No track loaded'}</strong>
            <span>{activeTrack ? `${activeTrack.artist ?? 'Unknown'} - ${formatDuration(activeTrack.durationMs)}` : 'Pick a track'}</span>
          </div>
        </div>
        <Button icon={playing ? <Pause size={18} /> : <Play size={18} />} variant="primary" onClick={togglePlay}>
          {playing ? 'Pause' : 'Play'}
        </Button>
        <input className="volume" type="range" min="0" max="1" step="0.01" defaultValue="0.82" onChange={(event) => audioEngine.setVolume(Number(event.target.value))} />
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
  const [input, setInput] = useState('https://suno.com/song/demo-suno-01')
  const source = inferSource(input)
  const needsYoutubeConsent = source === 'youtube' && !settings.youtubeConsent
  const needsSunoConsent = source === 'suno' && !settings.sunoAdvancedEnabled

  const submit = async () => {
    await api.ingestUrl({
      source,
      input,
      advancedPublicSuno: settings.sunoAdvancedEnabled,
      consentAccepted: source === 'youtube' ? settings.youtubeConsent : source === 'suno' ? settings.sunoAdvancedEnabled : true,
    })
    onDone()
  }

  return (
    <Modal title="Ingest source" open={open} onClose={onClose}>
      <div className="form-stack">
        <label>
          URL or local audio path
          <input value={input} onChange={(event) => setInput(event.target.value)} />
        </label>
        <div className="notice">
          <strong>{source === 'suno' ? 'Suno import' : source === 'youtube' ? 'YouTube import' : 'Local import'}</strong>
          <p>
            {source === 'suno'
              ? 'Public Suno URLs are advanced mode. Style tags, prompts, lyrics, cover URL, and audio URL are preserved when metadata is available.'
              : source === 'youtube'
                ? 'Only import videos you own or have the right to download.'
                : 'Local files stay under your controlled library folder.'}
          </p>
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
        <Button variant="primary" icon={<Upload size={17} />} disabled={needsYoutubeConsent || needsSunoConsent} onClick={submit}>
          Queue ingest
        </Button>
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
    <Modal title="Settings" open={open} onClose={onClose}>
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
        <p className="muted">Audio root: {settings.audioRoot}. Sidecars and authenticated download workers are scaffolded as backend modules.</p>
      </div>
    </Modal>
  )
}

export default App
