export function ProgressBar({ value }: { value: number }) {
  return (
    <span className="progress" aria-label={`${Math.round(value * 100)} percent complete`}>
      <span style={{ width: `${Math.round(value * 100)}%` }} />
    </span>
  )
}
