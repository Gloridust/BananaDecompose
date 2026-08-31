'use client'

import { clear, createStore, del, get, set } from 'idb-keyval'
import type { Run, RunMeta } from './types'

// The run index lives in localStorage so the history list paints instantly and
// stays inspectable in devtools. The full runs — which carry megabytes of layer
// PNGs as data URIs — live in IndexedDB, because localStorage's ~5MB quota fits
// roughly two generated images and this demo exists to compare many runs.
const INDEX_KEY = 'bd:runs:index'
const store = createStore('banana-decompose', 'runs')

function readIndex(): RunMeta[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(INDEX_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeIndex(index: RunMeta[]) {
  try {
    window.localStorage.setItem(INDEX_KEY, JSON.stringify(index))
  } catch {
    // Quota blown by thumbnails — drop the oldest thumbnails and retry once.
    const slim = index.map((m, i) => (i < 12 ? m : { ...m, thumbnail: undefined }))
    try {
      window.localStorage.setItem(INDEX_KEY, JSON.stringify(slim))
    } catch {
      /* give up silently; IndexedDB still has the runs */
    }
  }
}

export function listRuns(): RunMeta[] {
  return readIndex().sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveRun(run: Run) {
  await set(`run:${run.id}`, run, store)
  const { scene: _scene, steps: _steps, artifacts: _artifacts, ...meta } = run
  const index = readIndex().filter((m) => m.id !== run.id)
  index.unshift(meta)
  writeIndex(index)
  return meta as RunMeta
}

export async function getRun(id: string): Promise<Run | undefined> {
  return get<Run>(`run:${id}`, store)
}

export async function deleteRun(id: string) {
  await del(`run:${id}`, store)
  writeIndex(readIndex().filter((m) => m.id !== id))
}

export async function clearRuns() {
  await clear(store)
  writeIndex([])
}

export function newRunId() {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${Date.now().toString(36)}-${rand}`
}

// ------------------------------------------------------------ settings

const SETTINGS_KEY = 'bd:settings'

export function loadSettings<T>(fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}

export function saveSettings(value: unknown) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(value))
  } catch {
    /* non-fatal */
  }
}
