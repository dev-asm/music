'use client'

import { useEffect, useRef } from 'react'

type UnknownRecord = Record<string, unknown>

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
  sampleBanks: SampleBankState[]
  lastEvaluatedAt?: number
  error?: string
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
  }
}

export interface SampleBankOptions {
  id?: string
  label?: string
  baseUrl?: string
  tag?: string
  prebake?: () => unknown
  bankPrefix?: string
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

const DEFAULT_BPM = 40
const DIRT_SAMPLE_SOURCE = 'github:tidalcycles/dirt-samples'
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
  }

  private core?: StrudelCore
  private webaudio?: StrudelWebAudio
  private web?: StrudelWeb
  private repl?: ReturnType<StrudelCore['repl']>
  private transpiler?: Transpiler

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

    this.readyPromise = (async () => {
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

      this.webaudio = webaudioModule
      this.web = webModule
      this.core = core
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

      const patternProto = (core as UnknownRecord)?.Pattern?.prototype as UnknownRecord | undefined
      if (patternProto) {
        if (typeof patternProto._punchcard !== 'function' && typeof patternProto.punchcard === 'function') {
          patternProto._punchcard = function inlinePunchcard(this: UnknownRecord, options?: UnknownRecord) {
            const inlineManager = (globalThis as UnknownRecord).__strudelInlineVisuals as InlineVisualManager | undefined
            const ctx = inlineManager?.enqueue('punchcard', options)
            const nextOptions = ctx ? { ...(options ?? {}), ctx } : options
            return patternProto.punchcard.call(this, nextOptions)
          }
        }
        if (typeof patternProto._scope !== 'function' && typeof patternProto.scope === 'function') {
          patternProto._scope = function inlineScope(this: UnknownRecord, options?: UnknownRecord) {
            const inlineManager = (globalThis as UnknownRecord).__strudelInlineVisuals as InlineVisualManager | undefined
            const ctx = inlineManager?.enqueue('scope', options)
            const nextOptions = ctx ? { ...(options ?? {}), ctx } : options
            return patternProto.scope.call(this, nextOptions)
          }
        }
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
    const samplesFn = this.webaudio?.samples
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
