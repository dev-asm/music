'use client'

import { useEffect, useRef } from 'react'
import { getAudioContext, connectToDestination } from 'superdough'
import type Hydra from 'hydra-synth'

type UnknownRecord = Record<string, unknown>

export type MiniLocation = [number, number]

export type SliderWidgetConfig = {
  type: 'slider'
  from: number
  to: number
  value: string
  min: number
  max: number
  step?: number
}

export type GenericWidgetConfig = {
  type: string
  to: number
  index?: number
  id?: string
  from?: number
  value?: string
  min?: number
  max?: number
  step?: number
}

export type StrudelWidget = SliderWidgetConfig | GenericWidgetConfig

export interface EngineState {
  isReady: boolean
  isPlaying: boolean
  isEvaluating: boolean
  bpm: number
  audioUnlocked: boolean
  samplesLoaded: boolean
  isLoadingSamples: boolean
  miniLocations: MiniLocation[]
  activeLocations: MiniLocation[]
  sampleBanks: SampleBankState[]
  lastEvaluatedAt?: number
  error?: string
  widgets: StrudelWidget[]
}

export type SampleBankSource = string | UnknownRecord

export type SampleBankStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface SampleBankState {
  id: string
  label: string
  status: SampleBankStatus
  source: SampleBankSource
  sourceSummary: string
  error?: string
  loadedAt?: number
  meta?: {
    baseUrl?: string
    tag?: string
    prebake?: () => unknown
    bankPrefix?: string
    bankAliases?: string[]
  }
}

export interface SampleBankOptions {
  id?: string
  label?: string
  baseUrl?: string
  tag?: string
  prebake?: () => unknown
  bankPrefix?: string
  bankAliases?: string[]
}

type Listener = (state: EngineState) => void

type EvaluateOptions = {
  autostart?: boolean
  hush?: boolean
}

type StrudelCore = UnknownRecord & {
  evalScope: (...modules: unknown[]) => Promise<unknown>
  repl: (options: UnknownRecord) => {
    setCps: (cps: number) => void
    evaluate: (code: string, autostart?: boolean, hush?: boolean) => Promise<unknown>
    setCode?: (code: string) => void
    start: () => void
    pause: () => void
    stop: () => void
    toggle: () => void
  }
  noteToMidi?: (value: string) => number
}

type StrudelWebAudio = UnknownRecord & {
  webaudioOutput: (...args: unknown[]) => unknown
  webaudioRepl: (options: UnknownRecord) => ReturnType<StrudelCore['repl']>
  samples?: (...args: unknown[]) => Promise<unknown>
  doughsamples?: (...args: unknown[]) => Promise<unknown>
  initAudioOnFirstClick?: (...args: unknown[]) => Promise<unknown>
  registerSynthSounds?: (...args: unknown[]) => Promise<unknown>
  getAudioContext?: () => AudioContext
}

type StrudelWeb = UnknownRecord

type Transpiler = (code: string, options?: UnknownRecord) => unknown

type StrudelReplState = {
  miniLocations?: Array<[number, number]>
  started?: boolean
  pending?: boolean
  evalError?: unknown
  schedulerError?: unknown
  widgets?: StrudelWidget[]
} & Record<string, unknown>

interface HapLike {
  context?: {
    locations?: Array<{ start: number; end: number }>
  }
}

const DEFAULT_BPM = 40
const DIRT_SAMPLE_SOURCE = 'github:tidalcycles/dirt-samples'
const DEFAULT_SAMPLE_BANK = '/sample-banks/default.json'
const LOCAL_SAMPLE_BANK = '/sample-banks/local.json'
export type StrudelEngineOptions = {
  autoRun?: boolean
}

class InlineVisualManager {
  private container: HTMLElement | null = null
  private pending: Array<{ ctx: CanvasRenderingContext2D }> = []

  setContainer(container: HTMLElement | null) {
    this.container = container
    this.reset()
  }

  reset() {
    this.pending = []
    if (this.container) {
      this.container.innerHTML = ''
    }
  }

  enqueue(kind: 'punchcard' | 'scope', options: UnknownRecord = {}) {
    if (!this.container || typeof document === 'undefined') {
      return null
    }
    const wrapper = document.createElement('div')
    wrapper.className = `strudel-visual strudel-visual--${kind}`
    wrapper.style.width = '100%'
    wrapper.style.marginTop = '1rem'
    wrapper.style.borderRadius = 'var(--radius)'
    wrapper.style.background = 'var(--card)'
    wrapper.style.border = '1px solid var(--border)'
    const defaultHeight = kind === 'scope' ? 160 : 220
    const height = Number.isFinite(Number(options?.height))
      ? Number(options?.height)
      : defaultHeight
    wrapper.style.height = `${Math.max(40, height)}px`
    wrapper.style.position = 'relative'
    wrapper.style.overflow = 'hidden'

    const canvas = document.createElement('canvas')
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    wrapper.appendChild(canvas)
    this.container.appendChild(wrapper)

    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      wrapper.remove()
      return null
    }

    const resize = () => {
      const rect = wrapper.getBoundingClientRect()
      const dpr = window.devicePixelRatio ?? 1
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      ctx.resetTransform?.()
      ctx.scale(dpr, dpr)
    }

    resize()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => resize())
      observer.observe(wrapper)
    }
    this.pending.push({ ctx })
    return ctx
  }

  consume() {
    return this.pending.shift()?.ctx ?? null
  }
}

export class StrudelEngine {
  private listeners = new Set<Listener>()

  public autoRun: boolean

  private state: EngineState = {
    isReady: false,
    isPlaying: false,
    isEvaluating: false,
    bpm: DEFAULT_BPM,
    audioUnlocked: false,
    samplesLoaded: false,
    isLoadingSamples: false,
    miniLocations: [],
    activeLocations: [],
    sampleBanks: [],
    widgets: [],
  }

  private core?: StrudelCore
  private webaudio?: StrudelWebAudio
  private web?: StrudelWeb
  private draw?: UnknownRecord
  private repl?: ReturnType<StrudelCore['repl']>
  private transpiler?: Transpiler
  private hydra?: Hydra
  private hydraScopeCanvas?: HTMLCanvasElement
  private scopeContainerElement?: HTMLElement | null
  private audioSplitterGain?: GainNode
  private audioRoutingPatched = false
  private reapplyScopeInterception?: () => void

  private readyPromise?: Promise<void>
  private audioInitPromise?: Promise<void>
  private sampleLoadPromise?: Promise<void>
  private sampleLoadingCount = 0
  private sampleBankPromises = new Map<string, Promise<SampleBankState>>()
  private sampleBankRegistry = new Map<string, SampleBankState>()
  private activeMap = new Map<string, { range: MiniLocation; count: number }>()
  private inlineVisuals = new InlineVisualManager()

  constructor(options: StrudelEngineOptions = {}) {
    this.autoRun = options.autoRun ?? true
  }

  setVisualContainer(element: HTMLElement | null) {
    this.inlineVisuals.setContainer(element)
    ;(globalThis as UnknownRecord).__strudelInlineVisuals = this.inlineVisuals
  }

