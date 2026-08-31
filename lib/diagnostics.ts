'use client'

import { buildZip, dataUriToBytes, safeName, textEntry, type ZipEntry } from './zip'
import { imageSize, loadImage } from './matte'
import { sceneToPng, sceneToSvg } from './export'
import { METRIC_SPECS } from './metrics'
import type { Board, BoardNode, Layer, Scene } from './types'

/**
 * Everything a board produced, as a zip you can hand to someone else.
 *
 * Images become real files rather than data URIs buried in JSON, so the bundle
 * can be browsed with a file manager and the JSON stays readable. Paths are
 * stable across exports, which means two bundles of the same board diff cleanly.
 */

export type BundleOptions = {
  /** Longest side to resample images to. 0 keeps them at native resolution. */
  maxDim: number
  /** Re-encode opaque images as JPEG. Alpha is always kept as PNG. */
  compressOpaque: boolean
}

export const DEFAULT_BUNDLE: BundleOptions = { maxDim: 1024, compressOpaque: true }

type Encoded = { data: Uint8Array; ext: string; width: number; height: number; hasAlpha: boolean }

function ctxOf(w: number, h: number) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w))
  canvas.height = Math.max(1, Math.round(h))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  return { canvas, ctx }
}

/** JPEG would silently flatten a matte, so transparency decides the format. */
async function encode(src: string, opts: BundleOptions): Promise<Encoded> {
  const img = await loadImage(src)
  const scale = opts.maxDim > 0 ? Math.min(1, opts.maxDim / Math.max(img.naturalWidth, img.naturalHeight)) : 1
  const { canvas, ctx } = ctxOf(img.naturalWidth * scale, img.naturalHeight * scale)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let hasAlpha = false
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] < 250) {
      hasAlpha = true
      break
    }
  }

  const useJpeg = opts.compressOpaque && !hasAlpha
  const uri = canvas.toDataURL(useJpeg ? 'image/jpeg' : 'image/png', useJpeg ? 0.92 : undefined)
  return {
    data: dataUriToBytes(uri),
    ext: useJpeg ? 'jpg' : 'png',
    width: canvas.width,
    height: canvas.height,
    hasAlpha,
  }
}

/** Strip pixel payloads out of a layer, leaving the geometry and styling. */
function describeLayer(layer: Layer, file: string | null) {
  const base = {
    id: layer.id,
    type: layer.type,
    name: layer.name,
    x: round(layer.x),
    y: round(layer.y),
    w: round(layer.w),
    h: round(layer.h),
    rotation: layer.rotation,
    opacity: layer.opacity,
    visible: layer.visible,
    provenance: layer.provenance,
  }
  if (layer.type === 'text') {
    return {
      ...base,
      text: layer.text,
      fontFamily: layer.fontFamily,
      fontSize: round(layer.fontSize),
      fontWeight: layer.fontWeight,
      letterSpacing: round(layer.letterSpacing),
      color: layer.color,
      align: layer.align,
      italic: layer.italic,
    }
  }
  return {
    ...base,
    file,
    matte: layer.matte,
    // Present when the layer is type kept as pixels rather than a text node.
    retypeText: layer.retype?.text,
    retypeColor: layer.retype?.color,
  }
}

function round(n: number) {
  return Math.round(n * 100) / 100
}

