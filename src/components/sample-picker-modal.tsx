'use client'

import { useEffect, useMemo, useRef, useState } from "react"
import { X, Loader2, Music2, Plus, RefreshCcw, Share2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { WorkspaceSurface } from "@/components/workspace-surface"
import { savePendingSamplePack } from "@/lib/sample-bank-bridge"
import { buildRawUrl, fetchGithubTreeEntries, resolveGithubSource } from "@/lib/sample-pack"
import { cn } from "@/lib/utils"

type SamplePickerModalProps = {
  open: boolean
  onClose: () => void
  onMinimize?: () => void
}

type SampleCategory = {
  name: string
  items: SampleItem[]
}

type SampleItem = {
  id: string
  name: string
  path: string
  url: string
  category: string
  size?: number
}

type SelectionItem = SampleItem & {
  alias: string
}

const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.flac', '.aiff', '.aif', '.m4a']

export function SamplePickerModal({ open, onClose, onMinimize }: SamplePickerModalProps) {
  const [input, setInput] = useState("github:tidalcycles/dirt-samples")
  const [categories, setCategories] = useState<SampleCategory[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [activeSource, setActiveSource] = useState<{
    owner: string
    repo: string
    ref: string
    path?: string
  } | null>(null)
  const [selection, setSelection] = useState<SelectionItem[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const modalRef = useRef<HTMLDivElement | null>(null)

  const baseRawUrl = useMemo(() => {
    if (!activeSource) return ''
    return `https://raw.githubusercontent.com/${activeSource.owner}/${activeSource.repo}/${activeSource.ref}/`
  }, [activeSource])

  const sampleMap = useMemo(() => {
    const map: Record<string, string> = {}
    selection.forEach((item) => {
      map[item.alias || item.name] = item.path
    })
    return map
  }, [selection])

  const sampleJson = useMemo(() => JSON.stringify(sampleMap, null, 2), [sampleMap])

  const handleConnect = async () => {
    setStatus('loading')
    setError(null)
    try {
      const source = await resolveGithubSource(input)
      const treeEntries = await fetchGithubTreeEntries(source)
      const prefix = source.path ? `${source.path.replace(/\/+$/, '')}/` : ''
      const audioEntries = treeEntries.filter(
        (entry) => entry.type === 'blob' && isAudioFile(entry.path),
      )
      const grouped = new Map<string, SampleItem[]>()
      audioEntries.forEach((entry) => {
        if (prefix && !entry.path.startsWith(prefix)) {
          return
        }
        const relativePath = prefix ? entry.path.slice(prefix.length) : entry.path
        if (!relativePath) {
          return
        }
        const segments = relativePath.split('/')
        const fileName = segments.pop() ?? relativePath
        const categoryName = segments.length > 0 ? segments[0] : 'Root'
        const sample: SampleItem = {
          id: entry.path,
          name: fileName,
          path: entry.path,
          url: buildRawUrl(source, entry.path),
          category: categoryName,
          size: entry.size,
        }
        const bucket = grouped.get(categoryName) ?? []
        bucket.push(sample)
        grouped.set(categoryName, bucket)
      })
      const resolvedCategories = Array.from(grouped.entries()).map(([name, items]) => ({
        name,
        items,
      }))
      resolvedCategories.sort((a, b) => a.name.localeCompare(b.name))
      setCategories(resolvedCategories)
      setActiveSource({ owner: source.owner, repo: source.repo, ref: source.ref, path: source.path })
      setStatus('ready')
    } catch (err) {
      setStatus('error')
      setCategories([])
      setActiveSource(null)
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    }
  }

  const handlePreview = (item: SampleItem) => {
    if (!audioRef.current) {
      audioRef.current = new Audio()
    }
    const element = audioRef.current
    element.src = item.url
    element.currentTime = 0
    element.play().catch(() => {
      /* ignore */
    })
  }

  const handleAddSample = (item: SampleItem) => {
    setSelection((prev) => {
      if (prev.some((entry) => entry.id === item.id)) {
        return prev
      }
      const alias = makeAlias(item.name, prev.map((entry) => entry.alias))
      return [...prev, { ...item, alias }]
    })
  }

  const handleAliasChange = (id: string, alias: string) => {
    setSelection((prev) =>
      prev.map((item) => (item.id === id ? { ...item, alias: alias.replace(/\s+/g, '') } : item)),
    )
  }

  const handleRemoveSample = (id: string) => {
    setSelection((prev) => prev.filter((item) => item.id !== id))
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const data = event.dataTransfer.getData('application/json')
    if (!data) return
    try {
      const parsed = JSON.parse(data) as SampleItem
      handleAddSample(parsed)
    } catch {
      /* ignore */
    }
  }

  const handleImport = () => {
    const payload = {
      label: activeSource ? `${activeSource.repo}-${activeSource.ref}` : 'SamplePack',
      map: sampleMap,
      baseUrl: baseRawUrl,
    }
    savePendingSamplePack(payload)
    onClose()
  }

  useEffect(() => {
    if (open && status === 'idle') {
      void handleConnect()
    }
  }, [open, status])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) {
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
    }
  }, [open, onClose])

  const handleBackdropMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (modalRef.current?.contains(event.target as Node)) {
      return
    }
    if (onMinimize) {
      onMinimize()
    } else {
      onClose()
    }
  }

  return (
    <div
      className={cn(
        "sample-picker-overlay fixed inset-0 z-50 bg-black/70 backdrop-blur transition-opacity",
        open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
      )}
      onMouseDown={handleBackdropMouseDown}
    >
      <div className="relative flex h-full w-full items-start justify-center overflow-y-auto py-8">
        <div ref={modalRef} className="w-full max-w-5xl px-4">
          <WorkspaceSurface className="sample-picker-modal-inner">
            <Card className="relative bg-card">
            <button
              type="button"
              aria-label="Close sample picker"
              className="absolute right-4 top-4 rounded-full border border-border/60 bg-background p-2 text-muted-foreground transition hover:text-foreground"
              onClick={onClose}
            >
              <X className="size-4" />
            </button>
            <CardHeader className="space-y-2 text-center">
              <CardTitle className="text-3xl">Sample Picker</CardTitle>
              <CardDescription>
                Browse GitHub sample packs, audition sounds, and import them directly into the workspace.
              </CardDescription>
            </CardHeader>
              <CardContent className="space-y-6">
              <section className="rounded-xl border border-border/70 bg-muted/20 p-5">
                <div className="mb-3">
                  <p className="text-base font-semibold">GitHub Source</p>
                  <p className="text-sm text-muted-foreground">
                    Paste a GitHub URL or use the github:owner/repo shorthand.
                  </p>
                </div>
                <div className="flex flex-col gap-3 md:flex-row">
                  <Input
                    value={input}
                    onChange={(event) => setInput(event.currentTarget.value)}
                    placeholder="github:owner/repo/path"
                    className="flex-1"
                  />
                  <Button type="button" onClick={handleConnect} disabled={status === 'loading'}>
                    {status === 'loading' ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        Loading…
                      </>
                    ) : (
                      <>
                        <RefreshCcw className="mr-2 size-4" />
                        Connect
                      </>
                    )}
                  </Button>
                </div>
                {error ? <p className="pt-2 text-sm text-destructive">{error}</p> : null}
              </section>

              <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
                <Card>
                  <CardHeader>
                    <CardTitle>Browse Samples</CardTitle>
                    <CardDescription>
                      Drag a sample card into the basket or tap the plus button to add it.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    {status === 'loading' && (
                      <div className="flex min-h-[180px] items-center justify-center gap-2 text-muted-foreground">
                        <Loader2 className="size-5 animate-spin" />
                        Loading folders…
                      </div>
                    )}
                    {status === 'ready' && categories.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No audio files detected. Make sure your repository has folders of samples.
                      </p>
                    ) : null}
                    {categories.map((category) => (
                        <div key={category.name} className="rounded-lg border border-border/60 bg-muted/15 p-4">
                        <div className="mb-3 flex items-center justify-between">
                          <div>
                            <p className="font-semibold">{category.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {category.items.length} sample{category.items.length === 1 ? '' : 's'}
                            </p>
                          </div>
                        </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {category.items.map((item) => (
                          <div
                            key={item.id}
                            className="rounded-xl border border-border/50 bg-background/70 p-3 text-left transition hover:border-primary/70 focus-within:ring-2 focus-within:ring-ring"
                            draggable
                            onDragStart={(event) =>
                              event.dataTransfer.setData('application/json', JSON.stringify(item))
                            }
                            role="group"
                          >
                            <button
                              type="button"
                              className="flex w-full items-center justify-between text-left"
                              onClick={() => handlePreview(item)}
                              tabIndex={0}
                            >
                              <div>
                                <p className="font-medium">{item.name}</p>
                                <p className="text-xs text-muted-foreground">{formatSize(item.size)}</p>
                              </div>
                              <Music2 className="size-4 text-muted-foreground transition group-hover:text-primary" />
                            </button>
                            <div className="mt-3 flex items-center justify-between text-sm">
                              <Button type="button" variant="ghost" size="sm" onClick={() => handlePreview(item)}>
                                Play
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  handleAddSample(item)
                                }}
                              >
                                <Plus className="mr-1 size-4" />
                                Add
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card
                  className={cn('border-dashed', selection.length === 0 ? 'border-primary/40' : 'border-border/80')}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={handleDrop}
                >
                  <CardHeader>
                    <CardTitle>Sample Basket</CardTitle>
                    <CardDescription>
                      Drop samples here, edit aliases, and import the pack into your Strudel session.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {selection.length === 0 ? (
                      <p className="rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-6 text-center text-sm text-muted-foreground">
                        Drag samples from the left to assemble your pack.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        {selection.map((item) => (
                          <div
                            key={item.id}
                            className="flex items-center gap-3 rounded-lg border border-border/70 bg-background/80 p-3"
                          >
                            <Input
                              value={item.alias}
                              onChange={(event) => handleAliasChange(item.id, event.currentTarget.value)}
                              className="max-w-[160px] font-mono text-sm"
                            />
                            <p className="flex-1 truncate text-xs text-muted-foreground">{item.path}</p>
                            <Button variant="ghost" size="sm" onClick={() => handleRemoveSample(item.id)}>
                              Remove
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}

                    {selection.length > 0 && (
                      <div className="space-y-3">
                        <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                          <p className="mb-2 text-xs font-semibold text-muted-foreground">strudel.json snippet</p>
                          <code className="block max-h-48 overflow-auto rounded bg-background/70 p-3 text-xs">
                            {sampleJson}
                          </code>
                          <p className="mt-2 text-xs text-muted-foreground">Base URL: {baseRawUrl || '—'}</p>
                        </div>
                        <Button type="button" className="w-full" onClick={handleImport} disabled={!selection.length}>
                          <Share2 className="mr-2 size-4" />
                          Import to Environment
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </CardContent>
            </Card>
          </WorkspaceSurface>
        </div>
      </div>
    </div>
  )
}

function isAudioFile(name: string) {
  const lower = name.toLowerCase()
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function makeAlias(name: string, existing: string[]) {
  const base = name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 24) || 'sample'
  let alias = base
  let counter = 1
  while (existing.includes(alias)) {
    alias = `${base}${counter}`
    counter += 1
  }
  return alias
}

function formatSize(size?: number) {
  if (!size || Number.isNaN(size)) {
    return '—'
  }
  if (size < 1024) {
    return `${size} B`
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

