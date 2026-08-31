'use client'

import { cropAndZoom } from '../matte'
import { FONT_CANDIDATES, dedupeRuns, ensureFonts, extractInk, fitText, scoreFonts, scoreMargin, type InkMetrics } from '../glyph'
import { boxToRect, hexOr, mapLimit, type PipelineCtx } from './shared'
import { api } from './shared'
import type { ImageLayer, Layer, SceneAnalysis, TextLayer, TextMode, UsageInfo } from '../types'

/**
 * Turning transcribed runs into text layers that actually land on the ink.
 *
 * Split by what each source is good for: the vision model says WHAT the text is
 * and WHICH face it resembles, the pixels say WHERE it sits and HOW BIG it is.
 * The model's own fontSize and box are used only as a search hint — never as the
 * final geometry, because a regressed coordinate cannot beat a measured one.
 */

export type RecoveredText = {
  layer: Layer
  /** Ink bounds in image pixels — the plate compositor patches exactly here. */
  inkBox: { x: number; y: number; w: number; h: number } | null
  fitted: boolean
}

const TEXT_CONCURRENCY = 6

export async function recoverText(
  ctx: PipelineCtx,
  source: string,
  runs: SceneAnalysis['texts'],
  size: { width: number; height: number },
  opts: { fitGlyphs: boolean; refineText: boolean; textMode: TextMode; visionModel?: string },
): Promise<{ texts: RecoveredText[]; cost: number; notes: string[] }> {
  // A layout pass readily reports the same glyphs twice — "V60杯" and "V60" over
  // one label — and rendering both stacks two layers on one spot.
  // Every measurement below depends on the real faces being resolved; on a cold
  // page they are not, and the fallback's metrics would be measured instead.
  await ensureFonts(FONT_CANDIDATES, runs.map((r) => r.content).join(''))

  const deduped = dedupeRuns(runs)
  const dropped = runs.length - deduped.length
  const notes: string[] = []
  if (dropped) notes.push(`去重 ${dropped} 段重叠文字`)

  let cost = 0
  let fittedCount = 0
  let refinedCount = 0

  const texts = await mapLimit(deduped, TEXT_CONCURRENCY, async (t, i) => {
    let content = t.content
    let family = t.fontFamily || 'Inter'
    let weight = t.fontWeight || 600
    let italic = Boolean(t.italic)

    let ink: InkMetrics | null = null
    if (opts.fitGlyphs) {
      ink = await extractInk(source, t.box).catch(() => null)
    }

    // Re-read the run from a zoomed crop. Only worth the call once the ink bounds
    // are known, because that is what makes the crop tight enough to help.
    if (opts.refineText && ink) {
      try {
        const crop = await cropAndZoom(source, ink.box)
        const res = await api<{ refined: { content?: string; fontFamily?: string; fontWeight?: number; italic?: boolean; isText?: boolean } | null; usage?: UsageInfo }>(
          '/api/refine-text',
          ctx,
          { image: crop, hint: t.content, model: opts.visionModel || undefined },
        )
        cost += res.usage?.cost ?? 0
        const r = res.refined
        if (r?.isText && r.content?.trim()) {
          content = r.content.trim()
          if (r.fontFamily) family = r.fontFamily
          if (r.fontWeight) weight = r.fontWeight
          italic = Boolean(r.italic)
          refinedCount++
        }
      } catch {
        /* the coarse read stands */
      }
    }

    if (!ink) {
      return { layer: fromBox(t, content, family, weight, italic, size, i), inkBox: null, fitted: false }
    }

    // Score the candidate faces against the measured ink — but only act on the
    // result when it is decisive. Rendering overlap is a weak font identifier, so
    // an ambiguous scoreboard defers to what the vision model read off the crop.
    const candidates = [
      { family, weight },
      ...FONT_CANDIDATES.filter((c: { family: string }) => c.family !== family),
    ]
    const ranked = await scoreFonts(content, candidates.slice(0, 7), ink, italic).catch(() => [])
    const decisive = ranked.length > 1 && scoreMargin(ranked) >= 0.06
    const best = decisive ? ranked[0] : { family, weight, score: ranked[0]?.score ?? 0 }

    fittedCount++

    // Keeping the original glyphs as pixels sidesteps font matching entirely: no
    // web font has to stand in for AI-drawn lettering, because the lettering is
    // the layer. The transcription rides along so the run can be regenerated in
    // the same style when someone actually wants to change the words.
    if (opts.textMode === 'pixel') {
      const layer: ImageLayer = {
        id: t.id || `tx-${i}`,
        type: 'image',
        name: content.slice(0, 24) || '文字',
        x: ink.box.x,
        y: ink.box.y,
        w: ink.box.w,
        h: ink.box.h,
        rotation: 0,
        opacity: 1,
        visible: true,
        locked: false,
        src: ink.cut,
        matte: 'vlm-mask',
        retype: { text: content, styleRef: ink.styleRef, color: ink.color },
        provenance: `原始笔画抠出 · 像素级一致 · 改字将按原样式重绘（识别为「${content}」）`,
      }
      return { layer, inkBox: ink.box, fitted: true }
    }

    const fit = fitText(content, best.family, best.weight, italic, ink.box)

    const layer: TextLayer = {
      id: t.id || `tx-${i}`,
      type: 'text',
      name: content.slice(0, 24) || '文字',
      x: fit.x,
      y: fit.y,
      w: fit.w,
      h: fit.h,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      text: content,
      fontFamily: best.family,
      fontSize: fit.fontSize,
      fontWeight: best.weight,
      color: ink.color,
      align: 'left',
      lineHeight: 1.15,
      letterSpacing: fit.letterSpacing,
      italic,
      provenance: [
        '字形贴合',
        `字号 ${fit.fontSize.toFixed(1)}px 由墨迹量出`,
        `颜色 ${ink.color} 取自笔画像素`,
        decisive ? `字体 ${best.family} 由渲染回测选出` : `字体 ${best.family} 取自模型判断（回测不够分辨）`,
        refinedCount && content !== t.content ? `裁图复核改写为「${content}」` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    }

    return { layer, inkBox: ink.box, fitted: true }
  })

  if (opts.fitGlyphs) notes.push(`${fittedCount}/${deduped.length} 段量到字形`)
  if (opts.refineText) notes.push(`${refinedCount} 段经裁图复核`)

  return { texts, cost, notes }
}

/** One line per recovered run, for the node's summary panel. */
export function describeRuns(texts: RecoveredText[]) {
  return texts
    .map((t) =>
      t.layer.type === 'text'
        ? `「${t.layer.text}」 ${t.layer.fontFamily} ${Math.round(t.layer.fontSize)}px`
        : `「${t.layer.retype?.text ?? t.layer.name}」 原始笔画`,
    )
    .join('\n')
}

/** No measurable ink — fall back to the model's box and its guessed size. */
function fromBox(
  t: SceneAnalysis['texts'][number],
  content: string,
  family: string,
  weight: number,
  italic: boolean,
  size: { width: number; height: number },
  i: number,
): TextLayer {
  const rect = boxToRect(t.box, size.width, size.height)
  const guessed = Number(t.fontSize)
  return {
    id: t.id || `tx-${i}`,
    type: 'text',
    name: content.slice(0, 24) || '文字',
    ...rect,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    text: content,
    fontFamily: family,
    fontSize: Number.isFinite(guessed) && guessed > 0 ? Math.min(guessed, rect.h * 1.6) : Math.max(12, rect.h * 0.78),
    fontWeight: weight,
    color: hexOr(t.color, '#ffffff'),
    align: t.align || 'left',
    lineHeight: 1.15,
    letterSpacing: 0,
    italic,
    provenance: '模型给的框与字号 · 未量到字形，位置多半对不准',
  }
}
