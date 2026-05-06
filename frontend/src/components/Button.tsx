import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode
  variant?: 'primary' | 'ghost' | 'quiet' | 'danger'
}

export function Button({ icon, variant = 'ghost', children, className = '', type = 'button', ...props }: ButtonProps) {
  const composed = ['button', `button-${variant}`, !children && icon ? 'button-icon' : '', className]
    .filter(Boolean)
    .join(' ')

  return (
    <button className={composed} type={type} {...props}>
      {icon}
      {children && <span>{children}</span>}
    </button>
  )
}
