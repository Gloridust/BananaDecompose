'use client'

import { chromaKeyMatte, cropBox, downscale, dualRenderMatte, imageSize, maskMatte, type MatteResult } from '../matte'
import type {
  ComposeOptions,
  ImageLayer,
  Layer,
  Scene,
  ScenePlan,
  SceneAnalysis,
  TextLayer,
  UsageInfo,
} from '../types'
import { backgroundPrompt, elementPrompt } from '../prompts'
import { api, boxToRect, checkCancelled, emit, hexOr, mapLimit, skip, track, tryTrack, type PipelineCtx } from './shared'
import { describeRuns, recoverText } from './text'
import { compositeMasked } from '../matte'

type GenRes = { images: string[]; usage: UsageInfo; model: string }

/** Per-branch fan-out. The global scheduler bounds actual load, so this only
 *  needs to be wide enough that one branch alone can saturate the pool. */
const ELEMENT_CONCURRENCY = 8

/** Grounding masks arrive as base64 text; a smaller frame is a smaller payload. */
export const SEGMENT_INPUT_MAX_DIM = 768

// A board holds at most one shared plan and one shared text-free plate, so those
// get fixed node ids and merge across branches automatically. Everything else is
// namespaced by branch.
export const PROMPT_NODE = 'n:prompt'
export const PLAN_NODE = 'n:plan'
export const PLATE_NODE = 'n:plate'

export type ComposeResult = {
  scene: Scene
  plan: ScenePlan
  background: string
  /** Board nodes the assembled scene descends from. */
  tailNodes: string[]
  warnings: string[]
}

/** Shared upstream, step 1. Every compose branch consumes the same plan. */
export async function preparePlan(
  ctx: PipelineCtx,
  prompt: string,
  opts: ComposeOptions,
  size: { width: number; height: number },
): Promise<ScenePlan> {
  return track(
    ctx,
    'plan',
    '规划 Scene JSON',
    async () => {
      const json = await api<any>('/api/plan', ctx, {
        prompt,
        width: size.width,
        height: size.height,
        maxElements: opts.maxElements,
        textStrategy: 'live',
        model: opts.visionModel || undefined,
      })
      const p = json.plan as ScenePlan
      return {
        value: p,
        usage: json.usage as UsageInfo,
        detail: `${p.elements.length} 个元素 · ${p.texts.length} 段文字`,
        summary: planSummary(p),
      }
    },
    { id: PLAN_NODE, kind: 'plan', inputs: [PROMPT_NODE] },
  )
}

/** Shared upstream, step 2. Only text-free plates are shareable — the baked arm
 *  renders copy into its own and is excluded. */
export async function preparePlate(
  ctx: PipelineCtx,
  plan: ScenePlan,
  opts: ComposeOptions,
  models: { image: string },
): Promise<string> {
  return track(
    ctx,
    'background',
    '生成背景板',
    async () => {
      const json = await gen(ctx, {
        prompt: backgroundPrompt(plan.background.prompt),
        aspectRatio: opts.aspectRatio,
        resolution: opts.resolution,
        model: models.image,
      })
      ctx.onArtifact({ label: '背景板', src: json.images[0], role: 'plate' })
      return { value: json.images[0], usage: json.usage, images: [{ label: '背景板', src: json.images[0] }] }
    },
    { id: PLATE_NODE, kind: 'plate', inputs: [PLAN_NODE] },
  )
}

/**
 * Pipeline A — "never flatten".
 *
 * Plan the composition first, render every element in isolation against a known
 * backdrop, recover alpha locally, and keep type as real text nodes. Editability
 * is structural rather than recovered, so nothing has to be un-baked afterwards.
 */
