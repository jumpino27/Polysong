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
  // Map of playlistId → trackIds in playlist (in insertion order).
  memberships: Record<number, number[]>
}

const STORAGE_KEY = 'polysong.browserPreviewState.v1'

const defaultSettings: AppSettings = {
  theme: 'dark',
  audioRoot: 'songs',
  youtubeConsent: false,
  sunoAdvancedEnabled: false,
  maxConcurrentDownloads: 2,
}

let { tracks, playlists, jobs, settings, memberships } = loadState()

export async function mockListTracks(filter: TrackFilter) {
  let result = [...tracks]
  if (filter.source) result = result.filter((track) => track.source === filter.source)
  if (filter.favoritesOnly) result = result.filter((track) => track.favorite)
  if (filter.playlistId != null) {
    const ids = new Set(memberships[filter.playlistId] ?? [])
    result = result.filter((track) => ids.has(track.id))
  }
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
  // Cascade: drop the track from every playlist it was in.
  memberships = Object.fromEntries(
    Object.entries(memberships).map(([key, ids]) => [Number(key), ids.filter((tid) => tid !== id)]),
  )
  saveState()
}

export async function mockListPlaylists() {
  return playlists.map((playlist) => ({
    ...playlist,
    trackCount: (memberships[playlist.id] ?? []).length,
  }))
}

export async function mockCreatePlaylist(name: string, description?: string | null) {
  const playlist = {
    id: Date.now(),
    name,
    description: description ?? null,
    trackCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  playlists = [playlist, ...playlists]
  memberships[playlist.id] = []
  saveState()
  return playlist
}

export async function mockAddTrackToPlaylist(trackId: number, playlistId: number) {
  const current = memberships[playlistId] ?? []
  if (!current.includes(trackId)) {
    memberships[playlistId] = [...current, trackId]
    saveState()
  }
}

export async function mockRemoveTrackFromPlaylist(trackId: number, playlistId: number) {
  memberships[playlistId] = (memberships[playlistId] ?? []).filter((id) => id !== trackId)
  saveState()
}

export async function mockListTrackPlaylists(trackId: number) {
  return Object.entries(memberships)
    .filter(([, ids]) => ids.includes(trackId))
    .map(([key]) => Number(key))
}

export async function mockListPlaylistMembers(playlistId: number) {
  return [...(memberships[playlistId] ?? [])]
}

export async function mockSetTrackPlaylists(trackId: number, playlistIds: number[]) {
  const target = new Set(playlistIds)
  for (const playlist of playlists) {
    const ids = memberships[playlist.id] ?? []
    const isMember = ids.includes(trackId)
    if (target.has(playlist.id) && !isMember) {
      memberships[playlist.id] = [...ids, trackId]
    } else if (!target.has(playlist.id) && isMember) {
      memberships[playlist.id] = ids.filter((id) => id !== trackId)
    }
  }
  saveState()
}

export async function mockIngest(request: IngestRequest) {
  // Dedup: if a track with the same source URL already exists, return it.
  if (request.input && request.source !== 'local') {
    const existing = tracks.find((track) => track.sourceUrl === request.input)
    if (existing) {
      const job: IngestJob = {
        id: Date.now(),
        source: request.source,
        input: request.input,
        status: 'ready',
        progress: 1,
        trackId: existing.id,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      jobs = [job, ...jobs]
      if (request.playlistId != null) await mockAddTrackToPlaylist(existing.id, request.playlistId)
      saveState()
      return existing.id
    }
  }

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

  let trackId = job.id
  if (request.consentAccepted) {
    const sourceId = sourceIdFromInput(request.input, request.source)
    const extension = request.source === 'local' ? extensionFromPath(request.input) : 'mp3'
    const newTrack: Track = {
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
    }
    tracks = [newTrack, ...tracks]
    trackId = newTrack.id
    if (request.playlistId != null) {
      await mockAddTrackToPlaylist(trackId, request.playlistId)
    }
  }

  saveState()
  return trackId
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
      memberships: parsed.memberships ?? {},
    }
  } catch {
    return emptyState()
  }
}

function saveState() {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ tracks, playlists, jobs, settings, memberships }),
  )
}

function emptyState(): MockState {
  return {
    tracks: [],
    playlists: [],
    jobs: [],
    settings: defaultSettings,
    memberships: {},
  }
}
