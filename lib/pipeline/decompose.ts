'use client'

import { compositeMasked, imageSize, maskMatte } from '../matte'
import { flatPrompt } from '../prompts'
import { describeRuns, recoverText } from './text'
import type { DecomposeOptions, ImageLayer, Layer, Scene, SceneAnalysis, UsageInfo } from '../types'
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
export type DecomposeResult = { scene: Scene; source: string; tailNodes: string[]; warnings: string[] }

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

  // 3 ── type. Measured before anything is erased, because the ink has to be
  // read off the pixels that still contain it.
  const textNode = `n:${B}:text`
  const recovered = await track(
    ctx,
    'text',
    `回收文字 ×${analysis.texts.length}`,
    async () => {
      const res = await recoverText(ctx, flat, analysis.texts, { width, height }, {
        fitGlyphs: opts.fitGlyphs,
        refineText: opts.refineText,
        textMode: opts.textMode,
        visionModel: opts.visionModel,
      })
      return {
        value: res,
        usage: { cost: res.cost },
        detail: res.notes.join(' · ') || `${res.texts.length} 段`,
        summary: describeRuns(res.texts),
      }
    },
    { id: textNode, kind: 'text', inputs: [analyzeNode] },
  )

  const textRegions = recovered.texts
    .map((t) => t.inkBox)
    .filter((b): b is { x: number; y: number; w: number; h: number } => Boolean(b))

  // 4 ── masks. One request per object: masks come back as base64 text, so
  // batching them was measured at >170s before timing out.
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
        if (seg?.reason && !notes.includes(seg.reason)) notes.push(seg.reason)
      }

      const withMask = Object.keys(out).length
      return {
        value: out,
        usage: { cost },
        detail: withMask
          ? `${withMask}/${analysis.elements.length} 个拿到掩码${notes.length ? ` · ${notes.join('；')}` : ''}`
          : `一个掩码都没拿到${notes.length ? ` · ${notes.join('；')}` : ''}`,
      }
    })
  } else {
    skip(ctx, 'segment', '分割掩码', '已关闭，元素留在背景里，不生成独立图层')
  }

  const masked = analysis.elements.filter((el) => masks[el.id]?.mask)
  emit(ctx, {
    id: `n:${B}:segment`,
    kind: 'renders',
    label: opts.useMasks ? `分割掩码 ×${analysis.elements.length}` : '分割掩码（已关闭）',
    detail: opts.useMasks
      ? `${masked.length}/${analysis.elements.length} 个可切出独立图层`
      : '元素留在背景里 —— 没有掩码就没有可编辑元素',
    inputs: [analyzeNode],
    status: opts.useMasks ? 'ok' : 'skipped',
  })

  // 5 ── reconstruct. The erase regenerates the whole frame, so its output is
  // only trusted where something was actually lifted; everywhere else the
  // original pixels are kept and the plate stays faithful.
  const plateNode = `n:${B}:erase`
  const elementRegions = masked.map((el) => boxToRect(masks[el.id]!.box ?? el.box, width, height))

  let erased: string | null = null
  if (opts.inpaintBackground && (textRegions.length || elementRegions.length)) {
    erased = await tryTrack(
      ctx,
      'inpaint',
      '擦除文字与元素，重建背景',
      async () => {
        const json = await api<any>('/api/erase', ctx, {
          image: flat,
          targets: masked.map((e) => e.label),
          aspectRatio: opts.aspectRatio,
          resolution: opts.resolution,
          model: models.image,
        })
        ctx.onArtifact({ label: '重绘底片', src: json.image, role: 'plate' })
        return {
          value: json.image as string,
          usage: json.usage as UsageInfo,
          images: [{ label: '重绘底片', src: json.image }],
        }
      },
      { id: plateNode, kind: 'erase', inputs: [SOURCE_NODE, textNode] },
      { value: null as unknown as string, note: '重建被拒，背景沿用原图（文字会重影）' },
    )
  } else {
    skip(
      ctx,
      'inpaint',
      '背景重建',
      '已关闭，背景层保留原图（文字与元素会重影）',
      { id: plateNode, kind: 'erase', inputs: [SOURCE_NODE, textNode] },
    )
  }

  // Text goes first: elements are then cut from an image that no longer carries
  // baked type, so a lifted element cannot drag the old lettering back on top of
  // the clean plate — which is exactly how the ghosting used to appear.
  const textFree = erased ? await compositeMasked(flat, erased, textRegions) : flat
  const plate = erased ? await compositeMasked(textFree, erased, elementRegions) : flat

  if (erased) {
    emit(ctx, {
      id: plateNode,
      kind: 'erase',
      label: '擦除文字与元素，重建背景',
      detail: `只在 ${textRegions.length} 处文字 + ${elementRegions.length} 处元素合成，其余像素与原图一致`,
      inputs: [SOURCE_NODE, textNode],
      status: 'ok',
      images: [{ label: '最终背景板', src: plate }],
    })
    ctx.onArtifact({ label: '最终背景板', src: plate, role: 'plate' })
  }

  // 6 ── lift each masked element out of the text-free raster
  const cutsNode = `n:${B}:cuts`
  const cutShots: { label: string; src: string }[] = []
  emit(ctx, {
    id: cutsNode,
    kind: 'cuts',
    label: `切图 ×${masked.length}`,
    inputs: [`n:${B}:segment`, plateNode],
    status: masked.length ? 'running' : 'skipped',
    detail: masked.length ? undefined : '没有掩码，不切图',
  })

  const elementLayers = await mapLimit(masked, SEG_CONCURRENCY, async (el, i) => {
    try {
      return await track(ctx, `cut-${el.id}`, `切图 ${i + 1}/${masked.length}：${el.label}`, async () => {
        const hit = masks[el.id]!
        const matte = await maskMatte(textFree, hit.mask, hit.box ?? el.box)

        ctx.onArtifact({ label: `${el.label} · 切出`, src: matte.src, role: 'cut' })
        cutShots.push({ label: el.label, src: matte.src })
        emit(ctx, {
          id: cutsNode,
          kind: 'cuts',
          label: `切图 ×${masked.length}`,
          inputs: [`n:${B}:segment`, plateNode],
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
          matte: 'vlm-mask',
          provenance: `分割掩码切出 · 覆盖率 ${(matte.coverage * 100).toFixed(0)}% · 已去除烘焙文字`,
        }
        return { value: layer, detail: `覆盖率 ${(matte.coverage * 100).toFixed(0)}%` }
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
    label: `切图 ×${masked.length}`,
    detail: masked.length ? '掩码切出，已去除烘焙文字' : '没有掩码，元素留在背景里',
    inputs: [`n:${B}:segment`, plateNode],
    status: masked.length ? 'ok' : 'skipped',
    images: [...cutShots],
  })

  // 7 ── assemble
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
    provenance: erased ? '按区域合成：只在文字与元素处采用重绘' : '原始平图（未重建）',
  }

  const elements = elementLayers.filter((l): l is ImageLayer => Boolean(l))
  const layers: Layer[] = [background, ...elements, ...recovered.texts.map((t) => t.layer)]

  // Say out loud what a degraded run produced, so a doubled poster reads as a
  // recorded consequence of the settings rather than as a mystery.
  const warnings: string[] = []
  const reset = recovered.texts.filter((t) => t.layer.type === 'text').length
  if (!erased && reset) {
    warnings.push(`背景未重建，${reset} 段重排文字会与原图上的文字重影`)
  }
  if (!erased && opts.inpaintBackground) {
    warnings.push('重建被拒，背景沿用原图')
  }
  if (!masked.length && analysis.elements.length) {
    warnings.push(`${analysis.elements.length} 个元素没有掩码，留在背景里，没有可编辑元素层`)
  }

  return {
    scene: {
      canvas: { width, height, background: hexOr(analysis.background.dominantColor, '#111114') },
      layers,
    },
    source: flat,
    tailNodes: [plateNode, ...(masked.length ? [cutsNode] : []), textNode],
    warnings,
  }
}
