import { invoke } from '@tauri-apps/api/core'
import type {
  AppSettings,
  IngestJob,
  IngestRequest,
  Playlist,
  SettingsPatch,
  Track,
  TrackFilter,
  TrackPatch,
} from '../types'
import {
  mockCreatePlaylist,
  mockDeleteTrack,
  mockGetSettings,
  mockIngest,
  mockListJobs,
  mockListPlaylists,
  mockListTracks,
  mockUpdateSettings,
  mockUpdateTrack,
} from './mock'

const hasTauri = Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
const backendUrl = 'http://127.0.0.1:4777/api'
const mediaBaseUrl = 'http://127.0.0.1:4777/media'

async function call<T>(command: string, args: Record<string, unknown>, fallback: () => Promise<T>) {
  if (hasTauri) return invoke<T>(command, args)

  try {
    const response = await fetch(`${backendUrl}/${command}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? `Backend returned ${response.status}`)
    }
    return (await response.json()) as T
  } catch (error) {
    console.warn(`Polysong backend unavailable for ${command}; using browser preview fallback.`, error)
    return fallback()
  }
}

export const api = {
  listTracks: (filter: TrackFilter) => call<Track[]>('list_tracks', { filter }, () => mockListTracks(filter)),
  updateTrackMetadata: (id: number, patch: TrackPatch) =>
    call<void>('update_track_metadata', { id, patch }, () => mockUpdateTrack(id, patch)),
  deleteTrack: (id: number) => call<void>('delete_track', { id }, () => mockDeleteTrack(id)),
  listPlaylists: () => call<Playlist[]>('list_playlists', {}, mockListPlaylists),
  createPlaylist: (name: string, description?: string | null) =>
    call<Playlist>('create_playlist', { name, description }, () => mockCreatePlaylist(name, description)),
  ingestUrl: (request: IngestRequest) => call<number>('ingest_url', { request }, () => mockIngest(request)),
  uploadLocal: async (file: File) => {
    try {
      const response = await fetch(`${backendUrl}/upload_local?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `Backend returned ${response.status}`)
      }
      return (await response.json()) as number
    } catch (error) {
      console.warn('Polysong backend unavailable for upload_local; using browser preview fallback.', error)
      return mockIngest({
        source: 'local',
        input: file.name,
        advancedPublicSuno: false,
        consentAccepted: true,
      })
    }
  },
  listIngestJobs: () => call<IngestJob[]>('list_ingest_jobs', {}, mockListJobs),
  getSettings: () => call<AppSettings>('get_settings', {}, mockGetSettings),
  updateSettings: (patch: SettingsPatch) =>
    call<AppSettings>('update_settings', { patch }, () => mockUpdateSettings(patch)),
}

export function mediaUrl(path?: string | null) {
  if (!path) return null
  return `${mediaBaseUrl}/${path.split('/').map(encodeURIComponent).join('/')}`
}
