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
import { api, boxToRect, checkCancelled, emit, hexOr, mapLimit, skip, track, tryTrack, type PipelineCtx } from './shared'
import { PROMPT_NODE, aspectToSize, segment } from './compose'

const SEG_CONCURRENCY = 8

/**
 * Pipeline B — post-hoc decomposition, pure API.
 *
 * This is the ReDesign shape, minus the local GPU: the vision model plays the
 * controller (read the layout, transcribe the type), native grounding supplies
 * masks, and the image model does the inpainting that a local LaMa would do.
 * Ceiling is roughly PSNR 26 — good enough to edit, never pixel-exact.
 */
export type DecomposeResult = { scene: Scene; source: string; tailNodes: string[] }

/** Every decompose branch of a board starts from the same flat raster. */
export const SOURCE_NODE = 'n:source'

/** Shared upstream for pipeline B: generate the flat raster once for every branch. */
export async function prepareSource(
  ctx: PipelineCtx,
  prompt: string,
  opts: DecomposeOptions,
  models: { image: string },
): Promise<string> {
  return track(
    ctx,
    'flat',
    '生成一张拍平的成品图',
    async () => {
      const json = await api<any>('/api/generate', ctx, {
        prompt: flatPrompt(prompt, true),
        aspectRatio: opts.aspectRatio,
        resolution: opts.resolution,
        model: models.image,
      })
      ctx.onArtifact({ label: '来源平图', src: json.images[0], role: 'source' })
      return {
        value: json.images[0] as string,
        usage: json.usage as UsageInfo,
        images: [{ label: '来源平图', src: json.images[0] }],
      }
    },
    { id: SOURCE_NODE, kind: 'source', inputs: [PROMPT_NODE] },
  )
}

