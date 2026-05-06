import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode
  variant?: 'primary' | 'ghost' | 'quiet' | 'danger'
}

export function Button({ icon, variant = 'ghost', children, className = '', ...props }: ButtonProps) {
  return (
    <button className={`button button-${variant} ${className}`} type="button" {...props}>
      {icon}
      {children && <span>{children}</span>}
    </button>
  )
}