export async function runCompose(
  ctx: PipelineCtx,
  prompt: string,
  opts: ComposeOptions,
  models: { image: string; vision: string; grounding: string },
  /** Reuse upstream artefacts from an earlier branch so only the matting strategy
   *  varies. The plate is independent of how elements get matted, so regenerating
   *  it per branch would add cost and noise, nothing else. */
  shared?: { plan?: ScenePlan; background?: string },
): Promise<ComposeResult> {
  const { width, height } = aspectToSize(opts.aspectRatio, opts.resolution)
  const B = ctx.branchId

  // 1 ── plan
  let plan: ScenePlan
  if (shared?.plan) {
    const reused = shared.plan
    skip(ctx, 'plan', '规划 Scene JSON', `复用共享规划（${reused.elements.length} 元素 / ${reused.texts.length} 文字）`)
    emit(ctx, {
      id: PLAN_NODE,
      kind: 'plan',
      label: '规划 Scene JSON',
      inputs: [PROMPT_NODE],
      status: 'ok',
      summary: planSummary(reused),
    })
    plan = reused
  } else {
    plan = await preparePlan(ctx, prompt, opts, { width, height })
  }

  const bakeText = opts.text === 'baked'
  // The baked arm renders copy into its plate, so it cannot share one.
  const plateNode = bakeText ? `n:${B}:plate` : PLATE_NODE

  // 2 ── background plate
  let bgSrc: string
  if (shared?.background && !bakeText) {
    skip(ctx, 'background', '生成背景板', '复用共享背景板 —— 抠图策略不影响背景')
    bgSrc = shared.background
    ctx.onArtifact({ label: '背景板（复用）', src: bgSrc, role: 'plate' })
    emit(ctx, {
      id: plateNode,
      kind: 'plate',
      label: '背景板',
      detail: '复用共享背景板',
      inputs: [PLAN_NODE],
      status: 'ok',
      images: [{ label: '背景板', src: bgSrc }],
    })
  } else {
    bgSrc = await track(
      ctx,
      'background',
      bakeText ? '生成背景（文字烘焙进像素）' : '生成背景板',
      async () => {
        const copy = plan.texts
          .map((t) => `- "${t.content}" (${t.fontFamily} ${t.fontWeight}, ${t.color})`)
          .join('\n')
        const withCopy =
          bakeText && plan.texts.length
            ? `${plan.background.prompt}\n\nRender this copy into the artwork, crisply and legibly, laid out as described:\n${copy}`
            : backgroundPrompt(plan.background.prompt)

        const json = await gen(ctx, {
          prompt: withCopy,
          aspectRatio: opts.aspectRatio,
          resolution: opts.resolution,
          model: models.image,
        })
        ctx.onArtifact({ label: '背景板', src: json.images[0], role: 'plate' })
        return { value: json.images[0], usage: json.usage, images: [{ label: '背景板', src: json.images[0] }] }
      },
      { id: plateNode, kind: 'plate', inputs: [PLAN_NODE] },
    )
  }

  // 3 ── elements, each rendered alone then matted
  const rendersNode = `n:${B}:renders`
  const cutsNode = `n:${B}:cuts`
  const rawShots: { label: string; src: string }[] = []
  const cutShots: { label: string; src: string }[] = []

  const pushRaw = (label: string, src: string) => {
    rawShots.push({ label, src })
    emit(ctx, {
      id: rendersNode,
      kind: 'renders',
      label: `独立渲染 ×${plan.elements.length}`,
      detail: backdropLabel(opts.matte),
      inputs: [PLAN_NODE],
      status: 'running',
      images: [...rawShots],
    })
  }

  emit(ctx, {
    id: rendersNode,
    kind: 'renders',
    label: `独立渲染 ×${plan.elements.length}`,
    detail: backdropLabel(opts.matte),
    inputs: [PLAN_NODE],
    status: 'running',
  })
  emit(ctx, {
    id: cutsNode,
    kind: 'cuts',
    label: `抠图 ×${plan.elements.length}`,
    detail: matteLabel(opts.matte),
    inputs: [rendersNode],
    status: 'running',
  })

  const elementLayers = await mapLimit(plan.elements, ELEMENT_CONCURRENCY, async (el, i) => {
    try {
      return await track(ctx, `el-${el.id}`, `元素 ${i + 1}/${plan.elements.length}：${el.name}`, async () => {
        const usage: UsageInfo = { cost: 0 }
        let matte: MatteResult
        let degraded: string | null = null

        if (opts.matte === 'dual') {
          const [white, black] = await Promise.all([
            gen(ctx, { prompt: elementPrompt(el.prompt, 'white'), aspectRatio: '1:1', resolution: opts.resolution, model: models.image, seed: 1000 + i }),
            gen(ctx, { prompt: elementPrompt(el.prompt, 'black'), aspectRatio: '1:1', resolution: opts.resolution, model: models.image, seed: 1000 + i }),
          ])
          usage.cost = white.usage.cost + black.usage.cost
          ctx.onArtifact({ label: `${el.name} · 白底`, src: white.images[0], role: 'raw' })
          ctx.onArtifact({ label: `${el.name} · 黑底`, src: black.images[0], role: 'raw' })
          pushRaw(`${el.name} · 白底`, white.images[0])
          pushRaw(`${el.name} · 黑底`, black.images[0])
          matte = await dualRenderMatte(white.images[0], black.images[0])
        } else if (opts.matte === 'chroma') {
          const res = await gen(ctx, { prompt: elementPrompt(el.prompt, 'magenta'), aspectRatio: '1:1', resolution: opts.resolution, model: models.image, seed: 1000 + i })
          usage.cost = res.usage.cost
          ctx.onArtifact({ label: `${el.name} · 品红底`, src: res.images[0], role: 'raw' })
          pushRaw(`${el.name} · 品红底`, res.images[0])
          matte = await chromaKeyMatte(res.images[0])
        } else {
          const res = await gen(ctx, { prompt: elementPrompt(el.prompt, 'grey'), aspectRatio: '1:1', resolution: opts.resolution, model: models.image, seed: 1000 + i })
          usage.cost = res.usage.cost
          ctx.onArtifact({ label: `${el.name} · 灰底`, src: res.images[0], role: 'raw' })
          pushRaw(`${el.name} · 灰底`, res.images[0])

          const seg = await segment(ctx, res.images[0], el.name, models.grounding)
          usage.cost += seg.usage?.cost ?? 0
          matte = seg.mask
            ? await maskMatte(res.images[0], seg.mask, seg.box ?? [0, 0, 1000, 1000])
            : await cropBox(res.images[0], seg.box ?? [0, 0, 1000, 1000])
          if (seg.degraded) degraded = seg.reason ?? '掩码不可用，已降级为矩形裁切'
        }

        ctx.onArtifact({ label: `${el.name} · 抠图结果`, src: matte.src, role: 'cut' })
        cutShots.push({ label: el.name, src: matte.src })
        emit(ctx, {
          id: cutsNode,
          kind: 'cuts',
          label: `抠图 ×${plan.elements.length}`,
          detail: matteLabel(opts.matte),
          inputs: [rendersNode],
          status: 'running',
          images: [...cutShots],
        })

        const target = boxToRect(el.box, width, height)
        const size = await imageSize(matte.src)
        const rect = fitContain(target, size.width / size.height)

        const layer: ImageLayer = {
          id: el.id,
          type: 'image',
          name: el.name,
          ...rect,
          rotation: 0,
          opacity: 1,
          visible: true,
          locked: false,
          src: matte.src,
          matte: opts.matte,
          provenance: `独立渲染 · ${opts.matte} · 覆盖率 ${(matte.coverage * 100).toFixed(0)}%`,
        }

        const pct = `${(matte.coverage * 100).toFixed(0)}%`
        return { value: layer, usage, detail: degraded ? `覆盖率 ${pct} · ${degraded}` : `覆盖率 ${pct}` }
      })
    } catch (err) {
      if ((err as Error).name === 'Cancelled') throw err
      return null // one bad element must not sink the whole branch
    }
  })

  checkCancelled(ctx)

  emit(ctx, {
    id: rendersNode,
    kind: 'renders',
    label: `独立渲染 ×${plan.elements.length}`,
    detail: backdropLabel(opts.matte),
    inputs: [PLAN_NODE],
    status: 'ok',
    images: [...rawShots],
  })
  emit(ctx, {
    id: cutsNode,
    kind: 'cuts',
    label: `抠图 ×${plan.elements.length}`,
    detail: matteLabel(opts.matte),
    inputs: [rendersNode],
    status: 'ok',
    images: [...cutShots],
  })

  // 4 ── type
  let textLayers: Layer[] = []
  let backgroundSrc = bgSrc
  const tailNodes = [plateNode, cutsNode]

  if (!bakeText) {
    skip(ctx, 'text', '文字层', '直接使用规划里的文本节点，未经过任何像素往返')
    textLayers = plan.texts.map((t) => planTextToLayer(t, width, height))
  } else {
    const ocrNode = `n:${B}:ocr`
    const analysed = await track(
      ctx,
      'ocr',
      'OCR 回收烘焙的文字',
      async () => {
        const json = await api<any>('/api/analyze', ctx, {
          image: bgSrc,
          width,
          height,
          maxElements: 1,
          model: opts.visionModel || undefined,
        })
        const a = json.analysis as SceneAnalysis
        return {
          value: a,
          usage: json.usage as UsageInfo,
          detail: `识别出 ${a.texts.length} 段`,
          summary: a.texts.map((t) => `「${t.content}」`).join('\n') || '没识别出文字',
        }
      },
      { id: ocrNode, kind: 'analysis', inputs: [plateNode] },
    )

    const textNode = `n:${B}:text`
    const recovered = await track(
      ctx,
      'fit',
      `字形贴合 ×${analysed.texts.length}`,
      async () => {
        const res = await recoverText(ctx, bgSrc, analysed.texts, { width, height }, {
          fitGlyphs: true,
          refineText: true,
          // The baked arm exists to measure what re-setting type costs, so it
          // always re-sets rather than keeping the original pixels.
          textMode: 'vector',
          visionModel: opts.visionModel,
        })
        return {
          value: res,
          usage: { cost: res.cost },
          detail: res.notes.join(' · ') || `${res.texts.length} 段`,
          summary: describeRuns(res.texts),
        }
      },
      { id: textNode, kind: 'text', inputs: [ocrNode] },
    )

    const textRegions = recovered.texts
      .map((t) => t.inkBox)
      .filter((b): b is { x: number; y: number; w: number; h: number } => Boolean(b))

    const eraseNode = `n:${B}:erase`
    const erased = await tryTrack(
      ctx,
      'erase',
      '擦除文字，重建背景',
      async () => {
        const json = await api<any>('/api/erase', ctx, {
          image: bgSrc,
          targets: [],
          aspectRatio: opts.aspectRatio,
          resolution: opts.resolution,
          model: models.image,
        })
        return {
          value: json.image as string,
          usage: json.usage as UsageInfo,
          images: [{ label: '重绘底片', src: json.image }],
        }
      },
      { id: eraseNode, kind: 'erase', inputs: [plateNode, textNode] },
      { value: null as unknown as string, note: '重建被拒，背景沿用原图（文字会重影）' },
    )

    // Patch only where the ink was: the erase regenerates the whole frame, and
    // taking all of it would drift every untouched pixel of the plate.
    backgroundSrc = erased ? await compositeMasked(bgSrc, erased, textRegions) : bgSrc
    if (erased) {
      ctx.onArtifact({ label: '擦除后的背景板', src: backgroundSrc, role: 'plate' })
      emit(ctx, {
        id: eraseNode,
        kind: 'erase',
        label: '擦除文字，重建背景',
        detail: `只在 ${textRegions.length} 处文字区合成`,
        inputs: [plateNode, textNode],
        status: 'ok',
        images: [{ label: '最终背景板', src: backgroundSrc }],
      })
    }

    textLayers = recovered.texts.map((t) => t.layer)
    tailNodes[0] = eraseNode
    tailNodes.push(textNode)
  }

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
    src: backgroundSrc,
    matte: 'none',
    provenance: bakeText ? '整图生成 → 文字擦除重建' : '整图生成（无文字）',
  }

  const elements = elementLayers.filter((l): l is ImageLayer => Boolean(l))
  const layers: Layer[] = [background, ...elements, ...textLayers]

  const warnings: string[] = []
  if (elements.length < plan.elements.length) {
    warnings.push(`${plan.elements.length - elements.length} 个元素渲染失败`)
  }
  if (bakeText && backgroundSrc === bgSrc && textLayers.length) {
    warnings.push('擦除被拒，背景仍带原文字，重排文字会重影')
  }

  return {
    scene: {
      canvas: { width, height, background: hexOr(plan.background.dominantColor, '#111114') },
      layers,
    },
    plan,
    background: bgSrc,
    tailNodes,
    warnings,
  }
}