export async function runDecompose(
  ctx: PipelineCtx,
  input: { prompt: string; sourceImage?: string; prepared?: boolean },
  opts: DecomposeOptions,
  models: { image: string; vision: string; grounding: string },
): Promise<DecomposeResult> {
  let width: number
  let height: number
  let flat: string
  const B = ctx.branchId

  // 1 ── source raster
  if (input.sourceImage) {
    flat = input.sourceImage
    const size = await imageSize(flat)
    width = size.width
    height = size.height
    const origin = input.prepared ? '共享来源图' : '用户上传'
    skip(ctx, 'flat', '来源图', `${origin} · ${width}×${height}`)
    ctx.onArtifact({ label: '来源平图', src: flat, role: 'source' })
    emit(ctx, {
      id: SOURCE_NODE,
      kind: 'source',
      label: '来源平图',
      detail: `${origin} · ${width}×${height}`,
      inputs: [PROMPT_NODE],
      status: 'ok',
      images: [{ label: '来源平图', src: flat }],
    })
  } else {
    const planned = aspectToSize(opts.aspectRatio, opts.resolution)
    flat = await track(
      ctx,
      'flat',
      '生成一张拍平的成品图',
      async () => {
        const json = await api<any>('/api/generate', ctx, {
          prompt: flatPrompt(input.prompt, true),
          aspectRatio: opts.aspectRatio,
          resolution: opts.resolution,
          model: models.image,
        })
        ctx.onArtifact({ label: '来源平图', src: json.images[0], role: 'source' })
        return {
          value: json.images[0] as string,
          usage: json.usage as UsageInfo,
          images: [{ label: '来源平图', src: json.images[0] }],
        }
      },
      { id: SOURCE_NODE, kind: 'source', inputs: [PROMPT_NODE] },
    )
    const size = await imageSize(flat)
    width = size.width || planned.width
    height = size.height || planned.height
  }

  // 2 ── read the layout back off the pixels
  const analyzeNode = `n:${B}:analysis`
  const analysis = await track(
    ctx,
    'analyze',
    '读版面：元素 + 文字 + z-order',
    async () => {
      const json = await api<any>('/api/analyze', ctx, {
        image: flat,
        width,
        height,
        maxElements: opts.maxElements,
        model: opts.visionModel || undefined,
      })
      const a = json.analysis as SceneAnalysis
      const els = a.elements.map((e) => `· ${e.label}`).join('\n')
      const txt = a.texts.map((t) => `「${t.content}」`).join('  ')
      return {
        value: a,
        usage: json.usage as UsageInfo,
        detail: `${a.elements.length} 个元素 · ${a.texts.length} 段文字`,
        summary: [els, txt].filter(Boolean).join('\n') || '什么都没读出来',
      }
    },
    { id: analyzeNode, kind: 'analysis', inputs: [SOURCE_NODE] },
  )

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
  emit(ctx, {
    id: `n:${B}:segment`,
    kind: 'renders',
    label: opts.useMasks ? `分割掩码 ×${analysis.elements.length}` : '分割掩码（已关闭）',
    detail: opts.useMasks
      ? `${Object.values(masks).filter((m) => m.mask).length}/${analysis.elements.length} 个拿到掩码`
      : '元素退化为 bbox 矩形裁切',
    inputs: [analyzeNode],
    status: opts.useMasks ? 'ok' : 'skipped',
  })

  // 4 ── lift each element out of the flat raster
  const cutsNode = `n:${B}:cuts`
  const cutShots: { label: string; src: string }[] = []
  emit(ctx, {
    id: cutsNode,
    kind: 'cuts',
    label: `切图 ×${analysis.elements.length}`,
    inputs: [`n:${B}:segment`],
    status: 'running',
  })

  const elementLayers = await mapLimit(analysis.elements, SEG_CONCURRENCY, async (el, i) => {
    try {
      return await track(ctx, `cut-${el.id}`, `切图 ${i + 1}/${analysis.elements.length}：${el.label}`, async () => {
        const hit = masks[el.id]
        // The grounding box is tighter than the layout box when it exists; fall
        // back to what the layout pass reported otherwise.
        const box = hit?.box ?? el.box
        const matte = hit?.mask ? await maskMatte(flat, hit.mask, box) : await cropBox(flat, box)

        ctx.onArtifact({ label: `${el.label} · 切出`, src: matte.src, role: 'cut' })
        cutShots.push({ label: el.label, src: matte.src })
        emit(ctx, {
          id: cutsNode,
          kind: 'cuts',
          label: `切图 ×${analysis.elements.length}`,
          inputs: [`n:${B}:segment`],
          status: 'running',
          images: [...cutShots],
        })

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

  emit(ctx, {
    id: cutsNode,
    kind: 'cuts',
    label: `切图 ×${analysis.elements.length}`,
    detail: Object.values(masks).some((m) => m.mask) ? '掩码切出' : 'bbox 矩形裁切，无 alpha',
    inputs: [`n:${B}:segment`],
    status: 'ok',
    images: [...cutShots],
  })

  // 5 ── reconstruct what was underneath
  const plateNode = `n:${B}:erase`
  let plate = flat
  if (opts.inpaintBackground) {
    plate = await tryTrack(
      ctx,
      'inpaint',
      '擦除元素与文字，重建背景板',
      async () => {
        const json = await api<any>('/api/erase', ctx, {
          image: flat,
          targets: analysis.elements.map((e) => e.label),
          aspectRatio: opts.aspectRatio,
          resolution: opts.resolution,
          model: models.image,
        })
        ctx.onArtifact({ label: '重建的背景板', src: json.image, role: 'plate' })
        return {
          value: json.image as string,
          usage: json.usage as UsageInfo,
          images: [{ label: '重建的背景板', src: json.image }],
        }
      },
      { id: plateNode, kind: 'erase', inputs: [SOURCE_NODE, analyzeNode] },
      { value: flat, note: '重建被拒，背景层沿用原图（元素会重影）' },
    )
  } else {
    skip(
      ctx,
      'inpaint',
      '背景重建',
      '已关闭，背景层仍是原始平图（元素会重影）',
      { id: plateNode, kind: 'erase', inputs: [SOURCE_NODE] },
    )
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
    tailNodes: [plateNode, cutsNode],
  }
}
