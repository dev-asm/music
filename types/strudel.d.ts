declare module '@strudel/core' {
  const core: Record<string, unknown>
  export = core
}

declare module '@strudel/mini' {
  const mini: Record<string, unknown>
  export = mini
}

declare module '@strudel/tonal' {
  const tonal: Record<string, unknown>
  export = tonal
}

declare module '@strudel/xen' {
  const xen: Record<string, unknown>
  export = xen
}

declare module '@strudel/webaudio' {
  const webaudio: Record<string, unknown>
  export = webaudio
}

declare module '@strudel/draw' {
  const draw: Record<string, unknown>
  export = draw
}

declare module '@strudel/web' {
  const web: Record<string, unknown>
  export = web
}

declare module '@strudel/transpiler' {
  const transpilerModule: Record<string, unknown>
  export = transpilerModule
}

declare module '@strudel/codemirror/slider' {
  import type { Extension, StateEffect } from '@codemirror/state'
  import type { EditorView } from '@codemirror/view'

  export interface SliderWidgetConfig {
    type: 'slider'
    from: number
    to: number
    value: string
    min: number
    max: number
    step?: number
  }

  export const sliderPlugin: Extension
  export const setSliderWidgets: StateEffect<SliderWidgetConfig[]>
  export function updateSliderWidgets(view: EditorView, widgets: SliderWidgetConfig[]): void
}
