import { Heart, Music2, Play, Sparkles, Trash2 } from 'lucide-react'
import type { Track } from '../types'
import { formatDuration, sourceLabel } from '../lib/format'
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
  return (
    <article className={`track-row ${active ? 'active' : ''}`}>
      <button className="cover-art" type="button" onClick={onPlay} aria-label={`Play ${track.title}`}>
        <Music2 size={21} />
      </button>
      <div className="track-main">
        <button className="track-title" type="button" onClick={onToggleExpanded}>
          <strong>{track.title}</strong>
          <span>{track.artist ?? 'Unknown artist'}</span>
        </button>
        {expanded && (
          <div className="track-details">
            {track.styleDescription && (
              <p>
                <Sparkles size={14} /> <span>{track.styleDescription}</span>
              </p>
            )}
            {track.sunoPrompt && <p className="muted">Prompt: {track.sunoPrompt}</p>}
            <p className="muted">{track.filePath}</p>
          </div>
        )}
      </div>
      <span className={`source-pill source-${track.source}`}>{sourceLabel(track.source)}</span>
      <span className="duration">{formatDuration(track.durationMs)}</span>
      <Button icon={<Play size={16} />} aria-label="Play" onClick={onPlay} />
      <Button
        icon={<Heart size={16} fill={track.favorite ? 'currentColor' : 'none'} />}
        aria-label={track.favorite ? 'Remove favorite' : 'Add favorite'}
        onClick={onToggleFavorite}
      />
      <Button icon={<Trash2 size={16} />} variant="quiet" aria-label="Delete track" onClick={onDelete} />
    </article>
  )
}
