import { useEffect, useState } from 'react'
import { AlertTriangle, Check, ListMusic, Loader2, Plus } from 'lucide-react'
import { Modal } from './Modal'
import { Button } from './Button'
import { api } from '../lib/tauri'
import type { Playlist, Track } from '../types'

/**
 * Multi-select dialog for managing the playlists a track belongs to. The user
 * can toggle existing playlists on/off and create a new one inline. Saving
 * commits the membership delta to the backend in one call.
 */
export function AddToPlaylistDialog({
  open,
  track,
  playlists,
  onClose,
  onSaved,
}: {
  open: boolean
  track: Track | null
  playlists: Playlist[]
  onClose: () => void
  onSaved: () => Promise<void> | void
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !track) return
    let cancelled = false
    setLoading(true)
    setNewName('')
    setError(null)
    api
      .listTrackPlaylists(track.id)
      .then((ids) => {
        if (!cancelled) setSelected(new Set(ids))
      })
      .catch((err) => {
        if (!cancelled) {
          setSelected(new Set())
          // Couldn't load existing memberships — surface so the user can
          // decide whether to retry or create from scratch.
          setError(err instanceof Error ? err.message : 'Could not load existing playlists for this track')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, track?.id])

  const toggle = (id: number) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const submit = async () => {
    if (!track || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await api.setTrackPlaylists(track.id, Array.from(selected))
      await onSaved()
      onClose()
    } catch (err) {
      // Surface failure visibly — previously this was swallowed and the
      // modal would just sit there as if nothing had been clicked.
      setError(err instanceof Error ? err.message : 'Could not save playlists')
      console.error('Polysong: setTrackPlaylists failed', err)
    } finally {
      setSubmitting(false)
    }
  }

  const createInline = async () => {
    const trimmed = newName.trim()
    if (!trimmed || creating) return
    setCreating(true)
    setError(null)
    try {
      const playlist = await api.createPlaylist(trimmed)
      setSelected((current) => {
        const next = new Set(current)
        next.add(playlist.id)
        return next
      })
      setNewName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create playlist')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal title="Add to playlists" eyebrow={track?.title ?? 'Track'} open={open} onClose={onClose}>
      <div className="form-stack">
        <p className="form-field-help">
          Pick which playlists should include this track. The audio file stays in its source folder —
          a track can belong to multiple playlists at once without being copied on disk.
        </p>

        {error && (
          <div className="dialog-error" role="alert">
            <AlertTriangle size={14} />
            <span>{error}</span>
          </div>
        )}

        <div className="playlist-picker" role="listbox" aria-label="Playlists">
          {loading && (
            <div className="playlist-picker-loading">
              <Loader2 size={16} className="spin" />
              <span>Loading…</span>
            </div>
          )}
          {!loading && playlists.length === 0 && (
            <p className="playlist-picker-empty">
              No playlists yet — create one below to add this track to it.
            </p>
          )}
          {!loading &&
            playlists.map((playlist) => {
              const checked = selected.has(playlist.id)
              return (
                <button
                  key={playlist.id}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  className={`playlist-picker-item ${checked ? 'selected' : ''}`}
                  onClick={() => toggle(playlist.id)}
                >
                  <span className="playlist-picker-check" aria-hidden>
                    {checked && <Check size={14} />}
                  </span>
                  <ListMusic size={14} className="playlist-picker-icon" aria-hidden />
                  <span className="playlist-picker-name">{playlist.name}</span>
                  <span className="playlist-picker-count">{playlist.trackCount}</span>
                </button>
              )
            })}
        </div>

        <div className="playlist-create">
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void createInline()
              }
            }}
            placeholder="New playlist name"
            spellCheck={false}
          />
          <Button
            icon={creating ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
            disabled={!newName.trim() || creating}
            onClick={() => void createInline()}
          >
            Create
          </Button>
        </div>

        <div className="modal-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={submitting || loading} onClick={() => void submit()}>
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
