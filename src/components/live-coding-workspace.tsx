'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import CodeMirror from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { EditorState, Extension, RangeSetBuilder } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { Loader2, Play, Square } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  StrudelEngine,
  type EngineState,
  type MiniLocation,
  type SampleBankState,
} from '@/lib/strudel-engine'

const DEFAULT_CODE = `// Patterns are composed with Strudel\'s mini-notation.
// Press Run Pattern to evaluate the code and hear the result.
stack(
  note("c4 e4 g4 c5").fast(2).gain(0.85),
  note("c3 g3").slow(2).gain(0.35)
)
`

const baseHighlight = Decoration.mark({ class: 'cm-mini-highlight' })
const activeHighlight = Decoration.mark({ class: 'cm-mini-active' })

function buildHighlightExtension(mini: MiniLocation[], active: MiniLocation[], docLength: number): Extension {
  type Highlight = { from: number; to: number; decoration: Decoration; priority: number }
  const normalise = ([start, end]: MiniLocation, decoration: Decoration, priority: number): Highlight | null => {
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return null
    }
    if (docLength <= 0) {
      return null
    }
    const min = Math.min(start, end)
    const max = Math.max(start, end)
    const from = Math.max(0, Math.min(docLength - 1, Math.floor(min)))
    const to = Math.max(0, Math.min(docLength, Math.ceil(max)))
    if (to <= from) {
      return null
    }
    return { from, to, decoration, priority }
  }

  const ranges: Highlight[] = []
  mini.forEach((range) => {
    const highlight = normalise(range, baseHighlight, 0)
    if (highlight) {
      ranges.push(highlight)
    }
  })
  active.forEach((range) => {
    const highlight = normalise(range, activeHighlight, 1)
    if (highlight) {
      ranges.push(highlight)
    }
  })

  ranges.sort((a, b) => {
    if (a.from !== b.from) {
      return a.from - b.from
    }
    if (a.priority !== b.priority) {
      return a.priority - b.priority
    }
    return a.to - b.to
  })

  const builder = new RangeSetBuilder<Decoration>()
  ranges.forEach(({ from, to, decoration }) => {
    builder.add(from, to, decoration)
  })

  return EditorView.decorations.of(builder.finish())
}

const editorTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'transparent',
      fontFamily: 'var(--font-geist-mono)',
    },
    '.cm-content': {
      padding: 0,
    },
    '.cm-scroller': {
      fontSize: '0.95rem',
      lineHeight: '1.5',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      fontSize: '0.75rem',
    },
  },
  { dark: false },
)

const engineInstance = () => new StrudelEngine({ autoRun: true })

function formatStatus(state: EngineState) {
  if (!state.isReady) {
    return 'Loading Strudel…'
  }
  if (state.error) {
    return 'Pattern error'
  }
  if (state.isLoadingSamples) {
    return 'Loading Dirt samples…'
  }
  if (!state.samplesLoaded) {
    return 'Samples will load on first Play.'
  }
  if (!state.audioUnlocked) {
    return 'Audio unlocks on your first Play.'
  }
  if (state.isEvaluating) {
    return 'Evaluating pattern…'
  }
  if (state.isPlaying) {
    return 'Playing'
  }
  return 'Idle'
}