  async setScopeContainer(element: HTMLElement | null) {
    // Set a dedicated container for scope visualization using Hydra
    // This allows scope to render to a dedicated window instead of inline
    this.scopeContainerElement = element
    
    if (element) {
      // Initialize Hydra if not already initialized
      if (!this.hydra) {
        try {
          const HydraModule = await import('hydra-synth')
          const Hydra = (HydraModule.default || HydraModule) as typeof import('hydra-synth').default
          
          // Get container dimensions
          const rect = element.getBoundingClientRect()
          const dpr = window.devicePixelRatio ?? 1
          const width = Math.max(1, Math.floor(rect.width * dpr))
          const height = Math.max(1, Math.floor(rect.height * dpr))
          
          // Create canvas for Hydra to use
          const canvas = document.createElement('canvas')
          canvas.style.display = 'block'
          canvas.style.width = '100%'
          canvas.style.height = '100%'
          canvas.style.background = 'var(--card)'
          canvas.width = width
          canvas.height = height
          element.appendChild(canvas)
          this.hydraScopeCanvas = canvas
          
          // Initialize Hydra with the canvas
          // detectAudio: false - we'll manually connect Strudel's audio to Hydra's analyser
          // makeGlobal: true exposes Hydra functions (osc, fft, out, etc.) globally
          // autoLoop: true automatically updates the visualization
          this.hydra = new Hydra({
            detectAudio: false, // We manually connect audio instead of using microphone
            makeGlobal: true, // Expose functions globally (osc, fft, out, etc.)
            autoLoop: true, // Auto-update visualization
            canvas: canvas,
            width: width,
            height: height,
          })
          
          // Expose Hydra globally for Strudel patterns to use
          ;(globalThis as UnknownRecord).hydra = this.hydra
          
          // Set up audio connection from Strudel to Hydra's analyser
          this.setupHydraAudioConnection()
          
          if (process.env.NODE_ENV !== 'production') {
            const audioContext = getAudioContext()
            console.log('[StrudelEngine] Hydra initialized - verify detectAudio is working', {
              hasAudioContext: !!audioContext,
              audioContextState: audioContext?.state,
            })
          }
          
          // Ensure Hydra's global functions are available
          // Hydra should expose these automatically with makeGlobal: true, but let's verify
          if (process.env.NODE_ENV !== 'production') {
            console.log('[StrudelEngine] Hydra initialized with scope canvas', {
              hydra: !!this.hydra,
              fft: typeof (globalThis as UnknownRecord).fft,
              osc: typeof (globalThis as UnknownRecord).osc,
              out: typeof (globalThis as UnknownRecord).out,
            })
          }
        } catch (error) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn('[StrudelEngine] Failed to initialize Hydra:', error)
          }
          return
        }
      }
      
      // Hydra already exists, find its canvas and move it to the container
      if (this.hydra && !this.hydraScopeCanvas) {
        const hydraSynth = (this.hydra as unknown as { synth: UnknownRecord }).synth
        const hydraOutput = (hydraSynth as unknown as { output: UnknownRecord }).output
        if (hydraOutput) {
          const regl = (hydraOutput as unknown as { regl: UnknownRecord }).regl
          if (regl && (regl as unknown as { _gl: { canvas: HTMLCanvasElement } })._gl) {
            const hydraCanvas = (regl as unknown as { _gl: { canvas: HTMLCanvasElement } })._gl.canvas
            if (hydraCanvas) {
              // Move Hydra's canvas to the container if it's not already there
              if (hydraCanvas.parentNode !== element) {
                if (hydraCanvas.parentNode) {
                  hydraCanvas.parentNode.removeChild(hydraCanvas)
                }
                element.appendChild(hydraCanvas)
              }
              this.hydraScopeCanvas = hydraCanvas
            }
          }
        }
      } else if (this.hydraScopeCanvas) {
        // Canvas already exists, ensure it's in the container
        if (this.hydraScopeCanvas.parentNode !== element) {
          if (this.hydraScopeCanvas.parentNode) {
            this.hydraScopeCanvas.parentNode.removeChild(this.hydraScopeCanvas)
          }
          element.appendChild(this.hydraScopeCanvas)
        }
      }
      
