'use client'

import type { Artifact, RunStep, UsageInfo } from '../types'

export type PipelineCtx = {
  signal?: AbortSignal
  onStep: (step: RunStep) => void
  onArtifact: (artifact: Artifact) => void
  /** Mutated as the run proceeds so the UI can show a live cost counter. */
  totals: { cost: number; ms: number }
}

export class Cancelled extends Error {
  constructor() {
    super('Run cancelled')
    this.name = 'Cancelled'
  }
}

export function checkCancelled(ctx: PipelineCtx) {
  if (ctx.signal?.aborted) throw new Cancelled()
}

export async function api<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
  return json as T
}

/** Wraps one unit of work with timing, cost accounting and step reporting. */
export async function track<T>(
  ctx: PipelineCtx,
  id: string,
  label: string,
  fn: () => Promise<{ value: T; usage?: UsageInfo; detail?: string }>,
): Promise<T> {
  checkCancelled(ctx)
  const started = performance.now()
  ctx.onStep({ id, label, status: 'running' })
  try {
    const { value, usage, detail } = await fn()
    const ms = Math.round(performance.now() - started)
    const cost = usage?.cost ?? 0
    ctx.totals.cost += cost
    ctx.totals.ms += ms
    ctx.onStep({ id, label, status: 'ok', ms, cost, detail })
    return value
  } catch (err) {
    const ms = Math.round(performance.now() - started)
    if (err instanceof Cancelled || (err as Error)?.name === 'AbortError') {
      ctx.onStep({ id, label, status: 'skipped', ms, detail: '已取消' })
      throw new Cancelled()
    }
    ctx.onStep({ id, label, status: 'error', ms, error: (err as Error).message })
    throw err
  }
}

export function skip(ctx: PipelineCtx, id: string, label: string, detail: string) {
  ctx.onStep({ id, label, status: 'skipped', detail })
}

/** 0..1000 [y0,x0,y1,x1] -> pixel rect on a w x h canvas. */
export function boxToRect(box: [number, number, number, number], w: number, h: number) {
  const [y0, x0, y1, x1] = box
  const x = (x0 / 1000) * w
  const y = (y0 / 1000) * h
  return {
    x,
    y,
    w: Math.max(1, ((x1 - x0) / 1000) * w),
    h: Math.max(1, ((y1 - y0) / 1000) * h),
  }
}

/** Run promises with a concurrency cap — image calls are slow and rate-limited. */
export async function mapLimit<A, B>(items: A[], limit: number, fn: (item: A, index: number) => Promise<B>) {
  const results = new Array<B>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

export function hexOr(value: string | undefined, fallback: string) {
  if (typeof value !== 'string') return fallback
  const v = value.trim()
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? v : fallback
}