export function LiveCodingWorkspace() {
  const [engine] = useState(() => engineInstance())
  const [code, setCode] = useState(DEFAULT_CODE)
  const [engineState, setEngineState] = useState<EngineState>(() => engine.getState())
  const [autoRun] = useState(engine.autoRun)
  const lastEvaluatedCodeRef = useRef(DEFAULT_CODE)
  const visualsRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    engine.setVisualContainer(visualsRef.current)
    return () => {
      engine.setVisualContainer(null)
    }
  }, [engine])

  useEffect(() => {
    let isMounted = true
    const unsubscribe = engine.subscribe((state) => {
      if (!isMounted) {
        return
      }
      setEngineState(state)
    })

    engine
      .init()
      .then(() => engine.evaluate(DEFAULT_CODE, { autostart: false }))
      .then(() => {
        lastEvaluatedCodeRef.current = DEFAULT_CODE
      })
      .catch((error) => {
        if (process.env.NODE_ENV !== 'production') {
          console.error('Failed to initialise Strudel', error)
        }
      })

    return () => {
      isMounted = false
      unsubscribe()
      engine.dispose()
    }
  }, [engine])

  const highlightExtension = useMemo(
    () => buildHighlightExtension(engineState.miniLocations, engineState.activeLocations, code.length),
    [engineState.miniLocations, engineState.activeLocations, code.length],
  )

  const extensions = useMemo<Extension[]>(
    () => [
      javascript({ typescript: false }),
      EditorState.tabSize.of(2),
      EditorView.lineWrapping,
      editorTheme,
      highlightExtension,
    ],
    [highlightExtension],
  )

  const handleRun = async () => {
    if (!engineState.isReady) {
      return
    }
    try {
      await engine.evaluate(code, { autostart: true })
      lastEvaluatedCodeRef.current = code
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Evaluation error', error)
      }
    }
  }

  useEffect(() => {
    if (!autoRun) {
      return
    }
    if (!engineState.isReady) {
      return
    }
    if (code === lastEvaluatedCodeRef.current) {
      return
    }
    const handle = setTimeout(async () => {
      try {
        await engine.evaluate(code, { autostart: engineState.isPlaying })
        lastEvaluatedCodeRef.current = code
      } catch (error) {
        if (process.env.NODE_ENV !== 'production') {
          console.error('Auto evaluation error', error)
        }
      }
    }, 400)

    return () => {
      clearTimeout(handle)
    }
  }, [autoRun, code, engine, engineState.isPlaying, engineState.isReady])

  return (
    <div className="relative max-w-4xl mx-auto">
      <div className="absolute -inset-8 gradient-rainbow opacity-50 blur-3xl rounded-xl" />
      <Card className="relative bg-card">
        <CardHeader>
        <CardTitle className="text-2xl">Strudel Live Coding</CardTitle>
        <CardDescription>
          Compose and perform generative music in the browser. Mini-notation segments highlight as
          they play.
        </CardDescription>
        <CardAction className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="icon"
              onClick={engineState.isPlaying ? engine.stop.bind(engine) : handleRun}
              disabled={!engineState.isReady || engineState.isEvaluating}
              aria-label={engineState.isPlaying ? 'Stop pattern' : 'Run pattern'}
            >
              {engineState.isPlaying ? (
                <Square className="size-4" />
              ) : (
                <Play className="size-4" />
              )}
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="relative min-h-[352px] rounded-xl border bg-muted/40 p-3 focus:outline-none focus-visible:outline-none">
          <CodeMirror
            value={code}
            height="320px"
            basicSetup={{ highlightActiveLine: false, foldGutter: true }}
            onChange={(value) => setCode(value)}
            extensions={extensions}
            theme="light"
          />
          {!engineState.isReady ? (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-xl bg-background/85 backdrop-blur-sm">
              <Loader2 className="size-6 animate-spin text-primary" />
              <span className="text-xs font-medium text-muted-foreground">Booting Strudel engine…</span>
            </div>
          ) : null}
        </div>
        <div ref={visualsRef} className="flex flex-col gap-4"></div>
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-muted-foreground">{formatStatus(engineState)}</p>
          {engineState.error ? (
            <p className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-destructive">
              {engineState.error}
            </p>
          ) : null}
        </div>
        <SampleBankSection engine={engine} banks={engineState.sampleBanks} engineReady={engineState.isReady} />
      </CardContent>
    </Card>
    </div>
  )
}

type SampleBankSectionProps = {
  engine: StrudelEngine
  banks: SampleBankState[]
  engineReady: boolean
}

const SAMPLE_MAP_EXAMPLE = `{
  "bd": "bd/BT0AADA.wav",
  "sd": "sd/rytm-01-classic.wav",
  "hh": "hh27/000_hh27closedhh.wav"
}`