export async function buildDiagnosticBundle(
  board: Board,
  opts: BundleOptions = DEFAULT_BUNDLE,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const entries: ZipEntry[] = []
  const root = `banana-diag-${board.id}`

  // Rough unit count so the progress bar means something.
  const totalUnits =
    board.nodes.reduce((a, n) => a + (n.images?.length ?? 0), 0) +
    board.branches.length * 2 +
    board.nodes.filter((n) => n.scene).reduce((a, n) => a + (n.scene?.layers.length ?? 0), 0)
  let done = 0
  const tick = () => onProgress?.(++done, totalUnits)

  // ---------------------------------------------------------- nodes
  const nodeIndex: Record<string, unknown>[] = []

  for (const node of board.nodes) {
    const dir = `${root}/nodes/${safeName(`${node.kind}-${node.id}`)}`
    const files: string[] = []

    for (const [i, image] of (node.images ?? []).entries()) {
      try {
        const enc = await encode(image.src, opts)
        const path = `${dir}/${String(i).padStart(2, '0')}-${safeName(image.label, 'image')}.${enc.ext}`
        entries.push({ path, data: enc.data })
        files.push(`${path.slice(root.length + 1)}  (${enc.width}x${enc.height}${enc.hasAlpha ? ', RGBA' : ''})`)
      } catch {
        files.push(`(第 ${i} 张图解码失败)`)
      }
      tick()
    }

    const meta = {
      id: node.id,
      kind: node.kind,
      label: node.label,
      detail: node.detail,
      status: node.status,
      warningOrError: node.error,
      ms: node.ms,
      cost: node.cost,
      inputs: node.inputs,
      branches: node.branches,
      shared: node.branches.length > 1,
      summary: node.summary,
      images: files,
    }
    entries.push(textEntry(`${dir}/meta.json`, JSON.stringify(meta, null, 2)))
    nodeIndex.push({ ...meta, images: files.length })
  }

  // --------------------------------------------------------- scenes
  for (const branch of board.branches) {
    // Prefer the recorded pointer, but fall back to finding the scene node by
    // membership: a branch that failed after producing a scene may never have
    // written the pointer, and that is exactly the run worth inspecting.
    const node =
      board.nodes.find((n) => n.id === branch.sceneNodeId && n.scene) ??
      board.nodes.find((n) => n.kind === 'scene' && n.scene && n.branches.includes(branch.id))
    if (!node?.scene) continue
    const dir = `${root}/scenes/${safeName(branch.label, branch.id)}`
    const scene: Scene = node.scene

    const layerDescriptions: unknown[] = []
    for (const [i, layer] of scene.layers.entries()) {
      let file: string | null = null
      if (layer.type === 'image') {
        try {
          const enc = await encode(layer.src, opts)
          file = `layers/${String(i).padStart(2, '0')}-${safeName(layer.name, layer.id)}.${enc.ext}`
          entries.push({ path: `${dir}/${file}`, data: enc.data })
        } catch {
          file = null
        }
      }
      layerDescriptions.push(describeLayer(layer, file))
      tick()
    }

    // The flattened render is the thing to eyeball first: if this looks right,
    // the layers add up; if it does not, the per-layer files say where it broke.
    try {
      const flat = await sceneToPng(scene)
      const enc = await encode(flat, opts)
      entries.push({ path: `${dir}/flattened.${enc.ext}`, data: enc.data })
    } catch {
      /* a scene that cannot flatten is itself a finding, recorded below */
    }
    tick()

    try {
      entries.push(textEntry(`${dir}/scene.svg`, sceneToSvg(scene)))
    } catch {
      /* non-fatal */
    }

    entries.push(
      textEntry(
        `${dir}/scene.json`,
        JSON.stringify(
          {
            branch: { id: branch.id, label: branch.label, pipeline: branch.pipeline, status: branch.status },
            options: branch.options,
            metrics: branch.metrics,
            cost: branch.cost,
            ms: branch.ms,
            error: branch.error,
            canvas: scene.canvas,
            layers: layerDescriptions,
          },
          null,
          2,
        ),
      ),
    )
    tick()
  }

  // ------------------------------------------------------- manifest
  const manifest = {
    board: {
      id: board.id,
      createdAt: new Date(board.createdAt).toISOString(),
      prompt: board.prompt,
      rounds: board.rounds,
      fromUpload: board.fromUpload,
      concurrency: board.concurrency,
      models: board.models,
      totals: {
        wallMs: board.totalMs,
        serialMs: board.serialMs,
        prepMs: board.prepMs,
        cost: board.totalCost,
        nodes: board.nodes.length,
        branches: board.branches.length,
      },
    },
    branches: board.branches.map((b) => ({
      id: b.id,
      label: b.label,
      pipeline: b.pipeline,
      status: b.status,
      error: b.error,
      ms: b.ms,
      cost: b.cost,
      options: b.options,
      metrics: b.metrics,
    })),
    exportedAt: new Date().toISOString(),
    bundleOptions: opts,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
  }
  entries.push(textEntry(`${root}/manifest.json`, JSON.stringify(manifest, null, 2)))
  entries.push(textEntry(`${root}/graph.json`, JSON.stringify({ nodes: nodeIndex }, null, 2)))
  entries.push(textEntry(`${root}/README.md`, readme(board, opts)))

  return buildZip(entries)
}

