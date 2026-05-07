import { Heart, Music2, Play, Sparkles, Trash2 } from 'lucide-react'
import type { Track } from '../types'
import { formatDuration, sourceLabel } from '../lib/format'
import { mediaUrl } from '../lib/tauri'
import { Button } from './Button'

export function TrackRow({
  track,
  active,
  expanded,
  onPlay,
  onToggleFavorite,
  onToggleExpanded,
  onDelete,
}: {
  track: Track
  active: boolean
  expanded: boolean
  onPlay: () => void
  onToggleFavorite: () => void
  onToggleExpanded: () => void
  onDelete: () => void
}) {
  const showStyleChip = Boolean(track.styleDescription)
  const coverUrl = mediaUrl(track.coverPath)

  return (
    <article className={`track-row ${active ? 'active' : ''} ${expanded ? 'expanded' : ''}`}>
      <div className="track-row-main">
        <button
          className="cover-art"
          type="button"
          onClick={onPlay}
          aria-label={`Play ${track.title}`}
        >
          {coverUrl ? <img src={coverUrl} alt="" /> : <Music2 size={18} strokeWidth={1.8} />}
          <span className="cover-art-overlay" aria-hidden>
            <Play size={16} fill="currentColor" />
          </span>
        </button>

        <button
          className="track-title"
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-controls={`track-details-${track.id}`}
        >
          <strong>{track.title}</strong>
          <span className="track-title-meta">
            <span className="artist">{track.artist ?? 'Unknown artist'}</span>
            {showStyleChip && (
              <span className="track-style" title={track.styleDescription ?? ''}>
                <Sparkles size={11} />
                <span className="track-style-text">{track.styleDescription}</span>
              </span>
            )}
          </span>
        </button>

        <span className={`source-pill source-${track.source}`}>{sourceLabel(track.source)}</span>

        <span className="duration-cell">{formatDuration(track.durationMs)}</span>

        <div className="track-actions">
          <Button
            icon={<Heart size={15} fill={track.favorite ? 'currentColor' : 'none'} />}
            aria-label={track.favorite ? 'Remove favorite' : 'Add favorite'}
            onClick={onToggleFavorite}
          />
          <Button icon={<Trash2 size={15} />} variant="quiet" aria-label="Delete track" onClick={onDelete} />
        </div>
      </div>

      {expanded && (
        <dl className="track-details" id={`track-details-${track.id}`}>
          {track.styleDescription && (
            <>
              <dt>Style description</dt>
              <dd>{track.styleDescription}</dd>
            </>
          )}
          {track.sunoPrompt && (
            <>
              <dt>Suno prompt</dt>
              <dd>{track.sunoPrompt}</dd>
            </>
          )}
          <dt>File</dt>
          <dd>
            <code>{track.filePath}</code>
          </dd>
        </dl>
      )}
    </article>
  )
}