      // Update canvas size
      if (this.hydraScopeCanvas) {
          const resize = () => {
            if (!this.hydraScopeCanvas || !element) return
            const rect = element.getBoundingClientRect()
            const dpr = window.devicePixelRatio ?? 1
            this.hydraScopeCanvas.width = Math.max(1, Math.floor(rect.width * dpr))
            this.hydraScopeCanvas.height = Math.max(1, Math.floor(rect.height * dpr))
            
            // Update Hydra resolution if possible
            if (this.hydra) {
              const hydraSynth = (this.hydra as unknown as { synth: UnknownRecord }).synth
              if (hydraSynth && typeof (hydraSynth as unknown as { setResolution: (w: number, h: number) => void }).setResolution === 'function') {
                const setResolution = (hydraSynth as unknown as { setResolution: (w: number, h: number) => void }).setResolution
                setResolution(this.hydraScopeCanvas.width, this.hydraScopeCanvas.height)
              }
            }
          }
          
          resize()
          if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver(() => resize())
            observer.observe(element)
          }
        }
    } else if (!element && this.hydraScopeCanvas && this.hydraScopeCanvas.parentNode) {
      // Clean up canvas when container is removed
      this.hydraScopeCanvas.parentNode.removeChild(this.hydraScopeCanvas)
    }
  }

  setAutoRun(enabled: boolean) {
    this.autoRun = enabled
  }

  getState() {
    return this.state
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    listener(this.state)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async init() {
    if (this.readyPromise) {
      return this.readyPromise
    }
    if (typeof window === 'undefined') {
      throw new Error('StrudelEngine can only be initialised in a browser environment')
    }

    // Use a module-level cache to ensure @strudel/core is only loaded once
    // even if multiple engine instances are created
    const moduleCache = (globalThis as UnknownRecord).__strudelModuleCache as {
      core?: StrudelCore
      miniModule?: UnknownRecord
      tonalModule?: UnknownRecord
      xenModule?: UnknownRecord
      drawModule?: UnknownRecord
      webaudioModule?: StrudelWebAudio
      webModule?: StrudelWeb
      transpilerModuleRaw?: UnknownRecord
      loadPromise?: Promise<void>
    } | undefined

    if (!moduleCache) {
      ;(globalThis as UnknownRecord).__strudelModuleCache = {}
    }
    const cache = (globalThis as UnknownRecord).__strudelModuleCache as {
      core?: StrudelCore
      miniModule?: UnknownRecord
      tonalModule?: UnknownRecord
      xenModule?: UnknownRecord
      drawModule?: UnknownRecord
      webaudioModule?: StrudelWebAudio
      webModule?: StrudelWeb
      transpilerModuleRaw?: UnknownRecord
      loadPromise?: Promise<void>
    }

    // If modules are already cached, use them
    if (cache.core && cache.miniModule && cache.tonalModule && cache.xenModule && 
        cache.drawModule && cache.webaudioModule && cache.webModule && cache.transpilerModuleRaw) {
      this.webaudio = cache.webaudioModule
      this.web = cache.webModule
      this.core = cache.core
      this.draw = cache.drawModule
      const transpilerExports = cache.transpilerModuleRaw as UnknownRecord
      let transpilerFn: unknown = transpilerExports.transpiler
      if (typeof transpilerFn !== 'function') {
        const defaultExport = transpilerExports.default as UnknownRecord | undefined
        transpilerFn = defaultExport?.transpiler
      }
      if (typeof transpilerFn !== 'function') {
        throw new Error('Failed to load Strudel transpiler')
      }
      this.transpiler = transpilerFn as Transpiler
      
      // Still need to call evalScope for this instance
      await cache.core.evalScope(
        cache.core, 
        cache.miniModule, 
        cache.tonalModule, 
        cache.xenModule, 
        cache.drawModule, 
        cache.webaudioModule, 
        cache.webModule
      )
      
      // Continue with initialization...
      this.readyPromise = Promise.resolve()
      return this.readyPromise
    }

    // If modules are being loaded by another instance, wait for that
    if (cache.loadPromise) {
      await cache.loadPromise
      // After waiting, modules should be cached
      if (cache.core && cache.miniModule && cache.tonalModule && cache.xenModule && 
          cache.drawModule && cache.webaudioModule && cache.webModule && cache.transpilerModuleRaw) {
        this.webaudio = cache.webaudioModule
        this.web = cache.webModule
        this.core = cache.core
        this.draw = cache.drawModule
        const transpilerExports = cache.transpilerModuleRaw as UnknownRecord
        let transpilerFn: unknown = transpilerExports.transpiler
        if (typeof transpilerFn !== 'function') {
          const defaultExport = transpilerExports.default as UnknownRecord | undefined
          transpilerFn = defaultExport?.transpiler
        }
        if (typeof transpilerFn !== 'function') {
          throw new Error('Failed to load Strudel transpiler')
        }
        this.transpiler = transpilerFn as Transpiler
        
        await cache.core.evalScope(
          cache.core, 
          cache.miniModule, 
          cache.tonalModule, 
          cache.xenModule, 
          cache.drawModule, 
          cache.webaudioModule, 
          cache.webModule
        )
        
        this.readyPromise = Promise.resolve()
        return this.readyPromise
      }
    }

    // Load modules for the first time and cache them
    cache.loadPromise = (async () => {
      const [
        core,
        miniModule,
        tonalModule,
        xenModule,
        drawModule,
        webaudioModule,
        webModule,
        transpilerModuleRaw,
      ] = (await Promise.all([
        import('@strudel/core'),
        import('@strudel/mini'),
        import('@strudel/tonal'),
        import('@strudel/xen'),
        import('@strudel/draw'),
        import('@strudel/webaudio'),
        import('@strudel/web'),
        import('@strudel/transpiler'),
      ])) as unknown as [
        StrudelCore,
        UnknownRecord,
        UnknownRecord,
        UnknownRecord,
        UnknownRecord,
        StrudelWebAudio,
        StrudelWeb,
        UnknownRecord
      ]

      // Cache the modules
      cache.core = core
      cache.miniModule = miniModule
      cache.tonalModule = tonalModule
      cache.xenModule = xenModule
      cache.drawModule = drawModule
      cache.webaudioModule = webaudioModule
      cache.webModule = webModule
      cache.transpilerModuleRaw = transpilerModuleRaw
    })()

    this.readyPromise = (async () => {
      await cache.loadPromise

      const core = cache.core!
      const miniModule = cache.miniModule!
      const tonalModule = cache.tonalModule!
      const xenModule = cache.xenModule!
      const drawModule = cache.drawModule!
      const webaudioModule = cache.webaudioModule!
      const webModule = cache.webModule!
      const transpilerModuleRaw = cache.transpilerModuleRaw!

      this.webaudio = webaudioModule
      this.web = webModule
      this.core = core
      this.draw = drawModule
      const transpilerExports = transpilerModuleRaw as UnknownRecord
      let transpilerFn: unknown = transpilerExports.transpiler
      if (typeof transpilerFn !== 'function') {
        const defaultExport = transpilerExports.default as UnknownRecord | undefined
        transpilerFn = defaultExport?.transpiler
      }
      if (typeof transpilerFn !== 'function') {
        throw new Error('Failed to load Strudel transpiler')
      }
      this.transpiler = transpilerFn as Transpiler

      await core.evalScope(core, miniModule, tonalModule, xenModule, drawModule, webaudioModule, webModule)

      // Hydra will be initialized lazily when scope container is set
      // This ensures Hydra's canvas is created in the correct container
      // Expose initHydra function globally for Strudel patterns
      // This allows patterns to call initHydra() to initialize Hydra
      ;(globalThis as UnknownRecord).initHydra = async (options?: UnknownRecord) => {
        // If Hydra is already initialized, return it
        if (this.hydra) {
          return this.hydra
        }
        
        // If scope container exists, Hydra should already be initialized by setScopeContainer
        // Don't create a new instance - wait for setScopeContainer to be called
        if (this.scopeContainerElement && this.hydraScopeCanvas) {
          if (process.env.NODE_ENV !== 'production') {
            console.log('[StrudelEngine] initHydra() called but scope container exists - Hydra should be initialized by setScopeContainer')
          }
          // Return null to indicate Hydra will be initialized later
          return null
        }
        
        // Otherwise initialize with options
        // detectAudio: false - we manually connect Strudel's audio to Hydra's analyser
        try {
          const HydraModule = await import('hydra-synth')
          const Hydra = (HydraModule.default || HydraModule) as typeof import('hydra-synth').default
          const opts = { 
            detectAudio: false, // We manually connect audio instead of using microphone
            makeGlobal: true, // Expose functions globally (osc, fft, out, etc.)
            autoLoop: true, // Auto-update visualization
            ...options 
          }
          this.hydra = new Hydra(opts)
          ;(globalThis as UnknownRecord).hydra = this.hydra
          // Set up audio connection if audio is already initialized
          this.setupHydraAudioConnection()
          if (process.env.NODE_ENV !== 'production') {
            console.log('[StrudelEngine] Hydra initialized via initHydra()')
          }
          return this.hydra
        } catch (error) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn('[StrudelEngine] Failed to initialize Hydra:', error)
          }
          throw error
        }
      }
      
      // Expose H() function globally for Strudel patterns to use Hydra
      // H() allows passing Strudel patterns as inputs to Hydra
      // Example: H(note("c3 e3 g3").fast(2))
      // Note: This is a basic implementation - full H() would convert patterns to Hydra inputs
      ;(globalThis as UnknownRecord).H = (pattern: unknown) => {
        if (!this.hydra) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn('[StrudelEngine] H() called but Hydra not initialized. Call initHydra() first.')
          }
          return pattern
        }
        // Basic H() implementation - returns pattern as-is
        // Full implementation would convert Strudel pattern to Hydra input
        if (process.env.NODE_ENV !== 'production') {
          console.log('[StrudelEngine] H() function called (basic implementation)')
        }
        return pattern
      }

      type PatternPrototype = UnknownRecord & {
        punchcard?: (options?: UnknownRecord) => unknown
        _punchcard?: (options?: UnknownRecord) => unknown
        scope?: (options?: UnknownRecord) => unknown
        _scope?: (options?: UnknownRecord) => unknown
      }
      const patternCtor = (core as UnknownRecord)?.Pattern as { prototype?: PatternPrototype } | undefined
      const patternProto = patternCtor?.prototype
      if (patternProto) {
        const basePunchcard = patternProto.punchcard
        if (typeof patternProto._punchcard !== 'function' && typeof basePunchcard === 'function') {
          patternProto._punchcard = function inlinePunchcard(this: UnknownRecord, options?: UnknownRecord) {
            const inlineManager = (globalThis as UnknownRecord).__strudelInlineVisuals as InlineVisualManager | undefined
            const ctx = inlineManager?.enqueue('punchcard', options)
            const nextOptions = ctx ? { ...(options ?? {}), ctx } : options
            return basePunchcard.call(this, nextOptions)
          }
        }
        // Intercept both scope and _scope methods (similar to punchcard/_punchcard pattern)
        const baseScope = patternProto.scope
        const baseScopeUnderscore = patternProto._scope
        
        if (process.env.NODE_ENV !== 'production') {
          console.log('[StrudelEngine] Setting up scope interception', {
            hasBaseScope: typeof baseScope === 'function',
            hasBaseScopeUnderscore: typeof baseScopeUnderscore === 'function',
            patternProtoKeys: Object.keys(patternProto).slice(0, 10),
            baseScopeType: typeof baseScope,
          })
        }
        
        // Create a shared scope handler function
        const engineInstance = this
        const createScopeHandler = (originalScope: ((options?: UnknownRecord) => unknown) | undefined) => {
          return function inlineScope(this: UnknownRecord, options?: UnknownRecord) {
            // ULTRA CRITICAL LOG - this should ALWAYS appear if our interception is being called
            console.log('🔴 [StrudelEngine] SCOPE INTERCEPTED HANDLER CALLED!')
            
            if (process.env.NODE_ENV !== 'production') {
              console.log('[StrudelEngine] .scope() called', {
                hasHydra: !!engineInstance.hydra,
                scopeContainerSet: engineInstance.scopeContainerElement !== undefined && engineInstance.scopeContainerElement !== null,
                thisKeys: Object.keys(this).slice(0, 10),
                options,
              })
            }
            
            // Ensure time source is set before calling scope
            engineInstance.setupScopeTimeSource()
            
            // Check if scope container is set (which means Hydra should be used)
            const scopeContainerSet = engineInstance.scopeContainerElement !== undefined && engineInstance.scopeContainerElement !== null
            
            // Try to initialize Hydra if scope container is set but Hydra isn't initialized yet
            if (scopeContainerSet && !engineInstance.hydra) {
              if (process.env.NODE_ENV !== 'production') {
                console.log('[StrudelEngine] Scope container set but Hydra not initialized, attempting to initialize')
              }
              // Scope container is set, so Hydra should be initialized
              // This will happen asynchronously, but we'll still try to use Hydra
              const initHydraFn = (globalThis as UnknownRecord).initHydra as ((options?: UnknownRecord) => Promise<unknown>) | undefined
              if (initHydraFn) {
                initHydraFn().catch(() => {
                  // Ignore errors, will fall back to canvas-based scope
                })
              }
            }
            
            // Use Hydra for scope visualization if available
            if (engineInstance.hydra) {
              if (process.env.NODE_ENV !== 'production') {
                console.log('[StrudelEngine] Using Hydra for scope visualization')
              }
              const analyserId = typeof options?.id === 'number' ? options.id : 1
              
              // Ensure pattern is analyzed to connect to audio
              const patternWithAnalyze = this as UnknownRecord & { analyze?: (id: number) => unknown }
              let analyzedPattern: unknown = this
              if (patternWithAnalyze.analyze) {
                analyzedPattern = patternWithAnalyze.analyze(analyserId)
              }
              
              // Note: We don't create Hydra visualizations for scope
              // The scope should show the actual oscilloscope waveform (jagged line),
              // not a colorful Hydra pattern. We'll use the original scope method below.
            }
            
            // Only fallback to canvas-based scope if Hydra is not available AND scope container is not set
            // If scope container is set, we should use Hydra (even if it's not initialized yet)
            if (!scopeContainerSet) {
              const inlineManager = (globalThis as UnknownRecord).__strudelInlineVisuals as InlineVisualManager | undefined
              const ctx = inlineManager?.enqueue('scope', options)
              
              // Ensure we have a valid analyser ID (default to 1)
              const analyserId = options?.id ?? 1
              
              // Merge canvas context into options if available
              const nextOptions = ctx 
                ? { 
                    ...(options ?? {}), 
                    ctx,
                    id: analyserId,
                  } 
                : { 
                    ...(options ?? {}),
                    id: analyserId,
                  }
              
              // Call the base scope method which will call .analyze(id).draw(...)
              // This connects the pattern to the analyser and sets up the animation loop
              if (originalScope) {
                return originalScope.call(this, nextOptions)
              }
              return this
            }
            
            // If scope container is set, we should still draw the actual oscilloscope waveform
            // The Hydra visualization was just a colorful pattern, not the actual scope
            // We need to call the original scope method to draw the waveform on canvas
            
            // Use the original scope implementation which draws the actual waveform
            if (originalScope) {
              // When scope container is set, get the canvas from the Hydra instance
              // and draw ONLY in the popup window (never inline)
              // When scope container is NOT set, use the inline manager for inline visualizations
              let ctx: CanvasRenderingContext2D | undefined
              
              if (scopeContainerSet) {
                // Hydra's WebGL canvas should already be in the scope container
                // We create a 2D canvas layered on top for the oscilloscope waveform
                let scopeCanvas = engineInstance.scopeContainerElement?.querySelector('canvas.scope-waveform') as HTMLCanvasElement | null
                
                if (!scopeCanvas) {
                  // Create a 2D canvas for the oscilloscope waveform, layered on top of Hydra
                  scopeCanvas = document.createElement('canvas')
                  scopeCanvas.className = 'scope-waveform'
                  scopeCanvas.style.position = 'absolute'
                  scopeCanvas.style.top = '0'
                  scopeCanvas.style.left = '0'
                  scopeCanvas.style.width = '100%'
                  scopeCanvas.style.height = '100%'
                  scopeCanvas.style.pointerEvents = 'none' // Allow clicks through to Hydra
                  
                  // Match the resolution of the container/Hydra canvas
                  if (engineInstance.scopeContainerElement) {
                    const rect = engineInstance.scopeContainerElement.getBoundingClientRect()
                    scopeCanvas.width = rect.width
                    scopeCanvas.height = rect.height
                  } else {
                    scopeCanvas.width = 800
                    scopeCanvas.height = 600
                  }
                  
                  // Add the canvas to the scope container (on top of Hydra's canvas)
                  engineInstance.scopeContainerElement?.appendChild(scopeCanvas)
                  
                  if (process.env.NODE_ENV !== 'production') {
                    console.log('[StrudelEngine] Created scope waveform canvas (layered on Hydra):', {
                      width: scopeCanvas.width,
                      height: scopeCanvas.height,
                    })
                  }
                }
                
                // Get the 2D context
                const canvasCtx = scopeCanvas.getContext('2d')
                if (canvasCtx) {
                  ctx = canvasCtx
                  if (process.env.NODE_ENV !== 'production') {
                    console.log('[StrudelEngine] Got 2D context for scope waveform:', {
                      canvasWidth: scopeCanvas.width,
                      canvasHeight: scopeCanvas.height,
                    })
                  }
                }
                
                // IMPORTANT: We MUST call originalScope even if ctx is undefined
                // The original scope method does TWO things:
                // 1. Calls .analyze(id) which creates the superdough analysers (CRITICAL!)
                // 2. Calls .draw() which sets up the drawing loop
                // If we don't call it, analysers never get created and scope won't work at all
                // If ctx is undefined, the draw callback will just draw a horizontal line until canvas is ready
              } else {
                // If scope container is NOT set, use inline manager for inline visualizations
                const inlineManager = (globalThis as UnknownRecord).__strudelInlineVisuals as InlineVisualManager | undefined
                const inlineCtx = inlineManager?.enqueue('scope', options)
                ctx = inlineCtx ?? undefined
              }
              
              // Ensure we have a valid analyser ID (default to 1)
              const analyserId = options?.id ?? 1
              
              // Merge canvas context into options if available
              // Even if ctx is undefined, we still pass it - the original scope will handle it
              const nextOptions = ctx 
                ? { 
                    ...(options ?? {}), 
                    ctx,
                    id: analyserId,
                  } 
                : { 
                    ...(options ?? {}),
                    id: analyserId,
                  }
              
              // ALWAYS call the original scope method
              // This ensures .analyze(id) is called, which creates the superdough analysers
              // The drawing will work once the canvas is ready
              if (process.env.NODE_ENV !== 'production') {
                console.log('[StrudelEngine] Calling original scope with options:', {
                  hasCtx: !!(nextOptions as { ctx?: CanvasRenderingContext2D }).ctx,
                  ctxCanvas: (nextOptions as { ctx?: CanvasRenderingContext2D }).ctx?.canvas,
                  canvasWidth: (nextOptions as { ctx?: CanvasRenderingContext2D }).ctx?.canvas?.width,
                  canvasHeight: (nextOptions as { ctx?: CanvasRenderingContext2D }).ctx?.canvas?.height,
                  analyserId: (nextOptions as { id?: number }).id,
                  scopeContainerSet,
                })
              }
              return originalScope.call(this, nextOptions)
            }
            
            // Fallback if no original scope method is available
            return this
          }
        }
        
        // Save the interception function for later re-application
        // This is needed because @strudel/core loads multiple times and overwrites our interception
        if (process.env.NODE_ENV !== 'production') {
          console.log('[StrudelEngine] Creating reapplyScopeInterception function')
        }
        this.reapplyScopeInterception = () => {
          // CRITICAL: We need to intercept the GLOBAL Pattern, not just the imported one
          // Patterns created by the REPL use the global Pattern constructor
          const GlobalPattern = (globalThis as UnknownRecord).Pattern as UnknownRecord | undefined
          const ImportedPattern = (core as UnknownRecord).Pattern as UnknownRecord | undefined
          
          // Intercept both the global and imported Pattern (they might be different!)
          const patternsToIntercept = [
            { name: 'Global', Pattern: GlobalPattern },
            { name: 'Imported', Pattern: ImportedPattern }
          ].filter(p => p.Pattern)
          
          if (process.env.NODE_ENV !== 'production') {
            console.log('[StrudelEngine] reapplyScopeInterception - found patterns:', patternsToIntercept.map(p => p.name))
          }
          
          patternsToIntercept.forEach(({ name, Pattern }) => {
            if (!Pattern) return
            const patternProto = Pattern.prototype as UnknownRecord
            const currentScope = patternProto.scope as (options?: UnknownRecord) => unknown
            
            // Check if current scope has our marker property
            // This is more reliable than comparing function references which fail across prototype replacements
            const isOurInterception = !!(currentScope as unknown as UnknownRecord)?.__strudelEngineIntercepted
          
            if (process.env.NODE_ENV !== 'production') {
              console.log(`[StrudelEngine] Checking ${name} Pattern:`, {
                hasPattern: !!Pattern,
                currentScopeType: typeof currentScope,
                isOurInterception,
                scopeFunctionStart: typeof currentScope === 'function' ? currentScope.toString().substring(0, 100) : 'not a function',
              })
            }
            
            // Only re-intercept if the current scope is NOT our intercepted version
            if (typeof currentScope === 'function' && !isOurInterception) {
              if (process.env.NODE_ENV !== 'production') {
                console.log(`[StrudelEngine] ${name} Pattern scope is NOT our interception, re-intercepting...`)
              }
              // Create and store our intercepted version
              const interceptedScope = createScopeHandler(currentScope)
              // Mark it as our interception so we can detect it later
              ;(interceptedScope as unknown as UnknownRecord).__strudelEngineIntercepted = true
              patternProto.scope = interceptedScope
              
              if (process.env.NODE_ENV !== 'production') {
                console.log(`[StrudelEngine] Re-applied scope interception to ${name} Pattern successfully`)
                console.log(`[StrudelEngine] Verification - ${name} Pattern.prototype.scope is now:`, typeof patternProto.scope === 'function' ? (patternProto.scope as (opts?: unknown) => unknown).toString().substring(0, 100) : 'not a function')
              }
            } else if (process.env.NODE_ENV !== 'production') {
              console.log(`[StrudelEngine] ${name} Pattern scope already intercepted, skipping`)
            }
          })
        }
        
        // CRITICAL: Intercept BOTH the imported Pattern AND the global Pattern
        // The REPL uses the global Pattern, not the imported one!
        const patternsToIntercept = [
          { name: 'Imported', proto: patternProto },
          { name: 'Global', proto: ((globalThis as UnknownRecord).Pattern as UnknownRecord | undefined)?.prototype as UnknownRecord | undefined }
        ].filter(p => p.proto)
        
        patternsToIntercept.forEach(({ name, proto }) => {
          if (!proto) return
          // Intercept _scope if it doesn't exist (similar to _punchcard pattern)
          if (typeof proto._scope !== 'function' && typeof baseScope === 'function') {
            const interceptedUnderscoreScope = createScopeHandler(baseScope)
            ;(interceptedUnderscoreScope as unknown as UnknownRecord).__strudelEngineIntercepted = true
            proto._scope = interceptedUnderscoreScope
            if (process.env.NODE_ENV !== 'production') {
              console.log(`[StrudelEngine] Intercepted _scope method on ${name} Pattern`)
            }
          }
          
          // Also override scope method directly to ensure it's always intercepted
          if (typeof baseScope === 'function') {
            const interceptedScope = createScopeHandler(baseScope)
            // Mark it as our interception so we can detect it later
            ;(interceptedScope as unknown as UnknownRecord).__strudelEngineIntercepted = true
            proto.scope = interceptedScope
            if (process.env.NODE_ENV !== 'production') {
              console.log(`[StrudelEngine] Intercepted scope method on ${name} Pattern`)
              console.log(`[StrudelEngine] Verification - ${name} Pattern.prototype.scope is now:`, (proto.scope as (opts?: unknown) => unknown).toString().substring(0, 100))
              console.log(`[StrudelEngine] Verification - Same as interceptedScope?`, proto.scope === interceptedScope)
            }
          }
        })
        
        // Expose Pattern and engine instance globally for debugging
        // This allows us to verify we're intercepting the same Pattern that's being used
        const PatternConstructor = (core as UnknownRecord).Pattern as UnknownRecord
        ;(globalThis as UnknownRecord).__strudelPattern = PatternConstructor
        ;(globalThis as UnknownRecord).__strudelEngine = engineInstance
        if (process.env.NODE_ENV !== 'production') {
          console.log('[StrudelEngine] Exposed Pattern globally as __strudelPattern')
          console.log('[StrudelEngine] Exposed engine instance globally as __strudelEngine')
          console.log('[StrudelEngine] reapplyScopeInterception exists?', !!engineInstance.reapplyScopeInterception)
        }
        
        // CRITICAL: @strudel/core loads multiple times due to bundler/HMR
        // The loads overwrite our interception at unpredictable times
        // Solution: Re-intercept multiple times with increasing delays
        const delays = [100, 200, 500, 1000]
        delays.forEach(delay => {
          setTimeout(() => {
            if (process.env.NODE_ENV !== 'production') {
              console.log(`[StrudelEngine] setTimeout fired after ${delay}ms`)
              console.log(`[StrudelEngine] reapplyScopeInterception exists?`, !!engineInstance.reapplyScopeInterception)
            }
            engineInstance.reapplyScopeInterception?.()
          }, delay)
        })
      }

      const baseOutput = webaudioModule.webaudioOutput

      const highlightOutput = async (
        hap: HapLike,
        deadline: number,
        duration: number,
        cps: number,
        scheduled: number,
      ) => {
        await this.ensureAudio()
        await this.loadSamples(DIRT_SAMPLE_SOURCE)
        this.sendHighlights(hap, duration)
        // Call baseOutput to output audio
        // Audio routing to Hydra's analyser is handled by patchAudioRouting()
        const result = await baseOutput(hap as unknown, deadline, duration, cps, scheduled)
        return result
      }

      this.repl = webaudioModule.webaudioRepl({
        defaultOutput: highlightOutput,
        beforeStart: () => this.ensureAudio(),
        transpiler: this.transpiler,
        onUpdateState: (next: StrudelReplState) => this.handleStateUpdate(next),
        onEvalError: (err: unknown) => this.handleEvalError(err),
        afterEval: () => {
          if (process.env.NODE_ENV !== 'production') {
            console.log('[StrudelEngine] afterEval called, checking scope interception')
          }
          // Always check and re-apply scope interception after eval
          // This catches cases where @strudel/core reloads between evals
          this.reapplyScopeInterception?.()

          this.setState({ lastEvaluatedAt: Date.now() })
          // The .scope() method will handle its own visualization by drawing the waveform on canvas
          // We don't need to trigger any Hydra visualization here
        },
        id: 'next-strudel-repl',
      })

      // Set up time source after REPL is created (REPL sets its own time source, but we need audio context time for scope)
      this.setupScopeTimeSource()

      this.repl.setCps(this.state.bpm / 60)
      this.setState({ isReady: true })
      
      // Load bundled sample banks asynchronously (non-blocking)
      // We do this after setting isReady to avoid blocking initialization
      this.loadBundledSampleBank(DEFAULT_SAMPLE_BANK).catch((error) => {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('Failed to load default sample bank:', error)
        }
      })
      this.loadBundledSampleBank(LOCAL_SAMPLE_BANK).catch((error) => {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('Failed to load local sample bank:', error)
        }
      })
    })()

    return this.readyPromise
  }

  async evaluate(code: string, options: EvaluateOptions = {}) {
    if (!code.trim()) {
      this.stop()
      return
    }
    await this.init()
    if (!this.repl) {
      throw new Error('Strudel REPL is not ready')
    }
    const { autostart = true, hush = true } = options
    this.setState({ error: undefined })
    this.inlineVisuals.reset()
    this.repl.setCode?.(code)
    try {
      await this.repl.evaluate(code, autostart, hush)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setState({ error: message })
      throw error
    }
  }

  togglePlayback() {
    this.repl?.toggle()
  }

  async start() {
    await this.init()
    await this.ensureAudio()
    await this.loadSamples(DIRT_SAMPLE_SOURCE)
    try {
      this.repl?.start()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setState({ error: message })
      throw error
    }
  }

  pause() {
    this.repl?.pause()
  }

  stop() {
    this.repl?.stop()
    this.clearActiveLocations()
  }

  setTempo(bpm: number) {
    const next = Math.min(240, Math.max(40, bpm))
    this.repl?.setCps(next / 60)
    this.setState({ bpm: next })
  }

  registerSampleBank(source: SampleBankSource, options: SampleBankOptions = {}) {
    const derivedId = options.id ?? inferSampleBankIdFromSource(source)
    const baseId = derivedId || `bank-${this.sampleBankRegistry.size + 1}`
    let id = normaliseSampleBankId(baseId)
    let existing = this.sampleBankRegistry.get(id)
    if (!options.id && existing && existing.source !== source) {
      let suffix = 2
      while (this.sampleBankRegistry.has(normaliseSampleBankId(`${baseId}-${suffix}`))) {
        suffix += 1
      }
      id = normaliseSampleBankId(`${baseId}-${suffix}`)
      existing = this.sampleBankRegistry.get(id)
    }
    const sourceChanged = existing?.source !== source
    const labelInput = options.label ?? existing?.label ?? inferSampleBankLabelFromSource(source, id)
    const normalisedPrefix =
      options.bankPrefix ??
      normaliseSampleBankPrefix(labelInput) ??
      existing?.meta?.bankPrefix ??
      normaliseSampleBankPrefix(baseId) ??
      baseId
    const label = normalisedPrefix
    const meta = mergeSampleBankMeta(existing?.meta, {
      baseUrl: options.baseUrl,
      tag: options.tag,
      prebake: options.prebake,
      bankPrefix: normalisedPrefix,
    })

    const nextState: SampleBankState = {
      id,
      label,
      status: sourceChanged ? 'idle' : existing?.status ?? 'idle',
      source,
      sourceSummary: describeSampleBankSource(source, {
        baseUrl: meta?.baseUrl,
        bankPrefix: meta?.bankPrefix,
      }),
      error: sourceChanged ? undefined : existing?.error,
      loadedAt: sourceChanged ? undefined : existing?.loadedAt,
      meta,
    }

    this.sampleBankRegistry.set(id, nextState)
    this.syncSampleBanks()
    return nextState
  }

  getSampleBank(id: string) {
    return this.sampleBankRegistry.get(normaliseSampleBankId(id)) ?? null
  }

  listSampleBanks() {
    return Array.from(this.sampleBankRegistry.values())
  }

  removeSampleBank(id: string) {
    const normalised = normaliseSampleBankId(id)
    const existing = this.sampleBankRegistry.get(normalised)
    if (!existing) {
      return null
    }
    this.sampleBankRegistry.delete(normalised)
    this.sampleBankPromises.delete(normalised)
    this.syncSampleBanks()
    return existing
  }

  async loadSampleBank(source: SampleBankSource, options: SampleBankOptions = {}) {
    const state = this.registerSampleBank(source, options)
    return this.runSampleBankLoad(state.id, options)
  }

  async loadSampleBankById(id: string, options: SampleBankOptions = {}) {
    const normalised = normaliseSampleBankId(id)
    const existing = this.sampleBankRegistry.get(normalised)
    if (!existing) {
      throw new Error(`Sample bank "${id}" is not registered`)
    }
    if (
      options.label !== undefined ||
      options.baseUrl !== undefined ||
      options.tag !== undefined ||
      options.prebake !== undefined
    ) {
      this.registerSampleBank(existing.source, { ...options, id: normalised })
    }
    return this.runSampleBankLoad(normalised, options)
  }

  private runSampleBankLoad(id: string, overrides: SampleBankOptions = {}) {
    const targetId = normaliseSampleBankId(id)
    const existing = this.sampleBankRegistry.get(targetId)
    if (!existing) {
      throw new Error(`Sample bank "${id}" is not registered`)
    }

    const meta = mergeSampleBankMeta(existing.meta, {
      baseUrl: overrides.baseUrl,
      tag: overrides.tag,
      prebake: overrides.prebake,
      bankPrefix: overrides.bankPrefix,
    })
    const summary = describeSampleBankSource(existing.source, {
      baseUrl: meta?.baseUrl,
      bankPrefix: meta?.bankPrefix,
    })
    const prepared =
      this.updateSampleBank(targetId, {
        meta,
        label: overrides.label ?? existing.label,
        sourceSummary: summary,
        error: undefined,
      }) ?? existing

    const inflight = this.sampleBankPromises.get(targetId)
    if (inflight) {
      return inflight
    }
    const promise = this.performSampleBankLoad(prepared)
    this.sampleBankPromises.set(targetId, promise)
    return promise
  }

  private async performSampleBankLoad(state: SampleBankState) {
    await this.init()
    const samplesFn = this.webaudio?.samples ?? this.webaudio?.doughsamples
    if (typeof samplesFn !== 'function') {
      throw new Error('Custom sample banks are not supported in this environment')
    }

    this.updateSampleBank(state.id, { status: 'loading', error: undefined })
    this.adjustSampleLoading(1)
    try {
      const preparedSource =
        isSampleMap(state.source) && state.meta?.bankPrefix
          ? augmentSampleMapWithPrefix(state.source, state.meta.bankPrefix)
          : state.source
      await this.ensureAudio()
      await samplesFn.call(this.webaudio, preparedSource, state.meta?.baseUrl, {
        tag: state.meta?.tag,
        prebake: state.meta?.prebake,
      })
      return (
        this.updateSampleBank(state.id, {
          status: 'ready',
          loadedAt: Date.now(),
        }) ?? state
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.updateSampleBank(state.id, { status: 'error', error: message })
      throw error
    } finally {
      this.adjustSampleLoading(-1)
      this.sampleBankPromises.delete(state.id)
    }
  }

  dispose() {
    this.stop()
    this.listeners.clear()
    this.activeMap.clear()
    if (this.state.audioUnlocked && this.webaudio?.getAudioContext) {
      try {
        this.webaudio.getAudioContext().close()
      } catch {
        /* noop */
      }
    }
  }

  private emit() {
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }

  private setState(update: Partial<EngineState>) {
    const keys = Object.keys(update ?? {}) as (keyof EngineState)[]
    if (keys.length === 0) {
      return
    }

    const next = { ...this.state, ...update } as EngineState
    const changed = keys.some((key) => !Object.is(this.state[key], next[key]))

    if (!changed) {
      return
    }

    this.state = next
    this.emit()
  }

  private updateSampleBank(id: string, patch: Partial<SampleBankState>) {
    const current = this.sampleBankRegistry.get(id)
    if (!current) {
      return undefined
    }
    const nextMeta =
      patch.meta !== undefined
        ? mergeSampleBankMeta(current.meta, patch.meta)
        : current.meta
    const nextState: SampleBankState = {
      ...current,
      ...patch,
      meta: nextMeta,
    }
    if (
      patch.sourceSummary === undefined &&
      patch.meta &&
      (patch.meta.baseUrl !== undefined || patch.meta.bankPrefix !== undefined)
    ) {
      nextState.sourceSummary = describeSampleBankSource(nextState.source, {
        baseUrl: nextMeta?.baseUrl,
        bankPrefix: nextMeta?.bankPrefix,
      })
    }
    this.sampleBankRegistry.set(id, nextState)
    this.syncSampleBanks()
    return nextState
  }

  private syncSampleBanks() {
    this.setState({ sampleBanks: Array.from(this.sampleBankRegistry.values()) })
  }

  private adjustSampleLoading(delta: number) {
    if (delta === 0 || Number.isNaN(delta)) {
      return
    }
    this.sampleLoadingCount = Math.max(0, this.sampleLoadingCount + delta)
    const isLoading = this.sampleLoadingCount > 0
    if (isLoading !== this.state.isLoadingSamples) {
      this.setState({ isLoadingSamples: isLoading })
    }
  }

  private handleStateUpdate(next: StrudelReplState) {
    const miniLocations = Array.isArray(next?.miniLocations)
      ? next.miniLocations.map((loc: [number, number]) => [loc[0], loc[1]] as MiniLocation)
      : this.state.miniLocations
    const errorSource = next?.evalError || next?.schedulerError || undefined
    const errorMessage = errorSource
      ? errorSource instanceof Error
        ? errorSource.message
        : String(errorSource)
      : undefined

    const update: Partial<EngineState> = {
      isPlaying: Boolean(next?.started),
      isEvaluating: Boolean(next?.pending),
      error: errorMessage,
    }

    if (!rangesEqual(this.state.miniLocations, miniLocations)) {
      update.miniLocations = miniLocations
    }

    if (Array.isArray(next?.widgets)) {
      update.widgets = next.widgets as StrudelWidget[]
    }

    this.setState(update)
  }

  private handleEvalError(err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    this.setState({ error: message })
  }

  private setupHydraAudioConnection() {
    // Set up audio routing from Strudel to Hydra's analyser for audio-reactive visualizations
    if (!this.hydra) {
      return
    }

    try {
      const audioContext = getAudioContext()
      if (!audioContext) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[StrudelEngine] Audio context not available for Hydra connection')
        }
        return
      }

      // Access or create Hydra's audio analyser node
      const hydraSynth = (this.hydra as unknown as { synth?: UnknownRecord }).synth
      if (!hydraSynth) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[StrudelEngine] Hydra synth not found')
        }
        return
      }

      // Since we set detectAudio: false, Hydra won't create its own audio object
      // So we need to create one ourselves
      let hydraAudio = (hydraSynth as unknown as { audio?: UnknownRecord }).audio
      let analyser: AnalyserNode

      if (!hydraAudio) {
        // Create our own analyser node
        analyser = audioContext.createAnalyser()
        analyser.fftSize = 2048
        analyser.smoothingTimeConstant = 0.8

        // Create the audio object structure that Hydra's fft() function expects
        hydraAudio = {
          analyser: analyser,
          fftSize: analyser.fftSize,
          getBins: () => {
            const bins = new Uint8Array(analyser.frequencyBinCount)
            analyser.getByteFrequencyData(bins)
            return bins
          },
          getWaveform: () => {
            const waveform = new Uint8Array(analyser.fftSize)
            analyser.getByteTimeDomainData(waveform)
            return waveform
          },
        }

        // Inject the audio object into Hydra's synth
        ;(hydraSynth as UnknownRecord).audio = hydraAudio

        if (process.env.NODE_ENV !== 'production') {
          console.log('[StrudelEngine] Created and injected audio analyser into Hydra')
        }
      } else {
        // Hydra already has an audio object (shouldn't happen with detectAudio: false, but handle it)
        analyser = (hydraAudio as unknown as { analyser?: AnalyserNode }).analyser!
        if (!analyser) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn('[StrudelEngine] Hydra audio exists but analyser not found')
          }
          return
        }
      }

      // Create a splitter gain node to route audio to both destination and Hydra's analyser
      // This allows us to tap into the audio stream without affecting the main output
      const splitter = audioContext.createGain()
      splitter.gain.value = 1.0

      // Connect the splitter to both the audio destination and Hydra's analyser
      splitter.connect(audioContext.destination)
      splitter.connect(analyser)

      // Store the splitter so we can connect Strudel's audio output to it
      this.audioSplitterGain = splitter

      if (process.env.NODE_ENV !== 'production') {
        console.log('[StrudelEngine] Hydra audio splitter created and connected to analyser')
      }

      // If audio is already initialized, patch the audio routing now
      // Otherwise, it will be patched when audio is initialized
      if (this.state.audioUnlocked) {
        this.patchAudioRouting()
      }
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[StrudelEngine] Failed to set up Hydra audio connection:', error)
      }
    }
  }

  private setupScopeTimeSource() {
    // Set up time source for scope visualization using audio context currentTime
    // Note: REPL sets its own time source, but we override it to use audio context time for scope
    // After evalScope, setTime is available on globalThis
    const setTimeFn = (globalThis as UnknownRecord).setTime ?? this.core?.setTime
    if (typeof setTimeFn !== 'function') {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[StrudelEngine] setTime function not found. Scope visualization may not work.')
        console.warn('[StrudelEngine] globalThis.setTime:', typeof (globalThis as UnknownRecord).setTime)
        console.warn('[StrudelEngine] this.core.setTime:', typeof this.core?.setTime)
      }
      return
    }

    try {
      // Use getAudioContext from superdough directly
      // The function passed to setTime should safely handle cases where audio context isn't ready
      const timeSourceFn = () => {
        try {
          const audioContext = getAudioContext()
          const currentTime = audioContext?.currentTime ?? 0
          if (process.env.NODE_ENV !== 'production' && currentTime === 0) {
            console.debug('[StrudelEngine] Audio context time is 0, may not be initialized yet')
          }
          return currentTime
        } catch (error) {
          // Audio context might not be initialized yet
          if (process.env.NODE_ENV !== 'production') {
            console.debug('[StrudelEngine] Audio context not ready for scope time source:', error)
          }
          return 0
        }
      }
      
      setTimeFn(timeSourceFn)
      
      if (process.env.NODE_ENV !== 'production') {
        console.log('[StrudelEngine] Scope time source set up successfully')
      }
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[StrudelEngine] Failed to set up scope time source:', error)
      }
    }
  }

  private async ensureAudio() {
    if (!this.webaudio) {
      return
    }
    if (!this.audioInitPromise) {
      const { initAudioOnFirstClick, registerSynthSounds } = this.webaudio
      this.audioInitPromise = (async () => {
        try {
          await initAudioOnFirstClick?.()
          await registerSynthSounds?.()
          this.setState({ audioUnlocked: true })
          // Set up scope time source after audio is initialized
          this.setupScopeTimeSource()
          // Patch audio routing to also connect to Hydra's analyser
          this.patchAudioRouting()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.setState({ error: message })
          throw error
        }
      })()
      this.audioInitPromise.catch(() => {
        /* error already handled in setState */
      })
    }
    return this.audioInitPromise
  }

  private patchAudioRouting() {
    // Patch the AudioContext destination to route audio to both speakers and Hydra's analyser
    // This ensures that all audio output from Strudel flows to both outputs
    
    // Only patch once to avoid multiple patching
    if (this.audioRoutingPatched) {
      return
    }
    
    if (!this.audioSplitterGain) {
      return
    }

    try {
      const audioContext = getAudioContext()
      if (!audioContext) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[StrudelEngine] Audio context not available for patching')
        }
        return
      }

      const splitter = this.audioSplitterGain
      const realDestination = audioContext.destination

      // Create a proxy destination node that intercepts connections
      // When nodes connect to "destination", they'll actually connect to our splitter
      // which then connects to both the real destination and Hydra's analyser
      
      // Connect our splitter to the real destination so audio still plays
      splitter.connect(realDestination)

      // Patch the AudioNode.prototype.connect method to intercept destination connections
      const originalConnect = AudioNode.prototype.connect
      
      // Create patched connect function that handles both overloads
      // We need to use a generic approach since TypeScript doesn't allow proper overload implementation in this context
      const patchedConnect = function(this: AudioNode, ...args: [AudioNode, number?, number?] | [AudioParam, number?]): AudioNode | void {
        const destination = args[0]
        
        // If connecting to the audio context destination (AudioNode), route through our splitter instead
        if (destination === realDestination) {
          if (process.env.NODE_ENV !== 'production') {
            console.log('[StrudelEngine] Intercepted destination connection, routing through Hydra splitter')
          }
          // Connect to our splitter instead of the destination
          // The splitter is already connected to both the real destination and Hydra's analyser
          // Cast to any to handle overload ambiguity
          return (originalConnect as any).call(this, splitter, args[1], args[2])
        }
        
        // For all other connections, use the original method
        return (originalConnect as any).apply(this, args)
      }

      // Replace the connect method
      AudioNode.prototype.connect = patchedConnect as typeof AudioNode.prototype.connect

      // Mark as patched
      this.audioRoutingPatched = true

      if (process.env.NODE_ENV !== 'production') {
        console.log('[StrudelEngine] Audio routing patched - all destination connections will route through Hydra splitter')
      }
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[StrudelEngine] Failed to patch audio routing:', error)
      }
    }
  }

  private async loadSamples(source: string) {
    const samplesFn = this.webaudio?.samples ?? this.webaudio?.doughsamples
    if (!samplesFn || this.state.samplesLoaded) {
      return
    }
    if (this.sampleLoadPromise) {
      return this.sampleLoadPromise
    }

    this.sampleLoadPromise = (async () => {
      this.adjustSampleLoading(1)
      try {
        await this.audioInitPromise
        await samplesFn.call(this.webaudio, source)
        this.setState({ samplesLoaded: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.setState({ error: message })
        throw error
      } finally {
        this.adjustSampleLoading(-1)
      }
    })()

    return this.sampleLoadPromise
  }

  private async loadBundledSampleBank(bankUrl: string) {
    if (!this.webaudio) {
      return
    }
    const samplesFn = this.webaudio?.samples ?? this.webaudio?.doughsamples
    if (typeof samplesFn !== 'function') {
      return
    }

    try {
      const response = await fetch(bankUrl)
      if (!response.ok) {
        return
      }
      const sampleMap = await response.json()
      const baseUrl = sampleMap._base || ''
      // Remove _base and _note from the map before passing to samples function
      const { _base, _note, ...samples } = sampleMap
      
      // Skip if no samples (e.g., empty local.json)
      if (Object.keys(samples).length === 0) {
        return
      }
      
      await this.ensureAudio()
      await samplesFn.call(this.webaudio, samples, baseUrl)
    } catch (error) {
      // Silently fail - this is a convenience feature, not critical
      throw error
    }
  }

  private sendHighlights(hap: HapLike, duration: number) {
    const locations = hap.context?.locations ?? []
    if (!locations.length) {
      return
    }
    const ranges = locations.map((loc) => [loc.start, loc.end] as MiniLocation)
    this.scheduleHighlight(ranges, duration)
  }

  private scheduleHighlight(locations: MiniLocation[], durationSeconds: number) {
    if (!locations.length) {
      return
    }
    const releaseFns = locations.map((range) => this.addActiveRange(range))
    const timeout = Math.max(0, durationSeconds * 1000)
    setTimeout(() => {
      releaseFns.forEach((fn) => fn())
    }, timeout + 10)
  }

  private addActiveRange(range: MiniLocation) {
    const key = `${range[0]}-${range[1]}`
    const entry = this.activeMap.get(key)
    if (entry) {
      entry.count += 1
    } else {
      this.activeMap.set(key, { range, count: 1 })
    }
    this.updateActiveLocations()
    return () => {
      const current = this.activeMap.get(key)
      if (!current) {
        return
      }
      current.count -= 1
      if (current.count <= 0) {
        this.activeMap.delete(key)
      }
      this.updateActiveLocations()
    }
  }

  private updateActiveLocations() {
    const next: MiniLocation[] = Array.from(this.activeMap.values()).map((entry) => entry.range)
    if (!rangesEqual(next, this.state.activeLocations)) {
      this.setState({ activeLocations: next })
    }
  }

  private clearActiveLocations() {
    if (this.activeMap.size === 0 && this.state.activeLocations.length === 0) {
      return
    }
    this.activeMap.clear()
    this.setState({ activeLocations: [] })
  }
}

export function useStrudelEngine(engine: StrudelEngine, listener: Listener) {
  const listenerRef = useRef(listener)

  useEffect(() => {
    listenerRef.current = listener
  }, [listener])

  useEffect(() => {
    return engine.subscribe((state) => listenerRef.current(state))
  }, [engine])
}

function rangesEqual(a: MiniLocation[], b: MiniLocation[]) {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) {
      return false
    }
  }
  return true
}

