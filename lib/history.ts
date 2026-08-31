'use client'

import { clear, createStore, del, get, set } from 'idb-keyval'
import type { Board, BoardMeta } from './types'

// The board index lives in localStorage so the history list paints instantly and
// stays inspectable in devtools. Full boards — megabytes of node images as data
// URIs — live in IndexedDB, because localStorage's ~5MB quota fits roughly two
// generated images and this demo exists to keep many boards side by side.
//
// Key is versioned: records from before the board model cannot be rendered by the
// current UI, so they are left behind rather than crashing the list.
const INDEX_KEY = 'bd:boards:index:v2'
const store = createStore('banana-decompose', 'boards')

function readIndex(): BoardMeta[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(INDEX_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeIndex(index: BoardMeta[]) {
  try {
    window.localStorage.setItem(INDEX_KEY, JSON.stringify(index))
  } catch {
    // Quota blown by thumbnails — keep the newest previews, drop the rest.
    const slim = index.map((m, i) => (i < 12 ? m : { ...m, thumbnail: undefined }))
    try {
      window.localStorage.setItem(INDEX_KEY, JSON.stringify(slim))
    } catch {
      /* give up silently; IndexedDB still holds the boards */
    }
  }
}

export function listBoards(): BoardMeta[] {
  return readIndex().sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveBoard(board: Board) {
  await set(`board:${board.id}`, board, store)
  const { branches: _b, nodes: _n, ...meta } = board
  const index = readIndex().filter((m) => m.id !== board.id)
  index.unshift(meta)
  writeIndex(index)
  return meta as BoardMeta
}

export async function getBoard(id: string): Promise<Board | undefined> {
  return get<Board>(`board:${id}`, store)
}

export async function deleteBoard(id: string) {
  await del(`board:${id}`, store)
  writeIndex(readIndex().filter((m) => m.id !== id))
}

export async function clearBoards() {
  await clear(store)
  writeIndex([])
}

export function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
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
