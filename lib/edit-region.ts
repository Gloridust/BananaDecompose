'use client'

import { featherEdges, imageSize, loadImage } from './matte'
import { sceneToPng } from './export'
import { editRegionPrompt } from './prompts'
import type { ImageLayer, Scene } from './types'

/**
 * Marquee a region, hand it to the image model with an instruction, drop the
 * result back as its own layer.
 *
 * The crop carries a margin of its surroundings so the model can match the
 * lighting and style it is being returned to, and the patch comes back as a
 * layer rather than being flattened into the plate — an edit you cannot switch
 * off or move afterwards is not an edit in a layered file, it is a commit.
 */
export async function editRegion(
  scene: Scene,
  region: { x: number; y: number; w: number; h: number },
  instruction: string,
  opts: { model?: string; signal?: AbortSignal; contextPad?: number } = {},
): Promise<{ layer: ImageLayer; cost: number }> {
  const pad = opts.contextPad ?? 0.18
  const flat = await sceneToPng(scene)
  const img = await loadImage(flat)

  const px = region.w * pad
  const py = region.h * pad
  const sx = Math.max(0, Math.round(region.x - px))
  const sy = Math.max(0, Math.round(region.y - py))
  const sw = Math.min(img.naturalWidth - sx, Math.round(region.w + px * 2))
  const sh = Math.min(img.naturalHeight - sy, Math.round(region.h + py * 2))
  if (sw < 8 || sh < 8) throw new Error('圈选的区域太小了')

  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
  const crop = canvas.toDataURL('image/png')

  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: editRegionPrompt(instruction),
      references: [crop],
      aspectRatio: aspectOf(sw, sh),
      model: opts.model,
    }),
    signal: opts.signal,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)

  const patched = await featherEdges(json.images[0], Math.round(Math.min(sw, sh) * 0.09))
  const size = await imageSize(patched)

  const layer: ImageLayer = {
    id: `edit-${Date.now().toString(36)}`,
    type: 'image',
    name: `局部编辑 · ${instruction.slice(0, 16)}`,
    x: sx,
    y: sy,
    w: sw,
    h: sh,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    src: patched,
    matte: 'none',
    provenance: `圈选重绘 · 「${instruction}」 · 边缘羽化后叠放，可随时隐藏或删除 · ${size.width}×${size.height}`,
  }

  return { layer, cost: Number(json?.usage?.cost ?? 0) }
}

/** Regenerate one existing layer in place, using its own pixels as the reference. */
export async function editLayer(
  layer: ImageLayer,
  instruction: string,
  opts: { model?: string; signal?: AbortSignal } = {},
): Promise<{ src: string; cost: number }> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: `${editRegionPrompt(instruction)}\n\nThe subject sits on a transparent background; keep it isolated with nothing added around it.`,
      references: [layer.src],
      aspectRatio: '1:1',
      model: opts.model,
    }),
    signal: opts.signal,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
  return { src: json.images[0] as string, cost: Number(json?.usage?.cost ?? 0) }
}

/** Nearest ratio the image API accepts, so the model does not reframe the crop. */
function aspectOf(w: number, h: number) {
  const options: [string, number][] = [
    ['1:1', 1], ['4:5', 0.8], ['3:2', 1.5], ['2:3', 2 / 3], ['16:9', 16 / 9], ['9:16', 9 / 16],
  ]
  const target = w / h
  return options.reduce((best, o) => (Math.abs(o[1] - target) < Math.abs(best[1] - target) ? o : best))[0]
}