function normaliseSampleBankId(value?: string) {
  const slug = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'sample-bank'
}

function inferSampleBankIdFromSource(source: SampleBankSource) {
  if (typeof source === 'string') {
    const segments = source.split(/[\\/]/).filter(Boolean)
    return segments[segments.length - 1] ?? source
  }
  const keys = Object.keys(source ?? {}).filter((key) => !key.startsWith('_'))
  return keys[0] ?? 'custom-bank'
}

function inferSampleBankLabelFromSource(source: SampleBankSource, fallback: string) {
  const candidate =
    typeof source === 'string'
      ? source.split(/[\\/]/).filter(Boolean).pop() ?? fallback
      : Object.keys(source ?? {})
          .filter((key) => !key.startsWith('_'))
          .shift() ?? fallback
  return humaniseToken(candidate)
}

function describeSampleBankSource(
  source: SampleBankSource,
  extras: { baseUrl?: string; bankPrefix?: string } = {},
) {
  if (typeof source === 'string') {
    return `${source}${formatBankDescriptor(extras)}`
  }
  const keys = Object.keys(source ?? {}).filter((key) => !key.startsWith('_'))
  const total = keys.length
  const preview = keys.slice(0, 3).join(', ')
  const extra = total > 3 ? ` +${total - 3} more` : ''
  const base = total
    ? `Custom map (${total} key${total === 1 ? '' : 's'}: ${preview}${extra})`
    : 'Custom map'
  const withBase = extras.baseUrl ? `${base} @ ${extras.baseUrl}` : base
  return `${withBase}${formatBankDescriptor(extras)}`
}