/** Orientation for whoever opens the bundle, including what to check first. */
function readme(board: Board, opts: BundleOptions) {
  const metricLines = board.branches
    .map((b) => {
      const cells = METRIC_SPECS.map((spec) => {
        const raw = b.metrics?.[spec.key]
        return `${spec.label} ${typeof raw === 'number' ? spec.format(raw) : '—'}`
      })
      return `- **${b.label}** (${b.status}) — ${cells.join(' · ')}`
    })
    .join('\n')

  const shared = board.nodes.filter((n) => n.branches.length > 1)
  const degraded = board.nodes.filter((n) => n.error)

  return `# BananaDecompose 诊断包

提示词：**${board.prompt}**

- 画布 \`${board.id}\`，${board.rounds} 轮，${board.branches.length} 条分支，${board.nodes.length} 个节点
- 墙钟 ${(board.totalMs / 1000).toFixed(1)}s（串行等价 ${(board.serialMs / 1000).toFixed(1)}s），成本 $${board.totalCost.toFixed(4)}
- 模型：出图 \`${board.models.image}\` / 视觉 \`${board.models.vision}\` / grounding \`${board.models.grounding}\`
- 图片${opts.maxDim ? `最长边缩到 ${opts.maxDim}px` : '为原始分辨率'}；**带透明的一律是 PNG**，不透明的转 JPEG

## 先看哪里

1. \`scenes/<分支>/flattened.*\` —— 图层叠回去的样子。**这张对了就说明图层加得起来**
2. 不对的话看 \`scenes/<分支>/layers/\` —— 逐层拆开，能看出是哪一层错了
3. \`scenes/<分支>/scene.json\` —— 每层的位置、尺寸、字号、颜色、来源说明（\`provenance\` 写了这层是怎么来的）
4. \`nodes/\` —— 每个中间产物的原始图和配置，按管线阶段命名

## 目录

\`\`\`
manifest.json           画布元数据、每条分支的配置与指标
graph.json              节点图（不含图片，图片在 nodes/ 下）
nodes/<阶段>-<id>/      每个节点的图片 + meta.json
scenes/<分支>/
  flattened.*           图层叠回去的渲染结果
  scene.svg             矢量导出（文字是 <text> 节点）
  scene.json            逐层的几何与样式，图片以文件名引用
  layers/               每一层单独一个文件，带 alpha
\`\`\`

## 各分支指标

${metricLines || '（没有指标）'}

> \`—\` 是"不适用"不是"没测出来"：重建 PSNR/L1 需要原图做参照，只有拆解管线有；底色残留需要一个彩色键，双渲染没有单一键色。

## 共享上游

${shared.length ? shared.map((n) => `- \`${n.label}\` —— ${n.branches.length} 条分支共用`).join('\n') : '（没有共享节点）'}

同管线各分支共享上游，所以指标表里每一行的差异只来自被测的那个变量。

## 降级与失败

${degraded.length ? degraded.map((n) => `- \`${n.label}\`（${n.status}）—— ${n.error}`).join('\n') : '（没有降级或失败的节点）'}
`
}

export async function imageStats(src: string) {
  return imageSize(src)
}
