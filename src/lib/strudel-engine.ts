'use client'

import { useEffect, useRef } from 'react'

export type MiniLocation = [number, number]

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
  lastEvaluatedAt?: number
  error?: string
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
} & Record<string, unknown>

interface HapLike {
  context?: {
    locations?: Array<{ start: number; end: number }>
  }
}

type UnknownRecord = Record<string, unknown>

const DEFAULT_BPM = 120
const DIRT_SAMPLE_SOURCE = 'github:tidalcycles/dirt-samples'

export class StrudelEngine {
  private listeners = new Set<Listener>()

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
  }

  private core?: StrudelCore
  private webaudio?: StrudelWebAudio
  private web?: StrudelWeb
  private repl?: ReturnType<StrudelCore['repl']>
  private transpiler?: Transpiler

  private readyPromise?: Promise<void>
  private audioInitPromise?: Promise<void>
  private sampleLoadPromise?: Promise<void>
  private activeMap = new Map<string, { range: MiniLocation; count: number }>()

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

    this.readyPromise = (async () => {
      const [
        core,
        miniModule,
        tonalModule,
        xenModule,
        webaudioModule,
        webModule,
        transpilerModuleRaw,
      ] = (await Promise.all([
        import('@strudel/core'),
        import('@strudel/mini'),
        import('@strudel/tonal'),
        import('@strudel/xen'),
        import('@strudel/webaudio'),
        import('@strudel/web'),
        import('@strudel/transpiler'),
      ])) as unknown as [
        StrudelCore,
        UnknownRecord,
        UnknownRecord,
        UnknownRecord,
        StrudelWebAudio,
        StrudelWeb,
        UnknownRecord
      ]

      this.core = core
      this.webaudio = webaudioModule
      this.web = webModule
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

      await core.evalScope(core, miniModule, tonalModule, xenModule, webaudioModule, webModule)

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
        return baseOutput(hap as unknown, deadline, duration, cps, scheduled)
      }

      this.repl = webaudioModule.webaudioRepl({
        defaultOutput: highlightOutput,
        beforeStart: () => this.ensureAudio(),
        transpiler: this.transpiler,
        onUpdateState: (next: StrudelReplState) => this.handleStateUpdate(next),
        onEvalError: (err: unknown) => this.handleEvalError(err),
        afterEval: () => this.setState({ lastEvaluatedAt: Date.now() }),
        id: 'next-strudel-repl',
      })

      this.repl.setCps(this.state.bpm / 60)
      this.setState({ isReady: true })
    })()

    return this.readyPromise
  }

  async evaluate(code: string, options: EvaluateOptions = {}) {
    await this.init()
    if (!this.repl) {
      throw new Error('Strudel REPL is not ready')
    }
    const { autostart = true, hush = true } = options
    this.setState({ error: undefined })
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

    this.setState(update)
  }

  private handleEvalError(err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    this.setState({ error: message })
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

  private async loadSamples(source: string) {
    const samplesFn = this.webaudio?.samples
    if (!samplesFn || this.state.samplesLoaded) {
      return
    }
    if (this.sampleLoadPromise) {
      return this.sampleLoadPromise
    }

    this.sampleLoadPromise = (async () => {
      this.setState({ isLoadingSamples: true })
      try {
        await this.audioInitPromise
        await samplesFn.call(this.webaudio, source)
        this.setState({ samplesLoaded: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.setState({ error: message })
        throw error
      } finally {
        this.setState({ isLoadingSamples: false })
      }
    })()

    return this.sampleLoadPromise
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
