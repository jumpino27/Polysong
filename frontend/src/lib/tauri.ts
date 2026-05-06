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

async function call<T>(command: string, args: Record<string, unknown>, fallback: () => Promise<T>) {
  if (!hasTauri) return fallback()
  return invoke<T>(command, args)
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
  listIngestJobs: () => call<IngestJob[]>('list_ingest_jobs', {}, mockListJobs),
  getSettings: () => call<AppSettings>('get_settings', {}, mockGetSettings),
  updateSettings: (patch: SettingsPatch) =>
    call<AppSettings>('update_settings', { patch }, () => mockUpdateSettings(patch)),
}
