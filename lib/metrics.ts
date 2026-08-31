'use client'

import { loadImage } from './matte'
import { sceneToPng } from './export'
import { MATTE_BACKDROP } from './types'
import type { Artifact, MatteStrategy, RunMetrics, Scene } from './types'

// Everything here is measured from pixels the run already produced, so a
// benchmark sweep costs nothing extra on top of the generations themselves.

function ctxOf(w: number, h: number) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w))
  canvas.height = Math.max(1, Math.round(h))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  return { canvas, ctx }
}

async function dataOf(src: string, w?: number, h?: number) {
  const img = await loadImage(src)
  const { ctx } = ctxOf(w ?? img.naturalWidth, h ?? img.naturalHeight)
  ctx.drawImage(img, 0, 0, ctx.canvas.width, ctx.canvas.height)
  return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height)
}

/**
 * Per-element alpha quality.
 *
 * `softEdge` is the fraction of surviving pixels that are partially transparent.
 * A correct matte keeps the feathered rim; a hard threshold flattens this toward
 * zero, which is how a cheap key betrays itself even when it looks fine at 100%.
 *
 * `spill` only means something against a chromatic backdrop — it is the share of
 * retained pixels still sitting close to the key colour. The dual-render arm has
 * no single key colour (it solves against both black and white), so it reports
 * null rather than a number that would not compare like for like.
 */
async function alphaQuality(src: string, backdrop: [number, number, number] | null) {
  const data = await dataOf(src)
  const D = data.data
  const total = D.length / 4

  let nonEmpty = 0
  let partial = 0
  let contaminated = 0

  // Only a saturated key can be told apart from legitimate subject colour.
  const chromatic = backdrop ? Math.max(...backdrop) - Math.min(...backdrop) > 60 : false

  for (let i = 0; i < D.length; i += 4) {
    const a = D[i + 3]
    if (a <= 8) continue
    nonEmpty++
    if (a < 250) partial++

    if (chromatic && backdrop) {
      const dr = D[i] - backdrop[0]
      const dg = D[i + 1] - backdrop[1]
      const db = D[i + 2] - backdrop[2]
      if (Math.sqrt(dr * dr + dg * dg + db * db) < 90) contaminated++
    }
  }

  return {
    softEdge: nonEmpty ? partial / nonEmpty : 0,
    coverage: total ? nonEmpty / total : 0,
    spill: chromatic && nonEmpty ? contaminated / nonEmpty : null,
  }
}

/** Reconstruction fidelity: does the layer stack still add up to the source? */
async function reconstruction(scene: Scene, referenceSrc: string) {
  const ref = await dataOf(referenceSrc)
  const flat = await dataOf(await sceneToPng(scene), ref.width, ref.height)

  let se = 0
  let abs = 0
  const n = (ref.data.length / 4) * 3

  for (let i = 0; i < ref.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = flat.data[i + c] - ref.data[i + c]
      se += d * d
      abs += Math.abs(d)
    }
  }

  const mse = se / n
  return {
    psnr: mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse),
    l1: abs / n / 255,
  }
}

export async function computeMetrics(
  scene: Scene,
  artifacts: Artifact[],
  opts: { matte?: MatteStrategy; liveText: boolean },
): Promise<RunMetrics> {
  const elements = scene.layers.filter((l) => l.type === 'image' && l.id !== 'background')
  const textLayers = scene.layers.filter((l) => l.type === 'text')

  const backdrop = opts.matte ? MATTE_BACKDROP[opts.matte] : null
  const quality = await Promise.all(
    elements.map((l) => alphaQuality((l as { src: string }).src, backdrop).catch(() => null)),
  )
  const ok = quality.filter((q): q is NonNullable<typeof q> => Boolean(q))
  const mean = (pick: (q: NonNullable<(typeof quality)[number]>) => number | null) => {
    const vals = ok.map(pick).filter((v): v is number => typeof v === 'number')
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  }

  let psnr: number | null = null
  let l1: number | null = null
  const reference = artifacts.find((a) => a.role === 'source')?.src
  if (reference) {
    try {
      const r = await reconstruction(scene, reference)
      psnr = r.psnr
      l1 = r.l1
    } catch {
      /* reconstruction is a bonus signal, never a hard failure */
    }
  }

  return {
    imageLayers: elements.length,
    textLayers: textLayers.length,
    liveText: opts.liveText,
    softEdgeRatio: mean((q) => q.softEdge),
    alphaCoverage: mean((q) => q.coverage),
    spill: mean((q) => q.spill),
    psnr,
    l1,
  }
}

// -------------------------------------------------------------- display

export type MetricSpec = {
  key: keyof RunMetrics
  label: string
  hint: string
  /** 1 = higher is better, -1 = lower is better, 0 = neutral count. */
  direction: 1 | -1 | 0
  format: (v: number) => string
}

export const METRIC_SPECS: MetricSpec[] = [
  { key: 'textLayers', label: '文字层', hint: '回收出多少段可编辑文字', direction: 0, format: (v) => `${v}` },
  { key: 'imageLayers', label: '元素层', hint: '背景之外的独立图层数', direction: 0, format: (v) => `${v}` },
  {
    key: 'softEdgeRatio',
    label: '软边占比',
    hint: '存活像素里半透明的比例。羽化边缘被正确还原时不该是 0 —— 硬阈值抠图会把它压平',
    direction: 1,
    format: (v) => `${(v * 100).toFixed(1)}%`,
  },
  {
    key: 'alphaCoverage',
    label: '存活面积',
    hint: '抠完后剩下多少画面。太低说明主体被啃掉了',
    direction: 0,
    format: (v) => `${(v * 100).toFixed(1)}%`,
  },
  {
    key: 'spill',
    label: '底色残留',
    hint: '仍贴近键色的像素比例，越低越好。只有彩色底（色键 / 灰底）能量出来，双渲染没有单一键色',
    direction: -1,
    format: (v) => `${(v * 100).toFixed(1)}%`,
  },
  {
    key: 'psnr',
    label: '重建 PSNR',
    hint: '图层重新叠回去和原图的差距，越高越好。只有拆解管线有原图可比',
    direction: 1,
    format: (v) => `${v.toFixed(2)} dB`,
  },
  {
    key: 'l1',
    label: '重建 L1',
    hint: '同上，逐像素平均绝对误差，越低越好',
    direction: -1,
    format: (v) => v.toFixed(4),
  },
]
