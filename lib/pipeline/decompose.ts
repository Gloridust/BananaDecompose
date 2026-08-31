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
import { aspectToSize } from './compose'

const SEG_CONCURRENCY = 2

/**
 * Pipeline B — post-hoc decomposition, pure API.
 *
 * This is the ReDesign shape, minus the local GPU: the vision model plays the
 * controller (read the layout, transcribe the type), native grounding supplies
 * masks, and the image model does the inpainting that a local LaMa would do.
 * Ceiling is roughly PSNR 26 — good enough to edit, never pixel-exact.
 */
export async function runDecompose(
  ctx: PipelineCtx,
  input: { prompt: string; sourceImage?: string },
  opts: DecomposeOptions,
  models: { image: string; vision: string; grounding: string },
): Promise<Scene> {
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
    ctx.onArtifact({ label: '来源平图', src: flat })
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
      ctx.onArtifact({ label: '来源平图', src: json.images[0] })
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
  let masks: Record<string, { box: [number, number, number, number]; mask: string | null }> = {}
  if (opts.useMasks && analysis.elements.length) {
    masks = await track(ctx, 'segment', '请求分割掩码', async () => {
      const res = await fetch('/api/segment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: flat,
          labels: analysis.elements.map((e) => e.label),
          model: opts.groundingModel || models.grounding,
        }),
        signal: ctx.signal,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)

      const out: typeof masks = {}
      const list = json.masks as { label: string; box: [number, number, number, number]; mask: string | null }[]
      analysis.elements.forEach((el, i) => {
        const hit = list.find((m) => m.label === el.label) ?? list[i]
        if (hit) out[el.id] = { box: hit.box, mask: hit.mask }
      })
      const withMask = Object.values(out).filter((m) => m.mask).length
      return {
        value: out,
        usage: json.usage as UsageInfo,
        detail: json.degraded
          ? `模型未返回掩码，降级为矩形裁切（${analysis.elements.length} 个）`
          : `${withMask}/${analysis.elements.length} 个拿到掩码`,
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
        const matte = hit?.mask
          ? await maskMatte(flat, hit.mask, hit.box)
          : await cropBox(flat, hit?.box ?? el.box)

        ctx.onArtifact({ label: `${el.label} · 切出`, src: matte.src })

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
      ctx.onArtifact({ label: '重建的背景板', src: json.image })
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
    canvas: { width, height, background: hexOr(analysis.background.dominantColor, '#111114') },
    layers,
  }
}
