import { invoke } from '@tauri-apps/api/core'
import type {
  AppSettings,
  IngestJob,
  IngestRequest,
  Playlist,
  SettingsPatch,
  Track,
  TrackAvailability,
  TrackFilter,
  TrackPatch,
  UpdateStatus,
} from '../types'
import {
  mockAddTrackToPlaylist,
  mockCreatePlaylist,
  mockDeleteTrack,
  mockGetSettings,
  mockIngest,
  mockListJobs,
  mockListPlaylistMembers,
  mockListPlaylists,
  mockListTrackPlaylists,
  mockListTracks,
  mockRemoveTrackFromPlaylist,
  mockSetTrackPlaylists,
  mockUpdateSettings,
  mockUpdateTrack,
} from './mock'

const hasTauri = Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
const backendBaseUrl = (import.meta.env.VITE_POLYSONG_BACKEND_URL ?? 'http://127.0.0.1:4777').replace(/\/$/, '')
const backendUrl = `${backendBaseUrl}/api`
const mediaBaseUrl = `${backendBaseUrl}/media`

async function callHttp<T>(command: string, args: Record<string, unknown>): Promise<T> {
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
}

/**
 * Call the backend, with graceful degradation.
 *
 * - Tauri mode: try `invoke()` first. If it throws (e.g. an old build that
 *   doesn't have a freshly-added command registered yet), fall back to the
 *   embedded HTTP backend served by the same binary — it often has the route
 *   even when the Tauri handler list is stale. If both fail, propagate the
 *   error so callers can surface it.
 * - Browser preview: try the HTTP backend, then the in-browser mock.
 */
async function call<T>(
  command: string,
  args: Record<string, unknown>,
  fallback: () => Promise<T>,
): Promise<T> {
  if (hasTauri) {
    try {
      return await invoke<T>(command, args)
    } catch (tauriError) {
      try {
        return await callHttp<T>(command, args)
      } catch (httpError) {
        console.warn(
          `Polysong: ${command} failed via both Tauri and HTTP. Tauri error:`,
          tauriError,
          'HTTP error:',
          httpError,
        )
        throw tauriError instanceof Error ? tauriError : new Error(String(tauriError))
      }
    }
  }
  try {
    return await callHttp<T>(command, args)
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
  downloadTrack: (trackId: number) =>
    call<Track>('download_track', { trackId }, async () => {
      throw new Error('download_track is not available in browser preview')
    }),
  uploadLocal: async (file: File, playlistId?: number | null) => {
    try {
      const params = new URLSearchParams({ filename: file.name })
      if (playlistId != null) params.set('playlistId', String(playlistId))
      const response = await fetch(`${backendUrl}/upload_local?${params.toString()}`, {
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
        playlistId,
        streamingOnly: false,
      })
    }
  },
  listIngestJobs: () => call<IngestJob[]>('list_ingest_jobs', {}, mockListJobs),
  getSettings: () => call<AppSettings>('get_settings', {}, mockGetSettings),
  updateSettings: (patch: SettingsPatch) =>
    call<AppSettings>('update_settings', { patch }, () => mockUpdateSettings(patch)),
  addTrackToPlaylist: (trackId: number, playlistId: number) =>
    call<void>('add_track_to_playlist', { trackId, playlistId }, () => mockAddTrackToPlaylist(trackId, playlistId)),
  removeTrackFromPlaylist: (trackId: number, playlistId: number) =>
    call<void>(
      'remove_track_from_playlist',
      { trackId, playlistId },
      () => mockRemoveTrackFromPlaylist(trackId, playlistId),
    ),
  listTrackPlaylists: (trackId: number) =>
    call<number[]>('list_track_playlists', { trackId }, () => mockListTrackPlaylists(trackId)),
  setTrackPlaylists: (trackId: number, playlistIds: number[]) =>
    call<void>('set_track_playlists', { trackId, playlistIds }, () =>
      mockSetTrackPlaylists(trackId, playlistIds),
    ),
  listPlaylistMembers: (playlistId: number) =>
    call<number[]>('list_playlist_members', { playlistId }, () =>
      mockListPlaylistMembers(playlistId),
    ),
  checkTracksAvailability: (trackIds: number[]) =>
    call<TrackAvailability[]>(
      'check_tracks_availability',
      { trackIds },
      async () => trackIds.map((id) => ({ id, available: true, checkedAt: Date.now() })),
    ),
  resolveStreamUrl: (trackId: number) =>
    call<string>('resolve_stream_url', { trackId }, async () => ''),
  checkUpdate: () => {
    const disabled = async (): Promise<UpdateStatus> => ({
      available: false,
      disabled: true,
      currentVersion: 'browser-preview',
      latestVersion: null,
      installerUrl: null,
    })
    return hasTauri ? call<UpdateStatus>('check_update', {}, disabled) : disabled()
  },
  installUpdate: () => (hasTauri ? call<void>('install_update', {}, async () => undefined) : Promise.resolve()),
}

export function mediaUrl(path?: string | null) {
  if (!path) return null
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  if (hasTauri) return `http://polysong.localhost/media/${encodedPath}`
  return `${mediaBaseUrl}/${encodedPath}`
}
