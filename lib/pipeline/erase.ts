'use client'

import { clusterRects, cropRect, pastePatch, type Rect } from '../matte'
import { erasePatchPrompt, erasePrompt } from '../prompts'
import { api, mapLimit, type PipelineCtx } from './shared'
import type { UsageInfo } from '../types'

/**
 * Clear the regions something was lifted out of, one patch at a time.
 *
 * Whole-frame erasure was measured re-toning an entire poster: the header band
 * came back several shades darker and the title was merely faded rather than
 * removed. A crop that is already mostly surface leaves the model far less
 * latitude, and compositing the result back means nothing outside the patch can
 * drift at all — the untouched parts stay bit-identical.
 */

const PATCH_CONCURRENCY = 3
/** Beyond this share of the frame a "patch" is really the whole picture again. */
const MAX_PATCH_AREA = 0.55
const CONTEXT_PAD = 0.35

export type EraseResult = {
  /** The plate with every patch composited in, or null when nothing worked. */
  plate: string | null
  cost: number
  patches: { rect: Rect; ok: boolean; reason?: string }[]
  note: string
}

export async function erasePatches(
  ctx: PipelineCtx,
  source: string,
  regions: Rect[],
  frame: { width: number; height: number },
  opts: { model?: string; aspectRatio?: string; resolution?: string; targets?: string[] },
): Promise<EraseResult> {
  if (!regions.length) return { plate: null, cost: 0, patches: [], note: '没有要清除的区域' }

  const clusters = clusterRects(regions, Math.max(16, Math.min(frame.width, frame.height) * 0.02))
  const frameArea = frame.width * frame.height
  const oversized = clusters.filter((c) => (c.w * c.h) / frameArea > MAX_PATCH_AREA)

  // A cluster covering most of the frame is not a patch; fall back to asking for
  // the whole thing, which at least keeps the framing consistent.
  if (oversized.length) {
    const json = await api<{ image: string; usage?: UsageInfo }>('/api/erase', ctx, {
      image: source,
      targets: opts.targets ?? [],
      aspectRatio: opts.aspectRatio,
      resolution: opts.resolution,
      model: opts.model,
    })
    return {
      plate: json.image,
      cost: json.usage?.cost ?? 0,
      patches: clusters.map((rect) => ({ rect, ok: true })),
      note: `有区域覆盖了 ${Math.round(((oversized[0].w * oversized[0].h) / frameArea) * 100)}% 画面，改为整帧重建`,
    }
  }

  let cost = 0
  const results = await mapLimit(clusters, PATCH_CONCURRENCY, async (rect) => {
    try {
      const crop = await cropRect(source, rect, CONTEXT_PAD)
      const json = await api<{ images: string[]; usage?: UsageInfo }>('/api/generate', ctx, {
        prompt: erasePatchPrompt(),
        references: [crop.src],
        model: opts.model,
      })
      cost += json.usage?.cost ?? 0
      return { rect: crop.rect, patch: json.images[0], ok: true as const }
    } catch (err) {
      if ((err as Error).name === 'Cancelled') throw err
      return { rect, patch: null, ok: false as const, reason: (err as Error).message }
    }
  })

  let plate = source
  let applied = 0
  for (const r of results) {
    if (!r.ok || !r.patch) continue
    try {
      plate = await pastePatch(plate, r.patch, r.rect)
      applied++
    } catch {
      /* an undecodable patch just leaves that region as it was */
    }
  }

  const failed = results.filter((r) => !r.ok)
  return {
    plate: applied ? plate : null,
    cost,
    patches: results.map((r) => ({ rect: r.rect, ok: r.ok, reason: r.ok ? undefined : r.reason })),
    note: `${applied}/${clusters.length} 块清除成功${failed.length ? ` · ${failed[0].reason}` : ''}`,
  }
}

/** Kept so the whole-frame path still has a prompt when it is the right call. */
export { erasePrompt }
