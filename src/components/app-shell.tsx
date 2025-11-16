'use client'

import { cn } from '@/lib/utils'
import { ReactNode } from 'react'

type AppShellProps = {
  children: ReactNode
  className?: string
  containerClassName?: string
}

export function AppShell({ children, className, containerClassName }: AppShellProps) {
  return (
    <main className={cn('min-h-screen bg-black', className)}>
      <div className={cn('mx-auto w-full max-w-5xl px-6 py-12 md:py-16', containerClassName)}>
        {children}
      </div>
    </main>
  )
}

