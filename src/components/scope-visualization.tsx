'use client'

import { useState } from 'react'
import { X, Maximize2, Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type ScopeVisualizationProps = {
  open: boolean
  onClose: () => void
  containerRef: React.RefObject<HTMLDivElement | null>
}

export function ScopeVisualization({ open, onClose, containerRef }: ScopeVisualizationProps) {
  const [isMinimized, setIsMinimized] = useState(false)

  // Hydra will manage the canvas through StrudelEngine.setScopeContainer
  // No need to create a canvas here

  if (!open) {
    return null
  }

  return (
    <div
      className={cn(
        'fixed z-50 flex flex-col rounded-lg border bg-background shadow-lg transition-all',
        isMinimized ? 'bottom-4 right-4 w-80' : 'bottom-4 right-4 h-[400px] w-[600px]',
      )}
    >
      <div className="flex items-center justify-between border-b px-4 py-2">
        <h3 className="text-sm font-semibold">Scope Visualization</h3>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setIsMinimized(!isMinimized)}
            aria-label={isMinimized ? 'Maximize' : 'Minimize'}
          >
            {isMinimized ? (
              <Maximize2 className="h-4 w-4" />
            ) : (
              <Minimize2 className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onClose}
            aria-label="Close scope visualization"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {!isMinimized && (
        <div ref={containerRef} className="flex-1 overflow-hidden rounded-b-lg" style={{ minHeight: 0 }}>
          {/* Canvas will be inserted here by the effect */}
          {/* Ensure container is ready before scope is evaluated */}
        </div>
      )}
    </div>
  )
}

