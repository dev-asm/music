declare module 'hydra-synth' {
  interface HydraOptions {
    canvas?: HTMLCanvasElement | null
    width?: number
    height?: number
    autoLoop?: boolean
    makeGlobal?: boolean
    detectAudio?: boolean
    numSources?: number
    numOutputs?: number
    extendTransforms?: unknown[] | unknown
    precision?: 'lowp' | 'mediump' | 'highp'
    pb?: unknown
  }

  class Hydra {
    constructor(options?: HydraOptions)
    synth: {
      time: number
      bpm: number
      width: number
      height: number
      fps?: number
      stats: {
        fps: number
      }
      speed: number
      mouse: unknown
      render: () => void
      setResolution: (width: number, height: number) => void
      update: (dt: number) => void
      afterUpdate: (dt: number) => void
      hush: () => void
      tick: (dt: number) => void
    }
    tick(dt: number): void
  }

  export default Hydra
}

