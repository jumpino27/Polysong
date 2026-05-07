import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export interface SelectOption<T extends string> {
  value: T
  label: string
}

/**
 * Theme-aware select. Replaces the native `<select>` because native option
 * popups don't honor `appearance: none` for color and ignore many CSS tokens,
 * which made our dark dropdown render with a light system popup.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
}: {
  value: T
  options: ReadonlyArray<SelectOption<T>>
  onChange: (next: T) => void
  ariaLabel?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const id = useId()
  const labelFor = options.find((option) => option.value === value)?.label ?? value

  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (!wrapperRef.current) return
      if (!wrapperRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Move focus into the popup when it opens so arrow keys traverse options.
  useEffect(() => {
    if (!open) return
    const list = listRef.current
    if (!list) return
    const current = list.querySelector<HTMLElement>(`[data-value="${value}"]`)
    current?.focus({ preventScroll: true })
  }, [open, value])

  const move = (delta: number) => {
    const idx = options.findIndex((option) => option.value === value)
    if (idx === -1) return
    const next = (idx + delta + options.length) % options.length
    onChange(options[next].value)
  }

  return (
    <div className={`select ${className}`} ref={wrapperRef} data-open={open}>
      <button
        type="button"
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={ariaLabel}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            if (!open) setOpen(true)
            else move(1)
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            if (!open) setOpen(true)
            else move(-1)
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen((value) => !value)
          }
        }}
      >
        <span>{labelFor}</span>
        <ChevronDown size={14} className={open ? 'select-chev open' : 'select-chev'} aria-hidden />
      </button>
      {open && (
        <div className="select-popup" role="listbox" id={`${id}-list`} ref={listRef}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              data-value={option.value}
              className={`select-option ${option.value === value ? 'selected' : ''}`}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              <span className="select-option-check" aria-hidden>
                {option.value === value && <Check size={14} />}
              </span>
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
