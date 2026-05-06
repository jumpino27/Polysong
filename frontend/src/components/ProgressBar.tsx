export function ProgressBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value))
  const display = Math.round(pct * 100)
  return (
    <span
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={display}
      aria-label={`${display} percent complete`}
    >
      <span style={{ width: `${display}%` }} />
    </span>
  )
}