function humaniseToken(value: string) {
  if (!value) {
    return 'Sample bank'
  }
  const spaced = value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : 'Sample bank'
}

function mergeSampleBankMeta(
  current?: SampleBankState['meta'],
  next?: SampleBankState['meta'],
): SampleBankState['meta'] | undefined {
  if (!current && !next) {
    return undefined
  }
  const merged: SampleBankState['meta'] = { ...(current ?? {}) }
  if (next) {
    if (next.baseUrl !== undefined) {
      merged.baseUrl = next.baseUrl
    }
    if (next.tag !== undefined) {
      merged.tag = next.tag
    }
    if (next.prebake !== undefined) {
      merged.prebake = next.prebake
    }
    if (next.bankPrefix !== undefined) {
      merged.bankPrefix = next.bankPrefix
    }
    if (next.bankAliases !== undefined) {
      const combined = dedupeBankAliases([
        ...(current?.bankAliases ?? []),
        ...(next.bankAliases ?? []),
      ])
      merged.bankAliases = combined.length ? combined : undefined
    }
  }
  return Object.keys(merged).length ? merged : undefined
}

function formatBankDescriptor(extras: { bankPrefix?: string }) {
  const segments: string[] = []
  if (extras.bankPrefix) {
    segments.push(extras.bankPrefix)
  }
  if (!segments.length) {
    return ''
  }
  return ` (bank: ${segments.join(' | ')})`
}

function inferSampleBankPrefix(label: string, fallback: string) {
  const tokens = (label || fallback)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
  return tokens.join('') || fallback
}

function normaliseSampleBankPrefix(value?: string) {
  if (!value) {
    return undefined
  }
  const compact = value.replace(/[^a-zA-Z0-9]+/g, '')
  if (!compact) {
    return undefined
  }
  return compact.charAt(0).toUpperCase() + compact.slice(1)
}

function isSampleMap(value: SampleBankSource): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

function augmentSampleMapWithPrefix(source: UnknownRecord, prefix?: string) {
  if (!prefix) {
    return source
  }
  const result: UnknownRecord = { ...source }
  Object.entries(source).forEach(([key, value]) => {
    if (key.startsWith('_')) {
      return
    }
    const prefixedKey = `${prefix}_${key}`
    if (result[prefixedKey] === undefined) {
      result[prefixedKey] = value
    }
  })
  return result
}

function dedupeBankAliases(values: (string | undefined)[]) {
  const seen = new Set<string>()
  values.forEach((value) => {
    if (!value) {
      return
    }
    seen.add(value)
  })
  return Array.from(seen)
}
