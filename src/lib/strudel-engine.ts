'use client'

import { useEffect, useRef } from 'react'

export type MiniLocation = [number, number]

export interface EngineState {
  isReady: boolean
  isPlaying: boolean
  isEvaluating: boolean
  bpm: number
  error?: string
  miniLocations: MiniLocation[]
  activeLocations: MiniLocation[]
  lastEvaluatedAt?: number
  audioUnlocked: boolean
}

type Listener = (state: EngineState) => void

type EvaluateOptions = {
  autostart?: boolean
  hush?: boolean
}

type StrudelCore = typeof import('@strudel/core')

interface StrudelLocation {
  start: number
  end: number
}

interface StrudelValue {
  note?: string | number | Array<string | number>
  n?: number | number[]
  freq?: number
  gain?: number
  velocity?: number
  amp?: number
  attack?: number
  release?: number
  wave?: string
  waveform?: string
  shape?: string
  [key: string]: unknown
}

interface StrudelHap {
  value?: StrudelValue | null
  context?: {
    locations?: StrudelLocation[]
  }
}

type StrudelReplState = {
  miniLocations?: Array<[number, number]>
  started?: boolean
  pending?: boolean
  evalError?: unknown
  schedulerError?: unknown
} & Record<string, unknown>

type AudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext
}


const DEFAULT_BPM = 120


export class StrudelEngine {
  private listeners = new Set<Listener>()
  public getState() {
    return this.state
  }

  private state: EngineState = {
    isReady: false,
    isPlaying: false,
    isEvaluating: false,
    bpm: DEFAULT_BPM,
    miniLocations: [],
    activeLocations: [],
    audioUnlocked: false,
  }
  private core?: StrudelCore
  private repl?: ReturnType<StrudelCore['repl']>
  private transpiler?: typeof import('@strudel/transpiler')['transpiler']
  private noteToMidi?: (value: string) => number
  private audioCtx?: AudioContext
  private masterGain?: GainNode
  private activeMap = new Map<string, { range: MiniLocation; count: number }>()
  private readyPromise?: Promise<void>

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
      const [core, miniModule, transpilerModule] = await Promise.all([
        import('@strudel/core'),
        import('@strudel/mini'),
        import('@strudel/transpiler'),
      ])

      this.core = core
      this.transpiler = transpilerModule.transpiler
      this.noteToMidi = core.noteToMidi ?? undefined

      await core.evalScope(core, miniModule)

      this.repl = core.repl({
        defaultOutput: (hap, deadline, duration, cps, scheduled) =>
          this.defaultOutput(hap, deadline, duration, cps, scheduled),
        getTime: () => this.getTime(),
        beforeStart: () => this.ensureAudio(),
        transpiler: this.transpiler,
        onUpdateState: (next) => this.handleStateUpdate(next),
        onEvalError: (err) => this.handleEvalError(err),
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
    await this.ensureAudio()
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
    if (this.audioCtx) {
      const ctx = this.audioCtx
      this.audioCtx = undefined
      if (typeof ctx.close === 'function') {
        ctx.close().catch(() => undefined)
      }
    }
    this.masterGain = undefined
    this.activeMap.clear()
  }

  private emit() {
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }

  private setState(update: Partial<EngineState>) {
    let changed = false
    const next: EngineState = { ...this.state }
    for (const [key, value] of Object.entries(update) as [keyof EngineState, unknown][]) {
      if (!Object.is(next[key], value)) {
        next[key] = value as EngineState[keyof EngineState]
        changed = true
      }
    }
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

    const shouldUpdateLocations = !rangesEqual(this.state.miniLocations, miniLocations)

    const update: Partial<EngineState> = {
      isPlaying: Boolean(next?.started),
      isEvaluating: Boolean(next?.pending),
      error: errorMessage,
    }

    if (shouldUpdateLocations) {
      update.miniLocations = miniLocations
    }

    this.setState(update)
  }

  private handleEvalError(err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    this.setState({ error: message })
  }

  private async ensureAudio() {
    if (typeof window === 'undefined') {
      return undefined
    }
    if (!this.audioCtx) {
      const audioWindow = window as AudioWindow
      const AudioContextClass: typeof AudioContext | undefined =
        typeof window.AudioContext !== 'undefined' ? window.AudioContext : audioWindow.webkitAudioContext
      if (!AudioContextClass) {
        this.setState({ error: 'Web Audio API is not supported in this browser.' })
        return undefined
      }
      this.audioCtx = new AudioContextClass({ latencyHint: 'interactive' })
      this.masterGain = this.audioCtx.createGain()
      this.masterGain.gain.value = 0.7
      this.masterGain.connect(this.audioCtx.destination)
    }
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume()
    }
    if (!this.state.audioUnlocked) {
      this.setState({ audioUnlocked: true })
    }
    return this.audioCtx
  }

