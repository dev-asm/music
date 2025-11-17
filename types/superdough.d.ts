declare module 'superdough' {
  export function getAudioContext(): AudioContext | null
  export function getAnalyzerData(type: 'time' | 'frequency', id: number): Float32Array
  export const analysers: Record<number, AnalyserNode>
  export function superdough(value: unknown, time: number, duration: number, cps: number, whole?: number): void
  export function initAudioOnFirstClick(): Promise<void>
  export function registerWorklet(url: string): void
  export function setLogger(logger: unknown): void
  export function doughTrigger(): void
  export function getWorklet(
    context: AudioContext,
    name: string,
    options?: unknown,
    processorOptions?: unknown,
  ): AudioWorkletNode
  export function connectToDestination(node: AudioNode): void
}

