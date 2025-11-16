'use client'

export type PendingSamplePack = {
  label: string
  baseUrl?: string
  map: Record<string, string>
}

const STORAGE_KEY = 'strudel:pending-sample-pack'

export function savePendingSamplePack(pack: PendingSamplePack) {
  if (typeof window === 'undefined') {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pack))
  window.dispatchEvent(new Event('strudel-sample-pack-import'))
}

export function consumePendingSamplePack(): PendingSamplePack | null {
  if (typeof window === 'undefined') {
    return null
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return null
  }
  window.localStorage.removeItem(STORAGE_KEY)
  try {
    return JSON.parse(raw) as PendingSamplePack
  } catch {
    return null
  }
}

