"use client"

import { ReactNode } from "react"
import { cn } from "@/lib/utils"

type WorkspaceSurfaceProps = {
  children: ReactNode
  className?: string
}

export function WorkspaceSurface({ children, className }: WorkspaceSurfaceProps) {
  return (
    <div className={cn("relative mx-auto w-full max-w-4xl", className)}>
      <div className="pointer-events-none absolute -inset-8 rounded-xl gradient-rainbow opacity-50 blur-3xl" />
      <div className="relative">{children}</div>
    </div>
  )
}

