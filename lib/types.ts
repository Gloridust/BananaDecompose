// ---------- Scene graph (the shared output of BOTH pipelines) ----------

export type Vec = { x: number; y: number; w: number; h: number }

export type LayerBase = Vec & {
  id: string
  name: string
  rotation: number
  opacity: number
  visible: boolean
  locked: boolean
  /** Where this layer came from — surfaced in the inspector so the two
   *  pipelines can be compared element by element. */
  provenance?: string
}

export type ImageLayer = LayerBase & {
  type: 'image'
  /** data: URI, RGBA PNG */
  src: string
  /** Matting strategy that produced the alpha channel, if any. */
  matte?: MatteStrategy
}

export type TextLayer = LayerBase & {
  type: 'text'
  text: string
  fontFamily: string
  fontSize: number
  fontWeight: number
  color: string
  align: 'left' | 'center' | 'right'
  lineHeight: number
  letterSpacing: number
  italic: boolean
}

export type Layer = ImageLayer | TextLayer

export type Scene = {
  canvas: { width: number; height: number; background: string }
  /** Index 0 renders first (bottom). */
  layers: Layer[]
}

// ---------- Pipelines ----------

export type PipelineId = 'compose' | 'decompose'

/** How an element's alpha channel is recovered. Nano Banana never emits alpha. */
export type MatteStrategy =
  | 'dual'      // render twice (white bg + black bg), solve for alpha by difference
  | 'chroma'    // render once on a saturated key colour, chroma-key it out
  | 'vlm-mask'  // render once, ask the vision model for a segmentation mask
  | 'none'      // opaque plate (backgrounds)

export const MATTE_STRATEGIES: { id: MatteStrategy; label: string; note: string }[] = [
  { id: 'dual', label: '双渲染差值', note: '白底 + 黑底各生成一次，解方程求 alpha。边缘/半透明最准，2× 成本。' },
  { id: 'chroma', label: '色键抠图', note: '在纯品红底上生成一次，按色距抠除。1× 成本，边缘有色溢。' },
  { id: 'vlm-mask', label: 'VLM 分割掩码', note: '生成一次 + Gemini 返回 segmentation mask。1× 成本 + 1 次视觉调用。' },
]

/** Backdrop each strategy renders against — the metrics need it to measure spill. */
export const MATTE_BACKDROP: Record<MatteStrategy, [number, number, number] | null> = {
  dual: [0, 0, 0], // the black plate is what survives into the premultiplied colour
  chroma: [255, 0, 255],
  'vlm-mask': [128, 128, 128],
  none: null,
}

export type TextStrategy = 'live' | 'baked'

export const TEXT_STRATEGIES: { id: TextStrategy; label: string; note: string }[] = [
  { id: 'live', label: '文字不入像素', note: '出图时明确要求留白，文字用真实文本节点渲染。100% 可编辑。' },
  { id: 'baked', label: '烘焙后回收', note: '让模型把文字画进图里，再 OCR + 擦除 + 重排。对照组，会掉精度。' },
]

export type ComposeOptions = {
  matte: MatteStrategy
  /** Override the planning model for this run (blank = server default). */
  visionModel?: string
  text: TextStrategy
  aspectRatio: string
  resolution: string
  maxElements: number
}

export type DecomposeOptions = {
  aspectRatio: string
  resolution: string
  /** Override the grounding model for this run (blank = server default). */
  groundingModel?: string
  /** Override the layout-reading model for this run (blank = server default). */
  visionModel?: string
  /** Ask the vision model for per-element segmentation masks (slower, sharper). */
  useMasks: boolean
  /** Use the image model to inpaint the holes left behind by lifted elements. */
  inpaintBackground: boolean
  maxElements: number
}

export type PipelineOptions = {
  compose: ComposeOptions
  decompose: DecomposeOptions
}

// ---------- Run records (history / comparison) ----------

export type StepStatus = 'pending' | 'running' | 'ok' | 'error' | 'skipped'

export type RunStep = {
  id: string
  label: string
  status: StepStatus
  ms?: number
  cost?: number
  detail?: string
  error?: string
}

export type RunMeta = {
  id: string
  createdAt: number
  pipeline: PipelineId
  prompt: string
  /** small JPEG data URI for the history list */
  thumbnail?: string
  layerCount: number
  textLayerCount: number
  totalMs: number
  totalCost: number
  options: ComposeOptions | DecomposeOptions
  models: { image: string; vision: string; grounding: string }
  failed?: boolean
  metrics?: RunMetrics
  /** Set when this run was one arm of a one-click benchmark sweep. */
  benchmark?: BenchmarkRef
}

export type Artifact = {
  label: string
  src: string
  /** 'source' is the flat raster a decompose run started from — the metrics
   *  reference. 'plate' is the final background. 'cut' is a matted element. */
  role?: 'source' | 'plate' | 'raw' | 'cut'
}

/** Automatically measured so "which strategy is better" is a number, not a vibe. */
export type RunMetrics = {
  imageLayers: number
  textLayers: number
  /** True when no text ever entered a raster — the headline editability claim. */
  liveText: boolean
  /** Mean fraction of an element's non-empty pixels that are partially transparent.
   *  Real feathering survives; a hard key flattens this toward zero. */
  softEdgeRatio: number | null
  /** Mean fraction of the element frame that survived matting. */
  alphaCoverage: number | null
  /** Mean backdrop contamination among retained pixels, 0..1. Lower is better. */
  spill: number | null
  /** Reconstruction fidelity against the source raster. Decompose runs only. */
  psnr: number | null
  l1: number | null
}

export type BenchmarkRef = {
  id: string
  label: string
  index: number
  total: number
}

export type Run = RunMeta & {
  scene: Scene
  steps: RunStep[]
  /** Raw intermediates, kept so the two pipelines can be inspected side by side. */
  artifacts: Artifact[]
}

// ---------- API wire types ----------

export type UsageInfo = { cost: number; tokens?: number }

export type GenerateRequest = {
  prompt: string
  aspectRatio?: string
  resolution?: string
  /** Solid backdrop to composite against — enables `dual` and `chroma` matting. */
  backdrop?: 'white' | 'black' | 'magenta' | 'none' | 'transparent'
  /** data URIs of reference images for editing. */
  references?: string[]
  seed?: number
  n?: number
}

export type GenerateResponse = {
  images: string[] // data URIs
  usage: UsageInfo
  model: string
}

export type PlanResponse = {
  plan: ScenePlan
  usage: UsageInfo
  model: string
}

/** What the vision model returns for pipeline A. */
export type ScenePlan = {
  canvas: { width: number; height: number }
  background: { prompt: string; dominantColor: string }
  elements: {
    id: string
    name: string
    prompt: string
    box: [number, number, number, number] // y0,x0,y1,x1 in 0..1000
    z: number
  }[]
  texts: {
    id: string
    content: string
    box: [number, number, number, number]
    color: string
    fontFamily: string
    fontWeight: number
    fontSize: number
    align: 'left' | 'center' | 'right'
    z: number
  }[]
}

/** What the vision model returns for pipeline B. */
export type SceneAnalysis = {
  canvas: { width: number; height: number }
  background: { description: string; dominantColor: string }
  elements: {
    id: string
    label: string
    box: [number, number, number, number]
    z: number
    mask?: string // base64 PNG, box-local
  }[]
  texts: {
    id: string
    content: string
    box: [number, number, number, number]
    color: string
    fontFamily: string
    fontWeight: number
    fontSize: number
    align: 'left' | 'center' | 'right'
    italic: boolean
    z: number
  }[]
}