// ------------------------------------------------------------- helpers

async function gen(
  ctx: PipelineCtx,
  body: { prompt: string; aspectRatio?: string; resolution?: string; model?: string; seed?: number },
): Promise<GenRes> {
  return api<GenRes>('/api/generate', ctx, body)
}

export type SegmentResult = {
  label: string
  box: [number, number, number, number] | null
  mask: string | null
  usage: UsageInfo
  degraded: boolean
  reason?: string
}

/** One object per call. The image is downscaled first: the model's mask comes back
 *  as base64 text, so a smaller frame is a directly smaller — and faster — payload. */
export async function segment(ctx: PipelineCtx, image: string, label: string, model: string): Promise<SegmentResult> {
  const small = await downscale(image, SEGMENT_INPUT_MAX_DIM)
  return api<SegmentResult>('/api/segment', ctx, { image: small, label, model })
}

function planSummary(p: ScenePlan) {
  const els = p.elements.map((e) => `· ${e.name}`).join('\n')
  const txt = p.texts.map((t) => `「${t.content}」`).join('  ')
  return [`背景：${p.background.prompt.slice(0, 60)}…`, els, txt].filter(Boolean).join('\n')
}

function backdropLabel(m: ComposeOptions['matte']) {
  return m === 'dual' ? '白底 + 黑底，每个元素两张' : m === 'chroma' ? '品红底，每个元素一张' : '灰底，每个元素一张'
}

