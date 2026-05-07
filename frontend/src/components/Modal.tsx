import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from './Button'

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Modal({
  title,
  eyebrow,
  open,
  onClose,
  children,
}: {
  title: string
  eyebrow?: string
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)
  // Stash the latest onClose in a ref so the focus-trap effect's dependency
  // list doesn't include it — otherwise every parent re-render (audio engine
  // emits ~4 ticks/second) would re-run the cleanup, which yanks focus out
  // of whatever the user is typing in.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return
    previouslyFocused.current = (document.activeElement as HTMLElement) ?? null

    const dialog = dialogRef.current
    const focusables = dialog?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    const first = focusables && focusables.length > 0 ? focusables[0] : dialog
    first?.focus({ preventScroll: true })

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
      )
      if (items.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const head = items[0]
      const tail = items[items.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (event.shiftKey && (active === head || !dialog.contains(active))) {
        event.preventDefault()
        tail.focus()
      } else if (!event.shiftKey && active === tail) {
        event.preventDefault()
        head.focus()
      }
    }

    window.addEventListener('keydown', onKey)
    const previous = previouslyFocused.current
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus?.({ preventScroll: true })
    }
  }, [open])

  if (!open) return null

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            {eyebrow && <span className="eyebrow modal-eyebrow">{eyebrow}</span>}
            <h2>{title}</h2>
          </div>
          <Button icon={<X size={16} />} aria-label="Close dialog" onClick={onClose} />
        </header>
        {children}
      </section>
    </div>
  )
}
