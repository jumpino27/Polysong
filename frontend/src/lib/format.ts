export function formatDuration(durationMs?: number | null) {
  if (!durationMs) return '--:--'
  const totalSeconds = Math.round(durationMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

export function sourceLabel(source: string) {
  if (source === 'youtube') return 'YouTube'
  if (source === 'suno') return 'Suno'
  return 'Local'
}
