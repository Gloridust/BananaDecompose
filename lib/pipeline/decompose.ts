'use client'

import { cropBox, imageSize, maskMatte } from '../matte'
import { flatPrompt } from '../prompts'
import type {
  DecomposeOptions,
  ImageLayer,
  Layer,
  Scene,
  SceneAnalysis,
  TextLayer,
  UsageInfo,
} from '../types'
import { boxToRect, checkCancelled, hexOr, mapLimit, skip, track, type PipelineCtx } from './shared'
import { aspectToSize, segment } from './compose'

const SEG_CONCURRENCY = 2

/**
 * Pipeline B — post-hoc decomposition, pure API.
 *
 * This is the ReDesign shape, minus the local GPU: the vision model plays the
 * controller (read the layout, transcribe the type), native grounding supplies
 * masks, and the image model does the inpainting that a local LaMa would do.
 * Ceiling is roughly PSNR 26 — good enough to edit, never pixel-exact.
 */
export type DecomposeResult = { scene: Scene; source: string }

export async function runDecompose(
  ctx: PipelineCtx,
  input: { prompt: string; sourceImage?: string },
  opts: DecomposeOptions,
  models: { image: string; vision: string; grounding: string },
): Promise<DecomposeResult> {
  let width: number
  let height: number
  let flat: string

  // 1 ── source raster
  if (input.sourceImage) {
    flat = input.sourceImage
    const size = await imageSize(flat)
    width = size.width
    height = size.height
    skip(ctx, 'flat', '来源图', `用户上传 · ${width}×${height}`)
    ctx.onArtifact({ label: '来源平图', src: flat, role: 'source' })
  } else {
    const planned = aspectToSize(opts.aspectRatio, opts.resolution)
    flat = await track(ctx, 'flat', '生成一张拍平的成品图', async () => {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: flatPrompt(input.prompt, true),
          aspectRatio: opts.aspectRatio,
          resolution: opts.resolution,
          model: models.image,
        }),
        signal: ctx.signal,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
      ctx.onArtifact({ label: '来源平图', src: json.images[0], role: 'source' })
      return { value: json.images[0] as string, usage: json.usage as UsageInfo }
    })
    const size = await imageSize(flat)
    width = size.width || planned.width
    height = size.height || planned.height
  }

  // 2 ── read the layout back off the pixels
  const analysis = await track(ctx, 'analyze', '读版面：元素 + 文字 + z-order', async () => {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: flat, width, height, maxElements: opts.maxElements, model: opts.visionModel || undefined }),
      signal: ctx.signal,
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
    const a = json.analysis as SceneAnalysis
    return {
      value: a,
      usage: json.usage as UsageInfo,
      detail: `${a.elements.length} 个元素 · ${a.texts.length} 段文字`,
    }
  })

  // 3 ── masks (or plain box crops if grounding declines)
  //
  // One request per object, run with a small concurrency cap. Batching every mask
  // into one completion was measured at >170s before timing out: each mask is
  // base64 text in the response stream, so they add up fast.
  let masks: Record<string, { box: [number, number, number, number] | null; mask: string | null }> = {}
  if (opts.useMasks && analysis.elements.length) {
    masks = await track(ctx, 'segment', `请求分割掩码 ×${analysis.elements.length}`, async () => {
      let cost = 0
      const notes: string[] = []
      const out: typeof masks = {}

      const results = await mapLimit(analysis.elements, SEG_CONCURRENCY, async (el) => {
        try {
          return { el, seg: await segment(ctx, flat, el.label, opts.groundingModel || models.grounding) }
        } catch (err) {
          if ((err as Error).name === 'Cancelled') throw err
          return { el, seg: null }
        }
      })

      for (const { el, seg } of results) {
        cost += seg?.usage?.cost ?? 0
        if (seg?.mask) out[el.id] = { box: seg.box, mask: seg.mask }
        else if (seg?.box) out[el.id] = { box: seg.box, mask: null }
        if (seg?.reason && !notes.includes(seg.reason)) notes.push(seg.reason)
      }

      const withMask = Object.values(out).filter((m) => m.mask).length
      return {
        value: out,
        usage: { cost },
        detail: withMask
          ? `${withMask}/${analysis.elements.length} 个拿到掩码${notes.length ? ` · ${notes.join('；')}` : ''}`
          : `一个掩码都没拿到，全部降级为矩形裁切${notes.length ? ` · ${notes.join('；')}` : ''}`,
      }
    })
  } else {
    skip(ctx, 'segment', '分割掩码', '已关闭，元素按 bbox 矩形裁切')
  }

  // 4 ── lift each element out of the flat raster
  const elementLayers = await mapLimit(analysis.elements, SEG_CONCURRENCY, async (el, i) => {
    try {
      return await track(ctx, `cut-${el.id}`, `切图 ${i + 1}/${analysis.elements.length}：${el.label}`, async () => {
        const hit = masks[el.id]
        // The grounding box is tighter than the layout box when it exists; fall
        // back to what the layout pass reported otherwise.
        const box = hit?.box ?? el.box
        const matte = hit?.mask ? await maskMatte(flat, hit.mask, box) : await cropBox(flat, box)

        ctx.onArtifact({ label: `${el.label} · 切出`, src: matte.src, role: 'cut' })

        const layer: ImageLayer = {
          id: el.id,
          type: 'image',
          name: el.label,
          x: matte.bounds.x * width,
          y: matte.bounds.y * height,
          w: matte.bounds.w * width,
          h: matte.bounds.h * height,
          rotation: 0,
          opacity: 1,
          visible: true,
          locked: false,
          src: matte.src,
          matte: hit?.mask ? 'vlm-mask' : 'none',
          provenance: hit?.mask
            ? `分割掩码切出 · 覆盖率 ${(matte.coverage * 100).toFixed(0)}%`
            : 'bbox 矩形裁切 · 无 alpha',
        }
        return { value: layer, detail: hit?.mask ? '掩码' : '矩形' }
      })
    } catch (err) {
      if ((err as Error).name === 'Cancelled') throw err
      return null
    }
  })

  checkCancelled(ctx)

  // 5 ── reconstruct what was underneath
  let plate = flat
  if (opts.inpaintBackground) {
    plate = await track(ctx, 'inpaint', '擦除元素与文字，重建背景板', async () => {
      const res = await fetch('/api/erase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: flat,
          targets: analysis.elements.map((e) => e.label),
          aspectRatio: opts.aspectRatio,
          resolution: opts.resolution,
          model: models.image,
        }),
        signal: ctx.signal,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
      ctx.onArtifact({ label: '重建的背景板', src: json.image, role: 'plate' })
      return { value: json.image as string, usage: json.usage as UsageInfo }
    })
  } else {
    skip(ctx, 'inpaint', '背景重建', '已关闭，背景层仍是原始平图（元素会重影）')
  }

  // 6 ── assemble
  const background: ImageLayer = {
    id: 'background',
    type: 'image',
    name: '背景板',
    x: 0,
    y: 0,
    w: width,
    h: height,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    src: plate,
    matte: 'none',
    provenance: opts.inpaintBackground ? '模型重绘补全' : '原始平图（未重建）',
  }

  const textLayers: TextLayer[] = analysis.texts.map((t, i) => {
    const rect = boxToRect(t.box, width, height)
    const size = Number(t.fontSize)
    return {
      id: t.id || `tx-${i}`,
      type: 'text',
      name: t.content.slice(0, 24) || '文字',
      ...rect,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      text: t.content,
      fontFamily: t.fontFamily || 'Inter',
      fontSize: Number.isFinite(size) && size > 0 ? Math.min(size, rect.h * 1.6) : Math.max(12, rect.h * 0.78),
      fontWeight: t.fontWeight || 600,
      color: hexOr(t.color, '#ffffff'),
      align: t.align || 'left',
      lineHeight: 1.15,
      letterSpacing: 0,
      italic: Boolean(t.italic),
      provenance: 'OCR 回收 · 内容与字体均为模型推断',
    }
  })

  const elements = elementLayers.filter((l): l is ImageLayer => Boolean(l))
  const layers: Layer[] = [background, ...elements, ...textLayers]

  return {
    scene: {
      canvas: { width, height, background: hexOr(analysis.background.dominantColor, '#111114') },
      layers,
    },
    source: flat,
  }
}
