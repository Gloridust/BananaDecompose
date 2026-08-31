'use client'

import { schedule } from './scheduler'
import type { Artifact, BoardNode, RunStep, UsageInfo } from '../types'

/** A node emitted by a pipeline. The board owner merges by id and records which
 *  branch asked for it, so a shared node ends up listing every branch it feeds. */
export type NodeEmit = Omit<BoardNode, 'branches'>

export type PipelineCtx = {
  signal?: AbortSignal
  /** Namespaces per-branch node ids. */
  branchId: string
  /** Namespaces the shared upstream nodes, so a board can hold several rounds. */
  runKey: string
  /** Branches that consume the nodes this execution emits. The shared-upstream
   *  prepare phase lists every branch it feeds, so those nodes are drawn once
   *  and badged with how many chains depend on them. */
  attribution?: string[]
  onStep: (step: RunStep) => void
  onArtifact: (artifact: Artifact) => void
  onNode: (node: NodeEmit) => void
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

/** Every model call goes through the global scheduler, so total in-flight
 *  requests stay bounded no matter how many branches are running at once. */
export async function api<T>(path: string, ctx: PipelineCtx, body: unknown): Promise<T> {
  checkCancelled(ctx)
  return schedule(async () => {
    checkCancelled(ctx)
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctx.signal,
    })
    const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
    return json as T
  })
}

/** Describes the board node a unit of work produces. */
export type NodeSpec = {
  id: string
  kind: BoardNode['kind']
  inputs: string[]
}

/** Wraps one unit of work with timing, cost accounting, step reporting and — when
 *  a node spec is given — live node emission so the board fills in as it runs. */
export async function track<T>(
  ctx: PipelineCtx,
  id: string,
  label: string,
  fn: () => Promise<{
    value: T
    usage?: UsageInfo
    detail?: string
    images?: { label: string; src: string }[]
    summary?: string
  }>,
  node?: NodeSpec,
): Promise<T> {
  checkCancelled(ctx)
  const started = performance.now()
  ctx.onStep({ id, label, status: 'running' })
  if (node) ctx.onNode({ ...node, label, status: 'running' })

  try {
    const { value, usage, detail, images, summary } = await fn()
    const ms = Math.round(performance.now() - started)
    const cost = usage?.cost ?? 0
    ctx.totals.cost += cost
    ctx.totals.ms += ms
    ctx.onStep({ id, label, status: 'ok', ms, cost, detail })
    if (node) ctx.onNode({ ...node, label, status: 'ok', ms, cost, detail, images, summary })
    return value
  } catch (err) {
    const ms = Math.round(performance.now() - started)
    if (err instanceof Cancelled || (err as Error)?.name === 'AbortError') {
      ctx.onStep({ id, label, status: 'skipped', ms, detail: '已取消' })
      if (node) ctx.onNode({ ...node, label, status: 'skipped', ms, detail: '已取消' })
      throw new Cancelled()
    }
    const message = (err as Error).message
    ctx.onStep({ id, label, status: 'error', ms, error: message })
    if (node) ctx.onNode({ ...node, label, status: 'error', ms, error: message })
    throw err
  }
}

export function skip(ctx: PipelineCtx, id: string, label: string, detail: string, node?: NodeSpec) {
  ctx.onStep({ id, label, status: 'skipped', detail })
  if (node) ctx.onNode({ ...node, label, status: 'skipped', detail })
}

/** Emit or update a node outside of a tracked unit of work. */
export function emit(ctx: PipelineCtx, node: NodeEmit) {
  ctx.onNode(node)
}

/**
 * Like track(), but a failure degrades instead of killing the branch.
 *
 * Provider-side refusals are routine here — Gemini's copyright filter rejects
 * background-restoration calls on artwork containing stylised type often enough
 * that treating it as fatal would throw away an otherwise complete branch.
 */
export async function tryTrack<T>(
  ctx: PipelineCtx,
  id: string,
  label: string,
  fn: () => Promise<{
    value: T
    usage?: UsageInfo
    detail?: string
    images?: { label: string; src: string }[]
    summary?: string
  }>,
  node: NodeSpec,
  fallback: { value: T; note: string },
): Promise<T> {
  try {
    return await track(ctx, id, label, fn, node)
  } catch (err) {
    if (err instanceof Cancelled || (err as Error)?.name === 'Cancelled') throw err
    const message = (err as Error).message
    ctx.onStep({ id, label, status: 'skipped', detail: `${fallback.note}（${message}）` })
    ctx.onNode({
      ...node,
      label,
      status: 'skipped',
      detail: fallback.note,
      error: message,
    })
    return fallback.value
  }
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

/** Fan items out within one branch. The real throttle is the global scheduler —
 *  this cap only bounds how much of one branch's work is outstanding at once. */
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
