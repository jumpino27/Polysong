/**
 * Polysong — local-first music workstation.
 *
 * Composition. Three-column workstation grid: a left rail with sources and
 * playlists; a center workspace with a sticky toolbar, library header, and
 * dense single-column track list; a right rail focused on Now Playing — a
 * compact selected-track header with a "Full visualizer" button, plus a tall
 * queue list that fills the rail. The bass-reactive cover visualizer lives in
 * fullscreen mode, where its overlay (eyebrow, mode picker, title, controls)
 * sits in absolute top/bottom strips with gradient backdrops, leaving the
 * center clear so the visualizer dominates. When idle, the overlay fades and
 * only the cover + bars remain.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  Disc3,
  Download,
  FileAudio,
  ListMusic,
  Loader2,
  Maximize2,
  Minus,
  Minimize2,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  Repeat,
  Repeat1,
  Search,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  Sparkles,
  Square,
  Sun,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import './App.css'
import { Button } from './components/Button'
import { AddToPlaylistDialog } from './components/AddToPlaylistDialog'
import { Modal } from './components/Modal'
import { Select } from './components/Select'
import { TrackRow } from './components/TrackRow'
import { BarsVisualizer } from './features/visualizer/BarsVisualizer'
import { WaveformVisualizer } from './features/visualizer/WaveformVisualizer'
import { CoverVisualizer } from './features/visualizer/CoverVisualizer'
import { audioEngine, type RepeatMode } from './features/player/audioEngine'
import { formatDuration, formatTime, sourceLabel } from './lib/format'
import { api, mediaUrl } from './lib/tauri'
import type { AppSettings, AudioSource, IngestJob, Playlist, Track, TrackFilter, UpdateStatus, VisualizerMode } from './types'

const defaultSettings: AppSettings = {
  theme: 'dark',
  audioRoot: 'songs',
  youtubeConsent: false,
  sunoAdvancedEnabled: false,
  maxConcurrentDownloads: 2,
}

const SOURCES: ReadonlyArray<AudioSource | 'all'> = ['all', 'suno', 'youtube', 'local']
const VISUALIZER_MODES: ReadonlyArray<VisualizerMode> = ['cover', 'bars', 'waveform']

type PlaybackScope =
  | { kind: 'all' }
  | { kind: 'source'; source: AudioSource }
  | { kind: 'playlist'; id: number; name: string }

function scopeLabel(scope: PlaybackScope): string {
  if (scope.kind === 'all') return 'All sources'
  if (scope.kind === 'source') return sourceLabel(scope.source)
  return `Playlist · ${scope.name}`
}

function App() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [libraryTracks, setLibraryTracks] = useState<Track[]>([])
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [activeJobs, setActiveJobs] = useState<IngestJob[]>([])
  const [allJobs, setAllJobs] = useState<IngestJob[]>([])
  const [view, setView] = useState<'library' | 'downloads'>('library')
  const [downloadingTrackIds, setDownloadingTrackIds] = useState<Set<number>>(new Set())
  const [downloadFailedTrackIds, setDownloadFailedTrackIds] = useState<Set<number>>(new Set())
  const [dismissedJobIds, setDismissedJobIds] = useState<Set<number>>(new Set())
  const [downloadsPulse, setDownloadsPulse] = useState(false)
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [source, setSource] = useState<AudioSource | 'all'>('all')
  const [search, setSearch] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [activeTrack, setActiveTrack] = useState<Track | null>(null)
  const [expandedTrack, setExpandedTrack] = useState<number | null>(null)
  const [leftPanelOpen, setLeftPanelOpen] = useState(true)
  const [rightPanelOpen, setRightPanelOpen] = useState(true)
  const [ingestOpen, setIngestOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [createPlaylistOpen, setCreatePlaylistOpen] = useState(false)
  const [addToPlaylistTrack, setAddToPlaylistTrack] = useState<Track | null>(null)
  const [visualizerMode, setVisualizerMode] = useState<VisualizerMode>('cover')
  const [fullscreen, setFullscreen] = useState(false)
  const [overlayVisible, setOverlayVisible] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(audioEngine.volume)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [hasPrev, setHasPrev] = useState(false)
  const [hasNext, setHasNext] = useState(false)
  const [scrubValue, setScrubValue] = useState<number | null>(null)
  const [shuffle, setShuffle] = useState(audioEngine.shuffleEnabled)
  const [repeatMode, setRepeatMode] = useState<RepeatMode>(audioEngine.repeatMode)
  const [queueScope, setQueueScope] = useState<PlaybackScope | null>(null)
  const [queueTracks, setQueueTracks] = useState<Track[]>([])
  const [activePlaylistId, setActivePlaylistId] = useState<number | null>(null)
  const [activePlaylistMembers, setActivePlaylistMembers] = useState<Set<number> | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [installingUpdate, setInstallingUpdate] = useState(false)
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  )
  const [unavailableTrackIds, setUnavailableTrackIds] = useState<Set<number>>(new Set())

  const seekingRef = useRef(false)

  const refresh = useCallback(async () => {
    // When a playlist is active, ignore the source filter so users see every
    // track in the playlist regardless of which source pill was last selected.
    const effectiveSource = activePlaylistId != null ? null : source === 'all' ? null : source
    const filter: TrackFilter = {
      source: effectiveSource,
      search: search || null,
      favoritesOnly,
      playlistId: activePlaylistId,
    }
    const libraryFilter: TrackFilter = {
      source: null,
      search: null,
      favoritesOnly: false,
    }
    const [nextTracks, nextLibraryTracks, nextPlaylists, nextJobs, nextSettings] = await Promise.all([
      api.listTracks(filter),
      api.listTracks(libraryFilter),
      api.listPlaylists(),
      api.listIngestJobs(),
      api.getSettings(),
    ])

    const filtered = nextTracks.filter((track) => {
      if (filter.source && track.source !== filter.source) return false
      if (filter.favoritesOnly && !track.favorite) return false
      if (filter.playlistId != null && activePlaylistMembers && !activePlaylistMembers.has(track.id)) {
        return false
      }
      if (filter.search) {
        const needle = filter.search.toLowerCase()
        const haystack = [track.title, track.artist, track.album, track.styleDescription]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      return true
    })

    setTracks(filtered)
    setLibraryTracks(nextLibraryTracks)
    setPlaylists(nextPlaylists)
    setAllJobs(nextJobs)
    setActiveJobs(nextJobs.filter((job) => job.status === 'queued' || job.status === 'downloading'))
    setSettings(nextSettings)
    setActiveTrack((current) => current ?? filtered[0] ?? null)
  }, [favoritesOnly, search, source, activePlaylistId, activePlaylistMembers])

  useEffect(() => {
    const handle = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(handle)
  }, [refresh])

  useEffect(() => {
    if (activeJobs.length === 0) return
    const interval = window.setInterval(() => void refresh(), 1500)
    return () => window.clearInterval(interval)
  }, [activeJobs.length, refresh])

  useEffect(() => {
    const sync = () => {
      setPlaying(audioEngine.isPlaying)
      if (!seekingRef.current) setCurrentTime(audioEngine.currentTime)
      setDuration(audioEngine.duration)
      setHasPrev(audioEngine.hasPrevious())
      setHasNext(audioEngine.hasNext())
      setShuffle(audioEngine.shuffleEnabled)
      setRepeatMode(audioEngine.repeatMode)
      setQueueTracks(audioEngine.getQueueInPlayOrder())
      if (audioEngine.currentTrack && audioEngine.currentTrack.id !== activeTrack?.id) {
        setActiveTrack(audioEngine.currentTrack)
      }
    }
    const unsubscribe = audioEngine.subscribe(sync)
    sync()
    return () => {
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTrack?.id])

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  useEffect(() => {
    const suppressContextMenu = (event: MouseEvent) => event.preventDefault()
    window.addEventListener('contextmenu', suppressContextMenu)
    return () => window.removeEventListener('contextmenu', suppressContextMenu)
  }, [])

  useEffect(() => {
    let cancelled = false
    void api
      .checkUpdate()
      .then((status) => {
        if (!cancelled) setUpdateStatus(status)
      })
      .catch((error) => {
        console.warn('Polysong updater check failed.', error)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Online/offline detection. When offline, streaming-only tracks are hidden
  // from the library; when we come back online, refresh the availability check.
  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  // Probe streaming track availability on startup and whenever we come back
  // online. The backend HEAD-checks each source URL — anything that 404s gets
  // marked unavailable and is filtered out of the visible track list.
  useEffect(() => {
    if (!isOnline) return
    const streamingIds = libraryTracks
      .filter((track) => track.streamingOnly)
      .map((track) => track.id)
    if (streamingIds.length === 0) {
      setUnavailableTrackIds((prev) => (prev.size === 0 ? prev : new Set()))
      return
    }
    let cancelled = false
    void api
      .checkTracksAvailability(streamingIds)
      .then((results) => {
        if (cancelled) return
        const next = new Set<number>()
        for (const result of results) {
          if (!result.available) next.add(result.id)
        }
        setUnavailableTrackIds(next)
      })
      .catch((error) => {
        console.warn('Polysong: track availability check failed.', error)
      })
    return () => {
      cancelled = true
    }
  }, [isOnline, libraryTracks])

  // Pull the membership for the active playlist so we can client-side filter
  // the visible track list to that playlist's contents — works even if the
  // backend hasn't been rebuilt with the new playlistId-aware list_tracks.
  useEffect(() => {
    if (activePlaylistId == null) {
      setActivePlaylistMembers(null)
      return
    }
    let cancelled = false
    void api
      .listPlaylistMembers(activePlaylistId)
      .then((ids) => {
        if (!cancelled) setActivePlaylistMembers(new Set(ids))
      })
      .catch(() => {
        if (!cancelled) setActivePlaylistMembers(new Set())
      })
    return () => {
      cancelled = true
    }
  }, [activePlaylistId, playlists])

  useEffect(() => {
    if (!fullscreen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  useEffect(() => {
    if (!fullscreen || !overlayVisible) return
    const timeout = window.setTimeout(() => setOverlayVisible(false), 2400)
    return () => window.clearTimeout(timeout)
  }, [fullscreen, overlayVisible])

  useEffect(() => {
    const isEditable = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isEditable(event.target)) return
      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault()
        void togglePlay()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        audioEngine.seekBy(-5)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        audioEngine.seekBy(5)
      } else if (event.key === 'f' || event.key === 'F') {
        event.preventDefault()
        setFullscreen((value) => !value)
      } else if (event.key === 'm' || event.key === 'M') {
        event.preventDefault()
        toggleMute()
      } else if (event.key === 'n' || event.key === 'N') {
        if (audioEngine.hasNext()) void audioEngine.next()
      } else if (event.key === 'p' || event.key === 'P') {
        if (audioEngine.hasPrevious()) void audioEngine.previous()
      } else if (event.key === 's' || event.key === 'S') {
        audioEngine.toggleShuffle()
      } else if (event.key === 'r' || event.key === 'R') {
        audioEngine.cycleRepeat()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTrack?.id])

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

  // Streaming-aware view of the filtered track list. Streaming tracks are
  // hidden when offline (no source = no playback) or when the backend's
  // availability probe says the underlying URL is gone.
  const visibleTracks = useMemo(() => {
    return tracks.filter((track) => {
      if (track.streamingOnly && !isOnline) return false
      if (unavailableTrackIds.has(track.id)) return false
      return true
    })
  }, [tracks, isOnline, unavailableTrackIds])

  const hiddenOfflineCount = useMemo(() => {
    if (isOnline) return 0
    return tracks.filter((track) => track.streamingOnly).length
  }, [tracks, isOnline])

  const currentScope = useMemo<PlaybackScope>(() => {
    if (activePlaylistId != null) {
      const found = playlists.find((p) => p.id === activePlaylistId)
      return { kind: 'playlist', id: activePlaylistId, name: found?.name ?? 'Playlist' }
    }
    if (source === 'all') return { kind: 'all' }
    return { kind: 'source', source }
  }, [activePlaylistId, playlists, source])

  const selectAndPlay = async (track: Track) => {
    setActiveTrack(track)
    const label = scopeLabel(currentScope)
    setQueueScope(currentScope)
    audioEngine.startQueue(visibleTracks, label, track.id)
  }

  const togglePlay = async () => {
    if (!activeTrack && visibleTracks[0]) {
      await selectAndPlay(visibleTracks[0])
      return
    }
    if (!activeTrack) return
    if (audioEngine.currentTrack?.id !== activeTrack.id) {
      const label = scopeLabel(currentScope)
      setQueueScope(currentScope)
      audioEngine.startQueue(visibleTracks, label, activeTrack.id)
      return
    }
    if (audioEngine.isPlaying) audioEngine.pause()
    else await audioEngine.play()
  }

  const handleVolume = (event: ChangeEvent<HTMLInputElement>) => {
    const next = Number(event.target.value)
    setVolume(next)
    audioEngine.setVolume(next)
  }

  const lastNonZeroVolume = useRef(volume || 0.6)
  useEffect(() => {
    if (volume > 0) lastNonZeroVolume.current = volume
  }, [volume])

  const toggleMute = () => {
    if (volume > 0) {
      lastNonZeroVolume.current = volume
      setVolume(0)
      audioEngine.setVolume(0)
    } else {
      const restored = lastNonZeroVolume.current || 0.6
      setVolume(restored)
      audioEngine.setVolume(restored)
    }
  }

  const handleScrubBegin = () => {
    seekingRef.current = true
  }
  const handleScrubChange = (event: ChangeEvent<HTMLInputElement>) => {
    const v = Number(event.target.value)
    setScrubValue(v)
    setCurrentTime(v)
    audioEngine.seek(v)
  }
  const handleScrubEnd = () => {
    seekingRef.current = false
    setScrubValue(null)
  }

  const updateSettings = async (patch: Partial<AppSettings>) => {
    const next = await api.updateSettings(patch)
    setSettings(next)
  }

  const installAvailableUpdate = async () => {
    if (installingUpdate) return
    setInstallingUpdate(true)
    try {
      await api.installUpdate()
    } finally {
      setInstallingUpdate(false)
    }
  }

  const handleTrackDownload = async (track: Track) => {
    if (downloadingTrackIds.has(track.id)) return
    setDownloadingTrackIds((current) => {
      const next = new Set(current)
      next.add(track.id)
      return next
    })
    setDownloadFailedTrackIds((current) => {
      if (!current.has(track.id)) return current
      const next = new Set(current)
      next.delete(track.id)
      return next
    })
    try {
      await api.downloadTrack(track.id)
      await refresh()
    } catch (error) {
      console.error('Polysong: download_track failed.', error)
      setDownloadFailedTrackIds((current) => {
        const next = new Set(current)
        next.add(track.id)
        return next
      })
      window.setTimeout(() => {
        setDownloadFailedTrackIds((current) => {
          if (!current.has(track.id)) return current
          const next = new Set(current)
          next.delete(track.id)
          return next
        })
      }, 4000)
    } finally {
      setDownloadingTrackIds((current) => {
        if (!current.has(track.id)) return current
        const next = new Set(current)
        next.delete(track.id)
        return next
      })
    }
  }

  const dismissJob = (jobId: number) => {
    setDismissedJobIds((current) => {
      const next = new Set(current)
      next.add(jobId)
      return next
    })
  }

  const handleTrackDelete = async (track: Track) => {
    if (activePlaylistId != null) {
      await api.removeTrackFromPlaylist(track.id, activePlaylistId)
      setActivePlaylistMembers((current) => {
        if (!current) return current
        const next = new Set(current)
        next.delete(track.id)
        return next
      })
    } else {
      await api.deleteTrack(track.id)
      if (activeTrack?.id === track.id) {
        setActiveTrack(null)
      }
    }
    await refresh()
  }

  const renderVisualizer = () => {
    if (visualizerMode === 'waveform') return <WaveformVisualizer />
    if (visualizerMode === 'bars') return <BarsVisualizer compact={!fullscreen} />
    return <CoverVisualizer track={activeTrack} playing={playing} />
  }

  const scrubMax = duration > 0 ? duration : 1
  const scrubDisplay = scrubValue ?? currentTime
  const scrubPct = scrubMax > 0 ? Math.min(100, (scrubDisplay / scrubMax) * 100) : 0
  const remaining = Math.max(0, (duration || 0) - scrubDisplay)
  const volumePct = Math.round(volume * 100)
  const coverUrl = activeTrack ? mediaUrl(activeTrack.coverPath) : null

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
            <div className="fullscreen-eyebrow-block">
              <span className="eyebrow">Now Playing — Polysong</span>
              {queueScope && <span className="fullscreen-scope">{scopeLabel(queueScope)}</span>}
            </div>
            <div className="fullscreen-mode-picker" role="tablist" aria-label="Visualizer mode">
              {VISUALIZER_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={visualizerMode === mode}
                  className={visualizerMode === mode ? 'selected' : ''}
                  onClick={() => setVisualizerMode(mode)}
                >
                  {mode}
                </button>
              ))}
            </div>
            <Button icon={<Minimize2 size={17} />} onClick={() => setFullscreen(false)}>
              Exit fullscreen
            </Button>
          </div>

          <div className="fullscreen-overlay-bottom">
            <div className="fullscreen-text">
              <h1>{activeTrack?.title ?? 'No track selected'}</h1>
              {activeTrack?.styleDescription ? (
                <p className="style-line">
                  <Sparkles size={16} />
                  <span>{activeTrack.styleDescription}</span>
                </p>
              ) : (
                <p className="artist-line">
                  {activeTrack?.artist ?? 'Load a track from the library to begin.'}
                </p>
              )}
            </div>
            <div className="fullscreen-controls">
              <Button
                icon={<Shuffle size={16} />}
                className={shuffle ? 'transport-toggle on fullscreen-button' : 'transport-toggle fullscreen-button'}
                onClick={() => audioEngine.toggleShuffle()}
                aria-pressed={shuffle}
                aria-label={shuffle ? 'Shuffle on' : 'Shuffle off'}
              />
              <Button
                icon={<SkipBack size={18} />}
                className="fullscreen-button"
                onClick={() => void audioEngine.previous()}
                disabled={!hasPrev}
                aria-label="Previous track"
              />
              <Button
                icon={playing ? <Pause size={20} /> : <Play size={20} />}
                variant="primary"
                onClick={togglePlay}
                aria-label={playing ? 'Pause' : 'Play'}
              />
              <Button
                icon={<SkipForward size={18} />}
                className="fullscreen-button"
                onClick={() => void audioEngine.next()}
                disabled={!hasNext}
                aria-label="Next track"
              />
              <Button
                icon={repeatMode === 'one' ? <Repeat1 size={16} /> : <Repeat size={16} />}
                className={repeatMode !== 'off' ? 'transport-toggle on fullscreen-button' : 'transport-toggle fullscreen-button'}
                onClick={() => audioEngine.cycleRepeat()}
                aria-pressed={repeatMode !== 'off'}
                aria-label={`Repeat: ${repeatMode}`}
              />
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
      <AppTitlebar />
      <aside className={`sidebar left ${leftPanelOpen ? 'open' : 'closed'}`} aria-label="Sources and playlists">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            <img src="/polysong-logo-v2.png" alt="" />
          </div>
          <div className="brand-name">
            <strong>Polysong</strong>
            <span>local-first lab</span>
            <a
              className="support-creator-link"
              href="https://revolut.me/jumpino"
              target="_blank"
              rel="noreferrer"
            >
              <span>Support Creator</span>
              <small>Free and open source</small>
            </a>
          </div>
        </div>

        <nav className="downloads-nav" aria-label="Downloads">
          <button
            type="button"
            className={`downloads-button ${view === 'downloads' ? 'selected' : ''} ${downloadsPulse ? 'pulse' : ''}`}
            onClick={() => setView('downloads')}
            aria-pressed={view === 'downloads'}
          >
            <CloudDownload size={15} aria-hidden />
            <span className="downloads-button-label">Downloads</span>
            {activeJobs.length > 0 && (
              <span className="downloads-badge" aria-label={`${activeJobs.length} active downloads`}>
                {activeJobs.length}
              </span>
            )}
          </button>
        </nav>

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
                className={view === 'library' && source === value && activePlaylistId == null ? 'selected' : ''}
                onClick={() => {
                  setView('library')
                  setSource(value)
                  setActivePlaylistId(null)
                }}
                aria-pressed={view === 'library' && source === value && activePlaylistId == null}
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
              onClick={() => setCreatePlaylistOpen(true)}
            />
          </div>
          <div className="playlist-list">
            {playlists.length === 0 && <p className="playlist-empty">No playlists yet.</p>}
            {playlists.map((playlist) => (
              <button
                className={`playlist-item ${view === 'library' && activePlaylistId === playlist.id ? 'selected' : ''}`}
                type="button"
                key={playlist.id}
                onClick={() => {
                  setView('library')
                  setActivePlaylistId(playlist.id)
                }}
                aria-pressed={view === 'library' && activePlaylistId === playlist.id}
              >
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
          {updateStatus?.available && (
            <Button
              icon={installingUpdate ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
              variant="primary"
              className="update-button"
              onClick={() => void installAvailableUpdate()}
              disabled={installingUpdate}
              aria-label={`Install Polysong ${updateStatus.latestVersion ?? 'update'}`}
            >
              {installingUpdate ? 'Updating' : `Update ${updateStatus.latestVersion ?? ''}`.trim()}
            </Button>
          )}
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
            icon={rightPanelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            variant="ghost"
            aria-label={rightPanelOpen ? 'Hide detail panel' : 'Show detail panel'}
            onClick={() => setRightPanelOpen((value) => !value)}
          />
        </header>

        {view === 'downloads' ? (
          <DownloadsPanel
            jobs={allJobs.filter((job) => !dismissedJobIds.has(job.id))}
            onClear={dismissJob}
          />
        ) : (
        <>
        <header className="library-header">
          <div className="library-header-text">
            <h1>{scopeLabel(currentScope)}</h1>
          </div>
          <div className="library-header-meta">
            <span><strong>{libraryTracks.length}</strong> tracks</span>
            <span className="meta-sep" aria-hidden>·</span>
            <span><strong>{totals.suno}</strong> Suno</span>
            <span><strong>{totals.youtube}</strong> YouTube</span>
            <span><strong>{totals.local}</strong> local</span>
            <span className="meta-sep" aria-hidden>·</span>
            <span><strong>{formatDuration(totalDurationMs)}</strong> total</span>
          </div>
          <div className="library-header-controls">
            <label className="checkbox-line inline">
              <input
                type="checkbox"
                checked={favoritesOnly}
                onChange={(event) => setFavoritesOnly(event.target.checked)}
              />
              Favorites only
            </label>
          </div>
        </header>

        {activeJobs.length > 0 && (
          <div className="loading-cards" aria-live="polite">
            {activeJobs.map((job) => (
              <LoadingCard key={job.id} job={job} />
            ))}
          </div>
        )}

        {hiddenOfflineCount > 0 && (
          <p className="offline-banner" role="status">
            Offline — {hiddenOfflineCount} streaming {hiddenOfflineCount === 1 ? 'track' : 'tracks'} hidden
          </p>
        )}

        <section className="track-list" aria-label="Tracks">
          {visibleTracks.length === 0 && (
            <p className="track-list-empty">
              {activeJobs.length > 0
                ? 'Waiting for the first imports to land — your library will populate as ingests finish.'
                : 'No tracks match. Adjust filters or queue an ingest.'}
            </p>
          )}
          {visibleTracks.map((track) => (
            <TrackRow
              key={track.id}
              track={track}
              active={activeTrack?.id === track.id}
              expanded={expandedTrack === track.id}
              onPlay={() => void selectAndPlay(track)}
              onToggleFavorite={() => void api.updateTrackMetadata(track.id, { favorite: !track.favorite }).then(refresh)}
              onToggleExpanded={() => setExpandedTrack((current) => (current === track.id ? null : track.id))}
              onDelete={() => void handleTrackDelete(track)}
              deleteLabel={activePlaylistId != null ? 'Remove from playlist' : 'Delete track'}
              onAddToPlaylist={() => setAddToPlaylistTrack(track)}
              onDownload={track.streamingOnly ? () => void handleTrackDownload(track) : undefined}
              downloading={downloadingTrackIds.has(track.id)}
              downloadFailed={downloadFailedTrackIds.has(track.id)}
            />
          ))}
        </section>
        </>
        )}
      </section>

      <aside
        className={`sidebar right ${rightPanelOpen ? 'open' : 'closed'}`}
        aria-label="Now playing and queue"
      >
        <section className="now-playing-header">
          <div className="now-playing-header-text">
            <span className="eyebrow">Now Playing</span>
            <span className="now-playing-scope">{queueScope ? scopeLabel(queueScope) : 'No active queue'}</span>
          </div>
          <Button
            icon={<Maximize2 size={14} />}
            variant="ghost"
            onClick={() => setFullscreen(true)}
            aria-label="Open fullscreen visualizer"
          >
            Full
          </Button>
        </section>

        <section className="now-playing-detail" aria-labelledby="selected-heading">
          <div className="now-playing-eyebrow">
            <span className="eyebrow" id="selected-heading">Selected</span>
            {activeTrack && <span className="now-playing-duration">{formatDuration(activeTrack.durationMs)}</span>}
          </div>
          <h2>{activeTrack?.title ?? 'No track loaded'}</h2>
          <p className="artist-line">{activeTrack?.artist ?? 'Choose a track to load the audio engine.'}</p>
        </section>

        <section className="queue-panel queue-panel-fill" aria-labelledby="queue-heading">
          <div className="rail-heading">
            <h2 id="queue-heading">Queue</h2>
            <span className="rail-heading-count">{queueTracks.length}</span>
          </div>
          {queueTracks.length === 0 && (
            <p className="queue-empty">Press play on any track to start a queue.</p>
          )}
          <div className="queue-list queue-list-fill">
            {queueTracks.map((track, index) => (
              <button
                key={`${track.id}-${index}`}
                className={`queue-item ${activeTrack?.id === track.id ? 'active' : ''}`}
                type="button"
                onClick={() => void selectAndPlay(track)}
                aria-current={activeTrack?.id === track.id ? 'true' : undefined}
              >
                <span className="queue-index">
                  {activeTrack?.id === track.id ? (
                    <span className={`queue-indicator ${playing ? 'playing' : ''}`} aria-hidden>
                      <span /><span /><span />
                    </span>
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="queue-title-block">
                  <span className="queue-title">{track.title}</span>
                  {track.artist && <span className="queue-artist">{track.artist}</span>}
                </span>
                <span className="queue-duration">{formatDuration(track.durationMs)}</span>
              </button>
            ))}
          </div>
        </section>
      </aside>

      <footer className="player-bar" aria-label="Player">
        <div className="player-meta">
          <div className={`mini-cover ${playing ? 'playing' : ''}`} aria-hidden>
            {coverUrl ? <img src={coverUrl} alt="" /> : <Disc3 size={20} strokeWidth={2.2} />}
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

        <div className="transport" role="group" aria-label="Playback controls">
          <Button
            icon={<Shuffle size={15} />}
            variant="ghost"
            className={shuffle ? 'transport-toggle on' : 'transport-toggle'}
            onClick={() => audioEngine.toggleShuffle()}
            aria-pressed={shuffle}
            aria-label={shuffle ? 'Shuffle on' : 'Shuffle off'}
          />
          <Button
            icon={<SkipBack size={17} />}
            variant="ghost"
            disabled={!hasPrev}
            onClick={() => void audioEngine.previous()}
            aria-label="Previous track"
          />
          <Button
            icon={playing ? <Pause size={18} /> : <Play size={18} />}
            variant="primary"
            onClick={togglePlay}
            disabled={!activeTrack && tracks.length === 0}
            aria-label={playing ? 'Pause' : 'Play'}
          />
          <Button
            icon={<SkipForward size={17} />}
            variant="ghost"
            disabled={!hasNext}
            onClick={() => void audioEngine.next()}
            aria-label="Next track"
          />
          <Button
            icon={repeatMode === 'one' ? <Repeat1 size={15} /> : <Repeat size={15} />}
            variant="ghost"
            className={repeatMode !== 'off' ? 'transport-toggle on' : 'transport-toggle'}
            onClick={() => audioEngine.cycleRepeat()}
            aria-pressed={repeatMode !== 'off'}
            aria-label={`Repeat: ${repeatMode}`}
          />
        </div>

        <div className="scrubber">
          <span className="time-elapsed" aria-live="off">{formatTime(scrubDisplay)}</span>
          <input
            className="scrub"
            type="range"
            min={0}
            max={scrubMax}
            step={0.1}
            value={scrubDisplay}
            disabled={!duration}
            style={{ ['--scrub-pct' as string]: `${scrubPct}%` }}
            onMouseDown={handleScrubBegin}
            onTouchStart={handleScrubBegin}
            onPointerDown={handleScrubBegin}
            onChange={handleScrubChange}
            onMouseUp={handleScrubEnd}
            onTouchEnd={handleScrubEnd}
            onPointerUp={handleScrubEnd}
            onBlur={handleScrubEnd}
            aria-label="Seek"
          />
          <span className="time-remaining" aria-live="off">−{formatTime(remaining)}</span>
        </div>

        <div className="player-volume">
          <Button
            icon={volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
            variant="ghost"
            onClick={toggleMute}
            aria-label={volume === 0 ? 'Unmute' : 'Mute'}
          />
          <input
            className="volume"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            style={{ ['--volume-pct' as string]: `${volumePct}%` }}
            onChange={handleVolume}
            aria-label="Volume"
          />
        </div>
      </footer>

      <IngestDialog
        open={ingestOpen}
        settings={settings}
        activePlaylistId={activePlaylistId}
        onClose={() => setIngestOpen(false)}
        onSettings={updateSettings}
        onQueued={() => {
          setIngestOpen(false)
          setDownloadsPulse(true)
          window.setTimeout(() => setDownloadsPulse(false), 2000)
          void refresh()
        }}
      />
      <SettingsDialog open={settingsOpen} settings={settings} onClose={() => setSettingsOpen(false)} onUpdate={updateSettings} />
      <CreatePlaylistDialog
        open={createPlaylistOpen}
        onClose={() => setCreatePlaylistOpen(false)}
        onCreate={async (name) => {
          await api.createPlaylist(name)
          setCreatePlaylistOpen(false)
          await refresh()
        }}
      />
      <AddToPlaylistDialog
        open={addToPlaylistTrack !== null}
        track={addToPlaylistTrack}
        playlists={playlists}
        onClose={() => setAddToPlaylistTrack(null)}
        onSaved={async () => {
          await refresh()
        }}
      />
    </main>
  )
}

function AppTitlebar() {
  const hasTauriWindow = Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  const withAppWindow = (action: 'minimize' | 'toggleMaximize' | 'close') => {
    if (!hasTauriWindow) return
    const appWindow = getCurrentWindow()
    void appWindow[action]().catch(() => undefined)
  }

  return (
    <div className="app-titlebar" data-tauri-drag-region>
      <div className="app-titlebar-brand" data-tauri-drag-region>
        <img src="/polysong-logo-v2.png" alt="" data-tauri-drag-region />
        <span data-tauri-drag-region>Polysong</span>
      </div>
      <div className="window-controls">
        <button type="button" onClick={() => withAppWindow('minimize')} aria-label="Minimize">
          <Minus size={14} />
        </button>
        <button type="button" onClick={() => withAppWindow('toggleMaximize')} aria-label="Maximize">
          <Square size={12} />
        </button>
        <button type="button" className="close" onClick={() => withAppWindow('close')} aria-label="Close">
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

function statusLabel(status: IngestJob['status']): string {
  if (status === 'queued') return 'Queued'
  if (status === 'downloading') return 'Downloading'
  if (status === 'ready') return 'Done'
  if (status === 'failed') return 'Failed'
  return 'Cancelled'
}

function DownloadsPanel({
  jobs,
  onClear,
}: {
  jobs: IngestJob[]
  onClear: (jobId: number) => void
}) {
  const inProgress = useMemo(
    () =>
      jobs
        .filter((job) => job.status === 'queued' || job.status === 'downloading')
        .sort((a, b) => b.createdAt - a.createdAt),
    [jobs],
  )
  const recent = useMemo(
    () =>
      jobs
        .filter((job) => job.status === 'ready' || job.status === 'failed')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 20),
    [jobs],
  )

  if (jobs.length === 0) {
    return (
      <section className="downloads-panel" aria-labelledby="downloads-heading">
        <header className="library-header">
          <div className="library-header-text">
            <h1 id="downloads-heading">Downloads</h1>
          </div>
        </header>
        <p className="downloads-empty">
          No imports yet. Use the Ingest button to add a song or playlist.
        </p>
      </section>
    )
  }

  return (
    <section className="downloads-panel" aria-labelledby="downloads-heading">
      <header className="library-header">
        <div className="library-header-text">
          <h1 id="downloads-heading">Downloads</h1>
        </div>
        <div className="library-header-meta">
          <span><strong>{inProgress.length}</strong> active</span>
          <span className="meta-sep" aria-hidden>·</span>
          <span><strong>{recent.length}</strong> recent</span>
        </div>
      </header>

      {inProgress.length > 0 && (
        <>
          <h2 className="downloads-section-heading">In progress</h2>
          <div className="downloads-list">
            {inProgress.map((job) => (
              <DownloadsRow key={job.id} job={job} onClear={onClear} />
            ))}
          </div>
        </>
      )}

      {recent.length > 0 && (
        <>
          <h2 className="downloads-section-heading">Recent</h2>
          <div className="downloads-list">
            {recent.map((job) => (
              <DownloadsRow key={job.id} job={job} onClear={onClear} />
            ))}
          </div>
        </>
      )}
    </section>
  )
}

function DownloadsRow({ job, onClear }: { job: IngestJob; onClear: (jobId: number) => void }) {
  const dismissible = job.status === 'ready' || job.status === 'failed'
  const pct = Math.round(Math.max(0, Math.min(1, job.progress)) * 100)
  const indeterminate = job.status === 'downloading' && (!job.progress || job.progress <= 0)
  return (
    <article className="downloads-row" data-status={job.status} data-source={job.source}>
      <span className={`source-pill source-${job.source}`}>{sourceLabel(job.source)}</span>
      <span className="downloads-row-input" title={job.input}>{job.input || '—'}</span>
      <div className="downloads-row-body">
        <span className={`downloads-row-status status-${job.status}`}>
          {job.status === 'ready' && <CheckCircle2 size={12} />}
          {statusLabel(job.status)}
        </span>
        {job.status === 'downloading' && (
          <div
            className={`downloads-row-progress ${indeterminate ? 'indeterminate' : ''}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={indeterminate ? undefined : pct}
          >
            <span style={indeterminate ? undefined : { width: `${pct}%` }} />
          </div>
        )}
        {job.status === 'failed' && job.error && (
          <p className="downloads-row-error">{job.error}</p>
        )}
      </div>
      {dismissible && (
        <button
          type="button"
          className="downloads-row-dismiss"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => onClear(job.id)}
        >
          <X size={14} />
        </button>
      )}
    </article>
  )
}

function LoadingCard({ job }: { job: IngestJob }) {
  const pct = Math.round(Math.max(0, Math.min(1, job.progress)) * 100)
  return (
    <article className="loading-card" data-source={job.source}>
      <div className="loading-card-icon" aria-hidden>
        <Loader2 size={18} className="spin" />
      </div>
      <div className="loading-card-text">
        <span className="loading-card-eyebrow">
          {job.status === 'downloading' ? 'Downloading' : 'Queued'} · {sourceLabel(job.source)}
        </span>
        <strong className="loading-card-title">{readableInput(job.input)}</strong>
        <div className="loading-card-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span className="loading-card-pct">{pct}%</span>
    </article>
  )
}

function readableInput(input: string) {
  if (!input) return 'Importing…'
  if (input.length <= 64) return input
  return input.slice(0, 60) + '…'
}

function CreatePlaylistDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean
  onClose: () => void
  onCreate: (name: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) {
      setName('')
      setSubmitting(false)
    }
  }, [open])

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    try {
      await onCreate(trimmed)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal title="New playlist" eyebrow="Library" open={open} onClose={onClose}>
      <div className="form-stack">
        <div className="form-field">
          <label className="form-field-label" htmlFor="new-playlist-name">Name</label>
          <input
            id="new-playlist-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit()
            }}
            placeholder="e.g. Late Night Suno, Workout, Field Recordings"
            spellCheck={false}
            autoFocus
          />
        </div>
        <div className="modal-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || submitting} onClick={() => void submit()}>
            {submitting ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function IngestDialog({
  open,
  settings,
  activePlaylistId,
  onClose,
  onSettings,
  onQueued,
}: {
  open: boolean
  settings: AppSettings
  activePlaylistId: number | null
  onClose: () => void
  onSettings: (patch: Partial<AppSettings>) => Promise<void>
  onQueued: () => void
}) {
  const [source, setSource] = useState<AudioSource>('suno')
  const [input, setInput] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [streamingOnly, setStreamingOnly] = useState(false)

  useEffect(() => {
    if (!open) {
      setInput('')
      setFile(null)
      setSubmitting(false)
      setStreamingOnly(false)
    }
  }, [open])

  const needsYoutubeConsent = source === 'youtube' && !settings.youtubeConsent
  const needsSunoConsent = source === 'suno' && !settings.sunoAdvancedEnabled
  const cannotSubmit = source === 'local' ? !file : !input.trim() || needsYoutubeConsent || needsSunoConsent

  const submit = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      if (source === 'local') {
        if (!file) return
        await api.uploadLocal(file, activePlaylistId)
        onQueued()
        return
      }

      await api.ingestUrl({
        source,
        input,
        advancedPublicSuno: settings.sunoAdvancedEnabled,
        consentAccepted: source === 'youtube' ? settings.youtubeConsent : source === 'suno' ? settings.sunoAdvancedEnabled : true,
        playlistId: activePlaylistId,
        streamingOnly,
      })
      onQueued()
    } finally {
      setSubmitting(false)
    }
  }

  const sourceTitle =
    source === 'suno'
      ? 'Suno import — advanced public URL mode'
      : source === 'youtube'
        ? 'YouTube import — rights confirmation required'
        : 'Local import'
  const sourceCopy =
    source === 'suno'
      ? 'Paste a Suno song, short link, or playlist. Playlist imports expand into one downloaded track per clip with style, prompt, cover, and duration metadata when available.'
      : source === 'youtube'
        ? 'Only import audio you own or have explicit rights to download. Polysong does not host or transmit copyrighted media on your behalf.'
        : 'Choose an audio file from this machine. The backend copies it into songs/local and extracts embedded metadata and cover art when ffmpeg is available.'

  const placeholder =
    source === 'suno'
      ? 'https://suno.com/song/… or /s/…'
      : source === 'youtube'
        ? 'https://www.youtube.com/watch?v=…'
        : 'Optional note for this import'

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
            placeholder={placeholder}
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
        {source !== 'local' && (
          <div className="streaming-option">
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={streamingOnly}
                onChange={(event) => setStreamingOnly(event.target.checked)}
              />
              Streaming only (don't download audio)
            </label>
            <p className="streaming-helper">
              <em>Streaming songs won't be playable offline and will disappear if the source is deleted.</em>
            </p>
          </div>
        )}
        <div className="modal-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={submitting ? <Loader2 size={16} className="spin" /> : <Upload size={16} />}
            disabled={cannotSubmit || submitting}
            onClick={() => void submit()}
          >
            {submitting ? 'Queuing…' : source === 'local' ? 'Upload track' : 'Queue ingest'}
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
        <div className="form-field">
          <span className="form-field-label">Theme</span>
          <Select
            value={settings.theme}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
              { value: 'system', label: 'System' },
            ]}
            onChange={(next) => void onUpdate({ theme: next as AppSettings['theme'] })}
            ariaLabel="Theme"
          />
        </div>
        <div className="form-field">
          <label className="form-field-label" htmlFor="settings-concurrent">Concurrent downloads</label>
          <input
            id="settings-concurrent"
            type="number"
            min={1}
            max={6}
            value={settings.maxConcurrentDownloads}
            onChange={(event) => void onUpdate({ maxConcurrentDownloads: Number(event.target.value) })}
          />
          <p className="form-field-help">
            How many ingest jobs run at the same time. The rest queue up and start as slots free up — set
            higher when you have a fast connection, lower if your network or the source is rate-limited.
          </p>
        </div>
        <div className="form-field">
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={settings.sunoAdvancedEnabled}
              onChange={(event) => void onUpdate({ sunoAdvancedEnabled: event.target.checked })}
            />
            Suno public URL advanced mode
          </label>
          <p className="form-field-help">
            Off: Polysong only imports Suno songs from your own account. On: you can also paste public Suno
            song or playlist URLs (someone else's tracks). Only enable this for content you have the right
            to keep locally — Suno's terms still apply.
          </p>
        </div>
        <div className="notice">
          <strong>Audio root</strong>
          <p>
            <code className="inline-code">{settings.audioRoot}</code>. Imports are assigned to{' '}
            <code className="inline-code">songs/suno</code>,{' '}
            <code className="inline-code">songs/youtube</code>, or{' '}
            <code className="inline-code">songs/local</code> under the app data directory.
          </p>
        </div>
        <div className="modal-footer">
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  )
}

export default App