  private getTime() {
    if (this.audioCtx) {
      return this.audioCtx.currentTime
    }
    if (typeof performance !== 'undefined') {
      return performance.now() / 1000
    }
    return Date.now() / 1000
  }

  private resolveFrequency(value?: StrudelValue | null): number | undefined {
    if (!value) {
      return undefined
    }
    if (typeof value.freq === 'number') {
      return value.freq
    }
    const note = Array.isArray(value.note) ? value.note[0] : value.note
    if (typeof note === 'number') {
      return midiToHz(note)
    }
    if (typeof note === 'string') {
      const midi = this.noteToMidi ? this.noteToMidi(note) : noteNameToMidi(note)
      return midiToHz(midi)
    }
    const n = Array.isArray(value.n) ? value.n[0] : value.n
    if (typeof n === 'number') {
      // interpret as midi number when within midi range
      const candidate = n >= 0 && n <= 127 ? n : n + 60
      return midiToHz(candidate)
    }
    return undefined
  }

  private resolveGain(value?: StrudelValue | null): number {
    const base = 0.4
    const gain = typeof value?.gain === 'number' ? value.gain : 1
    const velocity = typeof value?.velocity === 'number' ? value.velocity : 1
    const amp = typeof value?.amp === 'number' ? value.amp : 1
    return clamp(base * gain * velocity * amp, 0.05, 1)
  }

  private resolveWaveform(value?: StrudelValue | null): OscillatorType {
    const raw = value?.wave || value?.waveform || value?.shape
    if (typeof raw === 'string') {
      const candidate = raw.toLowerCase()
      if (['sine', 'square', 'triangle', 'sawtooth'].includes(candidate)) {
        return candidate as OscillatorType
      }
    }
    return 'sine'
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

  private async defaultOutput(hap: StrudelHap, _deadline: number, duration: number, _cps: number, scheduled: number) {
    const ctx = await this.ensureAudio()
    if (!ctx || !this.masterGain) {
      return
    }

    const frequency = this.resolveFrequency(hap?.value)
    if (!frequency) {
      return
    }

    const oscillator = ctx.createOscillator()
    oscillator.type = this.resolveWaveform(hap?.value)
    oscillator.frequency.setValueAtTime(frequency, scheduled)

    const gainNode = ctx.createGain()
    const amplitude = this.resolveGain(hap?.value)
    const attack = typeof hap?.value?.attack === 'number' ? clamp(hap.value.attack, 0.001, 1) : 0.015
    const release = typeof hap?.value?.release === 'number' ? clamp(hap.value.release, 0.01, 1.5) : 0.12
    const start = scheduled
    const end = scheduled + Math.max(duration, attack + 0.05)

    gainNode.gain.setValueAtTime(0, start)
    gainNode.gain.linearRampToValueAtTime(amplitude, start + attack)
    gainNode.gain.linearRampToValueAtTime(0.0001, end + release)

    oscillator.connect(gainNode)
    gainNode.connect(this.masterGain)

    oscillator.onended = () => {
      oscillator.disconnect()
      gainNode.disconnect()
    }

    oscillator.start(start)
    oscillator.stop(end + release + 0.05)

    const locationSource = hap.context?.locations ?? []
    const locations = locationSource.map((loc) => [loc.start, loc.end] as MiniLocation)
    if (locations.length) {
      this.scheduleHighlight(locations, duration + release)
    }
  }
}

export function useStrudelEngine(engine: StrudelEngine, listener: Listener) {
  const listenerRef = useRef(listener)
  listenerRef.current = listener

  useEffect(() => {
    return engine.subscribe((state) => listenerRef.current(state))
  }, [engine])
}

function midiToHz(midi: number) {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

function noteNameToMidi(note: string): number {
  const trimmed = note.trim()
  const match = trimmed.match(/^([A-Ga-g])(b|#)?(\d+)?$/)
  if (!match) {
    return 60
  }
  const [, letter, accidental = '', octaveRaw] = match
  const pitchClasses: Record<string, number> = {
    c: 0,
    'c#': 1,
    db: 1,
    d: 2,
    'd#': 3,
    eb: 3,
    e: 4,
    'e#': 5,
    fb: 4,
    f: 5,
    'f#': 6,
    gb: 6,
    g: 7,
    'g#': 8,
    ab: 8,
    a: 9,
    'a#': 10,
    bb: 10,
    b: 11,
    'b#': 0,
    cb: 11,
  }
  const stepKey = `${letter.toLowerCase()}${accidental.toLowerCase()}`
  const pc = pitchClasses[stepKey] ?? pitchClasses[letter.toLowerCase()] ?? 0
  const octave = octaveRaw ? Number.parseInt(octaveRaw, 10) : 4
  const midi = (octave + 1) * 12 + pc
  return clamp(midi, 0, 127)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
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
