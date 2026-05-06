import type {
  AppSettings,
  AudioSource,
  IngestJob,
  IngestRequest,
  Playlist,
  SettingsPatch,
  Track,
  TrackFilter,
  TrackPatch,
} from '../types'

interface MockState {
  tracks: Track[]
  playlists: Playlist[]
  jobs: IngestJob[]
  settings: AppSettings
}

const STORAGE_KEY = 'polysong.browserPreviewState.v1'

const defaultSettings: AppSettings = {
  theme: 'dark',
  audioRoot: 'songs',
  youtubeConsent: false,
  sunoAdvancedEnabled: false,
  maxConcurrentDownloads: 2,
}

let { tracks, playlists, jobs, settings } = loadState()

export async function mockListTracks(filter: TrackFilter) {
  let result = [...tracks]
  if (filter.source) result = result.filter((track) => track.source === filter.source)
  if (filter.favoritesOnly) result = result.filter((track) => track.favorite)
  if (filter.search) {
    const needle = filter.search.toLowerCase()
    result = result.filter((track) =>
      [track.title, track.artist, track.album, track.styleDescription]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle)),
    )
  }
  return result
}

export async function mockUpdateTrack(id: number, patch: TrackPatch) {
  tracks = tracks.map((track) => (track.id === id ? { ...track, ...patch } : track))
  saveState()
}

export async function mockDeleteTrack(id: number) {
  tracks = tracks.filter((track) => track.id !== id)
  saveState()
}

export async function mockListPlaylists() {
  return playlists
}

export async function mockCreatePlaylist(name: string, description?: string | null) {
  const playlist = {
    id: Date.now(),
    name,
    description,
    trackCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  playlists = [playlist, ...playlists]
  saveState()
  return playlist
}

export async function mockIngest(request: IngestRequest) {
  const job: IngestJob = {
    id: Date.now(),
    source: request.source,
    input: request.input,
    status: request.consentAccepted ? 'ready' : 'failed',
    progress: request.consentAccepted ? 1 : 0,
    error: request.consentAccepted ? null : 'Consent is required before importing this source.',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  jobs = [job, ...jobs]

  if (request.consentAccepted) {
    const sourceId = sourceIdFromInput(request.input, request.source)
    const extension = request.source === 'local' ? extensionFromPath(request.input) : 'mp3'
    tracks = [
      {
        id: job.id,
        source: request.source,
        sourceId,
        filePath: `songs/${request.source}/${sourceId}.${extension}`,
        title: request.source === 'suno' ? `Suno ${sourceId}` : request.source === 'youtube' ? `YouTube ${sourceId}` : sourceId,
        artist: request.source === 'suno' ? 'Suno' : request.source === 'youtube' ? 'YouTube' : 'Local Files',
        durationMs: null,
        sourceUrl: request.source === 'local' ? null : request.input,
        favorite: false,
        playCount: 0,
        addedAt: Date.now(),
        styleDescription: null,
      },
      ...tracks,
    ]
  }

  saveState()
  return job.id
}

export async function mockListJobs() {
  return jobs
}

export async function mockGetSettings() {
  return settings
}

export async function mockUpdateSettings(patch: SettingsPatch) {
  settings = { ...settings, ...patch }
  saveState()
  return settings
}

export function inferSource(input: string): AudioSource {
  if (/suno\.com/i.test(input)) return 'suno'
  if (/youtu\.be|youtube\.com/i.test(input)) return 'youtube'
  return 'local'
}

function sourceIdFromInput(input: string, source: AudioSource) {
  if (source === 'youtube') {
    try {
      const url = new URL(input)
      if (url.hostname.includes('youtu.be')) return cleanId(url.pathname.split('/').filter(Boolean)[0])
      return cleanId(url.searchParams.get('v') ?? String(Date.now()))
    } catch {
      return String(Date.now())
    }
  }

  if (source === 'local') {
    const leaf = input.split(/[\\/]/).filter(Boolean).pop() ?? `local-${Date.now()}`
    return cleanId(leaf.replace(/\.[^.]+$/, ''))
  }

  try {
    const url = new URL(input)
    const segments = url.pathname.split('/').filter(Boolean)
    if ((segments[0] === 'song' || segments[0] === 's') && segments[1]) return cleanId(segments[1])
    return cleanId(segments.at(-1) ?? String(Date.now()))
  } catch {
    return String(Date.now())
  }
}

function extensionFromPath(input: string) {
  return input.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp3'
}

function cleanId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '') || String(Date.now())
}

function loadState(): MockState {
  if (typeof window === 'undefined') {
    return emptyState()
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyState()
    const parsed = JSON.parse(raw) as Partial<MockState>
    return {
      tracks: parsed.tracks ?? [],
      playlists: parsed.playlists ?? [],
      jobs: parsed.jobs ?? [],
      settings: { ...defaultSettings, ...parsed.settings },
    }
  } catch {
    return emptyState()
  }
}

function saveState() {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tracks, playlists, jobs, settings }))
}

function emptyState(): MockState {
  return {
    tracks: [],
    playlists: [],
    jobs: [],
    settings: defaultSettings,
  }
}
