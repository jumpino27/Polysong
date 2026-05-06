export type AudioSource = 'local' | 'youtube' | 'suno'
export type IngestStatus = 'queued' | 'downloading' | 'ready' | 'failed' | 'cancelled'
export type ThemeMode = 'dark' | 'light' | 'system'
export type VisualizerMode = 'bars' | 'waveform' | 'radial'

export interface Track {
  id: number
  source: AudioSource
  sourceId?: string | null
  filePath: string
  title: string
  artist?: string | null
  album?: string | null
  durationMs?: number | null
  coverPath?: string | null
  sourceUrl?: string | null
  favorite: boolean
  playCount: number
  addedAt: number
  lastPlayedAt?: number | null
  styleDescription?: string | null
  sunoPrompt?: string | null
  lyrics?: string | null
}

export interface TrackFilter {
  source?: AudioSource | null
  search?: string | null
  favoritesOnly: boolean
}

export interface TrackPatch {
  title?: string
  artist?: string | null
  album?: string | null
  favorite?: boolean
  styleDescription?: string | null
  sunoPrompt?: string | null
  lyrics?: string | null
}

export interface Playlist {
  id: number
  name: string
  description?: string | null
  trackCount: number
  createdAt: number
  updatedAt: number
}

export interface IngestRequest {
  source: AudioSource
  input: string
  advancedPublicSuno: boolean
  consentAccepted: boolean
}

export interface IngestJob {
  id: number
  source: AudioSource
  input: string
  status: IngestStatus
  progress: number
  trackId?: number | null
  error?: string | null
  createdAt: number
  updatedAt: number
}

export interface AppSettings {
  theme: ThemeMode
  audioRoot: string
  youtubeConsent: boolean
  sunoAdvancedEnabled: boolean
  maxConcurrentDownloads: number
}

export interface SettingsPatch {
  theme?: ThemeMode
  youtubeConsent?: boolean
  sunoAdvancedEnabled?: boolean
  maxConcurrentDownloads?: number
}
