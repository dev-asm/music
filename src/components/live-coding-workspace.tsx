'use client'

import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'

import CodeMirror from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { EditorState, Extension, RangeSetBuilder } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { Pause, Play, Square } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { StrudelEngine, type EngineState, type MiniLocation } from '@/lib/strudel-engine'

const DEFAULT_CODE = `// Patterns are composed with Strudel\'s mini-notation.
// Press Run Pattern to evaluate the code and hear the result.
stack(
  note("c4 e4 g4 c5").fast(2).gain(0.85),
  note("c3 g3").slow(2).gain(0.35)
)
`

const baseHighlight = Decoration.mark({ class: 'cm-mini-highlight' })
const activeHighlight = Decoration.mark({ class: 'cm-mini-active' })

function buildHighlightExtension(mini: MiniLocation[], active: MiniLocation[]): Extension {
  const builder = new RangeSetBuilder<Decoration>()
  mini.forEach(([from, to]) => {
    builder.add(from, to, baseHighlight)
  })
  active.forEach(([from, to]) => {
    builder.add(from, to, activeHighlight)
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

const engineInstance = () => new StrudelEngine()

function formatStatus(state: EngineState) {
  if (!state.isReady) {
    return 'Loading Strudel…'
  }
  if (state.error) {
    return 'Pattern error'
  }
  if (!state.audioUnlocked) {
    return 'Audio engine will start when you press Run or Play.'
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
  const engineRef = useRef<StrudelEngine>()
  if (!engineRef.current) {
    engineRef.current = engineInstance()
  }
  const engine = engineRef.current

  const [code, setCode] = useState(DEFAULT_CODE)
  const [engineState, setEngineState] = useState<EngineState>(engine.getState())

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
    () => buildHighlightExtension(engineState.miniLocations, engineState.activeLocations),
    [engineState.miniLocations, engineState.activeLocations],
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
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Evaluation error', error)
      }
    }
  }

  const handleToggle = async () => {
    if (!engineState.isReady) {
      return
    }
    if (engineState.isPlaying) {
      engine.pause()
      return
    }
    await engine.start()
  }

  const handleStop = () => {
    if (!engineState.isReady) {
      return
    }
    engine.stop()
  }

  const handleTempo = (event: ChangeEvent<HTMLInputElement>) => {
    if (!engineState.isReady) {
      return
    }
    const next = Number.parseInt(event.target.value, 10)
    if (Number.isFinite(next)) {
      engine.setTempo(next)
    }
  }

  return (
    <Card className="max-w-4xl mx-auto">
      <CardHeader>
        <CardTitle className="text-2xl">Strudel Live Coding</CardTitle>
        <CardDescription>
          Compose and perform generative music in the browser. Mini-notation segments highlight as
          they play.
        </CardDescription>
        <CardAction className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleRun} disabled={!engineState.isReady || engineState.isEvaluating}>
              <Play className="size-4" />
              <span className="ml-1">Run Pattern</span>
            </Button>
            <Button variant="outline" onClick={handleToggle} disabled={!engineState.isReady}>
              {engineState.isPlaying ? (
                <>
                  <Pause className="size-4" />
                  <span className="ml-1">Pause</span>
                </>
              ) : (
                <>
                  <Play className="size-4" />
                  <span className="ml-1">Play</span>
                </>
              )}
            </Button>
            <Button variant="ghost" onClick={handleStop} disabled={!engineState.isReady}>
              <Square className="size-4" />
              <span className="ml-1">Stop</span>
            </Button>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>Tempo</span>
            <input
              id="tempo"
              type="number"
              min={40}
              max={240}
              value={engineState.bpm}
              disabled={!engineState.isReady}
              onChange={handleTempo}
              className="w-20 rounded-md border border-border bg-transparent px-2 py-1 text-foreground"
            />
            <span className="text-xs uppercase tracking-tight">BPM</span>
          </label>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="rounded-xl border bg-muted/40 p-3">
          <CodeMirror
            value={code}
            height="320px"
            basicSetup={{ highlightActiveLine: false, foldGutter: true }}
            onChange={(value) => setCode(value)}
            extensions={extensions}
            theme="light"
          />
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-muted-foreground">{formatStatus(engineState)}</p>
          {engineState.error ? (
            <p className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-destructive">
              {engineState.error}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
