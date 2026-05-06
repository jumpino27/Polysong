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

let tracks: Track[] = [
  {
    id: 1,
    source: 'suno',
    sourceId: 'demo-suno-01',
    filePath: 'audio/suno/demo-suno-01.mp3',
    title: 'Glass Orchard Engine',
    artist: 'Jumpino',
    album: 'Drafts from Suno',
    durationMs: 206000,
    sourceUrl: 'https://suno.com/song/demo-suno-01',
    favorite: true,
    playCount: 4,
    addedAt: Date.now() - 1000,
    styleDescription:
      'Industrial art-pop with clipped machine percussion, choir pads, gliding bass, and a bright melodic hook.',
    sunoPrompt: 'A kinetic song about a city-sized music machine growing fruit made of light.',
    lyrics: 'Verse and chorus metadata appears here when Suno returns lyrics.',
  },
  {
    id: 2,
    source: 'youtube',
    sourceId: 'demo-youtube-01',
    filePath: 'audio/youtube/demo-youtube-01.mp3',
    title: 'Public Domain Radio Sweep',
    artist: 'Archive Import',
    album: 'Rights-cleared queue',
    durationMs: 183000,
    sourceUrl: 'https://youtube.com/watch?v=demo-youtube-01',
    favorite: false,
    playCount: 1,
    addedAt: Date.now() - 4000,
  },
  {
    id: 3,
    source: 'local',
    filePath: 'audio/local/night-drive.flac',
    title: 'Night Drive Reference',
    artist: 'Local Files',
    album: 'Inbox',
    durationMs: 251000,
    favorite: false,
    playCount: 8,
    addedAt: Date.now() - 9000,
  },
]

let playlists: Playlist[] = [
  {
    id: 1,
    name: 'Suno candidates',
    description: 'Generated tracks that need metadata review.',
    trackCount: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 2,
    name: 'Visualizer checks',
    description: 'Songs used to test bars, waveform, and radial modes.',
    trackCount: 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
]

let jobs: IngestJob[] = []
let settings: AppSettings = {
  theme: 'dark',
  audioRoot: 'audio',
  youtubeConsent: false,
  sunoAdvancedEnabled: false,
  maxConcurrentDownloads: 2,
}

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
}

export async function mockDeleteTrack(id: number) {
  tracks = tracks.filter((track) => track.id !== id)
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
    const sourceId = request.input.split('/').filter(Boolean).pop() ?? String(job.id)
    tracks = [
      {
        id: job.id,
        source: request.source,
        sourceId,
        filePath: `audio/${request.source}/${sourceId}.mp3`,
        title: request.source === 'suno' ? 'Queued Suno import' : 'Queued URL import',
        artist: request.source === 'suno' ? 'Suno' : request.source === 'youtube' ? 'YouTube' : 'Local Files',
        durationMs: null,
        sourceUrl: request.source === 'local' ? null : request.input,
        favorite: false,
        playCount: 0,
        addedAt: Date.now(),
        styleDescription:
          request.source === 'suno'
            ? 'Waiting for Suno tags/style metadata from the authenticated clip fetcher.'
            : null,
      },
      ...tracks,
    ]
  }

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
  return settings
}

export function inferSource(input: string): AudioSource {
  if (/suno\.com/i.test(input)) return 'suno'
  if (/youtu\.be|youtube\.com/i.test(input)) return 'youtube'
  return 'local'
}