function matteLabel(m: ComposeOptions['matte']) {
  return m === 'dual' ? '差值解 alpha' : m === 'chroma' ? '色距抠除 + 去色溢' : 'VLM 掩码'
}

/** Scale a subject into its planned box without distorting it. */
function fitContain(box: { x: number; y: number; w: number; h: number }, aspect: number) {
  let w = box.w
  let h = w / aspect
  if (h > box.h) {
    h = box.h
    w = h * aspect
  }
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h }
}

function planTextToLayer(t: ScenePlan['texts'][number], width: number, height: number): TextLayer {
  const rect = boxToRect(t.box, width, height)
  return {
    id: t.id,
    type: 'text',
    name: t.content.slice(0, 24) || '文字',
    ...rect,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    text: t.content,
    fontFamily: t.fontFamily || 'Inter',
    fontSize: clampFontSize(t.fontSize, rect.h),
    fontWeight: t.fontWeight || 600,
    color: hexOr(t.color, '#ffffff'),
    align: t.align || 'left',
    lineHeight: 1.15,
    letterSpacing: 0,
    italic: false,
    provenance: '规划直出 · 从未进入像素',
  }
}

function clampFontSize(size: number, boxHeight: number) {
  const n = Number(size)
  if (!Number.isFinite(n) || n <= 0) return Math.max(12, boxHeight * 0.7)
  return Math.min(Math.max(n, 8), boxHeight * 1.6)
}

export function aspectToSize(aspectRatio: string, resolution: string) {
  const [aw, ah] = aspectRatio.split(':').map(Number)
  const ratio = aw && ah ? aw / ah : 1
  const base = resolution === '4K' ? 2048 : resolution === '2K' ? 1536 : 1024
  return ratio >= 1
    ? { width: base, height: Math.round(base / ratio) }
    : { width: Math.round(base * ratio), height: base }
}
