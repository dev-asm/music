'use client'

import { useEffect, useMemo, useRef, useState, useId } from 'react'

import CodeMirror from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { EditorState, Extension, RangeSetBuilder } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { Loader2, Play, Square, PackageSearch, ChevronDown, Waves } from 'lucide-react'
import { sliderPlugin, updateSliderWidgets, type SliderWidgetConfig } from '@strudel/codemirror/slider'

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
import { consumePendingSamplePack } from '@/lib/sample-bank-bridge'
import { WorkspaceSurface } from '@/components/workspace-surface'
import { ScopeVisualization } from '@/components/scope-visualization'
import { cn } from '@/lib/utils'

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

// Singleton pattern to ensure only one engine instance exists
// This prevents @strudel/core from being loaded multiple times
let engineSingleton: StrudelEngine | null = null
const engineInstance = () => {
  if (!engineSingleton) {
    engineSingleton = new StrudelEngine({ autoRun: true })
  }
  return engineSingleton
}

type LiveCodingWorkspaceProps = {
  onOpenSamplePicker?: () => void
}

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

export function LiveCodingWorkspace({ onOpenSamplePicker }: LiveCodingWorkspaceProps = {}) {
  const [engine] = useState(() => engineInstance())
  const [code, setCode] = useState(DEFAULT_CODE)
  const [engineState, setEngineState] = useState<EngineState>(() => engine.getState())
  const [autoRun] = useState(engine.autoRun)
  const lastEvaluatedCodeRef = useRef(DEFAULT_CODE)
  const visualsRef = useRef<HTMLDivElement | null>(null)
  const scopeContainerRef = useRef<HTMLDivElement | null>(null)
  const [importNotice, setImportNotice] = useState<string | null>(null)
  const editorViewRef = useRef<EditorView | null>(null)
  const [sampleToolsOpen, setSampleToolsOpen] = useState(false)
  const [scopeOpen, setScopeOpen] = useState(false)
  const sampleToolsPanelId = useId()

  useEffect(() => {
    // Set visual container for inline visuals (punchcard, etc.)
    engine.setVisualContainer(visualsRef.current)
    return () => {
      engine.setVisualContainer(null)
    }
  }, [engine])

  useEffect(() => {
    // Set scope container when scope window is open
    // This needs to be set before patterns with .scope() are evaluated
    if (scopeOpen && scopeContainerRef.current) {
      engine.setScopeContainer(scopeContainerRef.current).then(() => {
        // If code contains .scope() and is already evaluated, re-evaluate to connect to new container
        if (code.includes('.scope()') && engineState.isReady && lastEvaluatedCodeRef.current === code) {
          engine.evaluate(code, { autostart: engineState.isPlaying }).catch((error) => {
            if (process.env.NODE_ENV !== 'production') {
              console.error('Failed to re-evaluate with scope container:', error)
            }
          })
        }
      }).catch((error) => {
        if (process.env.NODE_ENV !== 'production') {
          console.error('Failed to set scope container:', error)
        }
      })
    } else {
      engine.setScopeContainer(null)
    }
    return () => {
      if (scopeOpen) {
        engine.setScopeContainer(null)
      }
    }
  }, [engine, scopeOpen, code, engineState.isReady, engineState.isPlaying])

  useEffect(() => {
    const handleImport = () => {
      const pack = consumePendingSamplePack()
      if (!pack) {
        return
      }
      engine
        .loadSampleBank(pack.map, {
          label: pack.label,
          baseUrl: pack.baseUrl,
        })
        .then(() => {
          setImportNotice(`Imported ${pack.label} (${Object.keys(pack.map).length} samples)`)
          setTimeout(() => setImportNotice(null), 5000)
        })
        .catch((error) => {
          if (process.env.NODE_ENV !== 'production') {
            console.error('Failed to import sample pack', error)
          }
          setImportNotice('Failed to import sample pack. See console for details.')
        })
    }

    handleImport()
    window.addEventListener('strudel-sample-pack-import', handleImport)
    return () => {
      window.removeEventListener('strudel-sample-pack-import', handleImport)
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
      editorViewRef.current = null
    }
  }, [engine])

  const sliderWidgets = useMemo(
    () => (engineState.widgets ?? []).filter((widget): widget is SliderWidgetConfig => widget.type === 'slider'),
    [engineState.widgets],
  )

  useEffect(() => {
    const view = editorViewRef.current
    if (!view) {
      return
    }
    updateSliderWidgets(view, sliderWidgets)
  }, [sliderWidgets])

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
      sliderPlugin,
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
    <WorkspaceSurface>
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
            <Button
              size="icon"
              variant={scopeOpen ? 'default' : 'outline'}
              onClick={() => setScopeOpen(!scopeOpen)}
              disabled={!engineState.isReady}
              aria-label={scopeOpen ? 'Close scope visualization' : 'Open scope visualization'}
            >
              <Waves className="size-4" />
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
            onCreateEditor={(view) => {
              editorViewRef.current = view
              updateSliderWidgets(view, sliderWidgets)
            }}
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
          {importNotice ? (
            <p className="rounded-md border border-primary/50 bg-primary/10 px-3 py-2 text-primary">
              {importNotice}
            </p>
          ) : null}
          {engineState.error ? (
            <p className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-destructive">
              {engineState.error}
            </p>
          ) : null}
        </div>
        <section className="rounded-xl border border-border/60 bg-muted/20 p-3">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded-lg px-1 py-1 text-left transition-colors hover:text-foreground"
            onClick={() => setSampleToolsOpen((prev) => !prev)}
            aria-expanded={sampleToolsOpen}
            aria-controls={sampleToolsPanelId}
          >
            <div>
              <p className="text-sm font-semibold">Sample loading tools</p>
              <p className="text-xs text-muted-foreground">
                Load custom banks or open the sample picker when you need it.
              </p>
            </div>
            <ChevronDown
              className={cn('size-4 transition-transform', sampleToolsOpen && 'rotate-180')}
            />
          </button>
          <div
            id={sampleToolsPanelId}
            aria-hidden={!sampleToolsOpen}
            className={cn(
              'grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out',
              sampleToolsOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
            )}
          >
            <div
              className={cn(
                'min-h-0 overflow-hidden pt-4 transition-opacity duration-300 ease-out',
                sampleToolsOpen ? 'opacity-100' : 'opacity-0',
              )}
            >
              <SampleBankSection
                engine={engine}
                banks={engineState.sampleBanks}
                engineReady={engineState.isReady}
                onOpenSamplePicker={onOpenSamplePicker}
              />
            </div>
          </div>
        </section>
      </CardContent>
    </Card>
    <ScopeVisualization
      open={scopeOpen}
      onClose={() => setScopeOpen(false)}
      containerRef={scopeContainerRef}
    />
    </WorkspaceSurface>
  )
}

type SampleBankSectionProps = {
  engine: StrudelEngine
  banks: SampleBankState[]
  engineReady: boolean
  onOpenSamplePicker?: () => void
}

const SAMPLE_MAP_EXAMPLE = `{
  "bd": "bd/BT0AADA.wav",
  "sd": "sd/rytm-01-classic.wav",
  "hh": "hh27/000_hh27closedhh.wav"
}`

function SampleBankSection({ engine, banks, engineReady, onOpenSamplePicker }: SampleBankSectionProps) {
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
    <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
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

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button type="submit" disabled={isSubmitting || !engineReady}>
            {isSubmitting ? 'Loading…' : 'Load Sample Bank'}
          </Button>
          {onOpenSamplePicker ? (
            <Button type="button" size="sm" variant="ghost" onClick={onOpenSamplePicker}>
              <PackageSearch className="mr-1 size-4" />
              Use Sample Picker
            </Button>
          ) : null}
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

