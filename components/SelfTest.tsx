'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { chromaKeyMatte, dualRenderMatte, loadImage } from '@/lib/matte'
import BoardCanvas from './Board'
import GlyphTest from './GlyphTest'
import SceneEditor from './SceneEditor'
import type { Board, Scene } from '@/lib/types'

// The matting maths is the load-bearing part of pipeline A, and it is the part
// that costs money to test against the real model. So: build a subject with a
// KNOWN alpha channel, composite it over each backdrop exactly the way a renderer
// would, run the recovery, and measure the error against ground truth.

const SIZE = 256

type Case = { name: string; meanAlphaError: number; maxAlphaError: number; meanColorError: number; recovered: string; truth: string }

function makeCtx() {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  return { canvas, ctx }
}

/** Ground truth: an orange disc with a feathered rim plus a translucent bar. */
function groundTruth(): ImageData {
  const { ctx } = makeCtx()
  ctx.clearRect(0, 0, SIZE, SIZE)

  const grad = ctx.createRadialGradient(SIZE / 2, SIZE / 2, SIZE * 0.28, SIZE / 2, SIZE / 2, SIZE * 0.4)
  grad.addColorStop(0, 'rgba(255,140,32,1)')
  grad.addColorStop(1, 'rgba(255,140,32,0)')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(SIZE / 2, SIZE / 2, SIZE * 0.4, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = 'rgba(64,200,255,0.45)'
  ctx.fillRect(SIZE * 0.15, SIZE * 0.44, SIZE * 0.7, SIZE * 0.12)

  return ctx.getImageData(0, 0, SIZE, SIZE)
}

/** Composite the truth over a solid backdrop — exactly what the image model returns. */
function over(truth: ImageData, bg: [number, number, number]): string {
  const { canvas, ctx } = makeCtx()
  ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`
  ctx.fillRect(0, 0, SIZE, SIZE)
  const tmp = makeCtx()
  tmp.ctx.putImageData(truth, 0, 0)
  ctx.drawImage(tmp.canvas, 0, 0)
  return canvas.toDataURL('image/png')
}

function truthUrl(truth: ImageData): string {
  const { canvas, ctx } = makeCtx()
  ctx.putImageData(truth, 0, 0)
  return canvas.toDataURL('image/png')
}

/** Compare a recovered RGBA layer against the truth, re-padded to the same frame. */
async function score(recovered: string, bounds: { x: number; y: number; w: number; h: number }, truth: ImageData) {
  const img = await loadImage(recovered)
  const { ctx } = makeCtx()
  ctx.clearRect(0, 0, SIZE, SIZE)
  ctx.drawImage(img, bounds.x * SIZE, bounds.y * SIZE, bounds.w * SIZE, bounds.h * SIZE)
  const got = ctx.getImageData(0, 0, SIZE, SIZE)

  let alphaSum = 0
  let alphaMax = 0
  let colorSum = 0
  let colorN = 0

  for (let i = 0; i < truth.data.length; i += 4) {
    const da = Math.abs(got.data[i + 3] - truth.data[i + 3]) / 255
    alphaSum += da
    if (da > alphaMax) alphaMax = da
    // Colour only means anything where the subject is substantially opaque.
    if (truth.data[i + 3] > 200) {
      colorSum +=
        (Math.abs(got.data[i] - truth.data[i]) +
          Math.abs(got.data[i + 1] - truth.data[i + 1]) +
          Math.abs(got.data[i + 2] - truth.data[i + 2])) /
        3 /
        255
      colorN++
    }
  }

  const n = truth.data.length / 4
  return {
    meanAlphaError: alphaSum / n,
    maxAlphaError: alphaMax,
    meanColorError: colorN ? colorSum / colorN : 0,
  }
}

/** A board with the exact shape a three-arm sweep produces: one shared plan and
 *  one shared plate fanning out into three matting chains. Verifies the layered
 *  layout — depth columns, branch lanes, shared nodes centred — with no API spend. */
function syntheticBoard(swatch: string): Board {
  const arms = [
    { id: 'a-dual', label: 'A · 双渲染差值' },
    { id: 'a-chroma', label: 'A · 色键抠图' },
    { id: 'a-vlm', label: 'A · VLM 分割掩码' },
  ]
  const all = arms.map((a) => a.id)

  return {
    id: 'selftest',
    createdAt: 0,
    prompt: '一张咖啡品鉴会的海报',
    branchCount: arms.length,
    rounds: 1,
    nodeCount: 0,
    totalMs: 0,
    serialMs: 0,
    prepMs: 0,
    totalCost: 0,
    concurrency: 4,
    models: { image: 'image', vision: 'vision', grounding: 'grounding' },
    branches: arms.map((a) => ({
      id: a.id,
      label: a.label,
      pipeline: 'compose' as const,
      options: { matte: 'dual' as const, text: 'live' as const, aspectRatio: '1:1', resolution: '1K', maxElements: 2 },
      status: 'ok' as const,
      cost: 0,
      ms: 0,
    })),
    nodes: [
      { id: 'n:prompt', kind: 'prompt', label: '提示词', branches: [], inputs: [], status: 'ok', summary: '一张咖啡品鉴会的海报' },
      { id: 'n:plan', kind: 'plan', label: '规划 Scene JSON', branches: all, inputs: ['n:prompt'], status: 'ok', summary: '· 手冲壶\n· 陶瓷杯\n「晨间萃取」' },
      { id: 'n:plate', kind: 'plate', label: '背景板', branches: all, inputs: ['n:plan'], status: 'ok', images: [{ label: '背景板', src: swatch }] },
      ...arms.flatMap((a) => [
        { id: `n:${a.id}:renders`, kind: 'renders' as const, label: '独立渲染 ×2', branches: [a.id], inputs: ['n:plan'], status: 'ok' as const, images: [{ label: 'a', src: swatch }, { label: 'b', src: swatch }] },
        { id: `n:${a.id}:cuts`, kind: 'cuts' as const, label: '抠图 ×2', branches: [a.id], inputs: [`n:${a.id}:renders`], status: 'ok' as const, images: [{ label: 'a', src: swatch }] },
        { id: `n:${a.id}:scene`, kind: 'scene' as const, label: a.label, branches: [a.id], inputs: [`n:${a.id}:cuts`, 'n:plate'], status: 'ok' as const, ms: 42000 + arms.indexOf(a) * 9000, images: [{ label: 'scene', src: swatch }], scene: demoScene(swatch) },
      ]),
    ],
  }
}

/** A scene with one image layer and one text layer — enough to exercise the
 *  editor's selection, dragging, inline text editing and marquee. */
function demoScene(swatch: string): Scene {
  return {
    canvas: { width: 512, height: 512, background: '#1a1410' },
    layers: [
      {
        id: 'bg', type: 'image', name: '背景板', x: 0, y: 0, w: 512, h: 512,
        rotation: 0, opacity: 1, visible: true, locked: false, src: swatch, matte: 'none',
        provenance: '自检用的合成图层',
      },
      {
        id: 'title', type: 'text', name: '晨间萃取', x: 96, y: 60, w: 320, h: 80,
        rotation: 0, opacity: 1, visible: true, locked: false,
        text: '晨间萃取', fontFamily: 'Noto Serif SC', fontSize: 64, fontWeight: 700,
        color: '#f5e6c8', align: 'left', lineHeight: 1.15, letterSpacing: 0, italic: false,
        provenance: '自检用的文本节点 · 双击可直接改字',
      },
    ],
  }
}

export default function SelfTest() {
  const [cases, setCases] = useState<Case[]>([])
  const [busy, setBusy] = useState(false)
  const [demoBoard, setDemoBoard] = useState<Board | null>(null)
  const [hiddenNodes, setHiddenNodes] = useState<Set<string>>(new Set())
  const [hiddenBranches, setHiddenBranches] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<Scene | null>(null)

  const run = useCallback(async () => {
    setBusy(true)
    const truth = groundTruth()
    const truthSrc = truthUrl(truth)
    const results: Case[] = []

    const white = over(truth, [255, 255, 255])
    const black = over(truth, [0, 0, 0])
    const magenta = over(truth, [255, 0, 255])

    const dual = await dualRenderMatte(white, black)
    results.push({ name: '双渲染差值 (dual)', ...(await score(dual.src, dual.bounds, truth)), recovered: dual.src, truth: truthSrc })

    const chroma = await chromaKeyMatte(magenta)
    results.push({ name: '色键抠图 (chroma)', ...(await score(chroma.src, chroma.bounds, truth)), recovered: chroma.src, truth: truthSrc })

    setCases(results)
    setDemoBoard(syntheticBoard(truthSrc))
    setBusy(false)
  }, [])

  useEffect(() => {
    run()
  }, [run])

  return (
    <main className="min-h-screen bg-ink-950 p-6">
      <header className="mb-6 flex items-center gap-4">
        <Link href="/" className="font-mono text-sm font-semibold hover:text-banana-400">
          ← <span className="text-banana-400">Banana</span>Decompose
        </Link>
        <h1 className="text-xs text-ink-400">抠图自检 · 用已知 alpha 的合成图验证算法，不消耗 API</h1>
        <button
          onClick={run}
          disabled={busy}
          className="ml-auto rounded bg-banana-500 px-3 py-1 text-[11px] font-medium text-ink-950 disabled:opacity-50"
        >
          {busy ? '运行中…' : '重跑'}
        </button>
      </header>

      <p className="mb-4 max-w-2xl text-[11px] leading-relaxed text-ink-400">
        真值是一个带羽化边缘的橙色圆盘 + 一条 45% 半透明的蓝色横条 —— 专门挑了两种最难还原的情况：软边和半透明。
        把它按渲染器的方式合成到白 / 黑 / 品红底上，再跑一遍恢复算法，和真值逐像素比。
        <strong className="text-ink-200"> 这是算法上限</strong>：真实模型两次生成不会像这里一样像素级一致，实际误差会更大。
      </p>

      {editing ? (
        <SceneEditor
          title="编辑器自检（合成场景）"
          scene={editing}
          onChange={setEditing}
          onClose={() => setEditing(null)}
        />
      ) : null}

      <GlyphTest />

      {demoBoard ? (
        <section className="mb-6">
          <h2 className="mb-2 text-sm text-ink-50">节点画布布局自检</h2>
          <p className="mb-2 max-w-2xl text-[11px] leading-relaxed text-ink-400">
            一张三分支扫描该有的形状：<strong className="text-ink-200">一个规划节点 + 一个背景板节点，扇出到三条抠图链路</strong>。
            共享上游只画一次 —— 这就是为什么对比表里每行的差异只来自被测变量。点分支按钮可以关掉整条链路。
          </p>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {demoBoard.branches.map((b) => {
              const off = hiddenBranches.has(b.id)
              return (
                <button
                  key={b.id}
                  onClick={() =>
                    setHiddenBranches((prev) => {
                      const next = new Set(prev)
                      if (next.has(b.id)) next.delete(b.id)
                      else next.add(b.id)
                      return next
                    })
                  }
                  className={`rounded border px-2 py-1 text-[10px] ${
                    off ? 'border-ink-800 text-ink-600 line-through' : 'border-ink-700 text-ink-200'
                  }`}
                >
                  {b.label}
                </button>
              )
            })}
          </div>
          <div className="h-[420px]">
            <BoardCanvas
              board={demoBoard}
              hiddenBranches={hiddenBranches}
              hiddenNodes={hiddenNodes}
              onToggleNode={(id) =>
                setHiddenNodes((prev) => {
                  const next = new Set(prev)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
              selectedNodeId={null}
              onSelectNode={() => {}}
              onOpenScene={(node) => node.scene && setEditing(node.scene)}
            />
          </div>
        </section>
      ) : null}

      <h2 className="mb-2 text-sm text-ink-50">抠图算法自检</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {cases.map((c) => {
          const good = c.meanAlphaError < 0.01
          return (
            <article key={c.name} className="rounded-lg border border-ink-800 bg-ink-900 p-4">
              <div className="mb-3 flex items-center gap-2">
                <h2 className="text-sm text-ink-50">{c.name}</h2>
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[9px] ${
                    good ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'
                  }`}
                >
                  {good ? 'PASS' : 'LOSSY'}
                </span>
              </div>

              <dl className="mb-3 grid grid-cols-3 gap-2 font-mono text-[10px]">
                <Stat k="平均 alpha 误差" v={c.meanAlphaError} />
                <Stat k="最大 alpha 误差" v={c.maxAlphaError} />
                <Stat k="平均颜色误差" v={c.meanColorError} />
              </dl>

              <div className="grid grid-cols-2 gap-2">
                <Shot label="真值" src={c.truth} />
                <Shot label="恢复结果" src={c.recovered} />
              </div>
            </article>
          )
        })}
      </div>
    </main>
  )
}

function Stat({ k, v }: { k: string; v: number }) {
  return (
    <div className="rounded border border-ink-800 bg-ink-950 px-2 py-1.5">
      <dt className="text-[9px] text-ink-600">{k}</dt>
      <dd className="tabular-nums text-ink-50">{(v * 100).toFixed(2)}%</dd>
    </div>
  )
}

function Shot({ label, src }: { label: string; src: string }) {
  return (
    <figure>
      <div className="checker overflow-hidden rounded border border-ink-800">
        <img src={src} alt={label} className="h-40 w-full object-contain" />
      </div>
      <figcaption className="mt-1 font-mono text-[9px] text-ink-400">{label}</figcaption>
    </figure>
  )
}
