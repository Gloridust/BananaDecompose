'use client'

import type { ComposeOptions, DecomposeOptions, PipelineId } from './types'

/**
 * A one-click sweep across every strategy the demo ships.
 *
 * Arms of the same pipeline share their upstream artefact — compose arms reuse
 * one plan, decompose arms reuse one flat raster — so the only thing that differs
 * between two rows of the result table is the thing being tested. Without that,
 * a "benchmark" is just six unrelated generations sitting next to each other.
 */
export type BenchmarkVariant = {
  id: string
  label: string
  note: string
  pipeline: PipelineId
  compose?: Partial<ComposeOptions>
  decompose?: Partial<DecomposeOptions>
  /** Image-generation calls this arm costs, given N planned elements. */
  imageCalls: (n: number) => number
  /** True when this arm can reuse a text-free background plate from an earlier arm. */
  reusesPlate?: boolean
}

export const VARIANTS: BenchmarkVariant[] = [
  {
    id: 'a-dual',
    reusesPlate: true,
    label: 'A · 双渲染差值',
    note: '白底 + 黑底解方程求 alpha，文字不入像素。理论最准，2× 出图成本。',
    pipeline: 'compose',
    compose: { matte: 'dual', text: 'live' },
    imageCalls: (n) => 1 + 2 * n,
  },
  {
    id: 'a-chroma',
    reusesPlate: true,
    label: 'A · 色键抠图',
    note: '品红底单次生成 + 色距抠除。成本减半，软边会留色溢。',
    pipeline: 'compose',
    compose: { matte: 'chroma', text: 'live' },
    imageCalls: (n) => 1 + n,
  },
  {
    id: 'a-vlm',
    reusesPlate: true,
    label: 'A · VLM 分割掩码',
    note: '灰底单次生成 + Gemini grounding 出掩码。额外一次视觉调用，可能拿不到掩码。',
    pipeline: 'compose',
    compose: { matte: 'vlm-mask', text: 'live' },
    imageCalls: (n) => 1 + n,
  },
  {
    id: 'a-baked',
    label: 'A · 文字烘焙回收',
    note: '同双渲染，但文字先画进背景再 OCR 擦除回收。量化「事后回收文字」掉多少精度。',
    pipeline: 'compose',
    compose: { matte: 'dual', text: 'baked' },
    imageCalls: (n) => 1 + 2 * n + 1,
  },
  {
    id: 'b-mask',
    label: 'B · 掩码 + 重绘背景',
    note: '完整的事后拆解：读版面 → 掩码切图 → 重绘补洞。',
    pipeline: 'decompose',
    decompose: { useMasks: true, inpaintBackground: true },
    imageCalls: () => 1 + 1,
  },
  {
    id: 'b-nomask',
    label: 'B · 掩码关，仅重绘',
    note: '元素退化为 bbox 矩形裁切。隔离出掩码这一步到底贡献了多少。',
    pipeline: 'decompose',
    decompose: { useMasks: false, inpaintBackground: true },
    imageCalls: () => 1 + 1,
  },
  {
    id: 'b-raw',
    label: 'B · 全关（下限对照）',
    note: '不要掩码也不重绘背景。这是拆解质量的地板，用来标定其他几档的意义。',
    pipeline: 'decompose',
    decompose: { useMasks: false, inpaintBackground: false },
    imageCalls: () => 1,
  },
]

export const DEFAULT_SELECTION = VARIANTS.map((v) => v.id)

/** Rough only — the real number lands in each run record once it finishes. */
const APPROX_USD_PER_IMAGE = 0.08

export function estimate(selected: string[], composeElements: number, decomposeElements: number) {
  const arms = VARIANTS.filter((v) => selected.includes(v.id))

  // Arms after the first of each pipeline reuse the shared upstream artefact:
  // compose arms reuse the text-free plate, decompose arms reuse the source raster.
  let plateSeen = false
  let sourceSeen = false
  let images = 0

  for (const arm of arms) {
    if (arm.pipeline === 'compose') {
      const reuse = arm.reusesPlate && plateSeen ? 1 : 0
      images += arm.imageCalls(composeElements) - reuse
      if (arm.reusesPlate) plateSeen = true
    } else {
      images += arm.imageCalls(decomposeElements) - (sourceSeen ? 1 : 0)
      sourceSeen = true
    }
  }

  return { arms: arms.length, images, usd: images * APPROX_USD_PER_IMAGE }
}

export function resolveOptions(
  variant: BenchmarkVariant,
  base: { compose: ComposeOptions; decompose: DecomposeOptions },
) {
  return {
    compose: { ...base.compose, ...variant.compose },
    decompose: { ...base.decompose, ...variant.decompose },
  }
}