function SampleBankSection({ engine, banks, engineReady }: SampleBankSectionProps) {
  const [label, setLabel] = useState('CustomKit')
  const [baseUrl, setBaseUrl] = useState('github:tidalcycles/dirt-samples/master/')
  const [mapInput, setMapInput] = useState(SAMPLE_MAP_EXAMPLE)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleExample = () => {
    setLabel('DirtMiniKit')
    setBaseUrl('github:tidalcycles/dirt-samples/master/')
    setMapInput(SAMPLE_MAP_EXAMPLE)
    setError(null)
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!engineReady) {
      setError('Strudel is still initialising. Please wait a moment.')
      return
    }
    setIsSubmitting(true)
    try {
      const parsed = JSON.parse(mapInput)
      const resolvedLabel = label.trim() || 'CustomKit'
      const resolvedBaseUrl = baseUrl.trim()
      await engine.loadSampleBank(parsed, {
        label: resolvedLabel,
        baseUrl: resolvedBaseUrl || undefined,
      })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleReload = (id: string) => {
    engine.loadSampleBankById(id).catch((err) => {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Failed to reload sample bank', err)
      }
    })
  }

  const handleRemove = (id: string) => {
    engine.removeSampleBank(id)
  }

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
      <form
        onSubmit={handleSubmit}
        className="space-y-3 rounded-xl border border-border/60 bg-muted/30 p-4 text-sm"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">Custom Sample Bank</h3>
            <p className="text-xs text-muted-foreground">
              Load bespoke maps via Strudel&apos;s `samples()` helper as shown in the docs.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={handleExample}>
            Use Example
          </Button>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Kit / bank name</span>
          <input
            className="rounded-md border border-border bg-background px-2 py-1"
            value={label}
            onChange={(event) => setLabel(event.currentTarget.value)}
            placeholder="e.g. DirtMiniKit"
          />
          <span className="text-[11px] text-muted-foreground">
            This is exactly what you pass to `.bank()`. Stick to letters/numbers (no spaces).
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Base URL</span>
          <input
            className="rounded-md border border-border bg-background px-2 py-1"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.currentTarget.value)}
            placeholder="github:tidalcycles/dirt-samples/master/"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Sample map (JSON)</span>
          <textarea
            className="min-h-[120px] rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
            value={mapInput}
            onChange={(event) => setMapInput(event.currentTarget.value)}
            spellCheck={false}
          />
        </label>

        {error ? (
          <p className="rounded-md border border-destructive bg-destructive/10 px-2 py-1 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button type="submit" disabled={isSubmitting || !engineReady}>
            {isSubmitting ? 'Loading…' : 'Load Sample Bank'}
          </Button>
        </div>
      </form>

      <div className="rounded-xl border border-border/60 bg-muted/20 p-4 text-sm">
        <h3 className="text-base font-semibold">Loaded Banks</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          After loading, reference the short names (e.g. `bd sd hh`) directly in your patterns: `s("bd sd,hh*8")`.
        </p>
        <div className="space-y-2">
          {banks.length === 0 ? (
            <p className="text-xs text-muted-foreground">No custom banks yet.</p>
          ) : (
            banks.map((bank) => (
              <div
                key={bank.id}
                className="rounded-lg border border-border/60 bg-background/70 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">{bank.label}</p>
                    <p className="text-xs text-muted-foreground">{bank.sourceSummary}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleReload(bank.id)}
                      disabled={bank.status === 'loading'}
                    >
                      Reload
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => handleRemove(bank.id)}>
                      Remove
                    </Button>
                  </div>
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs">
                  <span
                    className={{
                      ready: 'text-emerald-600',
                      loading: 'text-amber-600',
                      error: 'text-destructive',
                      idle: 'text-muted-foreground',
                    }[bank.status]}
                  >
                    {bank.status === 'ready'
                      ? 'Ready'
                      : bank.status === 'loading'
                        ? 'Loading...'
                        : bank.status === 'error'
                          ? 'Error'
                          : 'Idle'}
                  </span>
                  <span className="font-mono text-muted-foreground">
                    Use: <code>.bank("{bank.label}")</code>
                  </span>
                  {bank.error ? <span className="text-destructive">{bank.error}</span> : null}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

