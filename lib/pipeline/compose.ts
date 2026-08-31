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
import { boxToRect, checkCancelled, hexOr, mapLimit, skip, track, type PipelineCtx } from './shared'

type GenRes = { images: string[]; usage: UsageInfo; model: string }

const ELEMENT_CONCURRENCY = 2
/** Grounding masks arrive as base64 text; a smaller frame is a smaller payload. */
export const SEGMENT_INPUT_MAX_DIM = 768

/**
 * Pipeline A — "never flatten".
 *
 * Plan the composition first, render every element in isolation against a known
 * backdrop, recover alpha locally, and keep type as real text nodes. Editability
 * is structural rather than recovered, so nothing has to be un-baked afterwards.
 */
export type ComposeResult = { scene: Scene; plan: ScenePlan; background: string }

export async function runCompose(
  ctx: PipelineCtx,
  prompt: string,
  opts: ComposeOptions,
  models: { image: string; vision: string; grounding: string },
  /** Reuse upstream artefacts from an earlier arm so only the matting strategy
   *  varies. The background plate is independent of how elements get matted, so
   *  regenerating it per arm would only add cost and noise. */
  shared?: { plan?: ScenePlan; background?: string },
): Promise<ComposeResult> {
  const { width, height } = aspectToSize(opts.aspectRatio, opts.resolution)

  // 1 ── plan
  let plan: ScenePlan
  if (shared?.plan) {
    skip(ctx, 'plan', '规划 Scene JSON', `复用上一轮的规划（${shared.plan.elements.length} 元素 / ${shared.plan.texts.length} 文字），保证只有抠图策略在变`)
    plan = shared.plan
  } else {
    plan = await track(ctx, 'plan', '规划 Scene JSON', async () => {
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          width,
          height,
          maxElements: opts.maxElements,
          textStrategy: opts.text,
          model: opts.visionModel || undefined,
        }),
        signal: ctx.signal,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
      const p = json.plan as ScenePlan
      return {
        value: p,
        usage: json.usage as UsageInfo,
        detail: `${p.elements.length} 个元素 · ${p.texts.length} 段文字`,
      }
    })
  }

  const bakeText = opts.text === 'baked'

  // 2 ── background plate. Shareable only when text stays out of the raster —
  // the baked arm needs its own plate with the copy rendered in.
  let bgSrc: string
  if (shared?.background && !bakeText) {
    skip(ctx, 'background', '生成背景板', '复用上一轮的背景板 —— 抠图策略不影响背景')
    bgSrc = shared.background
    ctx.onArtifact({ label: '背景板（复用）', src: bgSrc, role: 'plate' })
  } else {
    bgSrc = await track(ctx, 'background', bakeText ? '生成背景（文字烘焙进像素）' : '生成背景板', async () => {
      const basePrompt = backgroundPrompt(plan.background.prompt)
      const withCopy = bakeText && plan.texts.length
        ? `${plan.background.prompt}\n\nRender this copy into the artwork, crisply and legibly, laid out as described:\n${plan.texts
            .map((t) => `- "${t.content}" (${t.fontFamily} ${t.fontWeight}, ${t.color})`)
            .join('\n')}`
        : basePrompt

      const json = await gen(ctx, {
        prompt: withCopy,
        aspectRatio: opts.aspectRatio,
        resolution: opts.resolution,
        model: models.image,
      })
      ctx.onArtifact({ label: '背景板', src: json.images[0], role: 'plate' })
      return { value: json.images[0], usage: json.usage }
    })
  }

  // 3 ── elements, each rendered alone then matted
  const elementLayers = await mapLimit(plan.elements, ELEMENT_CONCURRENCY, async (el, i) => {
    const stepId = `el-${el.id}`
    try {
      return await track(ctx, stepId, `元素 ${i + 1}/${plan.elements.length}：${el.name}`, async () => {
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
          matte = await dualRenderMatte(white.images[0], black.images[0])
        } else if (opts.matte === 'chroma') {
          const res = await gen(ctx, { prompt: elementPrompt(el.prompt, 'magenta'), aspectRatio: '1:1', resolution: opts.resolution, model: models.image, seed: 1000 + i })
          usage.cost = res.usage.cost
          ctx.onArtifact({ label: `${el.name} · 品红底`, src: res.images[0], role: 'raw' })
          matte = await chromaKeyMatte(res.images[0])
        } else {
          const res = await gen(ctx, { prompt: elementPrompt(el.prompt, 'grey'), aspectRatio: '1:1', resolution: opts.resolution, model: models.image, seed: 1000 + i })
          usage.cost = res.usage.cost
          ctx.onArtifact({ label: `${el.name} · 灰底`, src: res.images[0], role: 'raw' })
          const seg = await segment(ctx, res.images[0], el.name, models.grounding)
          usage.cost += seg.usage?.cost ?? 0
          matte = seg.mask
            ? await maskMatte(res.images[0], seg.mask, seg.box ?? [0, 0, 1000, 1000])
            : await cropBox(res.images[0], seg.box ?? [0, 0, 1000, 1000])
          if (seg.degraded) degraded = seg.reason ?? '掩码不可用，已降级为矩形裁切'
        }

        ctx.onArtifact({ label: `${el.name} · 抠图结果`, src: matte.src, role: 'cut' })

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

        return {
          value: layer,
          usage,
          detail: degraded ? `覆盖率 ${(matte.coverage * 100).toFixed(0)}% · ${degraded}` : `覆盖率 ${(matte.coverage * 100).toFixed(0)}%`,
        }
      })
    } catch (err) {
      if ((err as Error).name === 'Cancelled') throw err
      return null // one bad element must not sink the whole run
    }
  })

  checkCancelled(ctx)

  // 4 ── type
  let textLayers: TextLayer[] = []
  let backgroundSrc = bgSrc

  if (!bakeText) {
    skip(ctx, 'text', '文字层', '直接使用规划里的文本节点，未经过任何像素往返')
    textLayers = plan.texts.map((t) => planTextToLayer(t, width, height))
  } else {
    const recovered = await track(ctx, 'ocr', 'OCR 回收烘焙的文字', async () => {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: bgSrc, width, height, maxElements: 1, model: opts.visionModel || undefined }),
        signal: ctx.signal,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
      const a = json.analysis as SceneAnalysis
      return { value: a.texts, usage: json.usage as UsageInfo, detail: `识别出 ${a.texts.length} 段` }
    })

    backgroundSrc = await track(ctx, 'erase', '擦除文字，重建背景', async () => {
      const res = await fetch('/api/erase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: bgSrc, targets: [], aspectRatio: opts.aspectRatio, resolution: opts.resolution, model: models.image }),
        signal: ctx.signal,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
      ctx.onArtifact({ label: '擦除后的背景板', src: json.image, role: 'plate' })
      return { value: json.image as string, usage: json.usage as UsageInfo }
    })

    textLayers = recovered.map((t, i) => analysisTextToLayer(t, width, height, i))
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

  return {
    scene: {
      canvas: { width, height, background: hexOr(plan.background.dominantColor, '#111114') },
      layers,
    },
    plan,
    background: bgSrc,
  }
}

// ------------------------------------------------------------- helpers

async function gen(
  ctx: PipelineCtx,
  body: { prompt: string; aspectRatio?: string; resolution?: string; model?: string; seed?: number; background?: 'transparent' },
): Promise<GenRes> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctx.signal,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
  return json as GenRes
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
  const res = await fetch('/api/segment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: small, label, model }),
    signal: ctx.signal,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
  return json as SegmentResult
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

function analysisTextToLayer(t: SceneAnalysis['texts'][number], width: number, height: number, i: number): TextLayer {
  const rect = boxToRect(t.box, width, height)
  return {
    id: t.id || `ocr-${i}`,
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
    italic: Boolean(t.italic),
    provenance: 'OCR 回收 · 字体为模型猜测',
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
